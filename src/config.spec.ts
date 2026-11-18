import { readConfiguration } from './config.js';

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  FRONTEND_ORIGIN: 'http://localhost:4200',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters',
  DATABASE_URL: 'postgresql://localhost/kotailor_test',
};

describe('readConfiguration', () => {
  it('rejects missing secrets instead of using placeholders', () => {
    expect(() => readConfiguration({ ...valid, GOOGLE_CLIENT_SECRET: '' })).toThrow(
      'GOOGLE_CLIENT_SECRET',
    );
    expect(() => readConfiguration({ ...valid, SESSION_SECRET: 'short' })).toThrow(
      'SESSION_SECRET',
    );
  });

  it('requires HTTPS in production and a shared session cookie hostname', () => {
    expect(() => readConfiguration({ ...valid, NODE_ENV: 'production' })).toThrow(
      'Invalid URL',
    );
    expect(() =>
      readConfiguration({
        ...valid,
        GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/google/callback',
      }),
    ).toThrow('share a hostname');
  });

  it('rejects a callback path that is not implemented', () => {
    expect(() =>
      readConfiguration({
        ...valid,
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/wrong',
      }),
    ).toThrow('must end with');
  });

  it('requires a complete and valid separate Google Calendar configuration', () => {
    const tokenKey = Buffer.alloc(32, 7).toString('base64url');
    const calendar = {
      GOOGLE_CALENDAR_REDIRECT_URI: 'http://localhost:3000/api/calendar/google/callback',
      CALENDAR_TOKEN_KEY: tokenKey,
    };
    expect(readConfiguration({ ...valid }).calendar).toBeUndefined();
    expect(readConfiguration({ ...valid, ...calendar }).calendar).toEqual({
      redirectUri: calendar.GOOGLE_CALENDAR_REDIRECT_URI, tokenKey,
    });
    expect(() => readConfiguration({ ...valid, ...calendar, CALENDAR_TOKEN_KEY: '' })).toThrow('CALENDAR_TOKEN_KEY');
    expect(() => readConfiguration({ ...valid, ...calendar, CALENDAR_TOKEN_KEY: 'invalid' })).toThrow('CALENDAR_TOKEN_KEY');
    expect(() => readConfiguration({ ...valid, ...calendar, GOOGLE_CALENDAR_REDIRECT_URI: 'http://127.0.0.1:3000/api/calendar/google/callback' }))
      .toThrow('Invalid Google Calendar callback');
    expect(() => readConfiguration({ ...valid, ...calendar, GOOGLE_CALENDAR_REDIRECT_URI: 'http://localhost:3000/wrong' }))
      .toThrow('Invalid Google Calendar callback');
  });
});
