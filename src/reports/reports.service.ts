import { BadRequestException, Inject, NotFoundException, Injectable } from '@nestjs/common';
import { Database } from '../database/database.js';
import { invoiceCollectionCounts, invoiceCollectionJoin } from '../invoices/invoice-collection.js';
import { executiveReportQuerySchema } from './reports.schema.js';

export interface MonthlyReport {
  month: string;
  salesCents: number;
  invoicedCents: number;
  collectedCents: number;
  newCustomers: number;
}

export interface StatusReport {
  status: string;
  count: number;
}

export interface CustomerReport {
  customerId: string;
  name: string;
  orders: number;
  salesCents: number;
}

export interface ProductReport {
  name: string;
  orders: number;
  salesCents: number;
}

export interface ReportSummary {
  salesCents: number;
  collectedCents: number;
  outstandingCents: number;
  invoicedCents: number;
  invoiceOutstandingCents: number;
  invoicesIssued: number;
  invoicedWithTaxCents: number;
  invoicedWithoutTaxCents: number;
  invoicesWithTax: number;
  invoicesWithoutTax: number;
  invoicesPaid: number;
  invoicesUnpaid: number;
  invoicesPartial: number;
  activeOrders: number;
  productionOrders: number;
  completedOrders: number;
  totalCustomers: number;
  newCustomers: number;
  frequentCustomers: number;
  annualIncomeCents: number;
}

