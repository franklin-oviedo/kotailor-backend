import { z } from 'zod';

export enum OrderFilter {
  All = 'all',
  Production = 'production',
  Ready = 'ready',
  Delivered = 'delivered',
}

export enum ProductionDeliveryFilter {
  All = 'all',
  ThisWeek = 'this_week',
}

export enum ProductionResponsibleFilter {
  All = 'all',
  Unassigned = 'unassigned',
  Historical = 'historical',
}

export const responsibleFilterSchema = z.union([z.enum(ProductionResponsibleFilter), z.uuid()]);

export enum OrderStatus {
  Received = 'received',
  Cutting = 'cutting',
  Sewing = 'sewing',
  Fitting = 'fitting',
  Ready = 'ready',
  Delivered = 'delivered',
}

export const statusChangeSchema = z.strictObject({
  expectedStatus: z.enum(OrderStatus),
  status: z.enum(OrderStatus),
});

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).refine((value) => {
  const date = new Date(`${value}:00Z`);
  return !value.startsWith('0000-') && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === value;
});

export const orderSchema = z.strictObject({
  requestId: z.uuid(),
  customerId: z.uuid(),
  catalogId: z.uuid(),
  catalogRevision: z.number().int().min(1),
  subtotalCents: z.number().int().min(0).max(99999999999),
  expectedTaxBasisPoints: z.number().int().min(0).max(10000).nullable(),
  measurementIds: z.array(z.uuid()).max(4).refine((ids) => new Set(ids).size === ids.length),
  deliveryLocal: localDateTime,
  responsibleId: z.uuid().nullable(),
});

export const taxSettingsSchema = z.strictObject({
  itbisBasisPoints: z.number().int().min(0).max(10000).nullable(),
});
