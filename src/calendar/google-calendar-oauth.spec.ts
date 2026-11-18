import { createHash } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Client, type Credentials, type TokenPayload } from 'google-auth-library';
import { readConfiguration } from '../config.js';
import {
  CalendarScope, GoogleCalendarOAuth, createCalendarOAuthClient, type CalendarOAuthClient,
} from './google-calendar-oauth.js';

describe('GoogleCalendarOAuth', () => {
  const config = readConfiguration({
    NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:4200',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters',
    DATABASE_URL: 'postgresql://localhost/kotailor_test',
    GOOGLE_CALENDAR_REDIRECT_URI: 'http://localhost:3000/api/calendar/google/callback',
    CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64url'),
  });

  it('uses separate offline consent with PKCE and only the requested calendar scopes', () => {
    const oauth = new GoogleCalendarOAuth(config, createCalendarOAuthClient(config));
    const { flow, url } = oauth.begin();
    const parameters = new URL(url).searchParams;
    expect(new URL(url).origin).toBe('https://accounts.google.com');
    expect(new URL(url).pathname).toBe('/o/oauth2/v2/auth');
    expect(parameters.get('scope')?.split(' ')).toEqual(['openid', 'email', CalendarScope.Events, CalendarScope.CalendarList]);
    expect(parameters.get('redirect_uri')).toBe(config.calendar?.redirectUri);
    expect(parameters.get('state')).toBe(flow.state);
    expect(parameters.get('nonce')).toBe(flow.nonce);
    expect(parameters.get('code_challenge_method')).toBe('S256');
    expect(parameters.get('code_challenge')).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));
    expect(parameters.get('access_type')).toBe('offline');
    expect(parameters.get('prompt')).toBe('consent');
    expect(oauth.begin().flow.state).not.toBe(flow.state);
    expect(url).not.toContain(config.googleClientSecret);
  });

  it('verifies identity, nonce, offline access and both calendar scopes', async () => {
    const raw = new OAuth2Client({ clientId: config.googleClientId, redirectUri: config.calendar!.redirectUri });
    let tokens: Credentials = {
      id_token: 'test-id-token', refresh_token: 'test-refresh-token',
      scope: `openid email ${CalendarScope.Events} ${CalendarScope.CalendarList}`,
    };
    let payload: TokenPayload = {
      iss: 'https://accounts.google.com', sub: 'test-subject', aud: config.googleClientId,
      iat: 1, exp: 9999999999, email: 'calendar@example.invalid', email_verified: true,
    };
    const getToken = vi.fn(async () => ({ tokens }));
    const verifyIdToken = vi.fn(async () => ({ getPayload: () => payload }));
    const client: CalendarOAuthClient = {
      generateAuthUrl: (options) => raw.generateAuthUrl(options),
      getToken,
      verifyIdToken,
    };
    const oauth = new GoogleCalendarOAuth(config, client);
    const { flow } = oauth.begin();
    payload = { ...payload, nonce: flow.nonce };
    await expect(oauth.exchange('test-code', flow)).resolves.toEqual({
      subject: 'test-subject', email: 'calendar@example.invalid', refreshToken: 'test-refresh-token',
    });
    expect(getToken).toHaveBeenCalledWith({
      code: 'test-code', codeVerifier: flow.verifier, redirect_uri: config.calendar?.redirectUri,
    });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'test-id-token', audience: config.googleClientId });
    tokens = { ...tokens, scope: CalendarScope.Events };
    await expect(oauth.exchange('test-code', flow)).rejects.toBeInstanceOf(UnauthorizedException);
    tokens = { ...tokens, scope: `${CalendarScope.Events} ${CalendarScope.CalendarList}`, refresh_token: null };
    await expect(oauth.exchange('test-code', flow)).rejects.toBeInstanceOf(UnauthorizedException);
    tokens = { ...tokens, refresh_token: 'test-refresh-token' };
    payload = { ...payload, nonce: 'wrong' };
    await expect(oauth.exchange('test-code', flow)).rejects.toBeInstanceOf(UnauthorizedException);
    payload = { ...payload, nonce: flow.nonce, email_verified: false };
    await expect(oauth.exchange('test-code', flow)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(oauth.exchange('test-code', { ...flow, expiresAt: 0 })).rejects.toBeInstanceOf(UnauthorizedException);
    getToken.mockRejectedValueOnce(new Error('test-sensitive-provider-response'));
    await expect(oauth.exchange('test-code', flow)).rejects.toThrow('Google Calendar authorization could not be verified');
  });
});
