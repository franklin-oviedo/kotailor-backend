import { InvoiceStatus } from './invoices.schema.js';

export enum InvoiceCollectionState {
  Partial = 'partial',
  Paid = 'paid',
}

export type InvoiceDisplayStatus = InvoiceStatus | InvoiceCollectionState;

export const invoiceDisplayLabels: Record<InvoiceDisplayStatus, string> = {
  [InvoiceStatus.Draft]: 'Borrador',
  [InvoiceStatus.Void]: 'Anulada',
  [InvoiceStatus.Issued]: 'Emitida',
  [InvoiceCollectionState.Partial]: 'Pago parcial',
  [InvoiceCollectionState.Paid]: 'Pagada',
};

// All readers use the same net payments, including refunds and payments linked from the order.
export const invoiceCollectionJoin = `
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(CASE WHEN p.kind = 'payment' THEN p.amount_cents ELSE -p.amount_cents END), 0) AS paid_cents
    FROM order_payments p WHERE p.workshop_id = i.workshop_id AND p.invoice_id = i.id
  ) net
  CROSS JOIN LATERAL (
    SELECT CASE WHEN i.status = '${InvoiceStatus.Issued}' AND i.total_cents IS NOT NULL
                THEN GREATEST(i.total_cents - net.paid_cents, 0) END AS due_cents
  ) balance
  CROSS JOIN LATERAL (
    SELECT CASE WHEN balance.due_cents IS NULL OR net.paid_cents <= 0 THEN i.status::text
                WHEN balance.due_cents = 0 THEN '${InvoiceCollectionState.Paid}'
                ELSE '${InvoiceCollectionState.Partial}' END AS display_status
  ) collection`;

export const invoiceCollectionFields = `net.paid_cents::float8 AS "paidCents",
  balance.due_cents::float8 AS "balanceCents", collection.display_status AS "displayStatus"`;

export function invoiceCollectionCounts(status: 'collection.display_status' | 'display_status'): string {
  return `count(*) FILTER (WHERE ${status} = '${InvoiceStatus.Issued}')::int AS "invoicesUnpaid",
    count(*) FILTER (WHERE ${status} = '${InvoiceCollectionState.Partial}')::int AS "invoicesPartial",
    count(*) FILTER (WHERE ${status} = '${InvoiceCollectionState.Paid}')::int AS "invoicesPaid"`;
}
