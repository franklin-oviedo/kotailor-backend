import { z } from 'zod';

export enum AppointmentKind {
  Fitting = 'fitting',
  Measurements = 'measurements',
  Delivery = 'delivery',
}

export enum AppointmentActor {
  Workshop = 'workshop',
  Customer = 'customer',
}

export enum AppointmentStatus {
  Scheduled = 'scheduled',
  Cancelled = 'cancelled',
}

export enum AppointmentSyncStatus {
  NotConnected = 'not_connected',
  Moving = 'moving',
  Synced = 'synced',
  Pending = 'pending',
  Retrying = 'retrying',
  NeedsAttention = 'needs_attention',
}

const interval = {
  responsibleId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
};

const validInterval = (value: { startsAt: string; endsAt: string }) =>
  Date.parse(value.endsAt) > Date.parse(value.startsAt);

export const createAppointmentSchema = z.strictObject({
  requestId: z.uuid(),
  customerId: z.uuid(),
  orderId: z.uuid().nullable(),
  kind: z.enum(AppointmentKind),
  ...interval,
}).refine(validInterval);

export const rescheduleAppointmentSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  ...interval,
}).refine(validInterval);

export const cancelAppointmentSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

export const appointmentRangeSchema = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
}).refine(({ from, to }) => {
  const duration = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return duration > 0 && duration <= 31 * 24 * 60 * 60 * 1000;
});
