import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { queryPage } from '../database/pagination.js';
import { renderThermalTicket, type ThermalTicket } from '../documents/thermal-ticket.js';
import { invoiceCollectionCounts, invoiceCollectionFields, invoiceCollectionJoin } from '../invoices/invoice-collection.js';
import { PaymentKind, PaymentMethod, paymentInputSchema } from './payments.schema.js';

type TaxBreakdown = Record<'withTax' | 'withoutTax' | 'pendingTax', { amountCents: number; count: number }>;

const paymentMethodLabels: Record<PaymentMethod, string> = {
  [PaymentMethod.Cash]: 'Efectivo',
  [PaymentMethod.Transfer]: 'Transferencia bancaria',
  [PaymentMethod.Card]: 'Tarjeta',
  [PaymentMethod.Other]: 'Otro',
};
const receiptMoney = new Intl.NumberFormat('es-DO', { style: 'currency', currency: 'DOP' });

function taxBreakdownSql(positiveOnly = false): string {
  const groups = [
    ['withTax', 'has_tax IS TRUE'], ['withoutTax', 'has_tax IS FALSE'], ['pendingTax', 'has_tax IS NULL'],
  ];
  return `json_build_object(${groups.map(([key, condition]) => {
    const filter = `FILTER (WHERE ${condition}${positiveOnly ? ' AND amount_cents > 0' : ''})`;
    return `'${key}', json_build_object(
      'amountCents', COALESCE(sum(amount_cents) ${filter}, 0),
      'count', count(*) ${filter}
    )`;
  }).join(', ')})`;
}

function receivablesSql(customerSource?: 'o' | 'i'): string {
  const orderScope = customerSource
    ? `ord.workshop_id = ${customerSource}.workshop_id AND ord.customer_id = ${customerSource}.customer_id` : 'ord.workshop_id = $1';
  const invoiceScope = customerSource
    ? `bill.workshop_id = ${customerSource}.workshop_id AND bill.customer_id = ${customerSource}.customer_id` : 'bill.workshop_id = $1';
  return `
    SELECT COALESCE(bill.total_cents, ord.subtotal_cents + COALESCE(ord.tax_cents, 0)) AS total_cents,
           bill.id IS NULL AND ord.tax_cents IS NULL AS pending_tax,
           COALESCE((SELECT sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END)
                     FROM order_payments p WHERE p.workshop_id = ord.workshop_id AND p.order_id = ord.id), 0) AS paid_cents,
           CASE WHEN bill.id IS NOT NULL THEN bill.has_tax
                WHEN ord.tax_cents IS NOT NULL THEN ord.tax_treatment = 'taxable' END AS has_tax
    FROM workshop_orders ord
    LEFT JOIN administrative_invoices bill
      ON bill.workshop_id = ord.workshop_id AND bill.order_id = ord.id AND bill.status = 'issued'
    WHERE ${orderScope}
    UNION ALL
    SELECT bill.total_cents, false,
           COALESCE((SELECT sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END)
                     FROM order_payments p WHERE p.workshop_id = bill.workshop_id AND p.invoice_id = bill.id), 0),
           bill.has_tax
    FROM administrative_invoices bill
    WHERE ${invoiceScope} AND bill.status = 'issued' AND bill.order_id IS NULL`;
}

function customerBalanceSql(source: 'o' | 'i'): string {
  return `(SELECT json_build_object(
    'outstandingCents', COALESCE(sum(GREATEST(due.total_cents - due.paid_cents, 0)), 0),
    'hasPendingTax', COALESCE(bool_or(due.pending_tax), false)
  ) FROM (${receivablesSql(source)}) due) AS "customerBalance"`;
}

const orderPaymentTotal = `CASE WHEN i.id IS NOT NULL THEN i.total_cents ELSE o.subtotal_cents + o.tax_cents END`;
const orderNetPayments = `COALESCE((SELECT sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END)
  FROM order_payments p WHERE p.workshop_id = o.workshop_id AND p.order_id = o.id), 0)`;

