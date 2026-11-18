import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ConflictException } from '@nestjs/common';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';
import { InvoiceStatus } from '../src/invoices/invoices.schema.js';
import { InvoicesService } from '../src/invoices/invoices.service.js';
import { PaymentKind, PaymentMethod } from '../src/payments/payments.schema.js';
import { PaymentsService } from '../src/payments/payments.service.js';
import { pdfText } from './pdf-text.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Administrative invoices and shared payments', () => {
  let database: Database;
  let invoices: InvoicesService;
  let payments: PaymentsService;
  let workshopId: string;
  let ownerId: string;
  let customerId: string;
  let orderId: string;
  const suffix = randomUUID();
  const subject = `invoice-test-${suffix}`;

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    database = new Database(readConfiguration());
    invoices = new InvoicesService(database);
    payments = new PaymentsService(database);
    ownerId = (await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       VALUES ($1, $2, 'Invoice Test') RETURNING id`,
      [subject, `${subject}@example.invalid`],
    )).rows[0].id;
    workshopId = (await database.pool.query<{ id: string }>(
      `INSERT INTO workshops (name, itbis_basis_points) VALUES ('Invoice test', 1800) RETURNING id`,
    )).rows[0].id;
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workshopId, ownerId],
    );
    customerId = (await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind, address)
       VALUES ($1, 'Invoice Customer', '8095550100', 'person', 'Calle del Cliente 10') RETURNING id`,
      [workshopId],
    )).rows[0].id;
    orderId = (await database.pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
       (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
        subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 1, $2, 'Invoice Customer', 'Jacket', '', 'taxable', 10000, 1800, 1800, '[]', '2030-01-01', $3)
       RETURNING id`,
      [workshopId, customerId, ownerId],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (!database) return;
    try {
      if (workshopId) await database.pool.query('DELETE FROM order_payments WHERE workshop_id = $1', [workshopId]);
      if (workshopId) await database.pool.query('DELETE FROM workshops WHERE id = $1', [workshopId]);
      if (ownerId) await database.pool.query('DELETE FROM app_users WHERE id = $1', [ownerId]);
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('links prior order payments, issues immutable invoices, and serializes invoice payment attempts', async () => {
    const priorPayment = await payments.create(workshopId, ownerId, orderId, {
      kind: PaymentKind.Payment, method: PaymentMethod.Cash, amountCents: 3000, requestId: randomUUID(),
    });
    const createInput = {
      source: 'order', orderId, requestId: randomUUID(), issueDate: '2030-01-01',
      dueDate: null, terms: '', notes: '',
    } as const;
    const created = await invoices.create(workshopId, ownerId, createInput);
    expect(await invoices.create(workshopId, ownerId, createInput)).toEqual(created);
    const beforeIssue = await invoices.detail(workshopId, ownerId, created.id);
    expect(beforeIssue.lines[0].taxBasisPoints).toBe(1800);
    expect(beforeIssue.paidCents).toBe(3000);
    expect(beforeIssue.payments[0].id).toBe(priorPayment.id);

    const updated = await invoices.update(workshopId, ownerId, created.id, {
      expectedVersion: 1, dueDate: '2030-01-05', terms: 'Updated terms', notes: '',
      lines: [{
        description: 'Jacket', quantityMilli: 1000, unitPriceCents: 10000,
        discountCents: 0, taxTreatment: 'taxable',
      }],
    });
    expect(updated.version).toBe(2);
    expect((await invoices.detail(workshopId, ownerId, created.id)).lines[0].taxBasisPoints).toBe(1800);
    await invoices.issue(workshopId, ownerId, created.id, { expectedVersion: 2 });
    const paymentInput = {
      kind: PaymentKind.Payment, method: PaymentMethod.Transfer, amountCents: 5000,
    };
    const attempts = await Promise.allSettled([
      payments.createInvoice(workshopId, ownerId, created.id, { ...paymentInput, requestId: randomUUID() }),
      payments.createInvoice(workshopId, ownerId, created.id, { ...paymentInput, requestId: randomUUID() }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect((await invoices.detail(workshopId, ownerId, created.id)).paidCents).toBe(8000);
    await expect(payments.createInvoice(workshopId, ownerId, created.id, {
      ...paymentInput, amountCents: 4000, requestId: randomUUID(),
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(invoices.update(workshopId, ownerId, created.id, {
      expectedVersion: 3, dueDate: null, terms: 'Changed', notes: '',
      lines: [{
        description: 'Jacket', quantityMilli: 1000, unitPriceCents: 10000,
        discountCents: 0, taxTreatment: 'taxable',
      }],
    })).rejects.toBeInstanceOf(ConflictException);
    const pdf = await invoices.pdf(workshopId, ownerId, created.id);
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdfText(pdf)).toContain('NO CONSTITUYE UN COMPROBANTE FISCAL AUTORIZADO POR LA DGII');
    expect((await invoices.detail(workshopId, ownerId, created.id)).status).toBe(InvoiceStatus.Issued);

    const voidInput = { expectedVersion: 3, reason: 'Correccion requerida' };
    await expect(invoices.void(workshopId, ownerId, created.id, voidInput))
      .rejects.toThrow('Refund invoice payments before voiding');
    const successful = attempts.find((attempt) => attempt.status === 'fulfilled');
    if (!successful || successful.status !== 'fulfilled') throw new Error('Expected invoice payment');
    await payments.createInvoice(workshopId, ownerId, created.id, {
      kind: PaymentKind.Refund, method: PaymentMethod.Transfer, amountCents: 5000,
      originalPaymentId: successful.value.id, reason: 'Correccion requerida', requestId: randomUUID(),
    });
    await payments.createInvoice(workshopId, ownerId, created.id, {
      kind: PaymentKind.Refund, method: PaymentMethod.Cash, amountCents: 3000,
      originalPaymentId: priorPayment.id, reason: 'Correccion requerida', requestId: randomUUID(),
    });
    await invoices.void(workshopId, ownerId, created.id, voidInput);
    const replacement = await invoices.create(workshopId, ownerId, {
      ...createInput, requestId: randomUUID(),
    });
    expect(replacement.number).toBe(created.number + 1);
    const manual = await invoices.create(workshopId, ownerId, {
      source: 'manual', customerId, requestId: randomUUID(), issueDate: '2030-01-02',
      dueDate: null, terms: '', notes: '',
      lines: [{
        description: 'Custom tailoring', quantityMilli: 1000, unitPriceCents: 10000,
        discountCents: 0, taxTreatment: 'taxable',
      }],
    });
    expect(manual.number).toBe(replacement.number + 1);
    const unknownTaxOrderId = (await database.pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
       (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
        subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 2, $2, 'Invoice Customer', 'Repair', '', 'taxable', 5000, NULL, NULL, '[]', '2030-01-02', $3)
       RETURNING id`,
      [workshopId, customerId, ownerId],
    )).rows[0].id;
    const unknownTax = await invoices.create(workshopId, ownerId, {
      ...createInput, orderId: unknownTaxOrderId, requestId: randomUUID(),
    });
    expect((await invoices.detail(workshopId, ownerId, unknownTax.id)).totalCents).toBeNull();
    await expect(invoices.issue(workshopId, ownerId, unknownTax.id, { expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('persists business assets and embeds only the original profile in historical PDFs', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9Wf1sAAAAASUVORK5CYII=';
    const original = {
      legalName: 'Emisor Legal Original', tradeName: 'Marca Original', rnc: '123456789',
      fiscalAddress: 'Calle Antigua 12', phone: '+1 (809) 555-0100', email: 'original@example.invalid',
    };
    await invoices.updateBillingProfile(workshopId, ownerId, { ...original, logoDataUrl: png });
    await invoices.updateBillingProfile(workshopId, ownerId, { sealDataUrl: png });
    expect(await invoices.billingProfile(workshopId, ownerId))
      .toMatchObject({ ...original, logoDataUrl: png, sealDataUrl: png });
    const make = () => invoices.create(workshopId, ownerId, {
      source: 'manual', customerId, requestId: randomUUID(), issueDate: '2030-01-03',
      dueDate: null, terms: 'Condiciones originales', notes: 'Nota de factura',
      lines: Array.from({ length: 60 }, (_, index) => ({
        description: `Servicio ${index + 1}`, quantityMilli: 1000, unitPriceCents: 5000,
        discountCents: 300, taxTreatment: 'taxable',
      })),
    });
    const historical = await make();
    await invoices.issue(workshopId, ownerId, historical.id, { expectedVersion: 1 });
    const awaitingIssue = await make();
    const historicalBefore = (await database.pool.query(
      `SELECT workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE id = $1`, [historical.id],
    )).rows[0];
    const replacement = { ...original, tradeName: 'Marca Actualizada' };
    await invoices.updateBillingProfile(workshopId, ownerId, { ...replacement, logoDataUrl: null });
    await invoices.updateBillingProfile(workshopId, ownerId, { ...replacement, sealDataUrl: null });
    await invoices.issue(workshopId, ownerId, awaitingIssue.id, { expectedVersion: 1 });
    expect((await invoices.detail(workshopId, ownerId, awaitingIssue.id)).workshop.tradeName).toBe('Marca Actualizada');
    expect((await database.pool.query(
      `SELECT workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE id = $1`, [historical.id],
    )).rows[0]).toEqual(historicalBefore);
    const current = await make();
    const oldPdf = await invoices.pdf(workshopId, ownerId, historical.id);
    const newPdf = await invoices.pdf(workshopId, ownerId, current.id);
    expect(pdfText(oldPdf)).toContain('Marca Original');
    expect(pdfText(oldPdf)).toContain('Calle Antigua 12');
    expect(pdfText(oldPdf)).toContain('Calle del Cliente 10');
    expect(pdfText(oldPdf)).toContain('Servicio 60');
    expect(pdfText(oldPdf)).toContain('TOTAL GENERAL');
    expect(pdfText(oldPdf)).not.toContain('Marca Actualizada');
    const images = oldPdf.toString('latin1').match(/\/I\d+ Do/g) ?? [];
    expect(images).toHaveLength(2);
    expect(newPdf.toString('latin1')).not.toMatch(/\/I\d+ Do/);
    expect(pdfText(newPdf)).toContain('Marca Actualizada');
    const qrUrl = 'https://example.invalid/ticket';
    const ticket = await invoices.thermalTicket(workshopId, ownerId, historical.id, qrUrl);
    expect(ticket).toContain('Marca Original');
    expect(ticket).toContain('Logo de la sastrería');
    expect(ticket).toContain('Sello de la sastrería');
    expect(ticket).toContain('Servicio 60');
    expect(ticket).toContain('TOTAL GENERAL');
    expect(ticket).toContain('EMITIDA');
    expect(ticket).not.toContain('Marca Actualizada');
    await expect(invoices.thermalTicket(workshopId, ownerId, current.id, qrUrl)).rejects.toThrow('drafts');
  });

  it('adopts existing commercial names without modifying invoice snapshots', async () => {
    const before = (await database.pool.query(
      `SELECT id, workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE workshop_id = $1 ORDER BY id`, [workshopId],
    )).rows;
    await database.pool.query('UPDATE workshops SET name = $2 WHERE id = $1', [workshopId, 'Nombre administrativo antiguo']);
    const migration = await readFile(new URL('../migrations/033_workshop_commercial_name.sql', import.meta.url), 'utf8');
    await database.pool.query(migration);
    expect((await database.pool.query('SELECT name FROM workshops WHERE id = $1', [workshopId])).rows[0].name)
      .toBe('Marca Actualizada');
    expect((await database.pool.query(
      `SELECT id, workshop_snapshot, workshop_logo_bytes, workshop_seal_bytes
       FROM administrative_invoices WHERE workshop_id = $1 ORDER BY id`, [workshopId],
    )).rows).toEqual(before);
    await database.pool.query('UPDATE workshop_billing_profiles SET trade_name = NULL WHERE workshop_id = $1', [workshopId]);
    await database.pool.query(migration);
    expect(await invoices.billingProfile(workshopId, ownerId))
      .toMatchObject({ workshopName: 'Marca Actualizada', tradeName: 'Marca Actualizada' });
  });
});
