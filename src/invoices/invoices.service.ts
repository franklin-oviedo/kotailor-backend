import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { queryPage } from '../database/pagination.js';
import { renderThermalTicket } from '../documents/thermal-ticket.js';
import { taxSettingsSchema } from '../orders/orders.schema.js';
import { invoicePdf } from './invoice-pdf.js';
import { invoiceCollectionFields, invoiceCollectionJoin, invoiceDisplayLabels, type InvoiceDisplayStatus } from './invoice-collection.js';
import {
  billingImageSchema, billingProfileSchema, createInvoiceSchema, InvoiceStatus, InvoiceTaxTreatment, invoiceVersionSchema,
  invoiceTaxSettingsSchema, updateInvoiceSchema, voidInvoiceSchema,
} from './invoices.schema.js';

interface InvoiceLineInput {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  discountCents: number;
  taxTreatment: InvoiceTaxTreatment;
}

export interface CalculatedLine extends InvoiceLineInput {
  position: number;
  subtotalCents: number;
  taxBasisPoints: number | null;
  taxCents: number | null;
}

interface InvoiceSnapshot {
  id: string;
  workshopId: string;
  number: number;
  orderId: string | null;
  customerId: string;
  status: InvoiceStatus;
  version: number;
  issueDate: string;
  dueDate: string | null;
  workshop: Record<string, unknown>;
  customer: Record<string, unknown>;
  terms: string;
  notes: string;
  subtotalCents: number;
  taxCents: number | null;
  hasTax: boolean;
  taxBasisPoints: number | null;
  totalCents: number | null;
  createdBy: string;
  createdAt: Date;
  lines: CalculatedLine[];
  voidReason: string | null;
};

const isPostgresUnique = (error: unknown) =>
  z.object({ code: z.literal('23505') }).safeParse(error).success;

const invoiceOrderJoin = 'LEFT JOIN workshop_orders o ON o.workshop_id = i.workshop_id AND o.id = i.order_id';