@Injectable()
export class PaymentsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async ticket(workshopId: string, userId: string, paymentId: string, qrUrl: string): Promise<string> {
    this.validateIds(workshopId, userId, paymentId);
    const { rows: [payment] } = await this.database.pool.query<{
      id: string; kind: PaymentKind; method: PaymentMethod; amountCents: number; reference: string | null;
      reason: string | null; createdAt: Date; createdBy: string; invoiceNumber: number | null; orderNumber: number | null;
      business: ThermalTicket['business']; customer: ThermalTicket['customer'];
      logoMime: string | null; logoBytes: Buffer | null; sealMime: string | null; sealBytes: Buffer | null;
    }>(
      `SELECT p.id, p.kind, p.method, p.amount_cents::float8 AS "amountCents", p.reference, p.reason,
              p.created_at AS "createdAt", u.display_name AS "createdBy",
              i.number AS "invoiceNumber", o.number AS "orderNumber",
              CASE WHEN i.id IS NOT NULL THEN i.workshop_snapshot ELSE jsonb_build_object(
                'workshopName', w.name, 'legalName', b.legal_name, 'tradeName', w.name,
                'rnc', b.rnc, 'fiscalAddress', b.fiscal_address, 'phone', b.phone, 'email', b.email
              ) END AS business,
              CASE WHEN i.id IS NOT NULL THEN i.customer_snapshot ELSE jsonb_build_object(
                'name', c.name, 'phone', c.phone, 'email', c.email, 'kind', c.kind, 'address', c.address,
                'documentKind', c.document_kind, 'documentNumber', c.document_number
              ) END AS customer,
              CASE WHEN i.id IS NOT NULL THEN i.workshop_logo_mime_type ELSE b.logo_mime_type END AS "logoMime",
              CASE WHEN i.id IS NOT NULL THEN i.workshop_logo_bytes ELSE b.logo_bytes END AS "logoBytes",
              CASE WHEN i.id IS NOT NULL THEN i.workshop_seal_mime_type ELSE b.seal_mime_type END AS "sealMime",
              CASE WHEN i.id IS NOT NULL THEN i.workshop_seal_bytes ELSE b.seal_bytes END AS "sealBytes"
       FROM order_payments p
       JOIN workshops w ON w.id = p.workshop_id
       JOIN app_users u ON u.id = p.created_by
       LEFT JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
       LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
       LEFT JOIN customers c ON p.invoice_id IS NULL AND c.workshop_id = p.workshop_id AND c.id = o.customer_id
       LEFT JOIN workshop_billing_profiles b ON p.invoice_id IS NULL AND b.workshop_id = p.workshop_id
       WHERE p.workshop_id = $1 AND p.id = $2 AND EXISTS (
         SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = p.workshop_id
           AND m.user_id = $3 AND m.role IN ('owner', 'manager'))`,
      [workshopId, paymentId, userId],
    );
    if (!payment) throw new NotFoundException('Payment not found or payment access denied');

    const refund = payment.kind === PaymentKind.Refund;
    const facts = [{ label: 'Método de pago', value: paymentMethodLabels[payment.method] }];
    if (payment.invoiceNumber !== null) {
      facts.push({ label: 'Factura', value: `FA-${String(payment.invoiceNumber).padStart(6, '0')}` });
    }
    if (payment.orderNumber !== null) {
      facts.push({ label: 'Orden', value: `OT-${String(payment.orderNumber).padStart(4, '0')}` });
    }
    facts.push({ label: 'Referencia', value: payment.reference ?? payment.id.slice(-8).toUpperCase() });
    if (refund && payment.reason) facts.push({ label: 'Motivo de devolución', value: payment.reason });

