import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { PaymentKind, PaymentMethod } from '../src/payments/payments.schema.js';
import { PaymentsService } from '../src/payments/payments.service.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Order payment ledger', () => {
  let database: Database;
  let service: PaymentsService;
  let workshopId: string;
  let ownerId: string;
  let staffId: string;
  let orderId: string;
  let unknownTotalId: string;
  let refundOrderId: string;
  const suffix = randomUUID();
  const subjects = [`payments-owner-${suffix}`, `payments-staff-${suffix}`];

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    database = new Database(readConfiguration());
    service = new PaymentsService(database);
    const users = await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       SELECT subject, subject || '@example.invalid', subject FROM unnest($1::text[]) subject RETURNING id`, [subjects],
    );
    [ownerId, staffId] = users.rows.map((row) => row.id);
    workshopId = (await database.pool.query<{ id: string }>("INSERT INTO workshops (name) VALUES ('Payment test') RETURNING id")).rows[0].id;
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'staff')`,
      [workshopId, ownerId, staffId],
    );
    const customer = (await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind) VALUES ($1, 'Synthetic', '8095550100', 'person') RETURNING id`,
      [workshopId],
    )).rows[0].id;
    const orders = await database.pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
       (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
        subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 1, $2, 'Synthetic', 'Test', '', 'taxable', 10000, 1800, 1800, '[]', '2030-01-01', $3),
              ($1, 2, $2, 'Synthetic', 'Test', '', 'taxable', 10000, NULL, NULL, '[]', '2030-01-01', $3),
              ($1, 3, $2, 'Synthetic', 'Test', '', 'taxable', 10000, 1800, 1800, '[]', '2030-01-01', $3)
       RETURNING id`, [workshopId, customer, ownerId],
    );
    [orderId, unknownTotalId, refundOrderId] = orders.rows.map((row) => row.id);
  });

  afterAll(async () => {
    if (!database) return;
    try {
      if (workshopId) await database.pool.query('DELETE FROM workshops WHERE id = $1', [workshopId]);
      await database.pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [subjects]);
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('prevents overpayment under concurrency and retries the same request without duplicates', async () => {
    const input = { kind: PaymentKind.Payment, method: PaymentMethod.Cash, amountCents: 7000, requestId: randomUUID() };
    await expect(service.create(workshopId, staffId, orderId, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create(workshopId, ownerId, unknownTotalId, input)).rejects.toBeInstanceOf(ConflictException);
    const same = await Promise.all([
      service.create(workshopId, ownerId, orderId, input),
      service.create(workshopId, ownerId, orderId, input),
    ]);
    expect(same[0]).toEqual(same[1]);
    await expect(service.create(workshopId, ownerId, orderId, { ...input, amountCents: 1 })).rejects.toBeInstanceOf(ConflictException);
    const concurrent = await Promise.allSettled([
      service.create(workshopId, ownerId, orderId, { ...input, amountCents: 4800, requestId: randomUUID() }),
      service.create(workshopId, ownerId, orderId, { ...input, amountCents: 4800, requestId: randomUUID() }),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.list(workshopId, ownerId, orderId)).paidCents).toBe(11800);
  });

  it('records partial refunds without exceeding the original payment', async () => {
    const first = await service.create(workshopId, ownerId, refundOrderId, {
      kind: PaymentKind.Payment, method: PaymentMethod.Cash, amountCents: 7000, requestId: randomUUID(),
    });
    const refund = {
      kind: PaymentKind.Refund, method: PaymentMethod.Transfer, amountCents: 4000,
      originalPaymentId: first.id, reason: 'Devolución parcial', requestId: randomUUID(),
    };
    const attempts = await Promise.allSettled([
      service.create(workshopId, ownerId, refundOrderId, refund),
      service.create(workshopId, ownerId, refundOrderId, { ...refund, requestId: randomUUID() }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const result = await service.list(workshopId, ownerId, refundOrderId);
    expect(result.paidCents).toBe(3000);
    expect(result.payments).toHaveLength(2);
    await expect(service.list(workshopId, staffId, refundOrderId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
