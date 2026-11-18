import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import { json } from 'express';
import type { Configuration } from './config.js';
import { Database } from './database/database.js';
import { SESSION_COOKIE, SESSION_DURATION_MS } from './auth/auth.types.js';

export function configureHttp(app: NestExpressApplication, config: Configuration): void {
  const logger = new Logger('SessionStore');
  const PgSession = connectPgSimple(session);
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use('/api/workshops/:workshopId/billing-profile', json({ limit: '180kb' }));
  // Nest detects the route-specific parser and otherwise skips its default JSON parser.
  app.use(json());
  app.use(session({
    name: SESSION_COOKIE,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new PgSession({
      pool: app.get(Database).pool,
      tableName: 'sessions',
      createTableIfMissing: false,
      errorLog: () => logger.error('PostgreSQL session storage failed'),
    }),
    cookie: {
      httpOnly: true,
      secure: config.production,
      sameSite: 'lax',
      maxAge: SESSION_DURATION_MS,
      path: '/',
    },
  }));
}
