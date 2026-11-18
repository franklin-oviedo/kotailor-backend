import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { GoogleIdentityProvider } from '../src/auth/google-identity.js';
import { CalendarMoveResult, CalendarMoveService } from '../src/calendar/calendar-move.service.js';
import { CalendarSelectionService } from '../src/calendar/calendar-selection.service.js';
import { CALENDAR_LIST_CLIENT } from '../src/calendar/google-calendar-list.js';
import { GoogleCalendarOAuth } from '../src/calendar/google-calendar-oauth.js';
import { CONFIGURATION, readConfiguration, type Configuration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { configureHttp } from '../src/http.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Calendar authorization endpoints', () => {
  let app: NestExpressApplication;
  let database: Database;
  let config: Configuration;
  const suffix = randomUUID();
  const subjects = [`calendar-http-manager-${suffix}`, `calendar-http-other-${suffix}`];
  const workshops: string[] = [];
  const loginFlow = { state: 'test-state', nonce: 'test-nonce', verifier: 'test-verifier', expiresAt: Date.now() + 600000 };
  const exchange = vi.fn(async () => ({
    subject: 'test-calendar-account', email: 'calendar@example.invalid', refreshToken: 'test-calendar-token',
  }));
  const listCalendars = vi.fn(async () => ({
    kind: 'calendar#calendarList',
    items: [{ id: 'test-calendar', summary: 'Calendar', accessRole: 'writer' }], nextPageToken: 'next-page',
  }));
  const getCalendar = vi.fn(async (_token: string, id: string) => ({
    kind: 'calendar#calendarListEntry', id, accessRole: id === 'read-only' ? 'reader' : 'writer',
  }));
  const calendar = {
    begin: () => {
      const state = randomBytes(32).toString('base64url');
      return {
        flow: {
          state, nonce: randomBytes(32).toString('base64url'),
          verifier: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000,
        },
        url: `https://accounts.google.com/test?state=${state}`,
      };
    },
    exchange,
  };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    config = {
      ...readConfiguration(), calendar: {
        redirectUri: 'http://localhost:3000/api/calendar/google/callback',
        tokenKey: Buffer.alloc(32, 7).toString('base64url'),
      },
    };
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(CONFIGURATION).useValue(config)
      .overrideProvider(GoogleCalendarOAuth).useValue(calendar)
      .overrideProvider(CALENDAR_LIST_CLIENT).useValue({ list: listCalendars, get: getCalendar })
      .overrideProvider(GoogleIdentityProvider).useValue({
        begin: () => ({ flow: loginFlow, url: 'https://accounts.google.com/test' }),
        verify: async (code: string) => {
          const index = code === 'manager' ? 0 : 1;
          return { subject: subjects[index], email: `${subjects[index]}@example.invalid`, name: code };
        },
      }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, module.get<Configuration>(CONFIGURATION));
    database = app.get(Database);
    await app.init();
  });

  afterAll(async () => {
    if (database) {
      if (workshops.length) await database.pool.query('DELETE FROM workshops WHERE id = ANY($1::uuid[])', [workshops]);
      await database.pool.query(
        `DELETE FROM sessions WHERE sess->>'userId' IN
         (SELECT id::text FROM app_users WHERE google_subject = ANY($1::text[]))`, [subjects],
      );
      await database.pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [subjects]);
    }
    if (app) await app.close();
  });

  it('requires an authenticated manager, origin and a single-use session-bound callback', async () => {
    const manager = request.agent(app.getHttpServer());
    const other = request.agent(app.getHttpServer());
    for (const [browser, code] of [[manager, 'manager'], [other, 'other']] as const) {
      await browser.get('/api/auth/google').expect(302);
      await browser.get(`/api/auth/google/callback?state=test-state&code=${code}`).expect(302);
    }
    const me = await manager.get('/api/auth/me').expect(200);
    const created = await database.pool.query<{ id: string }>("INSERT INTO workshops (name) VALUES ('Calendar HTTP test') RETURNING id");
    workshops.push(created.rows[0].id);
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'manager')",
      [workshops[0], me.body.user.id],
    );
    const listUrl = `/api/workshops/${workshops[0]}/calendar/calendars`;
    const selectionUrl = `/api/workshops/${workshops[0]}/calendar/selection`;
    await request(app.getHttpServer()).get(listUrl).expect(401);
    await other.get(listUrl).expect(404);
    await manager.get(listUrl).expect(409);
    await manager.get(selectionUrl).expect(409);
    await other.get(selectionUrl).expect(404);
    const url = `/api/workshops/${workshops[0]}/calendar/authorization`;
    await request(app.getHttpServer()).post(url).set('Origin', config.frontendOrigin).expect(401);
    await manager.post(url).expect(403);
    await other.post(url).set('Origin', config.frontendOrigin).expect(404);
    const start = await manager.post(url).set('Origin', config.frontendOrigin).expect(201).expect('Cache-Control', 'no-store');
    const state = new URL(start.body.url).searchParams.get('state');
    await other.get('/api/calendar/google/callback').query({ state, code: 'test-code' }).expect(401);
    const callback = await manager.get('/api/calendar/google/callback').query({ state, code: 'test-code' })
      .expect(302).expect('Cache-Control', 'no-store').expect('Referrer-Policy', 'no-referrer');
    expect(callback.headers.location).toBe(`${config.frontendOrigin}/agenda/calendar?calendar=connected`);
    expect(callback.headers.location).not.toContain('test-code');
    await manager.get('/api/calendar/google/callback').query({ state, code: 'test-code' }).expect(401);
    expect(exchange).toHaveBeenCalledTimes(1);

    const cancelled = await manager.post(url).set('Origin', config.frontendOrigin).expect(201);
    const cancelledState = new URL(cancelled.body.url).searchParams.get('state');
    await manager.get('/api/calendar/google/callback').query({ state: cancelledState, error: 'access_denied' })
      .expect(302).expect('Location', `${config.frontendOrigin}/agenda/calendar?calendar=cancelled`);
    await manager.get('/api/calendar/google/callback').query({ state: cancelledState, code: 'test-code' }).expect(401);
    expect(exchange).toHaveBeenCalledTimes(1);
    await manager.get(`/api/workshops/${workshops[0]}/calendar`).expect(200)
      .expect({ connected: true, email: 'calendar@example.invalid' });
    await manager.get(listUrl).query({ pageToken: 'page-1' }).expect(200).expect('Cache-Control', 'no-store')
      .expect({ calendars: [{ id: 'test-calendar', name: 'Calendar', primary: false }], nextPageToken: 'next-page' });
    expect(listCalendars).toHaveBeenCalledWith('test-calendar-token', 'page-1');
    await manager.get(listUrl).query({ pageToken: 'x'.repeat(4097) }).expect(400);
    await manager.get(selectionUrl).expect(200).expect('Cache-Control', 'no-store')
      .expect({ selectedCalendarId: null, pendingCalendarId: null, version: 0 });
    await manager.post(selectionUrl).send({ calendarId: 'first', expectedVersion: 0 }).expect(403);
    await other.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'first', expectedVersion: 0 }).expect(404);
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: '..', expectedVersion: 0 }).expect(400);
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'read-only', expectedVersion: 0 }).expect(409);
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'first', expectedVersion: 0 }).expect(200)
      .expect({ selectedCalendarId: 'first', pendingCalendarId: null, version: 1 });
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'first', expectedVersion: 1 }).expect(200)
      .expect({ selectedCalendarId: 'first', pendingCalendarId: null, version: 1 });
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'second', expectedVersion: 0 }).expect(409);
    await manager.post(selectionUrl).set('Origin', config.frontendOrigin)
      .send({ calendarId: 'second', expectedVersion: 1 }).expect(503);
    await app.get(CalendarSelectionService).select(workshops[0], me.body.user.id, { calendarId: 'second', expectedVersion: 1 });
    await manager.get(selectionUrl).expect(200)
      .expect({ selectedCalendarId: 'first', pendingCalendarId: 'second', version: 2 });
    await other.post(`/api/workshops/${workshops[0]}/calendar/disconnect`).set('Origin', config.frontendOrigin).expect(404);
    await manager.post(`/api/workshops/${workshops[0]}/calendar/disconnect`).expect(403);
    await manager.post(`/api/workshops/${workshops[0]}/calendar/disconnect`).set('Origin', config.frontendOrigin).expect(409);
    expect(await app.get(CalendarMoveService).processNext(workshops[0])).toBe(CalendarMoveResult.Finished);
    await manager.get(selectionUrl).expect(200)
      .expect({ selectedCalendarId: 'second', pendingCalendarId: null, version: 3 });
    await manager.post(`/api/workshops/${workshops[0]}/calendar/disconnect`)
      .set('Origin', config.frontendOrigin).expect(204);
    await manager.get(`/api/workshops/${workshops[0]}/calendar`).expect(200)
      .expect({ connected: false, email: null });
    await manager.get(listUrl).expect(409);
  });
});
