import { z } from 'zod';

export enum PaymentKind {
  Payment = 'payment',
  Refund = 'refund',
}

export enum PaymentMethod {
  Cash = 'cash',
  Transfer = 'transfer',
  Card = 'card',
  Other = 'other',
}

const common = {
  requestId: z.uuid(),
  amountCents: z.number().int().min(1).max(99999999999),
  method: z.enum(PaymentMethod),
  reference: z.string().trim().max(120).optional().default(''),
};

export const paymentInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal(PaymentKind.Payment) }),
  z.strictObject({
    ...common, kind: z.literal(PaymentKind.Refund),
    originalPaymentId: z.uuid(), reason: z.string().trim().min(1).max(500),
  }),
]);
