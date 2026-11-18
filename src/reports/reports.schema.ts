import { z } from 'zod';
import { OrderStatus } from '../orders/orders.schema.js';

const date = z.iso.date().refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});

export const executiveReportQuerySchema = z.strictObject({
  from: date,
  to: date,
  customerId: z.uuid().optional(),
  status: z.enum(OrderStatus).optional(),
}).superRefine((query, context) => {
  const from = Date.parse(`${query.from}T00:00:00.000Z`);
  const to = Date.parse(`${query.to}T00:00:00.000Z`);
  const days = (to - from) / 86_400_000;
  if (days < 0 || days > 365) {
    context.addIssue({ code: 'custom', message: 'Date range must be between 0 and 366 days', path: ['to'] });
  }
});
