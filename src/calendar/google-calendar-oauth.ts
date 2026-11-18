import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  CodeChallengeMethod, OAuth2Client, type Credentials, type GenerateAuthUrlOpts,
  type GetTokenOptions, type TokenPayload, type VerifyIdTokenOptions,
} from 'google-auth-library';
import { type OAuthFlow } from '../auth/auth.types.js';
import { createOAuthFlow, oauthChallenge } from '../auth/oauth-flow.js';
import { CONFIGURATION, type Configuration } from '../config.js';

export enum CalendarScope {
  Events = 'https://www.googleapis.com/auth/calendar.events',
  CalendarList = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
}

export const CALENDAR_OAUTH_CLIENT = Symbol('CALENDAR_OAUTH_CLIENT');

export interface CalendarOAuthClient {
  generateAuthUrl(options: GenerateAuthUrlOpts): string;
  getToken(options: GetTokenOptions): Promise<{ tokens: Credentials }>;
  verifyIdToken(options: VerifyIdTokenOptions): Promise<{ getPayload(): TokenPayload | undefined }>;
}

export function createCalendarOAuthClient(config: Configuration): CalendarOAuthClient {
  return new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.calendar?.redirectUri,
  });
}

@Injectable()
export class GoogleCalendarOAuth {
  private readonly logger = new Logger(GoogleCalendarOAuth.name);

  constructor(
    @Inject(CONFIGURATION) private readonly config: Configuration,
    @Inject(CALENDAR_OAUTH_CLIENT) private readonly client: CalendarOAuthClient,
  ) {}

  begin(): { flow: OAuthFlow; url: string } {
    if (!this.config.calendar) throw new ServiceUnavailableException('Google Calendar is not configured');
    const flow = createOAuthFlow();
    const url = this.client.generateAuthUrl({
      scope: ['openid', 'email', CalendarScope.Events, CalendarScope.CalendarList],
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: oauthChallenge(flow),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: false,
    });
    return { flow, url };
  }

  async exchange(code: string, flow: OAuthFlow): Promise<{ subject: string; email: string; refreshToken: string }> {
    if (!this.config.calendar) throw new ServiceUnavailableException('Google Calendar is not configured');
    if (!code || flow.expiresAt <= Date.now()) throw new UnauthorizedException('Calendar authorization expired');
    let tokens: Credentials;
    let payload: TokenPayload | undefined;
    try {
      ({ tokens } = await this.client.getToken({
        code, codeVerifier: flow.verifier, redirect_uri: this.config.calendar.redirectUri,
      }));
      if (!tokens.id_token) throw new Error('Missing identity token');
      const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
      payload = ticket.getPayload();
    } catch {
      this.logger.warn('Google Calendar token exchange or signature validation failed');
      throw new UnauthorizedException('Google Calendar authorization could not be verified');
    }
    const granted = new Set((tokens.scope ?? '').split(/\s+/));
    if (!tokens.refresh_token || !Object.values(CalendarScope).every((scope) => granted.has(scope))
        || !payload?.sub || !payload.email || payload.email_verified !== true || payload['nonce'] !== flow.nonce) {
      this.logger.warn('Google Calendar authorization claims or scopes were rejected');
      throw new UnauthorizedException('Google Calendar authorization was incomplete');
    }
    return { subject: payload.sub, email: payload.email, refreshToken: tokens.refresh_token };
  }
}
