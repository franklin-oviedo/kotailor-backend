import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { CONFIGURATION, type Configuration } from '../config.js';
import { type GoogleIdentity, type OAuthFlow } from './auth.types.js';
import { createOAuthFlow, oauthChallenge } from './oauth-flow.js';

@Injectable()
export class GoogleIdentityProvider {
  private readonly client: OAuth2Client;
  private readonly logger = new Logger(GoogleIdentityProvider.name);

  constructor(@Inject(CONFIGURATION) private readonly config: Configuration) {
    this.client = new OAuth2Client({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: config.googleRedirectUri,
    });
  }

  begin(): { flow: OAuthFlow; url: string } {
    const flow = createOAuthFlow();
    const url = this.client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: oauthChallenge(flow),
      prompt: 'select_account',
    });
    return { flow, url };
  }

  async verify(code: string, flow: OAuthFlow): Promise<GoogleIdentity> {
    let payload;
    try {
      const { tokens } = await this.client.getToken({
        code,
        codeVerifier: flow.verifier,
        redirect_uri: this.config.googleRedirectUri,
      });
      if (!tokens.id_token) throw new Error('Missing ID token');
      const ticket = await this.client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      // OAuth client errors may contain tokens or client credentials.
      this.logger.warn('Google token exchange or signature validation failed');
      throw new UnauthorizedException('Google authentication could not be verified');
    }
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload['nonce'] !== flow.nonce
    ) {
      this.logger.warn('Google identity claims were rejected');
      throw new UnauthorizedException('Invalid Google identity claims');
    }
    return {
      subject: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
    };
  }
}