@Injectable()
export class InvoicesService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async list(workshopId: string, userId: string, search: unknown, page?: unknown, pageSize?: unknown, status?: unknown) {
    this.validateIds(workshopId, userId);
    if (search !== undefined && (typeof search !== 'string' || search.length > 120)) {
      throw new BadRequestException('Invalid invoice search');
    }
    if (status !== undefined && (typeof status !== 'string' || !Object.hasOwn(invoiceDisplayLabels, status))) {
      throw new BadRequestException('Invalid invoice status filter');
    }
    const membership = await this.database.pool.query(
      `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager')`, [workshopId, userId],
    );
    if (!membership.rowCount) throw new NotFoundException('Invoice access denied');
    const escaped = typeof search === 'string' ? search.trim().replace(/[\\%_]/g, '\\$&') : '';
    const { rows, ...result } = await queryPage(this.database.pool,
      `SELECT i.id, i.number, i.order_id AS "orderId", o.number AS "orderNumber", i.customer_snapshot AS customer,
              i.status, i.issue_date AS "issueDate", i.due_date AS "dueDate", i.created_at AS "createdAt",
              i.subtotal_cents::float8 AS "subtotalCents", i.tax_cents::float8 AS "taxCents",
              i.total_cents::float8 AS "totalCents", i.has_tax AS "hasTax", i.tax_basis_points AS "taxBasisPoints",
              ${invoiceCollectionFields}
       FROM administrative_invoices i
       ${invoiceOrderJoin}
       ${invoiceCollectionJoin}
       WHERE i.workshop_id = $1 AND (i.number::text ILIKE $2 OR i.customer_snapshot->>'name' ILIKE $2
         OR ('FA-' || lpad(i.number::text, GREATEST(6, length(i.number::text)), '0')) ILIKE $2
         OR ('OT-' || lpad(o.number::text, GREATEST(4, length(o.number::text)), '0')) ILIKE $2)
         AND ($4::text IS NULL OR collection.display_status = $4)
         AND EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $3
                     AND role IN ('owner', 'manager'))`,
      [workshopId, `%${escaped}%`, userId, status ?? null], '"createdAt" DESC, id DESC', page, pageSize,
    );
    return { invoices: rows, ...result };
  }

  async detail(workshopId: string, userId: string, invoiceId: string, page?: unknown, pageSize?: unknown) {
    this.validateIds(workshopId, userId, invoiceId);
    await this.requireRole(workshopId, userId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const invoice = await this.lockedSnapshot(client, workshopId, invoiceId, false);
      const collection = await client.query<{
        orderNumber: number | null; paidCents: number; balanceCents: number | null; displayStatus: InvoiceDisplayStatus;
      }>(
        `SELECT o.number AS "orderNumber", ${invoiceCollectionFields}
         FROM administrative_invoices i ${invoiceOrderJoin} ${invoiceCollectionJoin}
         WHERE i.workshop_id = $1 AND i.id = $2`, [workshopId, invoiceId],
      );
      const payments = await client.query(
        `SELECT p.id, p.kind, p.method, p.amount_cents::float8 AS "amountCents",
                p.original_payment_id AS "originalPaymentId", p.reason, p.created_at AS "createdAt",
                u.display_name AS "createdBy"
         FROM order_payments p JOIN app_users u ON u.id = p.created_by
         WHERE p.workshop_id = $1 AND p.invoice_id = $2 ORDER BY p.created_at, p.id`,
        [workshopId, invoiceId],
      );
      const revisions = await queryPage(client,
        `SELECT r.id, r.revision, r.kind, r.snapshot, r.changed_by AS "changedBy",
                u.display_name AS "changedByName", r.changed_at AS "changedAt"
         FROM administrative_invoice_revisions r JOIN app_users u ON u.id = r.changed_by
         WHERE r.workshop_id = $1 AND r.invoice_id = $2`,
        [workshopId, invoiceId], 'revision DESC', page, pageSize,
      );
      await client.query('COMMIT');
      const fiscalDataMissing = [
        { key: 'legalName', label: 'Razón social' }, { key: 'tradeName', label: 'Nombre comercial' },
        { key: 'rnc', label: 'RNC' }, { key: 'fiscalAddress', label: 'Dirección fiscal' },
        { key: 'phone', label: 'Teléfono' }, { key: 'email', label: 'Correo electrónico' },
      ].filter(({ key }) => {
        const value = invoice.workshop[key];
        return typeof value !== 'string' || !value.trim();
      }).map(({ label }) => label);
      return {
        ...invoice,
        fiscalDataMissing,
        ...collection.rows[0],
        payments: payments.rows,
        revisions: revisions.rows,
        revisionsHaveMore: revisions.hasMore,
        revisionsPagination: revisions.pagination,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async pdf(workshopId: string, userId: string, invoiceId: string) {
    const invoice = await this.detail(workshopId, userId, invoiceId);
    const assets = await this.database.pool.query<{ logo: Buffer | null; seal: Buffer | null }>(
      `SELECT workshop_logo_bytes AS logo, workshop_seal_bytes AS seal FROM administrative_invoices
       WHERE workshop_id = $1 AND id = $2`, [workshopId, invoiceId],
    );
    if (!assets.rowCount) throw new NotFoundException('Invoice not found');
    return invoicePdf(invoice, this.taxLabel(invoice), assets.rows[0].logo, assets.rows[0].seal);
  }

  async thermalTicket(workshopId: string, userId: string, invoiceId: string, qrUrl: string) {
    const invoice = await this.detail(workshopId, userId, invoiceId);
    if (invoice.status === InvoiceStatus.Draft) throw new NotFoundException('Invoice ticket is not available for drafts');
    const assets = await this.database.pool.query<{
      logo: Buffer | null; seal: Buffer | null; logoMime: string | null; sealMime: string | null;
      issuedAt: Date | null; userName: string;
    }>(
      `SELECT i.workshop_logo_bytes AS logo, i.workshop_logo_mime_type AS "logoMime",
              i.workshop_seal_bytes AS seal, i.workshop_seal_mime_type AS "sealMime",
              i.issued_at AS "issuedAt", u.display_name AS "userName"
       FROM administrative_invoices i
       LEFT JOIN administrative_invoice_revisions r
         ON r.workshop_id = i.workshop_id AND r.invoice_id = i.id AND r.kind = 'issued'
       JOIN app_users u ON u.id = COALESCE(r.changed_by, i.created_by)
       WHERE i.workshop_id = $1 AND i.id = $2`, [workshopId, invoiceId],
    );
    if (!assets.rowCount) throw new NotFoundException('Invoice not found');
    const { logo, logoMime, seal, sealMime, issuedAt, userName } = assets.rows[0];
    const formatter = new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP' });
    const quantity = new Intl.NumberFormat('es-DO', { maximumFractionDigits: 3 });
    const money = (cents: number | null) => cents === null ? 'Sin calcular' : formatter.format(cents / 100);
    const discount = invoice.lines.reduce((sum, line) => sum + line.discountCents, 0);
    return renderThermalTicket({
      title: 'Factura administrativa', number: `FA-${String(invoice.number).padStart(6, '0')}`,
      documentDate: invoice.issueDate, date: issuedAt ?? invoice.createdAt, user: userName,
      business: invoice.workshop, customer: invoice.customer,
      logo: logo && logoMime ? { bytes: logo, mime: logoMime } : null,
      seal: seal && sealMime ? { bytes: seal, mime: sealMime } : null,
      status: invoiceDisplayLabels[invoice.displayStatus].toLocaleUpperCase('es-DO'),
      lines: invoice.lines.map((line) => ({
        description: line.description, quantity: quantity.format(line.quantityMilli / 1000),
        price: money(line.unitPriceCents), amount: money(line.subtotalCents + line.discountCents),
      })),
      totals: [
        { label: 'Subtotal', value: money(invoice.subtotalCents + discount) },
        { label: 'Descuento', value: money(discount ? -discount : 0) },
        ...(invoice.hasTax ? [{ label: 'ITBIS', value: money(invoice.taxCents) }] : []),
        { label: 'TOTAL GENERAL', value: money(invoice.totalCents), emphasis: true },
        ...(invoice.balanceCents === null ? [] : [
          { label: 'Monto pagado', value: money(invoice.paidCents) },
          { label: 'Monto pendiente', value: money(invoice.balanceCents) },
        ]),
      ],
      notes: [invoice.notes, invoice.terms, invoice.voidReason ? `Motivo de anulación: ${invoice.voidReason}` : '',
        'NO CONSTITUYE UN COMPROBANTE FISCAL AUTORIZADO POR LA DGII'],
      qrUrl,
    });
  }

  async create(workshopId: string, userId: string, body: unknown) {
    this.validateIds(workshopId, userId);
    const parsed = createInvoiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid administrative invoice');
    const input = parsed.data;
    if (input.dueDate && input.dueDate < input.issueDate) throw new BadRequestException('Due date precedes issue date');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireRole(workshopId, userId, client);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`invoice:${workshopId}:${userId}:${input.requestId}`]);
      const existing = await client.query<{ id: string; number: number; hash: string }>(
        `SELECT id, number, request_hash AS hash FROM administrative_invoices
         WHERE workshop_id = $1 AND created_by = $2 AND request_id = $3`,
        [workshopId, userId, input.requestId],
      );
      if (existing.rowCount) {
        if (existing.rows[0].hash !== hash) throw new ConflictException('Invoice request changed');
        await client.query('COMMIT');
        return { id: existing.rows[0].id, number: existing.rows[0].number };
      }

      const workshop = await this.workshopSnapshot(client, workshopId);
      let customerId: string;
      let orderId: string | null = null;
      let customer: Record<string, unknown>;
      let lines: InvoiceLineInput[];
      let hasTax: boolean;
      let rate: number | null;

      if (input.source === 'order') {
        const order = await client.query<{
          id: string; customerId: string; customerName: string; catalogName: string; subtotalCents: string;
          taxTreatment: InvoiceTaxTreatment; taxBasisPoints: number | null;
        }>(
          `SELECT id, customer_id AS "customerId", customer_name AS "customerName", catalog_name AS "catalogName",
                  subtotal_cents AS "subtotalCents", tax_treatment AS "taxTreatment", tax_basis_points AS "taxBasisPoints"
           FROM workshop_orders WHERE workshop_id = $1 AND id = $2 FOR UPDATE`,
          [workshopId, input.orderId],
        );
        if (!order.rowCount) throw new NotFoundException('Order not found');
        orderId = order.rows[0].id;
        customerId = order.rows[0].customerId;
        const profile = await this.customerSnapshot(client, workshopId, customerId);
        customer = profile;
        lines = [{
          description: order.rows[0].catalogName, quantityMilli: 1000,
          unitPriceCents: Number(order.rows[0].subtotalCents), discountCents: 0,
          taxTreatment: order.rows[0].taxTreatment,
        }];
        hasTax = order.rows[0].taxTreatment === InvoiceTaxTreatment.Taxable;
        rate = hasTax ? order.rows[0].taxBasisPoints : 0;
      } else {
        customerId = input.customerId;
        customer = await this.customerSnapshot(client, workshopId, customerId);
        hasTax = input.hasTax ?? true;
        this.requireTaxMode(hasTax, workshop.allowInvoicesWithoutTax);
        rate = hasTax ? workshop.taxRate : 0;
        lines = this.manualLines(input.lines, hasTax);
      }
      const calculated = this.calculateLines(lines, rate);
      const totals = this.totals(calculated);
      const sequence = await client.query<{ number: number }>(
        `INSERT INTO administrative_invoice_sequences (workshop_id, last_number) VALUES ($1, 1)
         ON CONFLICT (workshop_id) DO UPDATE SET last_number = administrative_invoice_sequences.last_number + 1
         RETURNING last_number AS number`, [workshopId],
      );
      const idempotencyRequest = input.requestId;
      const created = await client.query<{ id: string; number: number }>(
        `INSERT INTO administrative_invoices
         (workshop_id, number, order_id, customer_id, issue_date, due_date, workshop_snapshot,
          workshop_logo_mime_type, workshop_logo_bytes, customer_snapshot, terms, notes,
          subtotal_cents, tax_cents, total_cents, created_by, updated_by, request_id, request_hash, has_tax, tax_basis_points,
          workshop_seal_mime_type, workshop_seal_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$20,$21,$22)
         RETURNING id, number`,
        [workshopId, sequence.rows[0].number, orderId, customerId, input.issueDate, input.dueDate,
          JSON.stringify(workshop.profile), workshop.logoMimeType, workshop.logoBytes, JSON.stringify(customer),
          input.terms, input.notes, totals.subtotalCents, totals.taxCents, totals.totalCents,
          userId, idempotencyRequest, hash, hasTax, rate, workshop.sealMimeType, workshop.sealBytes],
      );
      await this.saveLines(client, workshopId, created.rows[0].id, calculated);
      if (orderId) {
        await client.query(
          `UPDATE order_payments SET invoice_id = $3
           WHERE workshop_id = $1 AND order_id = $2 AND invoice_id IS NULL`,
          [workshopId, orderId, created.rows[0].id],
        );
      }
      const snapshot = await this.snapshot(client, workshopId, created.rows[0].id);
      await this.addRevision(client, workshopId, created.rows[0].id, 1, 'created', snapshot, userId);
      await client.query('COMMIT');
      return created.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      if (isPostgresUnique(error)) throw new ConflictException('An invoice already exists for this order or request');
      throw error;
    } finally {
      client.release();
    }
  }

  async update(workshopId: string, userId: string, invoiceId: string, body: unknown) {
    this.validateIds(workshopId, userId, invoiceId);
    const parsed = updateInvoiceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invoice update');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireRole(workshopId, userId, client);
      const current = await this.lockedSnapshot(client, workshopId, invoiceId);
      if (current.status !== InvoiceStatus.Draft) throw new ConflictException('Only draft invoices can be edited');
      if (current.version !== parsed.data.expectedVersion) throw new ConflictException('Invoice changed');
      if (parsed.data.dueDate && parsed.data.dueDate < current.issueDate) throw new BadRequestException('Due date precedes issue date');
      const hasTax = parsed.data.hasTax ?? current.hasTax;
      let rate = current.taxBasisPoints;
      let lines = current.lines;
      const historicalMixed = current.lines.some((line) => line.taxTreatment === InvoiceTaxTreatment.Exempt) &&
        current.lines.some((line) => line.taxTreatment === InvoiceTaxTreatment.Taxable);
      if (current.orderId || historicalMixed) {
        if (hasTax !== current.hasTax || (parsed.data.lines && !this.matchesOrderLines(parsed.data.lines, current.lines))) {
          throw new ConflictException('The original invoice amounts and tax cannot be changed');
        }
      } else {
        const workshop = await this.workshopSnapshot(client, workshopId);
        this.requireTaxMode(hasTax, workshop.allowInvoicesWithoutTax);
        rate = hasTax ? workshop.taxRate : 0;
        lines = this.calculateLines(this.manualLines(parsed.data.lines ?? current.lines, hasTax), rate);
      }
      const totals = this.totals(lines);
      const updated = await client.query(
        `UPDATE administrative_invoices SET due_date = $3, terms = $4, notes = $5,
           subtotal_cents = $6, tax_cents = $7, total_cents = $8, version = version + 1,
           updated_by = $9, updated_at = now(), has_tax = $11, tax_basis_points = $12
         WHERE workshop_id = $1 AND id = $2 AND status = 'draft' AND version = $10`,
        [workshopId, invoiceId, parsed.data.dueDate, parsed.data.terms, parsed.data.notes,
          totals.subtotalCents, totals.taxCents, totals.totalCents, userId, current.version, hasTax, rate],
      );
      if (!updated.rowCount) throw new ConflictException('Invoice changed');
      if (!current.orderId && !historicalMixed) {
        await client.query('DELETE FROM administrative_invoice_lines WHERE workshop_id = $1 AND invoice_id = $2',
          [workshopId, invoiceId]);
        await this.saveLines(client, workshopId, invoiceId, lines);
      }
      const snapshot = await this.snapshot(client, workshopId, invoiceId);
      await this.addRevision(client, workshopId, invoiceId, current.version + 1, 'updated', snapshot, userId);
      await client.query('COMMIT');
      return { id: invoiceId, version: current.version + 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async issue(workshopId: string, userId: string, invoiceId: string, body: unknown) {
    return this.transition(workshopId, userId, invoiceId, body, InvoiceStatus.Issued);
  }

  async void(workshopId: string, userId: string, invoiceId: string, body: unknown) {
    return this.transition(workshopId, userId, invoiceId, body, InvoiceStatus.Void);
  }

  async billingProfile(workshopId: string, userId: string) {
    this.validateIds(workshopId, userId);
    await this.requireRole(workshopId, userId);
    const result = await this.database.pool.query(
      `SELECT p.legal_name AS "legalName", w.name AS "tradeName", p.rnc,
              p.fiscal_address AS "fiscalAddress", p.phone, p.email,
              p.logo_mime_type AS "logoMimeType", p.logo_bytes IS NOT NULL AS "hasLogo",
              'data:' || p.logo_mime_type || ';base64,' || replace(encode(p.logo_bytes, 'base64'), chr(10), '') AS "logoDataUrl",
              'data:' || p.seal_mime_type || ';base64,' || replace(encode(p.seal_bytes, 'base64'), chr(10), '') AS "sealDataUrl",
              w.name AS "workshopName", w.itbis_basis_points AS "itbisBasisPoints",
              w.allow_invoices_without_tax AS "allowInvoicesWithoutTax"
       FROM workshops w LEFT JOIN workshop_billing_profiles p ON p.workshop_id = w.id WHERE w.id = $1`,
      [workshopId],
    );
    if (!result.rowCount) throw new NotFoundException('Workshop not found');
    return result.rows[0];
  }

  async updateTaxSettings(workshopId: string, userId: string, body: unknown) {
    this.validateIds(workshopId, userId);
    const parsed = invoiceTaxSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invoice tax settings');
    const result = await this.database.pool.query(
      `WITH owner AS MATERIALIZED (
         SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE
       )
       UPDATE workshops SET allow_invoices_without_tax = $3
       WHERE id = $1 AND EXISTS (SELECT 1 FROM owner)
       RETURNING allow_invoices_without_tax AS "allowInvoicesWithoutTax"`,
      [workshopId, userId, parsed.data.allowInvoicesWithoutTax],
    );
    if (!result.rowCount) throw new ForbiddenException('Owner access required');
    return result.rows[0];
  }

  async applyPendingOrderTax(workshopId: string, userId: string, body: unknown) {
    this.validateIds(workshopId, userId);
    const parsed = taxSettingsSchema.safeParse(body);
    if (!parsed.success || parsed.data.itbisBasisPoints === null) {
      throw new BadRequestException('Expected ITBIS rate is required');
    }
    const rate = parsed.data.itbisBasisPoints;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE`,
        [workshopId, userId],
      );
      if (!owner.rowCount) throw new ForbiddenException('Owner access required');
      const settings = await client.query<{ rate: number | null }>(
        'SELECT itbis_basis_points AS rate FROM workshops WHERE id = $1 FOR SHARE', [workshopId],
      );
      if (settings.rows[0]?.rate !== rate) throw new ConflictException('Tax settings changed');

      // Use the same order-then-invoice lock sequence as linked invoice creation and payments.
      const pending = await client.query<{ id: string }>(
        `SELECT id FROM workshop_orders
         WHERE workshop_id = $1 AND tax_treatment = $2 AND tax_basis_points IS NULL AND tax_cents IS NULL
         ORDER BY id FOR UPDATE`,
        [workshopId, InvoiceTaxTreatment.Taxable],
      );
      const orders = await client.query<{ id: string; subtotalCents: string; taxCents: string }>(
        `UPDATE workshop_orders o SET tax_basis_points = $3::int, tax_cents = (subtotal_cents * $3::int + 5000) / 10000
         WHERE o.workshop_id = $1 AND o.id = ANY($2::uuid[]) AND NOT EXISTS (
           SELECT 1 FROM administrative_invoices i WHERE i.workshop_id = o.workshop_id AND i.order_id = o.id
             AND i.status = $4
         )
         RETURNING o.id, subtotal_cents AS "subtotalCents", tax_cents AS "taxCents"`,
        [workshopId, pending.rows.map(({ id }) => id), rate, InvoiceStatus.Issued],
      );
      const ordersById = new Map(orders.rows.map((order) => [order.id, order]));
      const drafts = await client.query<{ id: string; orderId: string }>(
        `SELECT id, order_id AS "orderId" FROM administrative_invoices
         WHERE workshop_id = $1 AND order_id = ANY($2::uuid[]) AND status = $3 ORDER BY order_id FOR UPDATE`,
        [workshopId, [...ordersById.keys()], InvoiceStatus.Draft],
      );
      for (const draft of drafts.rows) {
        const order = ordersById.get(draft.orderId)!;
        const current = await this.snapshot(client, workshopId, draft.id);
        const lines = this.calculateLines(current.lines, rate);
        const totals = this.totals(lines);
        if (totals.subtotalCents !== Number(order.subtotalCents) || totals.taxCents !== Number(order.taxCents)) {
          throw new ConflictException('Linked draft amounts do not match the order');
        }
        await client.query(
          `UPDATE administrative_invoices SET tax_basis_points = $3, tax_cents = $4, total_cents = $5,
             version = version + 1, updated_by = $6, updated_at = now()
           WHERE workshop_id = $1 AND id = $2`,
          [workshopId, draft.id, rate, totals.taxCents, totals.totalCents, userId],
        );
        await client.query('DELETE FROM administrative_invoice_lines WHERE workshop_id = $1 AND invoice_id = $2',
          [workshopId, draft.id]);
        await this.saveLines(client, workshopId, draft.id, lines);
        const snapshot = await this.snapshot(client, workshopId, draft.id);
        await this.addRevision(client, workshopId, draft.id, snapshot.version, 'updated', snapshot, userId);
      }
      await client.query('COMMIT');
      return { updatedOrders: orders.rows.length, updatedDrafts: drafts.rows.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateBillingProfile(workshopId: string, userId: string, body: unknown) {
    this.validateIds(workshopId, userId);
    const parsed = billingProfileSchema.safeParse(body);
    const image = parsed.success ? null : billingImageSchema.safeParse(body);
    if (!parsed.success && !image?.success) throw new BadRequestException('Invalid billing profile');
    const profile = parsed.data ?? {
      legalName: null, tradeName: null, rnc: null, fiscalAddress: null, phone: null, email: null,
      logoDataUrl: image?.data && 'logoDataUrl' in image.data ? image.data.logoDataUrl : undefined,
      sealDataUrl: image?.data && 'sealDataUrl' in image.data ? image.data.sealDataUrl : undefined,
    };
    const logo = profile.logoDataUrl === undefined ? undefined : this.parseLogo(profile.logoDataUrl);
    const seal = profile.sealDataUrl === undefined ? undefined : this.parseLogo(profile.sealDataUrl);
    const result = await this.database.pool.query(
      `WITH owned_workshop AS (
         UPDATE workshops SET name = CASE WHEN $15 AND $3::text IS NOT NULL THEN $3 ELSE name END
         WHERE id = $1 AND EXISTS (
           SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $10 AND role = 'owner'
         )
         RETURNING name
       )
       INSERT INTO workshop_billing_profiles
       (workshop_id, legal_name, trade_name, rnc, fiscal_address, phone, email, logo_mime_type, logo_bytes, updated_by,
        seal_mime_type, seal_bytes)
       SELECT $1,$2,name,$4,$5,$6,$7,$8,$9,$10,$12,$13 FROM owned_workshop
       ON CONFLICT (workshop_id) DO UPDATE SET
       legal_name = CASE WHEN $15 THEN EXCLUDED.legal_name ELSE workshop_billing_profiles.legal_name END,
       trade_name = EXCLUDED.trade_name,
       rnc = CASE WHEN $15 THEN EXCLUDED.rnc ELSE workshop_billing_profiles.rnc END,
       fiscal_address = CASE WHEN $15 THEN EXCLUDED.fiscal_address ELSE workshop_billing_profiles.fiscal_address END,
       phone = CASE WHEN $15 THEN EXCLUDED.phone ELSE workshop_billing_profiles.phone END,
       email = CASE WHEN $15 THEN EXCLUDED.email ELSE workshop_billing_profiles.email END,
       logo_mime_type = CASE WHEN $11 THEN EXCLUDED.logo_mime_type ELSE workshop_billing_profiles.logo_mime_type END,
       logo_bytes = CASE WHEN $11 THEN EXCLUDED.logo_bytes ELSE workshop_billing_profiles.logo_bytes END,
       seal_mime_type = CASE WHEN $14 THEN EXCLUDED.seal_mime_type ELSE workshop_billing_profiles.seal_mime_type END,
       seal_bytes = CASE WHEN $14 THEN EXCLUDED.seal_bytes ELSE workshop_billing_profiles.seal_bytes END,
       updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING legal_name AS "legalName", trade_name AS "tradeName", rnc,
         fiscal_address AS "fiscalAddress", phone, email, logo_mime_type AS "logoMimeType",
         logo_bytes IS NOT NULL AS "hasLogo"`,
      [workshopId, profile.legalName, profile.tradeName, profile.rnc, profile.fiscalAddress, profile.phone,
        profile.email, logo?.mimeType ?? null, logo?.bytes ?? null, userId, profile.logoDataUrl !== undefined,
        seal?.mimeType ?? null, seal?.bytes ?? null, profile.sealDataUrl !== undefined, parsed.success],
    );
    if (!result.rowCount) throw new NotFoundException('Owner access required');
    return this.billingProfile(workshopId, userId);
  }

  private async transition(
    workshopId: string, userId: string, invoiceId: string, body: unknown,
    status: InvoiceStatus,
  ) {
    this.validateIds(workshopId, userId, invoiceId);
    const parsed = status === InvoiceStatus.Void
      ? voidInvoiceSchema.safeParse(body)
      : invoiceVersionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invoice transition');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireRole(workshopId, userId, client);
      const current = await this.lockedSnapshot(client, workshopId, invoiceId);
      if (current.version !== parsed.data.expectedVersion) throw new ConflictException('Invoice changed');
      if (status === InvoiceStatus.Issued) {
        if (current.status !== InvoiceStatus.Draft) throw new ConflictException('Only draft invoices can be issued');
        const workshop = await this.workshopSnapshot(client, workshopId);
        if (!current.orderId && !current.hasTax) {
          this.requireTaxMode(current.hasTax, workshop.allowInvoicesWithoutTax);
        }
        if (current.totalCents === null) throw new ConflictException('Tax rate must be configured before issuing this invoice');
        await client.query(
          `UPDATE administrative_invoices SET workshop_snapshot = $3,
             workshop_logo_mime_type = $4, workshop_logo_bytes = $5,
             workshop_seal_mime_type = $6, workshop_seal_bytes = $7
           WHERE workshop_id = $1 AND id = $2`,
          [workshopId, invoiceId, JSON.stringify(workshop.profile), workshop.logoMimeType, workshop.logoBytes,
            workshop.sealMimeType, workshop.sealBytes],
        );
      } else if (current.status === InvoiceStatus.Void) {
        throw new ConflictException('Invoice is already void');
      }
      if (status === InvoiceStatus.Void) {
        const payments = await client.query<{ paidCents: number }>(
          `SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END), 0)::float8 AS "paidCents"
           FROM order_payments WHERE workshop_id = $1 AND invoice_id = $2`,
          [workshopId, invoiceId],
        );
        if (payments.rows[0].paidCents > 0) {
          throw new ConflictException('Refund invoice payments before voiding');
        }
      }
      const reason = status === InvoiceStatus.Void && 'reason' in parsed.data ? parsed.data.reason : null;
      const updated = await client.query(
        `UPDATE administrative_invoices SET status = $3::administrative_invoice_status,
           version = version + 1, updated_by = $4,
           updated_at = now(), issued_at = CASE WHEN $3::administrative_invoice_status = 'issued' THEN now() ELSE issued_at END,
           voided_at = CASE WHEN $3::administrative_invoice_status = 'void' THEN now() ELSE voided_at END,
           void_reason = $5
         WHERE workshop_id = $1 AND id = $2 AND version = $6`,
        [workshopId, invoiceId, status, userId, reason, current.version],
      );
      if (!updated.rowCount) throw new ConflictException('Invoice changed');
      const snapshot = await this.snapshot(client, workshopId, invoiceId);
      await this.addRevision(client, workshopId, invoiceId, current.version + 1,
        status === InvoiceStatus.Issued ? 'issued' : 'voided', snapshot, userId);
      await client.query('COMMIT');
      return { id: invoiceId, version: current.version + 1, status };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private requireTaxMode(hasTax: boolean, allowed: boolean) {
    if (!hasTax && !allowed) throw new ConflictException('Workshop does not allow invoices without ITBIS');
  }

  private manualLines(lines: Omit<InvoiceLineInput, 'taxTreatment'>[], hasTax: boolean): InvoiceLineInput[] {
    return lines.map((line) => ({
      ...line, taxTreatment: hasTax ? InvoiceTaxTreatment.Taxable : InvoiceTaxTreatment.Exempt,
    }));
  }

  private matchesOrderLines(input: (Omit<InvoiceLineInput, 'taxTreatment'> & { taxTreatment?: InvoiceTaxTreatment })[], current: CalculatedLine[]) {
    return input.length === current.length && input.every((line, index) => {
      const original = current[index];
      return line.description === original.description && line.quantityMilli === original.quantityMilli &&
        line.unitPriceCents === original.unitPriceCents && line.discountCents === original.discountCents &&
        (line.taxTreatment === undefined || line.taxTreatment === original.taxTreatment);
    });
  }

  private taxLabel(invoice: Pick<InvoiceSnapshot, 'hasTax' | 'taxBasisPoints'>): string {
    if (!invoice.hasTax) return 'Factura sin ITBIS';
    return `Factura con ITBIS${invoice.taxBasisPoints === null ? '' : ` (${invoice.taxBasisPoints / 100}%)`}`;
  }

  private calculateLines(input: InvoiceLineInput[], configuredRate: number | null): CalculatedLine[] {
    return input.map((line, index) => {
      const gross = Number((BigInt(line.quantityMilli) * BigInt(line.unitPriceCents) + 500n) / 1000n);
      if (line.discountCents > gross) throw new BadRequestException('Discount exceeds line amount');
      const subtotalCents = gross - line.discountCents;
      if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 99999999999) {
        throw new BadRequestException('Invoice line amount is too large');
      }
      const rate = line.taxTreatment === InvoiceTaxTreatment.Exempt ? 0 : configuredRate;
      if (rate !== null && rate !== undefined && rate < 0) {
        throw new BadRequestException('Order tax configuration is invalid');
      }
      const taxCents = rate === null || rate === undefined ? null
        : Number((BigInt(subtotalCents) * BigInt(rate) + 5000n) / 10000n);
      return {
        ...line, position: index + 1, subtotalCents, taxBasisPoints: rate ?? null, taxCents,
      };
    });
  }

  private totals(lines: CalculatedLine[]) {
    const subtotalCents = lines.reduce((total, line) => total + line.subtotalCents, 0);
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 99999999999) {
      throw new BadRequestException('Invoice subtotal is too large');
    }
    const taxCents = lines.some((line) => line.taxCents === null) ? null
      : lines.reduce((total, line) => total + line.taxCents!, 0);
    if (taxCents !== null && (!Number.isSafeInteger(taxCents) || taxCents > 99999999999
        || subtotalCents + taxCents > 99999999999)) {
      throw new BadRequestException('Invoice total is too large');
    }
    return { subtotalCents, taxCents, totalCents: taxCents === null ? null : subtotalCents + taxCents };
  }

  private async workshopSnapshot(client: PoolClient, workshopId: string) {
    const result = await client.query<{
      name: string; taxRate: number | null; legalName: string | null; tradeName: string | null;
      rnc: string | null; fiscalAddress: string | null; phone: string | null; email: string | null;
      logoMimeType: string | null; logoBytes: Buffer | null; allowInvoicesWithoutTax: boolean;
      sealMimeType: string | null; sealBytes: Buffer | null;
    }>(
      `SELECT w.name, w.itbis_basis_points AS "taxRate", w.allow_invoices_without_tax AS "allowInvoicesWithoutTax", p.legal_name AS "legalName",
              w.name AS "tradeName", p.rnc, p.fiscal_address AS "fiscalAddress",
              p.phone, p.email, p.logo_mime_type AS "logoMimeType", p.logo_bytes AS "logoBytes",
              p.seal_mime_type AS "sealMimeType", p.seal_bytes AS "sealBytes"
       FROM workshops w LEFT JOIN workshop_billing_profiles p ON p.workshop_id = w.id
       WHERE w.id = $1 FOR SHARE OF w`,
      [workshopId],
    );
    if (!result.rowCount) throw new NotFoundException('Workshop not found');
    const row = result.rows[0];
    return {
      taxRate: row.taxRate,
      allowInvoicesWithoutTax: row.allowInvoicesWithoutTax,
      profile: {
        workshopName: row.name, legalName: row.legalName, tradeName: row.tradeName, rnc: row.rnc,
        fiscalAddress: row.fiscalAddress, phone: row.phone, email: row.email,
      },
      logoMimeType: row.logoMimeType,
      logoBytes: row.logoBytes,
      sealMimeType: row.sealMimeType,
      sealBytes: row.sealBytes,
    };
  }

  private async customerSnapshot(client: PoolClient, workshopId: string, customerId: string) {
    const result = await client.query(
      `SELECT name, phone, email, kind, address, document_kind AS "documentKind", document_number AS "documentNumber"
       FROM customers WHERE workshop_id = $1 AND id = $2 FOR SHARE`, [workshopId, customerId],
    );
    if (!result.rowCount) throw new NotFoundException('Customer not found');
    return result.rows[0] as Record<string, unknown>;
  }

  private async saveLines(client: PoolClient, workshopId: string, invoiceId: string, lines: CalculatedLine[]) {
    for (const line of lines) {
      await client.query(
        `INSERT INTO administrative_invoice_lines
         (workshop_id, invoice_id, position, description, quantity_milli, unit_price_cents, discount_cents,
          tax_treatment, tax_basis_points, subtotal_cents, tax_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [workshopId, invoiceId, line.position, line.description, line.quantityMilli,
          line.unitPriceCents, line.discountCents, line.taxTreatment, line.taxBasisPoints,
          line.subtotalCents, line.taxCents],
      );
    }
  }

  private async snapshot(client: PoolClient, workshopId: string, invoiceId: string): Promise<InvoiceSnapshot> {
    const invoice = await client.query<{
      id: string; workshopId: string; number: number; orderId: string | null; customerId: string;
      status: InvoiceStatus; version: number; issueDate: string; dueDate: string | null;
      workshop: Record<string, unknown>; customer: Record<string, unknown>; terms: string; notes: string;
      subtotalCents: string; taxCents: string | null; totalCents: string | null; voidReason: string | null;
      hasTax: boolean; taxBasisPoints: number | null; createdBy: string; createdAt: Date;
    }>(
      `SELECT id, workshop_id AS "workshopId", number, order_id AS "orderId", customer_id AS "customerId",
              status, version, issue_date::text AS "issueDate", due_date::text AS "dueDate",
              workshop_snapshot AS workshop, customer_snapshot AS customer, terms, notes,
              subtotal_cents AS "subtotalCents", tax_cents AS "taxCents", total_cents AS "totalCents",
              void_reason AS "voidReason", has_tax AS "hasTax", tax_basis_points AS "taxBasisPoints",
              created_by AS "createdBy", created_at AS "createdAt"
       FROM administrative_invoices WHERE workshop_id = $1 AND id = $2`,
      [workshopId, invoiceId],
    );
    if (!invoice.rowCount) throw new NotFoundException('Invoice not found');
    const lines = await client.query<CalculatedLine>(
      `SELECT description, quantity_milli AS "quantityMilli", unit_price_cents AS "unitPriceCents",
              discount_cents AS "discountCents", tax_treatment AS "taxTreatment",
              tax_basis_points AS "taxBasisPoints", subtotal_cents AS "subtotalCents",
              tax_cents AS "taxCents", position
       FROM administrative_invoice_lines WHERE workshop_id = $1 AND invoice_id = $2 ORDER BY position`,
      [workshopId, invoiceId],
    );
    const row = invoice.rows[0];
    return {
      ...row,
      subtotalCents: Number(row.subtotalCents),
      taxCents: row.taxCents === null ? null : Number(row.taxCents),
      totalCents: row.totalCents === null ? null : Number(row.totalCents),
      lines: lines.rows.map((line) => ({
        ...line,
        quantityMilli: Number(line.quantityMilli), unitPriceCents: Number(line.unitPriceCents),
        discountCents: Number(line.discountCents), subtotalCents: Number(line.subtotalCents),
        taxCents: line.taxCents === null ? null : Number(line.taxCents),
      })),
    };
  }

  private async addRevision(
    client: PoolClient, workshopId: string, invoiceId: string, revision: number,
    kind: 'created' | 'updated' | 'issued' | 'voided', snapshot: InvoiceSnapshot, userId: string,
  ) {
    await client.query(
      `INSERT INTO administrative_invoice_revisions (workshop_id, invoice_id, revision, kind, snapshot, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [workshopId, invoiceId, revision, kind, JSON.stringify(snapshot), userId],
    );
  }

  private async lockedSnapshot(client: PoolClient, workshopId: string, invoiceId: string, lock = true): Promise<InvoiceSnapshot> {
    const found = await client.query(
      `SELECT id FROM administrative_invoices WHERE workshop_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [workshopId, invoiceId],
    );
    if (!found.rowCount) throw new NotFoundException('Invoice not found');
    return this.snapshot(client, workshopId, invoiceId);
  }

  private async requireRole(workshopId: string, userId: string, client?: PoolClient) {
    const executor = client ?? this.database.pool;
    const result = await executor.query(
      `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager')${client ? ' FOR SHARE' : ''}`, [workshopId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Invoice access denied');
  }

  private parseLogo(dataUrl: string | null): { mimeType: string; bytes: Buffer } | null {
    if (dataUrl === null) return null;
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw new BadRequestException('Invoice logo must be a PNG or JPEG data URL');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 61440 || bytes.toString('base64') !== match[2]) {
      throw new BadRequestException('Invoice logo exceeds the supported size');
    }
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
    if ((match[1] === 'image/png' && !png) || (match[1] === 'image/jpeg' && !jpeg)) {
      throw new BadRequestException('Invoice logo file signature does not match its format');
    }
    return { mimeType: match[1], bytes };
  }

  private validateIds(workshopId: string, userId: string, resourceId?: string) {
    if (![workshopId, userId, ...(resourceId ? [resourceId] : [])].every((id) => z.uuid().safeParse(id).success)) {
      throw new BadRequestException('Invalid invoice context');
    }
  }
}
