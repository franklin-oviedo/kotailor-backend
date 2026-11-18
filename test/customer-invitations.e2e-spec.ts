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

databaseSuite('Customer invitations', () => {
  let app: NestExpressApplication;
  let database: Database;
  let config: Configuration;
  const suffix = randomUUID();
  const subjects = ['issuer', 'recipient', 'other'].map((value) => `${value}-${suffix}`);
  const email = `recipient-${suffix}@example.invalid`;
  const workshops: string[] = [];
  const flow = { state: 'test-state', nonce: 'test-nonce', verifier: 'test-verifier', expiresAt: Date.now() + 600000 };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    config = readConfiguration();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleIdentityProvider)
      .useValue({
        begin: () => ({ flow, url: 'https://accounts.google.com/test' }),
        verify: async (code: string) => {
          const index = code === 'issuer' ? 0 : code === 'recipient' ? 1 : 2;
          return { subject: subjects[index], email: index === 1 ? email : `${subjects[index]}@example.invalid`, name: code };
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

  it('links only matching records, permits multiple workshops, and enforces issuer and recipient permissions', async () => {
    const issuer = request.agent(app.getHttpServer());
    await issuer.get('/api/auth/google').expect(302);
    await issuer.get('/api/auth/google/callback?state=test-state&code=issuer').expect(302);
    const issuerUser = (await issuer.get('/api/auth/me').expect(200)).body.user;
    const created = await database.pool.query(
      "INSERT INTO workshops (name) VALUES ('Customer invite A'), ('Customer invite B'), ('Customer invite foreign') RETURNING id",
    );
    workshops.push(...created.rows.map((row: { id: string }) => row.id));
    const [first, second, foreign] = workshops;
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role)
       VALUES ($1, $3, 'manager'), ($2, $3, 'manager'), ($4, $3, 'staff')`,
      [first, second, issuerUser.id, foreign],
    );
    const customers = await database.pool.query(
      `INSERT INTO customers (workshop_id, name, phone, email, kind)
       VALUES ($1, 'Matching', '8095550100', $3, 'person'),
              ($1, 'Other email', '8095550100', 'other@example.invalid', 'person'),
              ($2, 'Other workshop', '8095550100', $3, 'person')
       RETURNING id`, [first, second, email],
    );
    const [matching, wrongEmail, wrongWorkshop] = customers.rows.map((row: { id: string }) => row.id);
    const inviteUrl = (id: string) => `/api/workshops/${id}/customer-invitations`;
    await issuer.post(inviteUrl(foreign)).set('Origin', config.frontendOrigin).send({ email }).expect(403);
    await issuer.post(inviteUrl(first)).set('Origin', 'https://other.invalid').send({ email }).expect(403);
    const issued = await issuer.post(inviteUrl(first)).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    const token = new URL(issued.body.link).hash.slice(1);
    const stored = await database.pool.query('SELECT token_hash, expires_at - created_at AS lifetime FROM customer_invitations WHERE workshop_id = $1', [first]);
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].lifetime.days).toBe(7);
    const other = request.agent(app.getHttpServer());
    await other.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await other.get('/api/auth/google').expect(302);
    await other.get('/api/auth/google/callback?state=test-state&code=other').expect(302);
    await other.get('/api/invitations/pending').expect(403);
    await other.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
      .send({ choice: 'existing', customerId: matching }).expect(403);
    const recipient = request.agent(app.getHttpServer());
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await recipient.get('/api/auth/google/client').expect(302);
    await recipient.get('/api/auth/google/callback?state=test-state&code=recipient')
      .expect(302).expect('Location', `${config.frontendOrigin}/invitacion`);
    const pending = await recipient.get('/api/invitations/pending').expect(200);
    expect(pending.body.candidates).toEqual([{ id: matching, name: 'Matching' }]);
    for (const customerId of [wrongEmail, wrongWorkshop]) {
      await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
        .send({ choice: 'existing', customerId }).expect(403);
    }
    const accepted = await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
      .send({ choice: 'existing', customerId: matching }).expect(201);
    expect(accepted.body).toMatchObject({ kind: 'customer', workshopId: first, customerId: matching });
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).send({}).expect(201);
    const duplicate = await issuer.post(inviteUrl(first)).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: new URL(duplicate.body.link).hash.slice(1) }).expect(201);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
      .send({ choice: 'new', name: 'Duplicate', phone: '8095550100' }).expect(409);
    const another = await issuer.post(inviteUrl(second)).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: new URL(another.body.link).hash.slice(1) }).expect(201);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
      .send({ choice: 'new', name: 'Customer new', phone: '8095550100' }).expect(201);
    const recipientUser = (await recipient.get('/api/auth/me').expect(200)).body.user;
    const links = await database.pool.query('SELECT workshop_id FROM customer_account_links WHERE user_id = $1', [recipientUser.id]);
    expect(links.rowCount).toBe(2);
    await request(app.getHttpServer()).get('/api/client/workshops').expect(401);
    const portal = await recipient.get('/api/client/workshops').expect(200);
    expect(portal.headers['cache-control']).toBe('no-store');
    expect(portal.body.workshops.map((workshop: { id: string }) => workshop.id).sort())
      .toEqual([first, second].sort());
    await other.get('/api/client/workshops').expect(403);
    await issuer.get('/api/client/workshops').expect(403);
    await issuer.get(`/api/client/workshops/${first}/measurements`).expect(404);
    const dualWorkshop = await database.pool.query("INSERT INTO workshops (name) VALUES ('Dual role customer') RETURNING id");
    const dualId = dualWorkshop.rows[0].id as string;
    workshops.push(dualId);
    const dualCustomer = await database.pool.query(
      "INSERT INTO customers (workshop_id, name, phone, kind) VALUES ($1, 'Dual role', '8095550100', 'person') RETURNING id",
      [dualId],
    );
    await database.pool.query('INSERT INTO customer_account_links (customer_id, workshop_id, user_id) VALUES ($1, $2, $3)',
      [dualCustomer.rows[0].id, dualId, issuerUser.id]);
    expect((await issuer.get('/api/client/workshops').expect(200)).body.workshops).toEqual([
      { id: dualId, name: 'Dual role customer' },
    ]);
    expect((await issuer.get(`/api/client/workshops/${dualId}/measurements`).expect(200)).body.versions).toEqual([]);
    await issuer.get(`/api/client/workshops/${first}/measurements`).expect(404);
    await database.pool.query(
      `INSERT INTO customer_measurement_versions (workshop_id, customer_id, garment, version, measurements, verified_by)
       VALUES ($1, $2, 'womens_trousers', 1, '{"waist": 70}', $4),
              ($1, $2, 'womens_trousers', 2, '{"waist": 75}', $4),
              ($1, $3, 'womens_trousers', 1, '{"waist": 99}', $4)`,
      [first, matching, wrongEmail, issuerUser.id],
    );
    const measurementsUrl = `/api/client/workshops/${first}/measurements`;
    await request(app.getHttpServer()).get(measurementsUrl).expect(401);
    await other.get(measurementsUrl).expect(404);
    const measurements = await recipient.get(measurementsUrl).expect(200);
    expect(measurements.headers['cache-control']).toBe('no-store');
    expect(measurements.body.versions).toHaveLength(1);
    expect(measurements.body.versions[0]).toMatchObject({
      garment: 'womens_trousers', version: 2, measurements: { waist: 75 },
    });
    expect((await recipient.get(`/api/client/workshops/${second}/measurements`).expect(200)).body.versions).toEqual([]);
    await recipient.get(`/api/client/workshops/${foreign}/measurements`).expect(404);
    const draftUrl = `/api/client/workshops/${first}/measurement-drafts/womens_trousers`;
    await other.get(draftUrl).expect(404);
    await request(app.getHttpServer()).get(draftUrl).expect(401);
    const emptyDraft = await recipient.get(draftUrl).expect(200);
    expect(emptyDraft.body).toMatchObject({ revision: 0, measurements: {} });
    await recipient.put(draftUrl).set('Origin', 'https://other.invalid')
      .send({ revision: 0, measurements: { waist: 75 } }).expect(403);
    await recipient.put(draftUrl).set('Origin', config.frontendOrigin)
      .send({ revision: 0, measurements: { unknown: 75 } }).expect(400);
    await recipient.put(draftUrl).set('Origin', config.frontendOrigin)
      .send({ revision: 0, measurements: { waist: -1 } }).expect(400);
    const drafts = await Promise.all([70, 75].map((waist) =>
      recipient.put(draftUrl).set('Origin', config.frontendOrigin).send({ revision: 0, measurements: { waist } })));
    expect(drafts.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const savedDraft = await recipient.get(draftUrl).expect(200);
    expect(savedDraft.body.revision).toBe(1);
    expect([70, 75]).toContain(savedDraft.body.measurements.waist);
    const overview = await recipient.get(measurementsUrl).expect(200);
    expect(overview.body.drafts).toEqual([expect.objectContaining({ garment: 'womens_trousers' })]);
    expect(overview.body.versions[0].measurements).toEqual({ waist: 75 });
    await issuer.get(draftUrl).expect(404);
    const submitUrl = `${draftUrl}/submit`;
    await other.post(submitUrl).set('Origin', config.frontendOrigin).send({ revision: 1, confirmed: true }).expect(404);
    await recipient.post(submitUrl).set('Origin', 'https://other.invalid').send({ revision: 1, confirmed: true }).expect(403);
    await recipient.post(submitUrl).set('Origin', config.frontendOrigin).send({ revision: 1 }).expect(400);
    await recipient.post(submitUrl).set('Origin', config.frontendOrigin).send({ revision: 1, confirmed: true }).expect(400);
    const values = { waist: 72.5, hip: 98, totalLength: 102, kneeWidth: 22, hemWidth: 20, rise: 29 };
    await recipient.put(draftUrl).set('Origin', config.frontendOrigin)
      .send({ revision: 1, measurements: values }).expect(200);
    const submit = () => recipient.post(submitUrl).set('Origin', config.frontendOrigin).send({ revision: 2, confirmed: true });
    const [submitted, repeated] = await Promise.all([submit(), submit()]);
    expect(submitted.status).toBe(201);
    expect(repeated.body.id).toBe(submitted.body.id);
    const submissionId = submitted.body.id as string;
    const receiptUrl = `/api/client/workshops/${first}/measurement-submissions/${submissionId}`;
    await other.get(receiptUrl).expect(404);
    expect((await recipient.get(receiptUrl).expect(200)).body).toMatchObject({ verified: false, measurements: values });
    await recipient.put(draftUrl).set('Origin', config.frontendOrigin)
      .send({ revision: 2, measurements: { ...values, waist: 74 } }).expect(200);
    await recipient.post(submitUrl).set('Origin', config.frontendOrigin).send({ revision: 3, confirmed: true }).expect(409);
    const staffUrl = `/api/workshops/${first}/customers/${matching}/measurement-submissions`;
    const pendingSubmission = await issuer.get(`${staffUrl}?garment=womens_trousers`).expect(200);
    expect(pendingSubmission.body.submission).toMatchObject({ id: submissionId, measurements: values });
    await recipient.get(`${staffUrl}?garment=womens_trousers`).expect(403);
    await recipient.post(`${staffUrl}/${submissionId}/verify`).set('Origin', config.frontendOrigin)
      .send({ garment: 'womens_trousers', measurements: values, confirmed: true }).expect(404);
    const verify = () => issuer.post(`${staffUrl}/${submissionId}/verify`).set('Origin', config.frontendOrigin)
      .send({ garment: 'womens_trousers', measurements: { ...values, waist: 73 }, confirmed: true });
    const reviewed = await Promise.all([verify(), verify()]);
    expect(reviewed.map((response) => response.status)).toEqual([201, 201]);
    expect(reviewed[0].body).toEqual(reviewed[1].body);
    expect(reviewed[0].body.version).toBe(3);
    await issuer.post(`${staffUrl}/${submissionId}/verify`).set('Origin', config.frontendOrigin)
      .send({ garment: 'womens_trousers', measurements: values, confirmed: true }).expect(409);
    expect((await recipient.get(receiptUrl).expect(200)).body).toMatchObject({ verified: true, measurements: values });
    expect((await issuer.get(`${staffUrl}?garment=womens_trousers`).expect(200)).body.submission).toBeNull();
    expect((await recipient.get(measurementsUrl).expect(200)).body.versions[0].measurements.waist).toBe(73);
    await database.pool.query('DELETE FROM customer_account_links WHERE customer_id = $1', [matching]);
    await recipient.get(measurementsUrl).expect(404);
    await recipient.get(draftUrl).expect(404);
    await recipient.get(receiptUrl).expect(404);
    expect((await database.pool.query('SELECT 1 FROM client_measurement_drafts WHERE customer_id = $1', [matching])).rowCount).toBe(0);
    expect((await recipient.get('/api/client/workshops').expect(200)).body.workshops).toEqual([
      { id: second, name: 'Customer invite B' },
    ]);
    await database.pool.query('DELETE FROM customer_account_links WHERE user_id = $1 AND workshop_id = $2', [recipientUser.id, second]);
    await recipient.get('/api/client/workshops').expect(403);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin).send({ token }).expect(201);
    await recipient.get('/api/invitations/pending').expect(403);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin).send({}).expect(403);
    const revoked = await issuer.post(inviteUrl(second)).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: new URL(revoked.body.link).hash.slice(1) }).expect(201);
    await database.pool.query("UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2", [second, issuerUser.id]);
    await recipient.get('/api/invitations/pending').expect(403);
    await recipient.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
      .send({ choice: 'new', name: 'Customer', phone: '8095550100' }).expect(403);
    await database.pool.query("UPDATE customer_invitations SET expires_at = now() - interval '1 second' WHERE workshop_id = $1", [second]);
    await recipient.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
      .send({ token: new URL(revoked.body.link).hash.slice(1) }).expect(400);
  });

  it('prevents concurrent invitations from creating two links in the same workshop', async () => {
    const issuer = request.agent(app.getHttpServer());
    await issuer.get('/api/auth/google').expect(302);
    await issuer.get('/api/auth/google/callback?state=test-state&code=issuer').expect(302);
    const issuerUser = (await issuer.get('/api/auth/me').expect(200)).body.user;
    const created = await database.pool.query("INSERT INTO workshops (name) VALUES ('Concurrent customer invite') RETURNING id");
    const workshopId = created.rows[0].id as string;
    workshops.push(workshopId);
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'manager')",
      [workshopId, issuerUser.id],
    );
    const url = `/api/workshops/${workshopId}/customer-invitations`;
    const first = await issuer.post(url).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    const second = await issuer.post(url).set('Origin', config.frontendOrigin).send({ email }).expect(201);
    const recipients = [request.agent(app.getHttpServer()), request.agent(app.getHttpServer())];
    for (const [index, browser] of recipients.entries()) {
      const link = index === 0 ? first.body.link : second.body.link;
      await browser.post('/api/invitations/stage').set('Origin', config.frontendOrigin)
        .send({ token: new URL(link).hash.slice(1) }).expect(201);
      await browser.get('/api/auth/google').expect(302);
      await browser.get('/api/auth/google/callback?state=test-state&code=recipient').expect(302);
    }
    const responses = await Promise.all(recipients.map((browser) =>
      browser.post('/api/invitations/accept').set('Origin', config.frontendOrigin)
        .send({ choice: 'new', name: 'Concurrent customer', phone: '8095550100' })));
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    const links = await database.pool.query('SELECT 1 FROM customer_account_links WHERE workshop_id = $1', [workshopId]);
    const customers = await database.pool.query('SELECT 1 FROM customers WHERE workshop_id = $1', [workshopId]);
    expect(links.rowCount).toBe(1);
    expect(customers.rowCount).toBe(1);
  });
});
