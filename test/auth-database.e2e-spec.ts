import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { GoogleIdentityProvider } from '../src/auth/google-identity.js';
import { CONFIGURATION, readConfiguration, type Configuration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { configureHttp } from '../src/http.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Google session with PostgreSQL', () => {
  let app: NestExpressApplication;
  let database: Database;
  let config: Configuration;
  const subject = `integration-test-${randomUUID()}`;
  const workshopIds: string[] = [];
  const flow = {
    state: 'test-state',
    nonce: 'test-nonce',
    verifier: 'test-verifier',
    expiresAt: Date.now() + 60000,
  };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    config = readConfiguration();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleIdentityProvider)
      .useValue({
        begin: () => ({ flow, url: 'https://accounts.google.com/test' }),
        verify: async () => ({
          subject,
          email: 'integration-test@example.invalid',
          name: 'Integration test',
        }),
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, module.get<Configuration>(CONFIGURATION));
    database = app.get(Database);
    await app.init();
  });

  afterAll(async () => {
    if (database) {
      await database.pool.query(
        `DELETE FROM workshop_creation_grants WHERE user_id IN
         (SELECT id FROM app_users WHERE google_subject = $1)`, [subject],
      );
      await database.pool.query(
        `DELETE FROM administrator_invitations WHERE created_by IN
         (SELECT id FROM app_users WHERE google_subject = $1)`, [subject],
      );
      if (workshopIds.length) {
        await database.pool.query('DELETE FROM workshops WHERE id = ANY($1::uuid[])', [workshopIds]);
      }
      await database.pool.query(
        `DELETE FROM sessions WHERE sess->>'userId' IN
         (SELECT id::text FROM app_users WHERE google_subject = $1)`,
        [subject],
      );
      await database.pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [[subject, `${subject}-same-name`]]);
    }
    if (app) await app.close();
  });

  it('persists and restores a session, then destroys it on logout', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe('integration-test@example.invalid');
    expect(me.body.workshops).toEqual([]);
    const stored = await database.pool.query(
      "SELECT 1 FROM sessions WHERE sess->>'userId' = $1",
      [me.body.user.id],
    );
    expect(stored.rowCount).toBe(1);
    await browser.post('/api/auth/logout').set('Origin', config.frontendOrigin).expect(204);
    await browser.get('/api/auth/me').expect(401);
    const removed = await database.pool.query(
      "SELECT 1 FROM sessions WHERE sess->>'userId' = $1",
      [me.body.user.id],
    );
    expect(removed.rowCount).toBe(0);
  });

  it('restricts administrator invitations to authorized issuers and a verified recipient', async () => {
    const issuer = request.agent(app.getHttpServer());
    await issuer.get('/api/auth/google').expect(302);
    await issuer.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await issuer.get('/api/auth/me').expect(200);
    const url = '/api/admin/invitations';
    const invite = { kind: 'authorize_creator', email: 'integration-test@example.invalid' };
    await issuer.post(url).set('Origin', config.frontendOrigin).send(invite).expect(403);
    await database.pool.query('INSERT INTO platform_administrators (user_id) VALUES ($1)', [me.body.user.id]);
    await issuer.post(url).set('Origin', 'https://other.invalid').send(invite).expect(403);
    const issued = await issuer.post(url).set('Origin', config.frontendOrigin).send(invite).expect(201);
    const token = new URL(issued.body.link).hash.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await database.pool.query(
      'SELECT token_hash, expires_at - created_at AS lifetime FROM administrator_invitations WHERE created_by = $1',
      [me.body.user.id],
    );
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].lifetime.days).toBe(7);
    const recipient = request.agent(app.getHttpServer());
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await recipient.get('/api/auth/google').expect(302);
    await recipient.get('/api/auth/google/callback?state=test-state&code=test-code')
      .expect(302).expect('Location', `${config.frontendOrigin}/invitacion`);
    await recipient.get('/api/invitations/pending').expect(200);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(201);
    const granted = await recipient.get('/api/auth/me').expect(200);
    expect(granted.body.canCreateWorkshop).toBe(true);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(403);
    const created = await recipient.post('/api/workshops').set('Origin', config.frontendOrigin)
      .send({ name: 'Invitation test workshop' }).expect(201);
    workshopIds.push(created.body.id);
    const consumed = await recipient.get('/api/auth/me').expect(200);
    expect(consumed.body.canCreateWorkshop).toBe(false);
    await recipient.post('/api/workshops').set('Origin', config.frontendOrigin)
      .send({ name: 'Second workshop' }).expect(403);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(201);
    await recipient.post('/api/workshops').set('Origin', config.frontendOrigin)
      .send({ name: 'Second workshop' }).expect(403);
    const wrong = await issuer.post(url).set('Origin', config.frontendOrigin)
      .send({ ...invite, email: 'another@example.invalid' }).expect(201);
    const wrongToken = new URL(wrong.body.link).hash.slice(1);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: wrongToken }).expect(201);
    await recipient.get('/api/invitations/pending').expect(403);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(403);
    await database.pool.query(
      "UPDATE administrator_invitations SET expires_at = now() - interval '1 second' WHERE recipient_email = $1",
      ['another@example.invalid'],
    );
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: wrongToken }).expect(400);
    await database.pool.query('DELETE FROM platform_administrators WHERE user_id = $1', [me.body.user.id]);
  });

  it('creates a workshop for an invited administrator and rechecks the issuer on acceptance', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    await database.pool.query('INSERT INTO platform_administrators (user_id) VALUES ($1)', [me.body.user.id]);
    const issued = await browser.post('/api/admin/invitations').set('Origin', config.frontendOrigin)
      .send({ kind: 'create_workshop', email: 'integration-test@example.invalid', workshopName: 'Invited workshop' })
      .expect(201);
    const created = await database.pool.query(
      'SELECT workshop_id FROM administrator_invitations WHERE created_by = $1 AND workshop_id IS NOT NULL',
      [me.body.user.id],
    );
    const workshopId = created.rows[0].workshop_id as string;
    workshopIds.push(workshopId);
    const token = new URL(issued.body.link).hash.slice(1);
    await browser.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await database.pool.query('DELETE FROM platform_administrators WHERE user_id = $1', [me.body.user.id]);
    await browser.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(403);
    await database.pool.query('INSERT INTO platform_administrators (user_id) VALUES ($1)', [me.body.user.id]);
    await browser.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(201);
    const member = await database.pool.query(
      'SELECT role FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2',
      [workshopId, me.body.user.id],
    );
    expect(member.rows[0].role).toBe('owner');
    const ownerUrl = `/api/workshops/${workshopId}/administrator-invitations`;
    const ownerInvite = { kind: 'authorize_creator', email: 'integration-test@example.invalid' };
    const another = await browser.post(ownerUrl).set('Origin', config.frontendOrigin).send(ownerInvite).expect(201);
    await browser.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: new URL(another.body.link).hash.slice(1) }).expect(201);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2",
      [workshopId, me.body.user.id],
    );
    await browser.post(ownerUrl).set('Origin', config.frontendOrigin).send(ownerInvite).expect(403);
    await browser.post('/api/invitations/accept').set('Origin', config.frontendOrigin).expect(403);
    await database.pool.query('DELETE FROM platform_administrators WHERE user_id = $1', [me.body.user.id]);
  });

  it('isolates and validates the workshop catalog', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    const created = await database.pool.query(
      "INSERT INTO workshops (name) VALUES ('Catalog owned'), ('Catalog foreign') RETURNING id",
    );
    const [owned, foreign] = created.rows.map((row: { id: string }) => row.id);
    workshopIds.push(owned, foreign);
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
      [owned, me.body.user.id],
    );
    const url = `/api/workshops/${owned}/catalog`;
    const foreignUrl = `/api/workshops/${foreign}/catalog`;
    const item = {
      name: 'Test garment', category: 'tailoring', basePriceCents: 1600010,
      taxTreatment: 'taxable', measurementGarments: ['shirts', 'jackets'], instructions: 'Test',
    };
    await request(app.getHttpServer()).get(url).expect(401);
    await browser.get(foreignUrl).expect(403);
    await browser.post(foreignUrl).set('Origin', config.frontendOrigin).send(item).expect(403);
    await browser.post(url).set('Origin', 'https://other.invalid').send(item).expect(403);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...item, basePriceCents: 1.5 }).expect(400);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...item, measurementGarments: ['shirts', 'shirts'] }).expect(400);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...item, taxTreatment: 'unknown' }).expect(400);
    const saved = await browser.post(url).set('Origin', config.frontendOrigin).send(item).expect(201);
    const list = await browser.get(url).query({ search: 'Test garment' }).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject(item);
    expect(list.body.measurementCatalog).toHaveLength(4);
    const noMatches = await browser.get(url).query({ search: '%' }).expect(200);
    expect(noMatches.body.items).toHaveLength(0);
    const foreignItem = await database.pool.query(
      `INSERT INTO garment_catalog (workshop_id, name, category, base_price_cents, tax_treatment)
       VALUES ($1, 'Foreign item', 'tailoring', 100, 'taxable') RETURNING id`, [foreign],
    );
    const itemUrl = `${url}/${saved.body.id}`;
    const update = { ...item, revision: 1 };
    await browser.patch(itemUrl).set('Origin', 'https://other.invalid').send(update).expect(403);
    await browser.patch(`${foreignUrl}/${saved.body.id}`).set('Origin', config.frontendOrigin).send(update).expect(403);
    await browser.patch(`${url}/${foreignItem.rows[0].id}`).set('Origin', config.frontendOrigin).send(update).expect(404);
    await browser.patch(itemUrl).set('Origin', config.frontendOrigin)
      .send({ ...update, basePriceCents: -1 }).expect(400);
    const edited = { ...update, name: 'Updated garment', basePriceCents: 0, measurementGarments: [] };
    await browser.patch(itemUrl).set('Origin', config.frontendOrigin).send(edited).expect(200);
    await browser.patch(itemUrl).set('Origin', config.frontendOrigin).send(edited).expect(409);
    const updated = await browser.get(url).query({ search: 'Updated garment' }).expect(200);
    expect(updated.body.items[0]).toMatchObject({ ...edited, revision: 2 });
    await browser.post('/api/auth/logout').set('Origin', config.frontendOrigin).expect(204);
  });

  it('creates tenant-isolated orders with immutable measurements and explicit tax state', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    const workshops = await database.pool.query(
      "INSERT INTO workshops (name) VALUES ('Order owned'), ('Order foreign') RETURNING id",
    );
    const [owned, foreign] = workshops.rows.map((row: { id: string }) => row.id);
    workshopIds.push(owned, foreign);
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
      [owned, me.body.user.id],
    );
    const customers = await database.pool.query(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Order test', '8095550100', 'person'),
              ($2, 'Foreign customer', '8095550101', 'person') RETURNING id`,
      [owned, foreign],
    );
    const [customer, foreignCustomer] = customers.rows.map((row: { id: string }) => row.id);
    const catalog = await database.pool.query(
      `INSERT INTO garment_catalog (workshop_id, name, category, base_price_cents, tax_treatment, measurement_garments)
       VALUES ($1, 'Test garment', 'tailoring', 10001, 'taxable', ARRAY['jackets']::measurement_garment[])
       RETURNING id`, [owned],
    );
    const measurement = await database.pool.query(
      `INSERT INTO customer_measurement_versions (workshop_id, customer_id, garment, version, measurements, verified_by)
       VALUES ($1, $2, 'jackets', 1, '{"waistWidth":42}', $3) RETURNING id`,
      [owned, customer, me.body.user.id],
    );
    const url = `/api/workshops/${owned}/orders`;
    const settingsUrl = `/api/workshops/${owned}/order-settings`;
    const dashboardUrl = `/api/workshops/${owned}/order-dashboard`;
    const productionUrl = `/api/workshops/${owned}/production`;
    expect((await browser.get(dashboardUrl).expect(200)).body).toEqual({
      activeOrders: 0, dueToday: 0, priorities: [],
    });
    expect((await browser.get(productionUrl).expect(200)).body).toEqual({ stages: [], responsibles: [], hasHistorical: false });
    await request(app.getHttpServer()).get(productionUrl).expect(401);
    await browser.get(`/api/workshops/${foreign}/production`).expect(403);
    const order = {
      requestId: randomUUID(),
      customerId: customer, catalogId: catalog.rows[0].id, catalogRevision: 1, subtotalCents: 10001,
      expectedTaxBasisPoints: null, measurementIds: [measurement.rows[0].id],
      deliveryLocal: '2026-11-18T15:00', responsibleId: me.body.user.id,
    };
    await request(app.getHttpServer()).get(url).expect(401);
    await browser.get(`/api/workshops/${foreign}/orders`).expect(403);
    await browser.post(url).set('Origin', 'https://other.invalid').send(order).expect(403);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...order, customerId: foreignCustomer }).expect(400);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...order, measurementIds: [] }).expect(400);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...order, measurementIds: [measurement.rows[0].id, randomUUID()] }).expect(400);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...order, deliveryLocal: '2026-02-30T15:00' }).expect(400);
    const first = await browser.post(url).set('Origin', config.frontendOrigin).send(order).expect(201);
    expect(first.body.number).toBe(1);
    expect((await database.pool.query('SELECT responsible_id FROM workshop_orders WHERE id = $1', [first.body.id]))
      .rows[0].responsible_id).toBe(me.body.user.id);
    const replay = await browser.post(url).set('Origin', config.frontendOrigin).send(order).expect(201);
    expect(replay.body).toEqual(first.body);
    await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...order, subtotalCents: 12345 }).expect(409);
    await database.pool.query('UPDATE garment_catalog SET name = $2, revision = revision + 1 WHERE id = $1',
      [catalog.rows[0].id, 'Changed template']);
    const detail = await browser.get(`${url}/${first.body.id}`).expect(200);
    expect(detail.body).toMatchObject({
      catalogName: 'Test garment', subtotalCents: 10001, taxCents: null, taxBasisPoints: null,
      deliveryLocal: '2026-11-18T15:00', responsibleName: 'Integration test',
    });
    expect(detail.body.measurementSnapshots[0].measurements).toEqual({ waistWidth: 42 });
    expect(detail.body.history).toEqual([]);
    const statusUrl = `${url}/${first.body.id}/status`;
    const change = { expectedStatus: 'received', status: 'cutting' };
    await request(app.getHttpServer()).put(statusUrl).set('Origin', config.frontendOrigin).send(change).expect(401);
    await browser.put(statusUrl).set('Origin', 'https://other.invalid').send(change).expect(403);
    await browser.put(statusUrl).set('Origin', config.frontendOrigin)
      .send({ expectedStatus: 'received', status: 'sewing' }).expect(400);
    await browser.put(statusUrl).set('Origin', config.frontendOrigin)
      .send({ expectedStatus: 'received', status: 'invalid' }).expect(400);
    await browser.put(`/api/workshops/${foreign}/orders/${first.body.id}/status`)
      .set('Origin', config.frontendOrigin).send(change).expect(403);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2",
      [owned, me.body.user.id],
    );
    await browser.put(statusUrl).set('Origin', config.frontendOrigin).send(change).expect(403);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'manager' WHERE workshop_id = $1 AND user_id = $2",
      [owned, me.body.user.id],
    );
    const changes = await Promise.all([
      browser.put(statusUrl).set('Origin', config.frontendOrigin).send(change),
      browser.put(statusUrl).set('Origin', config.frontendOrigin).send(change),
    ]);
    expect(changes.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const advanced = changes.find((response) => response.status === 200)!;
    expect(advanced.body.event).toMatchObject({
      previousStatus: 'received', newStatus: 'cutting', changedBy: 'Integration test',
    });
    for (const [expectedStatus, status] of [
      ['cutting', 'sewing'], ['sewing', 'fitting'], ['fitting', 'ready'], ['ready', 'delivered'],
      ['delivered', 'ready'], ['ready', 'fitting'], ['fitting', 'sewing'], ['sewing', 'cutting'], ['cutting', 'received'],
    ]) {
      await browser.put(statusUrl).set('Origin', config.frontendOrigin).send({ expectedStatus, status }).expect(200);
    }
    const history = (await browser.get(`${url}/${first.body.id}`).expect(200)).body;
    expect(history.status).toBe('received');
    expect(history.history).toHaveLength(10);
    expect(history.history[0]).toMatchObject({ previousStatus: 'cutting', newStatus: 'received', changedBy: 'Integration test' });
    expect(history.historyHasMore).toBe(false);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'owner' WHERE workshop_id = $1 AND user_id = $2",
      [owned, me.body.user.id],
    );
    await browser.post(url).set('Origin', config.frontendOrigin).send({ ...order, requestId: randomUUID() }).expect(409);
    await browser.put(settingsUrl).set('Origin', 'https://other.invalid').send({ itbisBasisPoints: 1800 }).expect(403);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2",
      [owned, me.body.user.id],
    );
    await browser.put(settingsUrl).set('Origin', config.frontendOrigin).send({ itbisBasisPoints: 1800 }).expect(403);
    await database.pool.query(
      "UPDATE workshop_memberships SET role = 'owner' WHERE workshop_id = $1 AND user_id = $2",
      [owned, me.body.user.id],
    );
    await browser.put(settingsUrl).set('Origin', config.frontendOrigin).send({ itbisBasisPoints: 1800 }).expect(200);
    const secondOrder = { ...order, requestId: randomUUID(), catalogRevision: 2, responsibleId: null };
    await browser.post(url).set('Origin', config.frontendOrigin).send(secondOrder).expect(409);
    const second = await browser.post(url).set('Origin', config.frontendOrigin)
      .send({ ...secondOrder, expectedTaxBasisPoints: 1800, subtotalCents: 10003 }).expect(201);
    expect(second.body.number).toBe(2);
    const taxed = await browser.get(`${url}/${second.body.id}`).expect(200);
    expect(taxed.body.taxCents).toBe(1801);
    expect((await browser.get(url).query({ search: 'OT-0002' }).expect(200)).body.orders).toHaveLength(1);
    const filtered = await browser.get(url).query({ filter: 'ready' }).expect(200);
    expect(filtered.body.orders).toHaveLength(0);
    expect(filtered.body.counts).toMatchObject({ all: 2, production: 2, ready: 0 });
    await browser.get(url).query({ filter: 'invalid' }).expect(400);
    const parallel = await Promise.all([
      browser.post(url).set('Origin', config.frontendOrigin)
        .send({ ...order, requestId: randomUUID(), catalogRevision: 2, expectedTaxBasisPoints: 1800 }),
      browser.post(url).set('Origin', config.frontendOrigin)
        .send({ ...order, requestId: randomUUID(), catalogRevision: 2, expectedTaxBasisPoints: 1800 }),
    ]);
    expect(parallel.map((response) => response.status)).toEqual([201, 201]);
    expect(parallel.map((response) => response.body.number).sort((a: number, b: number) => a - b)).toEqual([3, 4]);
    const retryOrder = { ...order, requestId: randomUUID(), catalogRevision: 2, expectedTaxBasisPoints: 1800 };
    const retries = await Promise.all([
      browser.post(url).set('Origin', config.frontendOrigin).send(retryOrder),
      browser.post(url).set('Origin', config.frontendOrigin).send(retryOrder),
    ]);
    expect(retries.map((response) => response.status)).toEqual([201, 201]);
    expect(retries[0].body).toEqual(retries[1].body);
    expect(retries[0].body.number).toBe(5);
    await browser.get(`/api/workshops/${foreign}/orders/${first.body.id}`).expect(403);
    await request(app.getHttpServer()).get(dashboardUrl).expect(401);
    await browser.get(`/api/workshops/${foreign}/order-dashboard`).expect(403);
    await database.pool.query(
      `UPDATE workshop_orders SET delivery_local = (now() AT TIME ZONE 'America/Santo_Domingo')::date + INTERVAL '1 day'
       WHERE workshop_id = $1`, [owned],
    );
    await database.pool.query(
      `UPDATE workshop_orders SET delivery_local = (now() AT TIME ZONE 'America/Santo_Domingo')::date + INTERVAL '10 hours'
       WHERE id = $1`, [first.body.id],
    );
    await database.pool.query(
      `UPDATE workshop_orders SET status = 'delivered',
       delivery_local = (now() AT TIME ZONE 'America/Santo_Domingo')::date + INTERVAL '11 hours'
       WHERE id = $1`, [second.body.id],
    );
    const dashboard = await browser.get(dashboardUrl).expect(200).expect('Cache-Control', 'no-store');
    expect(dashboard.body.activeOrders).toBe(4);
    expect(dashboard.body.dueToday).toBe(1);
    expect(dashboard.body.priorities).toHaveLength(4);
    expect(dashboard.body.priorities[0]).toMatchObject({ number: 1, customerName: 'Order test', status: 'received' });
    expect(dashboard.body.priorities.some((entry: { number: number }) => entry.number === 2)).toBe(false);
    const production = await browser.get(productionUrl).expect(200).expect('Cache-Control', 'no-store');
    expect(production.body.stages).toHaveLength(1);
    expect(production.body.stages[0]).toMatchObject({ status: 'received', total: 4 });
    expect(production.body.stages[0].orders[0])
      .toMatchObject({ number: 1, customerName: 'Order test', responsibleName: 'Integration test' });
    expect(production.body.stages[0].orders).toHaveLength(4);
    await database.pool.query(
      `INSERT INTO workshop_orders
         (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
          subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, responsible_name, created_by)
       SELECT o.workshop_id, 100 + n, o.customer_id, o.customer_name, o.catalog_name, o.catalog_instructions,
              o.tax_treatment, o.subtotal_cents, o.tax_basis_points, o.tax_cents, o.measurement_snapshots,
              o.delivery_local + INTERVAL '2 days', o.responsible_name, o.created_by
       FROM workshop_orders o CROSS JOIN generate_series(1, 21) n WHERE o.id = $1`,
      [first.body.id],
    );
    const limitedProduction = await browser.get(productionUrl).expect(200);
    expect(limitedProduction.body.stages[0].total).toBe(25);
    expect(limitedProduction.body.stages[0].orders).toHaveLength(20);
    const lastProductionPage = await browser.get(productionUrl)
      .query({ stage: 'received', page: 99, pageSize: 10 }).expect(200);
    expect(lastProductionPage.body.stages[0].pagination).toEqual({ total: 25, page: 3, pageSize: 10 });
    expect(lastProductionPage.body.stages[0].orders).toHaveLength(5);
    await database.pool.query(
      `UPDATE workshop_orders SET status = 'ready',
       delivery_local = (now() AT TIME ZONE 'America/Santo_Domingo')::date - INTERVAL '1 day'
       WHERE id = $1`, [second.body.id],
    );
    const overdue = await browser.get(dashboardUrl).expect(200);
    expect(overdue.body.activeOrders).toBe(26);
    expect(overdue.body.priorities).toHaveLength(4);
    expect(overdue.body.priorities[0]).toMatchObject({ number: 2, status: 'ready' });
    const anotherUser = await database.pool.query(
      'INSERT INTO app_users (google_subject, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`${subject}-same-name`, 'same-name@example.invalid', 'Integration test'],
    );
    const anotherId = anotherUser.rows[0].id;
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'staff')", [owned, anotherId],
    );
    await database.pool.query(
      'UPDATE workshop_orders SET responsible_id = $3 WHERE workshop_id = $1 AND number = $2', [owned, 101, anotherId],
    );
    const people = await browser.get(productionUrl).expect(200);
    expect(people.body.responsibles).toEqual([
      expect.objectContaining({ id: expect.any(String), name: 'Integration test' }),
      expect.objectContaining({ id: expect.any(String), name: 'Integration test' }),
    ]);
    expect(people.body.responsibles.map((person: { id: string }) => person.id).sort((a: string, b: string) => a.localeCompare(b)))
      .toEqual([me.body.user.id, anotherId].sort((a: string, b: string) => a.localeCompare(b)));
    expect(people.body.hasHistorical).toBe(true);
    const byFirst = await browser.get(productionUrl).query({ responsible: me.body.user.id }).expect(200);
    expect(byFirst.body.stages[0].total).toBe(4);
    const bySecond = await browser.get(productionUrl).query({ responsible: anotherId }).expect(200);
    expect(bySecond.body.stages[0].total).toBe(1);
    expect(bySecond.body.stages[0].orders[0].number).toBe(101);
    const historical = await browser.get(productionUrl).query({ responsible: 'historical' }).expect(200);
    expect(historical.body.stages[0].total).toBe(20);
    const unassigned = await browser.get(productionUrl).query({ responsible: 'unassigned' }).expect(200);
    expect(unassigned.body.stages[0].orders[0].number).toBe(2);
    await browser.get(productionUrl).query({ responsible: 'not-an-id' }).expect(400);
    await browser.get(`/api/workshops/${foreign}/production`).query({ responsible: anotherId }).expect(403);
    await browser.get(productionUrl).query({ delivery: 'invalid' }).expect(400);
    await browser.get(productionUrl).query({ delivery: ['all', 'this_week'] }).expect(400);
    await browser.get(`/api/workshops/${foreign}/production`).query({ delivery: 'this_week' }).expect(403);
    await database.pool.query(
      `UPDATE workshop_orders
       SET delivery_local = date_trunc('week', now() AT TIME ZONE 'America/Santo_Domingo') +
         CASE WHEN number = 3 THEN INTERVAL '0 seconds'
              WHEN number = 4 THEN INTERVAL '1 week' - INTERVAL '1 second'
              WHEN number = 5 THEN INTERVAL '1 week'
              ELSE -INTERVAL '1 second' END
       WHERE workshop_id = $1 AND status = 'received'`,
      [owned],
    );
    const weekly = await browser.get(productionUrl).query({ delivery: 'this_week' }).expect(200);
    const received = weekly.body.stages.find((stage: { status: string }) => stage.status === 'received');
    expect(received.total).toBe(2);
    expect(received.orders.map((entry: { number: number }) => entry.number)).toEqual([3, 4]);
    const weeklyFirst = await browser.get(productionUrl)
      .query({ delivery: 'this_week', responsible: me.body.user.id }).expect(200);
    expect(weeklyFirst.body.stages[0].total).toBe(2);
    const weeklyOther = await browser.get(productionUrl)
      .query({ delivery: 'this_week', responsible: anotherId }).expect(200);
    expect(weeklyOther.body.stages).toEqual([]);
    await database.pool.query('DELETE FROM app_users WHERE id = $1', [anotherId]);
    const preserved = await browser.get(productionUrl).query({ responsible: 'historical' }).expect(200);
    expect(preserved.body.stages[0].total).toBe(21);
    expect(preserved.body.stages[0].orders[0].responsibleName).toBe('Integration test');
    await database.pool.query(
      'DELETE FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2',
      [owned, me.body.user.id],
    );
    await browser.get(dashboardUrl).expect(403);
    await browser.get(productionUrl).expect(403);
    await browser.post('/api/auth/logout').set('Origin', config.frontendOrigin).expect(204);
  }, 30000);

  it('isolates customers by workshop and rejects invalid or cross-origin writes', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test-code').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    const created = await database.pool.query(
      "INSERT INTO workshops (name) VALUES ('Integration owned'), ('Integration foreign') RETURNING id",
    );
    workshopIds.push(...created.rows.map((row: { id: string }) => row.id));
    const [owned, foreign] = created.rows.map((row: { id: string }) => row.id);
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
      [owned, me.body.user.id],
    );
    const customer = {
      name: 'Test customer', phone: '8095550100', email: null, kind: 'person',
      documentKind: null, documentNumber: null, contactAuthorized: false,
    };
    const ownedUrl = `/api/workshops/${owned}/customers`;
    const foreignUrl = `/api/workshops/${foreign}/customers`;
    await request(app.getHttpServer()).get(ownedUrl).expect(401);
    await browser.get(foreignUrl).expect(403);
    await browser.post(foreignUrl).set('Origin', config.frontendOrigin).send(customer).expect(403);
    await browser.post(ownedUrl).set('Origin', 'https://other.invalid').send(customer).expect(403);
    await browser.post(ownedUrl).set('Origin', config.frontendOrigin)
      .send({ ...customer, documentKind: 'cedula' }).expect(400);
    const saved = await browser.post(ownedUrl).set('Origin', config.frontendOrigin).send(customer).expect(201);
    const result = await browser.get(ownedUrl).query({ search: 'Test customer' }).expect(200);
    expect(result.body.customers).toHaveLength(1);
    expect(result.body.customers[0].name).toBe(customer.name);
    const noMatches = await browser.get(ownedUrl).query({ search: '%' }).expect(200);
    expect(noMatches.body.customers).toHaveLength(0);
    const foreignCustomer = await database.pool.query(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Foreign customer', '8095550101', 'person') RETURNING id`, [foreign],
    );
    const detailUrl = `${ownedUrl}/${saved.body.id}`;
    const measuresUrl = `${detailUrl}/measurements`;
    const foreignDetailUrl = `${ownedUrl}/${foreignCustomer.rows[0].id}`;
    const measurement = {
      garment: 'womens_trousers', confirmed: true,
      measurements: { waist: 72.5, hip: 98, totalLength: 102, kneeWidth: 22, hemWidth: 20, rise: 29 },
    };
    const detail = await browser.get(detailUrl).expect(200);
    expect(detail.body.measurementCatalog.map((item: { id: string }) => item.id))
      .toEqual(['womens_trousers', 'shirts', 'jackets', 'dresses']);
    await browser.get(foreignDetailUrl).expect(404);
    await browser.get(`${foreignDetailUrl}/measurements`).expect(404);
    await browser.post(`${foreignDetailUrl}/measurements`).set('Origin', config.frontendOrigin)
      .send(measurement).expect(404);
    await browser.post(measuresUrl).set('Origin', 'https://other.invalid').send(measurement).expect(403);
    await browser.post(measuresUrl).set('Origin', config.frontendOrigin)
      .send({ ...measurement, confirmed: false }).expect(400);
    await browser.post(measuresUrl).set('Origin', config.frontendOrigin)
      .send({ ...measurement, measurements: { ...measurement.measurements, waist: 1.001 } }).expect(400);
    const versions = await Promise.all([
      browser.post(measuresUrl).set('Origin', config.frontendOrigin).send(measurement),
      browser.post(measuresUrl).set('Origin', config.frontendOrigin)
        .send({ ...measurement, measurements: { ...measurement.measurements, waist: 73 } }),
    ]);
    expect(versions.map((response) => response.status)).toEqual([201, 201]);
    expect(versions.map((response) => response.body.version).sort((a: number, b: number) => a - b)).toEqual([1, 2]);
    const history = await browser.get(measuresUrl).expect(200);
    expect(history.body.versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);
    expect(history.body.versions.map((version: { measurements: { waist: number } }) => version.measurements.waist).sort((a: number, b: number) => a - b))
      .toEqual([72.5, 73]);
    const earlier = await browser.get(measuresUrl).query({ before: 2 }).expect(200);
    expect(earlier.body.versions).toHaveLength(1);
    expect(earlier.body.versions[0].version).toBe(1);
    await browser.get(measuresUrl).query({ before: 'invalid' }).expect(400);
    await browser.get(measuresUrl).query({ garment: 'unknown' }).expect(400);
    const expectedFields = {
      shirts: ['backLength', 'waistLength', 'totalLength', 'chestWidth', 'waistWidth', 'hipWidth',
        'sleeveLength', 'armWidth', 'cuffWidth', 'chestFrontWidth', 'neckWidth', 'front', 'back'],
      jackets: ['backLength', 'waistLength', 'totalLength', 'chestWidth', 'waistWidth', 'hipWidth',
        'sleeveLength', 'sleeveWidth', 'sleeveOpeningWidth'],
      dresses: ['backLength', 'waistLength', 'totalLength', 'bustCircumference', 'waistCircumference',
        'hipCircumference', 'bustSeparation', 'hipHeight', 'backHipHeight', 'nippleHeight',
        'bustHeight', 'armholeWidth'],
    };
    for (const [garment, fields] of Object.entries(expectedFields)) {
      const definition = detail.body.measurementCatalog.find((item: { id: string }) => item.id === garment);
      expect(definition.fields.map((field: { key: string }) => field.key)).toEqual(fields);
      const values = Object.fromEntries(fields.map((key) => [key, 42]));
      await browser.post(measuresUrl).set('Origin', config.frontendOrigin)
        .send({ garment, confirmed: true, measurements: { ...values, invalid: 42 } }).expect(400);
      const incomplete = { ...values };
      delete incomplete[fields[0]];
      await browser.post(measuresUrl).set('Origin', config.frontendOrigin)
        .send({ garment, confirmed: true, measurements: incomplete }).expect(400);
      const savedVersion = await browser.post(measuresUrl).set('Origin', config.frontendOrigin)
        .send({ garment, confirmed: true, measurements: values }).expect(201);
      expect(savedVersion.body.version).toBe(1);
      const garmentHistory = await browser.get(measuresUrl).query({ garment }).expect(200);
      expect(garmentHistory.body.versions).toHaveLength(1);
      expect(garmentHistory.body.versions[0].measurements).toEqual(values);
    }
    const trousersHistory = await browser.get(measuresUrl).query({ garment: 'womens_trousers' }).expect(200);
    expect(trousersHistory.body.versions).toHaveLength(2);
    await browser.post('/api/auth/logout').set('Origin', config.frontendOrigin).expect(204);
  });
});
