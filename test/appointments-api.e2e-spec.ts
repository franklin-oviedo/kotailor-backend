import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { CustomerAppointmentsController, WorkshopAppointmentsController } from '../src/appointments/appointments.controller.js';
import { AppointmentsService } from '../src/appointments/appointments.service.js';
import { GoogleIdentityProvider } from '../src/auth/google-identity.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { CONFIGURATION, readConfiguration, type Configuration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { configureHttp } from '../src/http.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Appointment HTTP endpoints', () => {
  let app: NestExpressApplication;
  let database: Database;
  let config: Configuration;
  const suffix = randomUUID();
  const subjects = ['owner', 'staff', 'customer', 'other'].map((name) => `appointments-api-${name}-${suffix}`);
  const workshops: string[] = [];
  const flow = { state: 'test-state', nonce: 'test-nonce', verifier: 'test-verifier', expiresAt: Date.now() + 600000 };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    config = readConfiguration();
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [WorkshopAppointmentsController, CustomerAppointmentsController],
      providers: [AppointmentsService, SessionGuard],
    }).overrideProvider(GoogleIdentityProvider).useValue({
      begin: () => ({ flow, url: 'https://accounts.google.com/test' }),
      verify: async (code: string) => {
        const index = ['owner', 'staff', 'customer', 'other'].indexOf(code);
        if (index < 0) throw new Error('Invalid test user');
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

  it('isolates customer appointments, enforces permissions and uses Dominican dates', async () => {
    const browsers = await Promise.all(['owner', 'staff', 'customer', 'other'].map(async (code) => {
      const browser = request.agent(app.getHttpServer());
      await browser.get('/api/auth/google').expect(302);
      await browser.get(`/api/auth/google/callback?state=test-state&code=${code}`).expect(302);
      const me = await browser.get('/api/auth/me').expect(200);
      return { browser, userId: me.body.user.id as string };
    }));
    const [owner, staff, customer, other] = browsers;
    const created = await database.pool.query<{ id: string }>(
      `INSERT INTO workshops (name) VALUES ('Appointment API A'), ('Appointment API B') RETURNING id`,
    );
    workshops.push(...created.rows.map((row) => row.id));
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $3, 'owner'), ($1, $4, 'staff')`,
      [workshops[0], workshops[1], owner.userId, staff.userId],
    );
    const customerRows = await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'API customer A', '8095550100', 'person'),
              ($1, 'API customer B', '8095550100', 'person') RETURNING id`, [workshops[0]],
    );
    const [first, second] = customerRows.rows.map((row) => row.id);
    await database.pool.query(
      `INSERT INTO customer_account_links (workshop_id, customer_id, user_id)
       VALUES ($1, $2, $3), ($1, $4, $5)`, [workshops[0], first, customer.userId, second, other.userId],
    );
    const url = `/api/workshops/${workshops[0]}/appointments`;
    const customerUrl = `/api/client/workshops/${workshops[0]}/appointments`;
    const options = await customer.browser.get(`${customerUrl}/options`)
      .expect(200).expect('Cache-Control', 'no-store');
    expect(options.body.customers).toEqual([{ id: first, name: 'API customer A' }]);
    expect(options.body.responsibles).toContainEqual({ id: staff.userId, name: 'staff' });
    await staff.browser.get(`${customerUrl}/options`).expect(404);
    const input = {
      requestId: randomUUID(), customerId: first, orderId: null, responsibleId: staff.userId,
      kind: 'fitting', startsAt: '2031-02-01T04:00:00Z', endsAt: '2031-02-01T04:30:00Z',
    };
    await request(app.getHttpServer()).get(`${url}?from=2031-02-01&to=2031-02-02`).expect(401);
    await owner.browser.post(url).send(input).expect(403);
    await staff.browser.post(url).set('Origin', config.frontendOrigin).send(input).expect(404);
    await other.browser.post(customerUrl).set('Origin', config.frontendOrigin).send(input).expect(404);
    const appointment = await customer.browser.post(customerUrl).set('Origin', config.frontendOrigin).send(input).expect(201);
    const retry = await customer.browser.post(customerUrl).set('Origin', config.frontendOrigin).send(input).expect(201);
    expect(retry.body.id).toBe(appointment.body.id);
    await owner.browser.post(url).set('Origin', config.frontendOrigin).send({
      ...input, requestId: randomUUID(), customerId: second,
      startsAt: '2031-02-01T03:00:00Z', endsAt: '2031-02-01T03:30:00Z',
    }).expect(201);
    await owner.browser.get(`${url}?from=2031-02-01&to=2031-03-05`).expect(400);
    await staff.browser.get(`${url}?from=2031-02-01&to=2031-02-02`).expect(404);
    const day = await owner.browser.get(`${url}?from=2031-02-01&to=2031-02-02`)
      .expect(200).expect('Cache-Control', 'no-store');
    expect(day.body.appointments).toHaveLength(1);
    expect(day.body.appointments[0]).toMatchObject({ id: appointment.body.id, synced: false });
    const own = await customer.browser.get(`${customerUrl}?from=2031-01-31&to=2031-02-02&page=2&pageSize=10`).expect(200);
    expect(own.body.appointments).toHaveLength(1);
    expect(own.body.pagination).toEqual({ page: 1, pageSize: 10, total: 1 });
    await other.browser.post(`${customerUrl}/${appointment.body.id}/cancel`)
      .set('Origin', config.frontendOrigin).send({ expectedVersion: 1 }).expect(404);
    await customer.browser.put(`${customerUrl}/${appointment.body.id}`).set('Origin', config.frontendOrigin).send({
      expectedVersion: 1, responsibleId: staff.userId,
      startsAt: '2031-02-01T05:00:00Z', endsAt: '2031-02-01T05:30:00Z',
    }).expect(200);
    await owner.browser.post(`${url}/${appointment.body.id}/cancel`)
      .set('Origin', config.frontendOrigin).send({ expectedVersion: 1 }).expect(409);
    await customer.browser.post(`${customerUrl}/${appointment.body.id}/cancel`)
      .set('Origin', config.frontendOrigin).send({ expectedVersion: 2 }).expect(201);
    const empty = await customer.browser.get(`${customerUrl}?from=2031-02-01&to=2031-02-02`).expect(200);
    expect(empty.body.appointments).toEqual([]);
    await database.pool.query('DELETE FROM customer_account_links WHERE workshop_id = $1 AND user_id = $2',
      [workshops[0], customer.userId]);
    await customer.browser.get(`${customerUrl}?from=2031-02-01&to=2031-02-02`).expect(404);
    await database.pool.query(
      `INSERT INTO appointments
         (workshop_id, customer_id, responsible_id, kind, starts_at, ends_at, created_by, updated_by)
       SELECT $1, $2, $3, 'fitting',
              '2031-02-02T03:59:00Z'::timestamptz + n * interval '2 minutes',
              '2031-02-02T04:01:00Z'::timestamptz + n * interval '2 minutes', $4, $4
       FROM generate_series(0, 100) n`, [workshops[0], first, staff.userId, owner.userId],
    );
    const limited = await owner.browser.get(`${url}?from=2031-02-02&to=2031-02-03`).expect(200);
    expect(limited.body.appointments).toHaveLength(100);
    expect(limited.body.hasMore).toBe(true);
    const boundary = await owner.browser.get(`${url}?from=2031-02-01&to=2031-02-02`).expect(200);
    expect(boundary.body.appointments).toHaveLength(1);
  });
});