export interface ExecutiveReport {
  summary: ReportSummary;
  monthly: MonthlyReport[];
  ordersByStatus: StatusReport[];
  topCustomers: CustomerReport[];
  topProducts: ProductReport[];
  inventoryCritical: null;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async executive(workshopId: string, userId: string, query: unknown): Promise<ExecutiveReport> {
    const parsed = executiveReportQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid executive report filters');
    const filters = parsed.data;
    const access = await this.database.pool.query(
      `SELECT 1 FROM workshop_memberships m
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')
         AND ($3::uuid IS NULL OR EXISTS (
           SELECT 1 FROM customers c WHERE c.workshop_id = m.workshop_id AND c.id = $3
         ))`,
      [workshopId, userId, filters.customerId ?? null],
    );
    if (!access.rowCount) throw new NotFoundException('Workshop or customer not found');

    const values = [workshopId, filters.from, filters.to, filters.customerId ?? null, filters.status ?? null];
    const [summary, monthly, statuses, customers, products] = await Promise.all([
      this.database.pool.query(
        `WITH selected_orders AS MATERIALIZED (
           SELECT o.id, o.customer_id, o.customer_name, o.catalog_name, o.status,
                  o.subtotal_cents + COALESCE(o.tax_cents, 0) AS total_cents
           FROM workshop_orders o
           WHERE o.workshop_id = $1
             AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND ($4::uuid IS NULL OR o.customer_id = $4)
             AND ($5::text IS NULL OR o.status::text = $5::text)
         ), selected_invoices AS MATERIALIZED (
           SELECT i.total_cents, i.has_tax, balance.due_cents, collection.display_status
           FROM administrative_invoices i
           ${invoiceCollectionJoin}
           WHERE i.workshop_id = $1 AND i.status = 'issued'
             AND i.issue_date >= $2::date AND i.issue_date <= $3::date
             AND ($4::uuid IS NULL OR i.customer_id = $4)
             AND ($5::text IS NULL OR EXISTS (
               SELECT 1 FROM workshop_orders o
               WHERE o.workshop_id = i.workshop_id AND o.id = i.order_id AND o.status::text = $5::text
             ))
         ), invoice_counts AS (
           SELECT ${invoiceCollectionCounts('display_status')} FROM selected_invoices
         ), order_balances AS (
           SELECT o.id, o.total_cents,
                  COALESCE(sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END), 0) AS paid_cents
           FROM selected_orders o
           JOIN workshop_orders source ON source.workshop_id = $1 AND source.id = o.id AND source.tax_cents IS NOT NULL
           LEFT JOIN order_payments p ON p.workshop_id = $1 AND p.order_id = o.id AND p.invoice_id IS NULL
           WHERE NOT EXISTS (
             SELECT 1 FROM administrative_invoices i
             WHERE i.workshop_id = $1 AND i.order_id = o.id AND i.status <> 'void'
           )
           GROUP BY o.id, o.total_cents
         ), period_payments AS (
           SELECT p.kind, p.amount_cents
           FROM order_payments p
           LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
           LEFT JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
           WHERE p.workshop_id = $1
             AND p.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND p.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND ($4::uuid IS NULL OR COALESCE(o.customer_id, i.customer_id) = $4)
             AND ($5::text IS NULL OR o.status::text = $5::text)
         ), year_payments AS (
           SELECT p.kind, p.amount_cents
           FROM order_payments p
           LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
           LEFT JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
           WHERE p.workshop_id = $1
             AND p.created_at >= (date_trunc('year', $3::date)::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND p.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND ($4::uuid IS NULL OR COALESCE(o.customer_id, i.customer_id) = $4)
             AND ($5::text IS NULL OR o.status::text = $5::text)
         ), order_receivables AS (
           SELECT GREATEST(total_cents - paid_cents, 0) AS due_cents FROM order_balances
         )
         SELECT
           COALESCE((SELECT sum(total_cents) FROM selected_orders), 0)::float8 AS "salesCents",
           COALESCE((SELECT sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END)
                     FROM period_payments), 0)::float8 AS "collectedCents",
           COALESCE((SELECT sum(due_cents) FROM (
             SELECT due_cents FROM order_receivables UNION ALL SELECT due_cents FROM selected_invoices
           ) receivables), 0)::float8 AS "outstandingCents",
           COALESCE((SELECT sum(total_cents) FROM selected_invoices), 0)::float8 AS "invoicedCents",
           COALESCE((SELECT sum(due_cents) FROM selected_invoices), 0)::float8 AS "invoiceOutstandingCents",
           (SELECT count(*)::int FROM selected_invoices) AS "invoicesIssued",
           (SELECT COALESCE(sum(total_cents), 0)::float8 FROM selected_invoices WHERE has_tax) AS "invoicedWithTaxCents",
           (SELECT COALESCE(sum(total_cents), 0)::float8 FROM selected_invoices WHERE NOT has_tax) AS "invoicedWithoutTaxCents",
           (SELECT count(*)::int FROM selected_invoices WHERE has_tax) AS "invoicesWithTax",
           (SELECT count(*)::int FROM selected_invoices WHERE NOT has_tax) AS "invoicesWithoutTax",
           invoice_counts.*,
           (SELECT count(*)::int FROM selected_orders WHERE status <> 'delivered') AS "activeOrders",
           (SELECT count(*)::int FROM selected_orders
            WHERE status IN ('received', 'cutting', 'sewing', 'fitting')) AS "productionOrders",
           (SELECT count(*)::int FROM selected_orders WHERE status = 'delivered') AS "completedOrders",
           (SELECT count(*)::int FROM customers c
            WHERE c.workshop_id = $1 AND ($4::uuid IS NULL OR c.id = $4)) AS "totalCustomers",
           (SELECT count(*)::int FROM customers c
            WHERE c.workshop_id = $1
              AND c.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
              AND c.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
              AND ($4::uuid IS NULL OR c.id = $4)) AS "newCustomers",
           (SELECT count(*)::int FROM (
             SELECT customer_id FROM selected_orders GROUP BY customer_id HAVING count(*) > 1
           ) frequent) AS "frequentCustomers",
           COALESCE((SELECT sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END)
                     FROM year_payments), 0)::float8 AS "annualIncomeCents"
         FROM invoice_counts`,
        values,
      ),
      this.database.pool.query(
        `WITH periods AS (
           SELECT generate_series(date_trunc('month', $2::date)::date,
                                  date_trunc('month', $3::date)::date,
                                  INTERVAL '1 month')::date AS month
         )
         SELECT to_char(m.month, 'YYYY-MM') AS month,
           COALESCE((SELECT sum(o.subtotal_cents + COALESCE(o.tax_cents, 0)) FROM workshop_orders o
             WHERE o.workshop_id = $1
               AND o.created_at >= (GREATEST($2::date, m.month)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND o.created_at < (LEAST($3::date + 1, (m.month + INTERVAL '1 month')::date)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND ($4::uuid IS NULL OR o.customer_id = $4)
               AND ($5::text IS NULL OR o.status::text = $5::text)), 0)::float8 AS "salesCents",
           COALESCE((SELECT sum(i.total_cents) FROM administrative_invoices i
             WHERE i.workshop_id = $1 AND i.status = 'issued' AND i.total_cents IS NOT NULL
               AND i.issue_date >= GREATEST($2::date, m.month)
               AND i.issue_date < LEAST($3::date + INTERVAL '1 day', m.month + INTERVAL '1 month')
               AND ($4::uuid IS NULL OR i.customer_id = $4)
               AND ($5::text IS NULL OR EXISTS (
                 SELECT 1 FROM workshop_orders o WHERE o.workshop_id = $1 AND o.id = i.order_id AND o.status::text = $5::text
               ))), 0)::float8 AS "invoicedCents",
           COALESCE((SELECT sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END)
             FROM order_payments p
             LEFT JOIN workshop_orders o ON o.workshop_id = p.workshop_id AND o.id = p.order_id
             LEFT JOIN administrative_invoices i ON i.workshop_id = p.workshop_id AND i.id = p.invoice_id
             WHERE p.workshop_id = $1
               AND p.created_at >= (GREATEST($2::date, m.month)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND p.created_at < (LEAST($3::date + 1, (m.month + INTERVAL '1 month')::date)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND ($4::uuid IS NULL OR COALESCE(o.customer_id, i.customer_id) = $4)
               AND ($5::text IS NULL OR o.status::text = $5::text)), 0)::float8 AS "collectedCents",
           (SELECT count(*)::int FROM customers c
             WHERE c.workshop_id = $1
               AND c.created_at >= (GREATEST($2::date, m.month)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND c.created_at < (LEAST($3::date + 1, (m.month + INTERVAL '1 month')::date)::timestamp AT TIME ZONE 'America/Santo_Domingo')
               AND ($4::uuid IS NULL OR c.id = $4)) AS "newCustomers"
         FROM periods m ORDER BY m.month`,
        values,
      ),
      this.database.pool.query(
        `SELECT o.status, count(*)::int AS count
         FROM workshop_orders o
         WHERE o.workshop_id = $1
           AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND ($4::uuid IS NULL OR o.customer_id = $4)
           AND ($5::text IS NULL OR o.status::text = $5::text)
         GROUP BY o.status ORDER BY o.status`,
        values,
      ),
      this.database.pool.query(
        `SELECT o.customer_id AS "customerId", o.customer_name AS name,
                count(*)::int AS orders, sum(o.subtotal_cents + COALESCE(o.tax_cents, 0))::float8 AS "salesCents"
         FROM workshop_orders o
         WHERE o.workshop_id = $1
           AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND ($4::uuid IS NULL OR o.customer_id = $4)
           AND ($5::text IS NULL OR o.status::text = $5::text)
         GROUP BY o.customer_id, o.customer_name
         ORDER BY "salesCents" DESC, orders DESC, name LIMIT 5`,
        values,
      ),
      this.database.pool.query(
        `SELECT o.catalog_name AS name, count(*)::int AS orders,
                sum(o.subtotal_cents + COALESCE(o.tax_cents, 0))::float8 AS "salesCents"
         FROM workshop_orders o
         WHERE o.workshop_id = $1
           AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo')
           AND ($4::uuid IS NULL OR o.customer_id = $4)
           AND ($5::text IS NULL OR o.status::text = $5::text)
         GROUP BY o.catalog_name ORDER BY orders DESC, "salesCents" DESC, name LIMIT 5`,
        values,
      ),
    ]);

    return {
      summary: summary.rows[0],
      monthly: monthly.rows as MonthlyReport[],
      ordersByStatus: statuses.rows as StatusReport[],
      topCustomers: customers.rows as CustomerReport[],
      topProducts: products.rows as ProductReport[],
      inventoryCritical: null,
    };
  }
}
