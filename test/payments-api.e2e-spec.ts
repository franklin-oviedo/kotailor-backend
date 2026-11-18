import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { GoogleIdentityProvider } from '../src/auth/google-identity.js';
import { CONFIGURATION, type Configuration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { configureHttp } from '../src/http.js';
import { pdfText } from './pdf-text.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Payment HTTP endpoints', () => {
  let app: NestExpressApplication;
  let database: Database;
  let config: Configuration;
  let workshopId: string;
  const subject = `payments-http-${randomUUID()}`;
  const flow = { state: 'test-state', nonce: 'test-nonce', verifier: 'test-verifier', expiresAt: Date.now() + 600000 };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleIdentityProvider).useValue({
        begin: () => ({ flow, url: 'https://accounts.google.com/test' }),
        verify: async () => ({ subject, email: `${subject}@example.invalid`, name: 'Test' }),
      }).compile();
    config = module.get<Configuration>(CONFIGURATION);
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, config);
    database = app.get(Database);
    await app.init();
  });

  afterAll(async () => {
    if (database) {
      if (workshopId) {
        await database.pool.query('DELETE FROM order_payments WHERE workshop_id = $1', [workshopId]);
        await database.pool.query('DELETE FROM workshops WHERE id = $1', [workshopId]);
      }
      await database.pool.query(
        `DELETE FROM sessions WHERE sess->>'userId' IN
         (SELECT id::text FROM app_users WHERE google_subject = $1)`, [subject],
      );
      await database.pool.query('DELETE FROM app_users WHERE google_subject = $1', [subject]);
    }
    if (app) await app.close();
  });

  it('requires a session and origin and persists an idempotent payment', async () => {
    const [{ today }] = (await database.pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'America/Santo_Domingo')::date::text AS today`,
    )).rows;
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test').expect(302);
    const me = await browser.get('/api/auth/me').expect(200);
    workshopId = (await database.pool.query<{ id: string }>(
      "INSERT INTO workshops (name) VALUES ('Payment HTTP test') RETURNING id",
    )).rows[0].id;
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workshopId, me.body.user.id],
    );
    const customer = (await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind) VALUES ($1, 'Synthetic', '8095550100', 'person') RETURNING id`,
      [workshopId],
    )).rows[0].id;
    const order = (await database.pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
       (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
        subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 1, $2, 'Synthetic', 'Test', '', 'exempt', 10000, 0, 0, '[]', '2030-01-01', $3) RETURNING id`,
      [workshopId, customer, me.body.user.id],
    )).rows[0].id;
    const url = `/api/workshops/${workshopId}/orders/${order}/payments`;
    const orderReceivablesUrl = `/api/workshops/${workshopId}/payments/order-receivables`;
    const availableOrders = async () => (await browser.get(orderReceivablesUrl)
      .expect(200).expect('Cache-Control', 'no-store')).body.orders;
    await request(app.getHttpServer()).get(orderReceivablesUrl).expect(401);
    expect(await availableOrders()).toEqual([{ id: order, number: 1, customerName: 'Synthetic', catalogName: 'Test' }]);
    const input = {
      kind: 'payment', method: 'transfer', amountCents: 5000, reference: 'TRX-TEST-0248', requestId: randomUUID(),
    };
    await request(app.getHttpServer()).get(url).expect(401);
    await browser.post(url).send(input).expect(403);
    const first = await browser.post(url).set('Origin', config.frontendOrigin).send(input).expect(201);
    const retry = await browser.post(url).set('Origin', config.frontendOrigin).send(input).expect(201);
    expect(retry.body.id).toBe(first.body.id);
    const ledger = await browser.get(url).expect(200).expect('Cache-Control', 'no-store');
    expect(ledger.body.paidCents).toBe(5000);
    expect(ledger.body.payments).toHaveLength(1);
    expect(ledger.body.payments[0].reference).toBe('TRX-TEST-0248');
    const receiptUrl = `/api/workshops/${workshopId}/payments/${first.body.id}/ticket`;
    await request(app.getHttpServer()).get(receiptUrl).expect(401);
    await browser.get(receiptUrl.replace(workshopId, randomUUID())).expect(404);
    const receipt = await browser.get(receiptUrl).expect(200).expect('Content-Type', /text\/html/).expect('Cache-Control', 'no-store');
    expect(receipt.text).toContain('Recibo de pago');
    expect(receipt.text).toContain('OT-0001');
    expect(receipt.text).toContain('TRX-TEST-0248');
    expect(receipt.text).not.toContain('Logo de la sastrería');
    const dashboardUrl = `/api/workshops/${workshopId}/payments/dashboard`;
    expect((await browser.get(dashboardUrl).expect(200)).body).toMatchObject({
      collectedMonthCents: 5000, movements: [], pagination: { total: 0 },
    });

    const invoiceUrl = `/api/workshops/${workshopId}/invoices`;
    const invoiceInput = {
      source: 'order', orderId: order, requestId: randomUUID(), issueDate: today,
      dueDate: null, terms: '', notes: '',
    };
    await browser.post(invoiceUrl).send(invoiceInput).expect(403);
    const invoice = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
      .send(invoiceInput).expect(201);
    expect(await availableOrders()).toEqual([]);
    const detail = await browser.get(`${invoiceUrl}/${invoice.body.id}`).expect(200);
    expect(detail.body.paidCents).toBe(5000);
    expect(detail.body.orderNumber).toBe(1);
    await browser.put(`${invoiceUrl}/${invoice.body.id}`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1, hasTax: true, dueDate: null, terms: '', notes: '' }).expect(409);
    await browser.post(`${invoiceUrl}/${invoice.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(201);
    const linkedSearch = await browser.get(invoiceUrl).query({ search: 'ot-0001', status: 'partial' }).expect(200);
    expect(linkedSearch.body.pagination.total).toBe(1);
    expect(linkedSearch.body.invoices).toEqual([
      expect.objectContaining({ id: invoice.body.id, number: invoice.body.number, orderNumber: 1 }),
    ]);
    expect(await availableOrders()).toEqual([expect.objectContaining({ id: order })]);
    await browser.get(`${invoiceUrl}/${invoice.body.id}/pdf`)
      .expect(200).expect('Content-Type', /application\/pdf/);
    const dashboard = await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200);
    expect(dashboard.body.collectedMonthCents).toBe(5000);
    expect(dashboard.body.outstandingCents).toBe(5000);
    expect(dashboard.body.movements[0].reference).toBe('TRX-TEST-0248');
    const invoiceReference = `FA-${String(invoice.body.number).padStart(6, '0')}`;
    expect((await browser.get(dashboardUrl).query({ search: invoiceReference }).expect(200)).body).toMatchObject({
      movements: [expect.objectContaining({ id: first.body.id, invoiceNumber: invoice.body.number, orderNumber: 1 })],
      pagination: { total: 1 },
    });

    const voidUrl = `${invoiceUrl}/${invoice.body.id}/void`;
    await browser.post(voidUrl).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 2, reason: 'Prueba de anulación' }).expect(409);
    await browser.post(`${invoiceUrl}/${invoice.body.id}/payments`).set('Origin', config.frontendOrigin)
      .send({
        kind: 'refund', method: 'transfer', amountCents: 5000, reference: 'TRX-REFUND-0248',
        originalPaymentId: first.body.id, reason: 'Reverso de prueba', requestId: randomUUID(),
      }).expect(201);
    expect(await availableOrders()).toEqual([expect.objectContaining({ id: order })]);
    await browser.post(voidUrl).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 2, reason: 'Prueba de anulación' }).expect(201);
    expect(await availableOrders()).toEqual([expect.objectContaining({ id: order })]);

    const replacement = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
      .send({ ...invoiceInput, requestId: randomUUID() }).expect(201);
    await browser.post(`${invoiceUrl}/${replacement.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(201);
    await browser.post(`${invoiceUrl}/${replacement.body.id}/payments`).set('Origin', config.frontendOrigin)
      .send({
        kind: 'payment', method: 'cash', amountCents: 10000, reference: 'REC-REISSUE-0248',
        requestId: randomUUID(),
      }).expect(201);
    const reconciledDashboard = await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200);
    expect(reconciledDashboard.body.collectedMonthCents).toBe(10000);
    expect(reconciledDashboard.body.outstandingCents).toBe(0);

    const settingsUrl = `/api/workshops/${workshopId}/order-settings`;
    const profileUrl = `/api/workshops/${workshopId}/billing-profile`;
    await browser.put(settingsUrl).send({ itbisBasisPoints: 1625 }).expect(403);
    await browser.put(settingsUrl).set('Origin', config.frontendOrigin)
      .send({ itbisBasisPoints: 1625 }).expect(200, { itbisBasisPoints: 1625 });
    expect((await browser.get(profileUrl).expect(200)).body.itbisBasisPoints).toBe(1625);
    await browser.put(settingsUrl).set('Origin', config.frontendOrigin)
      .send({ itbisBasisPoints: null }).expect(200, { itbisBasisPoints: null });
    expect((await browser.get(profileUrl).expect(200)).body.itbisBasisPoints).toBeNull();

    const manual = {
      source: 'manual', customerId: customer, issueDate: today,
      dueDate: null, terms: '', notes: '',
    };
    const line = { description: 'Concepto de prueba', quantityMilli: 1000, unitPriceCents: 5000, discountCents: 0 };
    const draftWithoutRate = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
      .send({ ...manual, requestId: randomUUID(), lines: [{ ...line, taxTreatment: 'taxable' }] }).expect(201);
    await browser.post(`${invoiceUrl}/${draftWithoutRate.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(409);

    const preferenceUrl = `/api/workshops/${workshopId}/invoice-tax-settings`;
    const withoutTax = { ...manual, hasTax: false, requestId: randomUUID(), lines: [line] };
    expect((await browser.get(profileUrl).expect(200)).body.allowInvoicesWithoutTax).toBe(false);
    await browser.post(invoiceUrl).set('Origin', config.frontendOrigin).send(withoutTax).expect(409);
    await browser.put(preferenceUrl).send({ allowInvoicesWithoutTax: true }).expect(403);
    await database.pool.query(`UPDATE workshop_memberships SET role = 'manager' WHERE workshop_id = $1 AND user_id = $2`,
      [workshopId, me.body.user.id]);
    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin)
      .send({ allowInvoicesWithoutTax: true }).expect(403);
    await database.pool.query(`UPDATE workshop_memberships SET role = 'owner' WHERE workshop_id = $1 AND user_id = $2`,
      [workshopId, me.body.user.id]);
    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin)
      .send({ allowInvoicesWithoutTax: true }).expect(200, { allowInvoicesWithoutTax: true });
    const exempt = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin).send(withoutTax).expect(201);
    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin).send({ allowInvoicesWithoutTax: false }).expect(200);
    await browser.post(`${invoiceUrl}/${exempt.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(409);
    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin).send({ allowInvoicesWithoutTax: true }).expect(200);
    await browser.post(`${invoiceUrl}/${exempt.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(201);
    const issued = await browser.get(`${invoiceUrl}/${exempt.body.id}`).expect(200);
    expect(issued.body).toMatchObject({ status: 'issued', hasTax: false, taxBasisPoints: 0, subtotalCents: 5000, taxCents: 0, totalCents: 5000 });
    expect(issued.body.revisions[0]).toMatchObject({ kind: 'issued', changedBy: me.body.user.id, snapshot: { hasTax: false, taxBasisPoints: 0 } });
    const pdf = await browser.get(`${invoiceUrl}/${exempt.body.id}/pdf`).expect(200)
      .expect('Content-Type', /application\/pdf/).expect('Content-Disposition', /^attachment;/);
    expect(Buffer.isBuffer(pdf.body)).toBe(true);
    const document = pdfText(Buffer.from(pdf.body));
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
    expect(document).toContain('NO CONSTITUYE UN COMPROBANTE FISCAL AUTORIZADO POR LA DGII');
    expect(document).toContain('Factura sin ITBIS');
    expect(document).not.toContain('ITBIS:');

    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin).send({ allowInvoicesWithoutTax: false }).expect(200);
    await browser.put(settingsUrl).set('Origin', config.frontendOrigin).send({ itbisBasisPoints: 1800 }).expect(200);
    await browser.put(`${invoiceUrl}/${draftWithoutRate.body.id}`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1, hasTax: true, dueDate: null, terms: '', notes: '', lines: [line] }).expect(200);
    await browser.post(`${invoiceUrl}/${draftWithoutRate.body.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 2 }).expect(201);
    const taxed = await browser.get(`${invoiceUrl}/${draftWithoutRate.body.id}`).expect(200);
    expect(taxed.body).toMatchObject({ hasTax: true, taxBasisPoints: 1800, taxCents: 900, totalCents: 5900 });
    const taxedPdf = await browser.get(`${invoiceUrl}/${draftWithoutRate.body.id}/pdf`).expect(200);
    expect(pdfText(Buffer.from(taxedPdf.body))).toContain('ITBIS:');
    await browser.get(`${invoiceUrl}/${draftWithoutRate.body.id}/pdf?preview=true`)
      .expect('Content-Disposition', /^inline;/).expect(200);
    expect((await browser.get(`${invoiceUrl}/${exempt.body.id}`).expect(200)).body.hasTax).toBe(false);
    const report = await browser.get(`/api/workshops/${workshopId}/reports/executive`)
      .query({ from: today, to: today, customerId: customer }).expect(200);
    const breakdown = {
      invoicedWithTaxCents: 5900, invoicedWithoutTaxCents: 15000, invoicesWithTax: 1, invoicesWithoutTax: 2,
    };
    expect(report.body.summary).toMatchObject(breakdown);
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject(breakdown);
    const otherOrders = await database.pool.query<{ id: string; number: number }>(
      `INSERT INTO workshop_orders
         (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
          subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 2, $2, 'Synthetic', 'Pending tax', '', 'taxable', 25000, NULL, NULL, '[]', '2030-01-01', $3),
              ($1, 3, $2, 'Synthetic', 'Known total', '', 'exempt', 11000, 0, 0, '[]', '2030-01-01', $3)
       RETURNING id, number`, [workshopId, customer, me.body.user.id],
    );
    const knownOrder = otherOrders.rows.find(({ number }) => number === 3)!;
    const unbilledSearch = await browser.get(invoiceUrl).query({ search: 'OT-0003' }).expect(200);
    expect(unbilledSearch.body.invoices).toEqual([]);
    expect(await availableOrders()).toEqual([expect.objectContaining({ id: knownOrder.id })]);
    await browser.post(`/api/workshops/${workshopId}/orders/${knownOrder.id}/payments`)
      .set('Origin', config.frontendOrigin)
      .send({ kind: 'payment', method: 'cash', amountCents: 2000, requestId: randomUUID() }).expect(201);
    expect((await browser.get(url).expect(200)).body).not.toHaveProperty('customerBalance');
    const pendingOrder = otherOrders.rows.find(({ number }) => number === 2)!;
    const pendingLedgerUrl = `/api/workshops/${workshopId}/orders/${pendingOrder.id}/payments`;
    const pendingDraft = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
      .send({ ...invoiceInput, orderId: pendingOrder.id, requestId: randomUUID() }).expect(201);
    const aggregate = { outstandingCents: 44900, hasPendingTax: true };
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject({
      ...aggregate,
      outstandingByTax: {
        withTax: { amountCents: 5900, count: 1 },
        withoutTax: { amountCents: 14000, count: 2 },
        pendingTax: { amountCents: 25000, count: 1 },
      },
    });
    expect((await browser.get(url).query({ includeCustomerBalance: true }).expect(200)).body).toMatchObject({
      totalCents: 10000, paidCents: 10000, customerBalance: aggregate,
    });
    expect((await browser.get(pendingLedgerUrl).query({ includeCustomerBalance: true }).expect(200)).body).toMatchObject({
      totalCents: null, paidCents: 0, customerBalance: aggregate,
    });

    const batchUrl = `/api/workshops/${workshopId}/orders/apply-pending-itbis`;
    const applyTax = (rate: number) => browser.post(batchUrl).set('Origin', config.frontendOrigin)
      .send({ itbisBasisPoints: rate });
    await browser.post(batchUrl).send({ itbisBasisPoints: 1800 }).expect(403);
    await applyTax(1625).expect(409);
    await database.pool.query(`UPDATE workshop_memberships SET role = 'manager' WHERE workshop_id = $1 AND user_id = $2`,
      [workshopId, me.body.user.id]);
    await applyTax(1800).expect(403);
    await database.pool.query(`UPDATE workshop_memberships SET role = 'owner' WHERE workshop_id = $1 AND user_id = $2`,
      [workshopId, me.body.user.id]);
    const bareOrder = await database.pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
         (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
          subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 4, $2, 'Synthetic', 'Pending without draft', '', 'taxable', 525, NULL, NULL, '[]', '2030-01-01', $3)
       RETURNING id`, [workshopId, customer, me.body.user.id],
    );
    await applyTax(1800).expect(201, { updatedOrders: 2, updatedDrafts: 1 });
    await applyTax(1800).expect(201, { updatedOrders: 0, updatedDrafts: 0 });
    const draftUrl = `${invoiceUrl}/${pendingDraft.body.id}`;
    const updatedDraft = await browser.get(draftUrl).expect(200);
    expect(updatedDraft.body).toMatchObject({
      status: 'draft', version: 2, hasTax: true, taxBasisPoints: 1800, taxCents: 4500, totalCents: 29500,
      lines: [{ taxBasisPoints: 1800, taxCents: 4500 }],
    });
    expect(updatedDraft.body.revisions[0]).toMatchObject({
      kind: 'updated', changedBy: me.body.user.id, snapshot: { taxBasisPoints: 1800, taxCents: 4500 },
    });
    const orderUrl = `/api/workshops/${workshopId}/orders`;
    expect((await browser.get(`${orderUrl}/${bareOrder.rows[0].id}`).expect(200)).body)
      .toMatchObject({ taxBasisPoints: 1800, taxCents: 95 });
    expect((await browser.get(`${orderUrl}/${knownOrder.id}`).expect(200)).body)
      .toMatchObject({ taxTreatment: 'exempt', taxBasisPoints: 0, taxCents: 0 });
    const recalculated = { outstandingCents: 50020, hasPendingTax: false };
    expect((await browser.get(pendingLedgerUrl).query({ includeCustomerBalance: true }).expect(200)).body).toMatchObject({
      totalCents: 29500, customerBalance: recalculated,
    });
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject(recalculated);
    await browser.post(`${draftUrl}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(409);
    await browser.post(`${draftUrl}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 2 }).expect(201);
    const unissued = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
      .send({ ...manual, requestId: randomUUID(), lines: [line] }).expect(201);
    const manualReceivablesUrl = `/api/workshops/${workshopId}/payments/manual-receivables`;
    await request(app.getHttpServer()).get(manualReceivablesUrl).expect(401);
    const manualReceivables = await browser.get(manualReceivablesUrl).expect(200);
    expect(manualReceivables.body.invoices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: exempt.body.id, number: exempt.body.number, customerName: 'Synthetic' }),
    ]));
    const availableIds = manualReceivables.body.invoices.map(({ id }: { id: string }) => id);
    expect(availableIds).not.toContain(unissued.body.id);
    expect(availableIds).not.toContain(pendingDraft.body.id);
    const manualLedger = `${invoiceUrl}/${exempt.body.id}/payments`;
    expect((await browser.get(manualLedger).query({ includeCustomerBalance: true }).expect(200)).body)
      .toMatchObject({ totalCents: 5000, paidCents: 0, customerBalance: recalculated });
    await browser.post(manualLedger).set('Origin', config.frontendOrigin)
      .send({ kind: 'payment', method: 'cash', amountCents: 5000, requestId: randomUUID() }).expect(201);
    const afterManualPayment = await browser.get(manualReceivablesUrl).expect(200);
    expect(afterManualPayment.body.invoices.map(({ id }: { id: string }) => id)).not.toContain(exempt.body.id);
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject({
      outstandingCents: 45020, movements: expect.arrayContaining([
        expect.objectContaining({ invoiceNumber: exempt.body.number, orderId: null, amountCents: 5000 }),
      ]),
    });
    const mixed = (await browser.get(dashboardUrl).expect(200)).body;
    expect(mixed.movements).not.toContainEqual(expect.objectContaining({ orderId: knownOrder.id }));
    expect(mixed.movements).toContainEqual(expect.objectContaining({ kind: 'refund', invoiceNumber: invoice.body.number }));
    await browser.post(`${invoiceUrl}/${draftWithoutRate.body.id}/payments`).set('Origin', config.frontendOrigin)
      .send({ kind: 'payment', method: 'cash', amountCents: 1000, requestId: randomUUID() }).expect(201);
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject({
      outstandingCents: 44020,
      outstandingByTax: {
        withTax: { amountCents: 35020, count: 3 },
        withoutTax: { amountCents: 9000, count: 1 },
        pendingTax: { amountCents: 0, count: 0 },
      },
      collectedTodayCents: 18000,
      collectedTodayByTax: {
        withTax: { amountCents: 1000, count: 1 },
        withoutTax: { amountCents: 17000, count: 5 },
        pendingTax: { amountCents: 0, count: 0 },
      },
      ...breakdown, invoicedWithTaxCents: 35400, invoicesWithTax: 2,
    });

    const reportUrl = `/api/workshops/${workshopId}/reports/executive`;
    const reportFilters = { from: today, to: today, customerId: customer };
    const baseline = (await browser.get(reportUrl).query(reportFilters).expect(200)).body.summary;
    await browser.put(preferenceUrl).set('Origin', config.frontendOrigin)
      .send({ allowInvoicesWithoutTax: true }).expect(200);
    const createIssued = async () => {
      const { body } = await browser.post(invoiceUrl).set('Origin', config.frontendOrigin)
        .send({ ...withoutTax, requestId: randomUUID(), lines: [{ ...line, unitPriceCents: 1_000_000 }] }).expect(201);
      await browser.post(`${invoiceUrl}/${body.id}/issue`).set('Origin', config.frontendOrigin)
        .send({ expectedVersion: 1 }).expect(201);
      return { id: String(body.id), number: Number(body.number) };
    };
    const installments = await createIssued();
    const onePayment = await createIssued();
    const assertCollection = async (
      invoice: typeof installments, displayStatus: string, paidCents: number, balanceCents: number,
    ) => {
      const expected = { status: 'issued', displayStatus, paidCents, balanceCents };
      const detailUrl = `${invoiceUrl}/${invoice.id}`;
      expect((await browser.get(detailUrl).expect(200)).body).toMatchObject(expected);
      const search = `FA-${String(invoice.number).padStart(6, '0')}`;
      const { body } = await browser.get(invoiceUrl).query({ search, status: displayStatus, pageSize: 10 }).expect(200);
      expect(body.pagination.total).toBe(1);
      expect(body.invoices).toEqual([expect.objectContaining({ id: invoice.id, ...expected })]);
      const excludedStatus = displayStatus === 'paid' ? 'partial' : 'paid';
      expect((await browser.get(invoiceUrl).query({ search, status: excludedStatus }).expect(200)).body.pagination.total).toBe(0);
    };
    const pay = (id: string, amountCents: number) => browser.post(`${invoiceUrl}/${id}/payments`)
      .set('Origin', config.frontendOrigin)
      .send({ kind: 'payment', method: 'cash', amountCents, requestId: randomUUID() }).expect(201);
    await assertCollection(installments, 'issued', 0, 1_000_000);
    const advance = await pay(installments.id, 400_000);
    await assertCollection(installments, 'partial', 400_000, 600_000);
    const thermal = await browser.get(`${invoiceUrl}/${installments.id}/ticket`).expect(200)
      .expect('Content-Type', /text\/html/).expect('Content-Security-Policy', /script-src 'sha256-/);
    expect(thermal.text).toContain('PAGO PARCIAL');
    expect(thermal.text).toContain('Monto pagado');
    expect(thermal.text).toContain('Monto pendiente');
    expect(thermal.text).not.toContain('<dt>ITBIS</dt>');
    expect(thermal.text).toContain('Código QR');
    expect((await browser.get(`/api/workshops/${workshopId}/payments/${advance.body.id}/ticket`).expect(200)).text)
      .toContain(`FA-${String(installments.number).padStart(6, '0')}`);
    expect((await browser.get(reportUrl).query(reportFilters).expect(200)).body.summary).toMatchObject({
      invoicesUnpaid: baseline.invoicesUnpaid + 1, invoicesPartial: baseline.invoicesPartial + 1,
      invoicesPaid: baseline.invoicesPaid, invoiceOutstandingCents: baseline.invoiceOutstandingCents + 1_600_000,
    });
    await pay(onePayment.id, 1_000_000);
    await assertCollection(onePayment, 'paid', 1_000_000, 0);
    await pay(installments.id, 600_000);
    await assertCollection(installments, 'paid', 1_000_000, 0);
    const settled = {
      invoicesUnpaid: baseline.invoicesUnpaid, invoicesPartial: baseline.invoicesPartial, invoicesPaid: baseline.invoicesPaid + 2,
    };
    expect((await browser.get(reportUrl).query(reportFilters).expect(200)).body.summary)
      .toMatchObject({ ...settled, invoiceOutstandingCents: baseline.invoiceOutstandingCents });
    expect((await browser.get(`/api/workshops/${workshopId}/payments/dashboard`).expect(200)).body).toMatchObject(settled);
    expect(pdfText(Buffer.from((await browser.get(`${invoiceUrl}/${installments.id}/pdf`).expect(200)).body)))
      .toContain('Estado: Pagada');
    await browser.post(`${invoiceUrl}/${installments.id}/payments`).set('Origin', config.frontendOrigin)
      .send({ kind: 'refund', method: 'cash', amountCents: 400_000, originalPaymentId: advance.body.id,
        reason: 'Devolución de prueba', requestId: randomUUID() }).expect(201);
    await assertCollection(installments, 'partial', 600_000, 400_000);
    await browser.get(invoiceUrl).query({ status: 'invalid' }).expect(400);
  }, 15_000);

  it('persists the complete fiscal form atomically and snapshots its current identity only on issuance', async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.get('/api/auth/google').expect(302);
    await browser.get('/api/auth/google/callback?state=test-state&code=test').expect(302);
    const profileUrl = `/api/workshops/${workshopId}/billing-profile`;
    const invoicesUrl = `/api/workshops/${workshopId}/invoices`;
    const original = {
      legalName: 'Empresa Fiscal Original', tradeName: 'Marca Fiscal Original', rnc: '123456789',
      fiscalAddress: 'Calle Fiscal 10', phone: '+1 (809) 555-0100', email: 'fiscal@example.invalid',
    };
    const existing = (await database.pool.query(
      `SELECT id, workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE workshop_id = $1 AND status = 'issued' ORDER BY id`, [workshopId],
    )).rows;
    await request(app.getHttpServer()).put(profileUrl).send(original).expect(401);
    await browser.put(profileUrl).send(original).expect(403);
    await browser.put(profileUrl).set('Origin', config.frontendOrigin).send(original).expect(200);
    const customerId = (await database.pool.query<{ id: string }>(
      'SELECT id FROM customers WHERE workshop_id = $1 LIMIT 1', [workshopId],
    )).rows[0].id;
    const draft = (await browser.post(invoicesUrl).set('Origin', config.frontendOrigin).send({
      source: 'manual', customerId, requestId: randomUUID(), issueDate: '2030-01-03',
      dueDate: null, terms: '', notes: '',
      lines: [{ description: 'Servicio fiscal', quantityMilli: 1000, unitPriceCents: 5000, discountCents: 0 }],
    }).expect(201)).body;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9Wf1sAAAAASUVORK5CYII=', 'base64');
    const padded = Buffer.concat([png, Buffer.alloc(61440 - png.length)]);
    const asset = `data:image/png;base64,${padded.toString('base64')}`;
    const complete = { ...original, tradeName: 'Marca Vigente', logoDataUrl: asset, sealDataUrl: asset };
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeGreaterThan(100 * 1024);
    const saved = await browser.put(profileUrl).set('Origin', config.frontendOrigin).send(complete).expect(200);
    expect(saved.body).toMatchObject({ ...complete, workshopName: complete.tradeName });
    expect((await browser.get('/api/auth/me').expect(200)).body.workshops)
      .toContainEqual(expect.objectContaining({ id: workshopId, name: complete.tradeName }));
    if (existing.length) {
      const historical = (await browser.get(`${invoicesUrl}/${existing[0].id}`).expect(200)).body;
      expect(historical.fiscalDataMissing).toContain('RNC');
      expect(historical.workshop.rnc).toBeNull();
    }
    expect((await browser.get(profileUrl).expect(200).expect('Cache-Control', 'no-store')).body).toMatchObject(complete);
    const freshSession = request.agent(app.getHttpServer());
    await freshSession.get('/api/auth/google').expect(302);
    await freshSession.get('/api/auth/google/callback?state=test-state&code=test').expect(302);
    expect((await freshSession.get(profileUrl).expect(200)).body).toMatchObject(complete);
    for (const invalid of [
      { ...original, rnc: '12345678' }, { ...original, rnc: '123456789012' },
      { ...original, email: 'correo-invalido' }, { ...original, phone: '123' },
      { ...original, tradeName: '   ' },
      { ...original, tradeName: 'Cambio que no debe guardarse',
        logoDataUrl: `data:image/png;base64,${Buffer.concat([padded, Buffer.alloc(1)]).toString('base64')}` },
      { logoDataUrl: `data:image/png;base64,${Buffer.concat([padded, Buffer.alloc(1)]).toString('base64')}` },
      { sealDataUrl: 'data:image/gif;base64,R0lGODlh' },
    ]) {
      await browser.put(profileUrl).set('Origin', config.frontendOrigin).send(invalid).expect(400);
    }
    expect((await browser.get(profileUrl).expect(200)).body).toMatchObject(complete);
    await browser.post(`${invoicesUrl}/${draft.id}/issue`).set('Origin', config.frontendOrigin)
      .send({ expectedVersion: 1 }).expect(201);
    const detail = (await browser.get(`${invoicesUrl}/${draft.id}`).expect(200)).body;
    expect(detail.fiscalDataMissing).toEqual([]);
    expect(detail.workshop).toMatchObject({ ...original, tradeName: 'Marca Vigente', workshopName: 'Marca Vigente' });
    expect(detail.revisions[0]).toMatchObject({
      kind: 'issued', snapshot: { workshop: { ...original, tradeName: 'Marca Vigente' } },
    });
    const stored = (await database.pool.query<{
      workshop_snapshot: Record<string, unknown>; workshop_logo_bytes: Buffer; workshop_seal_bytes: Buffer;
    }>(
      `SELECT workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE id = $1`, [draft.id],
    )).rows[0];
    expect(stored.workshop_snapshot).toMatchObject({ ...original, tradeName: 'Marca Vigente' });
    expect(stored.workshop_logo_bytes).toEqual(padded);
    expect(stored.workshop_seal_bytes).toEqual(padded);
    const pdf = Buffer.from((await browser.get(`${invoicesUrl}/${draft.id}/pdf`).expect(200)).body);
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1);
    const text = pdfText(pdf);
    expect(text).not.toContain('Firma autorizada');
    for (const value of Object.values({ ...original, tradeName: 'Marca Vigente' })) expect(text).toContain(value);
    expect(pdf.toString('latin1').match(/\/I\d+ Do/g)).toHaveLength(2);
    const ticket = await browser.get(`${invoicesUrl}/${draft.id}/ticket`).expect(200);
    expect(ticket.text).toContain('Marca Vigente');
    expect(ticket.text).toContain('Logo de la sastrería');
    expect(ticket.text).toContain('Sello de la sastrería');
    expect(ticket.text).toContain('class="status">Estado: <strong>EMITIDA</strong>');
    const header = ticket.text.slice(ticket.text.indexOf('<header>'), ticket.text.indexOf('</header>'));
    expect(header).toContain('Sello de la sastrería');
    for (const value of Object.values({ ...original, tradeName: 'Marca Vigente' })) expect(header).toContain(value);
    const newName = `Cambio posterior ${'S'.repeat(130)}`;
    await browser.put(profileUrl).set('Origin', config.frontendOrigin).send({
      ...original, tradeName: newName, logoDataUrl: null, sealDataUrl: null,
    }).expect(200);
    expect((await browser.get('/api/auth/me').expect(200)).body.workshops)
      .toContainEqual(expect.objectContaining({ id: workshopId, name: newName }));
    expect((await browser.get(`${invoicesUrl}/${draft.id}`).expect(200)).body.workshop).toEqual(detail.workshop);
    expect((await database.pool.query(
      `SELECT workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE id = $1`, [draft.id],
    )).rows[0]).toEqual(stored);
    expect((await database.pool.query(
      `SELECT id, workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE workshop_id = $1 AND status = 'issued' AND id != $2 ORDER BY id`,
      [workshopId, draft.id],
    )).rows).toEqual(existing);
  });
});