    const ticket: ThermalTicket = {
      title: refund ? 'Recibo de devolución' : 'Recibo de pago',
      number: `REC-${payment.id.toUpperCase()}`,
      date: payment.createdAt,
      user: payment.createdBy,
      qrUrl,
      business: payment.business,
      customer: payment.customer,
      logo: payment.logoMime && payment.logoBytes ? { mime: payment.logoMime, bytes: payment.logoBytes } : null,
      seal: payment.sealMime && payment.sealBytes ? { mime: payment.sealMime, bytes: payment.sealBytes } : null,
      facts,
      totals: [{ label: refund ? 'Monto devuelto' : 'Monto pagado', value: receiptMoney.format(payment.amountCents / 100), emphasis: true }],
      notes: ['Este recibo no sustituye un comprobante fiscal autorizado por la DGII.'],
    };
    return renderThermalTicket(ticket);
  }

  async list(workshopId: string, userId: string, orderId: string, includeCustomerBalance = false) {
    this.validateIds(workshopId, userId, orderId);
    const result = await this.database.pool.query<{
      totalCents: number | null; paidCents: number; payments: unknown[];
      customerBalance?: { outstandingCents: number; hasPendingTax: boolean };
    }>(
      `SELECT (${orderPaymentTotal})::float8 AS "totalCents",
              (${orderNetPayments})::float8 AS "paidCents",
              COALESCE((SELECT json_agg(json_build_object(
                'id', p.id, 'kind', p.kind, 'method', p.method, 'amountCents', p.amount_cents,
                'reference', p.reference,
                'originalPaymentId', p.original_payment_id, 'reason', p.reason, 'createdAt', p.created_at,
                'createdBy', u.display_name
              ) ORDER BY p.created_at, p.id)
              FROM order_payments p JOIN app_users u ON u.id = p.created_by
              WHERE p.workshop_id = o.workshop_id AND p.order_id = o.id), '[]'::json) AS payments
              ${includeCustomerBalance ? `, ${customerBalanceSql('o')}` : ''}
       FROM workshop_orders o LEFT JOIN administrative_invoices i
         ON i.workshop_id = o.workshop_id AND i.order_id = o.id AND i.status <> 'void'
       WHERE o.workshop_id = $1 AND o.id = $2 AND EXISTS (
         SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = o.workshop_id
           AND m.user_id = $3 AND m.role IN ('owner', 'manager'))`,
      [workshopId, orderId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Order not found or payment access denied');
    return result.rows[0];
  }

  async create(workshopId: string, userId: string, orderId: string, body: unknown) {
    this.validateIds(workshopId, userId, orderId);
    const parsed = paymentInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payment');
    const { requestId, ...input } = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify({ orderId, ...input })).digest('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
         AND role IN ('owner', 'manager') FOR SHARE`, [workshopId, userId],
      );
      if (!membership.rowCount) throw new NotFoundException('Order not found or payment access denied');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`payment:${workshopId}:${userId}:${requestId}`]);
      const previous = await client.query<{ id: string; hash: string }>(
        'SELECT id, request_hash AS hash FROM order_payments WHERE workshop_id = $1 AND created_by = $2 AND request_id = $3',
        [workshopId, userId, requestId],
      );
      if (previous.rowCount) {
        if (previous.rows[0].hash !== hash) throw new ConflictException('Payment request changed');
        await client.query('COMMIT');
        return { id: previous.rows[0].id };
      }
      const order = await client.query<{ total: string | null }>(
        `SELECT CASE WHEN tax_cents IS NULL THEN NULL ELSE (subtotal_cents + tax_cents)::float8 END AS total
         FROM workshop_orders WHERE workshop_id = $1 AND id = $2 FOR UPDATE`, [workshopId, orderId],
      );
      if (!order.rowCount) throw new NotFoundException('Order not found');
      const invoice = await client.query<{ id: string; status: string; total: string | null }>(
        `SELECT id, status, total_cents AS total FROM administrative_invoices
         WHERE workshop_id = $1 AND order_id = $2 AND status <> 'void' FOR UPDATE`, [workshopId, orderId],
      );
      if (invoice.rowCount && (invoice.rows[0].status !== 'issued' || invoice.rows[0].total === null)) {
        throw new ConflictException('Invoice must be issued before registering payments');
      }
      const total = invoice.rowCount ? Number(invoice.rows[0].total) : order.rows[0].total === null
        ? null : Number(order.rows[0].total);
      if (input.kind === PaymentKind.Payment) {
        if (total === null) throw new ConflictException('Order total is not calculated');
        const balance = await client.query<{ paid: number }>(
          `SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END), 0)::float8 AS paid
           FROM order_payments WHERE workshop_id = $1 AND order_id = $2`, [workshopId, orderId],
        );
        if (balance.rows[0].paid + input.amountCents > total) {
          throw new ConflictException('Payment exceeds order balance');
        }
      } else {
        const original = await client.query<{ remaining: number }>(
          `SELECT (p.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM order_payments r
              WHERE r.workshop_id = p.workshop_id AND r.order_id = p.order_id
                AND r.original_payment_id = p.id AND r.kind = 'refund'), 0))::float8 AS remaining
           FROM order_payments p WHERE p.workshop_id = $1 AND p.order_id = $2 AND p.id = $3 AND p.kind = 'payment'`,
          [workshopId, orderId, input.originalPaymentId],
        );
        if (!original.rowCount || input.amountCents > original.rows[0].remaining) {
          throw new ConflictException('Refund exceeds original payment');
        }
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO order_payments
         (workshop_id, order_id, invoice_id, kind, method, amount_cents, reference, original_payment_id, reason, created_by, request_id, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [workshopId, orderId, invoice.rows[0]?.id ?? null, input.kind, input.method, input.amountCents,
          input.reference || null,
          input.kind === PaymentKind.Refund ? input.originalPaymentId : null,
          input.kind === PaymentKind.Refund ? input.reason : null, userId, requestId, hash],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listInvoice(workshopId: string, userId: string, invoiceId: string, includeCustomerBalance = false) {
    this.validateIds(workshopId, userId, invoiceId);
    const result = await this.database.pool.query(
      `SELECT i.total_cents::float8 AS "totalCents",
              ${invoiceCollectionFields},
              COALESCE((SELECT json_agg(json_build_object(
                'id', p.id, 'kind', p.kind, 'method', p.method, 'amountCents', p.amount_cents,
                'reference', p.reference,
                'originalPaymentId', p.original_payment_id, 'reason', p.reason, 'createdAt', p.created_at,
                'createdBy', u.display_name
              ) ORDER BY p.created_at, p.id)
              FROM order_payments p JOIN app_users u ON u.id = p.created_by
              WHERE p.workshop_id = i.workshop_id AND p.invoice_id = i.id), '[]'::json) AS payments
              ${includeCustomerBalance ? `, ${customerBalanceSql('i')}` : ''}
       FROM administrative_invoices i ${invoiceCollectionJoin}
       WHERE i.workshop_id = $1 AND i.id = $2 AND i.status = 'issued'
         AND EXISTS (SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = i.workshop_id
           AND m.user_id = $3 AND m.role IN ('owner', 'manager'))`,
      [workshopId, invoiceId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Invoice not found or payment access denied');
    return result.rows[0];
  }

  async listOrderReceivables(workshopId: string, userId: string) {
    this.validateIds(workshopId, userId);
    await this.requireWorkshopAccess(workshopId, userId);
    const result = await this.database.pool.query<{ id: string; number: number; customerName: string; catalogName: string }>(
      `SELECT o.id, o.number, o.customer_name AS "customerName", o.catalog_name AS "catalogName"
       FROM workshop_orders o
       LEFT JOIN administrative_invoices i
         ON i.workshop_id = o.workshop_id AND i.order_id = o.id AND i.status <> 'void'
       WHERE o.workshop_id = $1 AND (i.id IS NULL OR i.status = 'issued')
         AND (${orderPaymentTotal}) > ${orderNetPayments}
         AND EXISTS (SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = o.workshop_id
           AND m.user_id = $2 AND m.role IN ('owner', 'manager'))
       ORDER BY o.number DESC, o.id`,
      [workshopId, userId],
    );
    return { orders: result.rows };
  }

  async listManualReceivables(workshopId: string, userId: string) {
    this.validateIds(workshopId, userId);
    await this.requireWorkshopAccess(workshopId, userId);
    const result = await this.database.pool.query<{ id: string; number: number; customerName: string }>(
      `SELECT i.id, i.number, c.name AS "customerName"
       FROM administrative_invoices i
       JOIN customers c ON c.workshop_id = i.workshop_id AND c.id = i.customer_id
       ${invoiceCollectionJoin}
       WHERE i.workshop_id = $1 AND i.order_id IS NULL AND i.status = 'issued'
         AND balance.due_cents > 0
         AND EXISTS (SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = i.workshop_id
           AND m.user_id = $2 AND m.role IN ('owner', 'manager'))
       ORDER BY c.name, i.number DESC`,
      [workshopId, userId],
    );
    return { invoices: result.rows };
  }

  async dashboard(workshopId: string, userId: string, filters: Record<string, unknown> = {}) {
    this.validateIds(workshopId, userId);
    await this.requireWorkshopAccess(workshopId, userId);

    const summary = await this.database.pool.query<{
      collectedMonthCents: number; collectedTodayCents: number; outstandingCents: number;
      outstandingByTax: TaxBreakdown; collectedTodayByTax: TaxBreakdown;
      hasPendingTax: boolean;
      invoicedWithTaxCents: number; invoicedWithoutTaxCents: number; invoicesWithTax: number; invoicesWithoutTax: number;
      invoicesUnpaid: number; invoicesPartial: number; invoicesPaid: number;
    }>(
      `WITH local_time AS (
         SELECT now() AT TIME ZONE 'America/Santo_Domingo' AS current_local
       ), receivables AS (
         ${receivablesSql()}
       ), balances AS (
         SELECT GREATEST(total_cents - paid_cents, 0) AS amount_cents, pending_tax, has_tax FROM receivables
       ), receivable_totals AS (
         SELECT COALESCE(sum(amount_cents), 0)::float8 AS "outstandingCents",
                COALESCE(bool_or(pending_tax), false) AS "hasPendingTax",
                ${taxBreakdownSql(true)} AS "outstandingByTax"
         FROM balances
       ), today_movements AS (
         SELECT CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END AS amount_cents,
                CASE WHEN i.tax_cents IS NOT NULL THEN i.has_tax
                     WHEN o.tax_cents IS NOT NULL THEN o.tax_treatment = 'taxable' END AS has_tax
         FROM order_payments p CROSS JOIN local_time t
         LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
         LEFT JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
         WHERE p.workshop_id = $1
           AND (p.created_at AT TIME ZONE 'America/Santo_Domingo')::date = t.current_local::date
       ), today_totals AS (
         SELECT COALESCE(sum(amount_cents), 0)::float8 AS "collectedTodayCents",
                ${taxBreakdownSql()} AS "collectedTodayByTax"
         FROM today_movements
       ), monthly_invoice_totals AS (
         SELECT COALESCE(sum(i.total_cents) FILTER (WHERE i.has_tax), 0)::float8 AS "invoicedWithTaxCents",
                COALESCE(sum(i.total_cents) FILTER (WHERE NOT i.has_tax), 0)::float8 AS "invoicedWithoutTaxCents",
                (count(*) FILTER (WHERE i.has_tax))::int AS "invoicesWithTax",
                (count(*) FILTER (WHERE NOT i.has_tax))::int AS "invoicesWithoutTax",
                ${invoiceCollectionCounts('collection.display_status')}
         FROM administrative_invoices i CROSS JOIN local_time t
         ${invoiceCollectionJoin}
         WHERE i.workshop_id = $1 AND i.status = 'issued'
           AND i.issue_date BETWEEN date_trunc('month', t.current_local)::date AND t.current_local::date
       )
       SELECT
         COALESCE((SELECT sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END)
                   FROM order_payments p CROSS JOIN local_time t
                   WHERE p.workshop_id = $1
                     AND p.created_at AT TIME ZONE 'America/Santo_Domingo' >= date_trunc('month', t.current_local)), 0)::float8
           AS "collectedMonthCents",
         today_totals.*,
         receivable_totals.*,
         monthly_invoice_totals.*
       FROM monthly_invoice_totals CROSS JOIN receivable_totals CROSS JOIN today_totals`,
      [workshopId],
    );
    const { month, method, search, page, pageSize } = filters;
    if ((month !== undefined && (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)))
      || (method !== undefined && method !== 'all' && !Object.values(PaymentMethod).some((value) => value === method))
      || (search !== undefined && (typeof search !== 'string' || search.length > 120))) {
      throw new BadRequestException('Invalid movement filters');
    }
    const movements = await queryPage(this.database.pool,
      `SELECT p.id, p.kind, p.method, p.amount_cents::float8 AS "amountCents", p.reference,
              p.created_at AS "createdAt", u.display_name AS "createdBy",
              COALESCE(o.customer_name, i.customer_snapshot->>'name') AS "customerName",
              o.number AS "orderNumber", p.order_id AS "orderId", i.number AS "invoiceNumber"
       FROM order_payments p
       JOIN app_users u ON u.id = p.created_by
       LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
       JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
       WHERE p.workshop_id = $1
         AND ($2::text IS NULL OR (p.created_at >= ($2 || '-01')::timestamp AT TIME ZONE 'America/Santo_Domingo'
           AND p.created_at < (($2 || '-01')::timestamp + interval '1 month') AT TIME ZONE 'America/Santo_Domingo'))
         AND ($3::text IS NULL OR p.method::text = $3)
         AND ($4::text = '' OR
           strpos(lower(COALESCE(o.customer_name, i.customer_snapshot->>'name', '')), $4) > 0 OR
           strpos(lower(COALESCE(p.reference, right(p.id::text, 8))), $4) > 0 OR
           strpos('fa-' || lpad(i.number::text, greatest(6, length(i.number::text)), '0'), $4) > 0)`,
      [workshopId, month ?? null, method === 'all' ? null : method ?? null, typeof search === 'string' ? search.trim().toLowerCase() : ''],
      '"createdAt" DESC, id DESC', page, pageSize,
    );
    return { ...summary.rows[0], movements: movements.rows, pagination: movements.pagination };
  }

  async createInvoice(workshopId: string, userId: string, invoiceId: string, body: unknown) {
    this.validateIds(workshopId, userId, invoiceId);
    const parsed = paymentInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid payment');
    const { requestId, ...input } = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify({ invoiceId, ...input })).digest('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
         AND role IN ('owner', 'manager') FOR SHARE`, [workshopId, userId],
      );
      if (!membership.rowCount) throw new NotFoundException('Invoice not found or payment access denied');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`invoice-payment:${workshopId}:${userId}:${requestId}`]);
      const previous = await client.query<{ id: string; hash: string }>(
        `SELECT id, request_hash AS hash FROM order_payments
         WHERE workshop_id = $1 AND created_by = $2 AND request_id = $3`,
        [workshopId, userId, requestId],
      );
      if (previous.rowCount) {
        if (previous.rows[0].hash !== hash) throw new ConflictException('Payment request changed');
        await client.query('COMMIT');
        return { id: previous.rows[0].id };
      }
      const invoice = await client.query<{ orderId: string | null; total: string | null }>(
        `SELECT order_id AS "orderId", total_cents AS total FROM administrative_invoices
         WHERE workshop_id = $1 AND id = $2 AND status = 'issued' FOR UPDATE`,
        [workshopId, invoiceId],
      );
      if (!invoice.rowCount || invoice.rows[0].total === null) {
        throw new ConflictException('Invoice must be issued before registering payments');
      }
      if (input.kind === PaymentKind.Payment) {
        const balance = await client.query<{ paid: number }>(
          `SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END), 0)::float8 AS paid
           FROM order_payments WHERE workshop_id = $1 AND invoice_id = $2`,
          [workshopId, invoiceId],
        );
        if (balance.rows[0].paid + input.amountCents > Number(invoice.rows[0].total)) {
          throw new ConflictException('Payment exceeds invoice balance');
        }
      } else {
        const original = await client.query<{ remaining: number }>(
          `SELECT (p.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM order_payments r
              WHERE r.workshop_id = p.workshop_id AND r.invoice_id = p.invoice_id
                AND r.original_payment_id = p.id AND r.kind = 'refund'), 0))::float8 AS remaining
           FROM order_payments p WHERE p.workshop_id = $1 AND p.invoice_id = $2
             AND p.id = $3 AND p.kind = 'payment'`,
          [workshopId, invoiceId, input.originalPaymentId],
        );
        if (!original.rowCount || input.amountCents > original.rows[0].remaining) {
          throw new ConflictException('Refund exceeds original payment');
        }
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO order_payments
         (workshop_id, order_id, invoice_id, kind, method, amount_cents, reference, original_payment_id,
          reason, created_by, request_id, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [workshopId, invoice.rows[0].orderId, invoiceId, input.kind, input.method, input.amountCents,
          input.reference || null,
          input.kind === PaymentKind.Refund ? input.originalPaymentId : null,
          input.kind === PaymentKind.Refund ? input.reason : null, userId, requestId, hash],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireWorkshopAccess(workshopId: string, userId: string): Promise<void> {
    const membership = await this.database.pool.query(
      `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager')`, [workshopId, userId],
    );
    if (!membership.rowCount) throw new NotFoundException('Workshop not found or payment access denied');
  }

  private validateIds(...ids: string[]): void {
    if (!ids.every((id) => z.uuid().safeParse(id).success)) {
      throw new BadRequestException('Invalid payment context');
    }
  }
}
