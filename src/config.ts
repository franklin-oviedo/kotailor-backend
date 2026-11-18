export enum RuntimeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export interface Configuration {
  production: boolean;
  port: number;
  frontendOrigin: string;
  googleRedirectUri: string;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  databaseUrl: string;
  trustProxy?: string;
  calendar?: { redirectUri: string; tokenKey: string };
}

export const CONFIGURATION = Symbol('CONFIGURATION');

export function readConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Configuration {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const environment = required('NODE_ENV');
  if (!Object.values(RuntimeEnvironment).some((value) => value === environment)) {
    throw new Error('NODE_ENV must be development, test or production');
  }
  const production = environment === RuntimeEnvironment.Production;
  const url = (name: string): URL => {
    const value = new URL(required(name));
    if (
      !['http:', 'https:'].includes(value.protocol) ||
      value.username ||
      value.password ||
      value.search ||
      value.hash ||
      (production && value.protocol !== 'https:')
    ) {
      throw new Error(`Invalid URL configuration: ${name}`);
    }
    return value;
  };
  const frontend = url('FRONTEND_ORIGIN');
  if (frontend.pathname !== '/') {
    throw new Error('FRONTEND_ORIGIN must be an origin without a path');
  }
  const redirect = url('GOOGLE_REDIRECT_URI');
  if (redirect.hostname !== frontend.hostname) {
    throw new Error('Frontend and callback must share a hostname for session cookies');
  }
  if (redirect.pathname !== '/api/auth/google/callback') {
    throw new Error('GOOGLE_REDIRECT_URI must end with /api/auth/google/callback');
  }
  const calendarRedirect = env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  const calendarTokenKey = env.CALENDAR_TOKEN_KEY?.trim();
  let calendar: Configuration['calendar'];
  if (calendarRedirect || calendarTokenKey) {
    const calendarUrl = url('GOOGLE_CALENDAR_REDIRECT_URI');
    const tokenKey = required('CALENDAR_TOKEN_KEY');
    if (calendarUrl.hostname !== frontend.hostname || calendarUrl.pathname !== '/api/calendar/google/callback') {
      throw new Error('Invalid Google Calendar callback');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(tokenKey)
        || Buffer.from(tokenKey, 'base64url').toString('base64url') !== tokenKey) {
      throw new Error('CALENDAR_TOKEN_KEY must be 32 bytes encoded as base64url');
    }
    calendar = { redirectUri: calendarUrl.href, tokenKey };
  }
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  }
  const port = Number(required('PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const databaseUrl = required('DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  }
  return {
    production,
    port,
    frontendOrigin: frontend.origin,
    googleRedirectUri: redirect.href,
    googleClientId: required('GOOGLE_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
    sessionSecret,
    databaseUrl,
    trustProxy: env.TRUST_PROXY?.trim() || undefined,
    calendar,
  };
}
