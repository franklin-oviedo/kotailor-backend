import { z } from 'zod';

export enum InvoiceStatus {
  Draft = 'draft',
  Issued = 'issued',
  Void = 'void',
}

export enum InvoiceTaxTreatment {
  Taxable = 'taxable',
  Exempt = 'exempt',
}

const lineSchema = z.strictObject({
  description: z.string().trim().min(1).max(500),
  quantityMilli: z.number().int().min(1).max(1000000000),
  unitPriceCents: z.number().int().min(0).max(99999999999),
  discountCents: z.number().int().min(0).max(99999999999),
  taxTreatment: z.enum(InvoiceTaxTreatment).optional(),
});

const dateSchema = z.iso.date();
const notes = z.string().max(4000);
const terms = z.string().max(2000);

export const createInvoiceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('manual'),
    requestId: z.uuid(),
    customerId: z.uuid(),
    hasTax: z.boolean().optional(),
    issueDate: dateSchema,
    dueDate: dateSchema.nullable(),
    terms,
    notes,
    lines: z.array(lineSchema).min(1).max(100),
  }),
  z.strictObject({
    source: z.literal('order'),
    requestId: z.uuid(),
    orderId: z.uuid(),
    issueDate: dateSchema,
    dueDate: dateSchema.nullable(),
    terms,
    notes,
  }),
]);

export const updateInvoiceSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  hasTax: z.boolean().optional(),
  dueDate: dateSchema.nullable(),
  terms,
  notes,
  lines: z.array(lineSchema).min(1).max(100).optional(),
});

export const invoiceTaxSettingsSchema = z.strictObject({ allowInvoicesWithoutTax: z.boolean() });

export const invoiceVersionSchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});

export const voidInvoiceSchema = invoiceVersionSchema.extend({
  reason: z.string().trim().min(1).max(1000),
});

export const fiscalPhonePattern = /^\+?[\d ()-]+$/;
export const billingProfileSchema = z.strictObject({
  legalName: z.string().trim().max(200).nullable(),
  tradeName: z.string().trim().min(1).max(200).nullable(),
  rnc: z.string().trim().regex(/^(?:[0-9]{9,11})?$/).nullable().transform((value) => value || null),
  fiscalAddress: z.string().trim().max(500).nullable(),
  phone: z.string().trim().max(30).refine((value) => value === '' ||
    (fiscalPhonePattern.test(value) && /^\d{10,15}$/.test(value.replace(/\D/g, '')))).nullable()
    .transform((value) => value || null),
  email: z.email().max(254).nullable(),
  logoDataUrl: z.string().max(82000).nullable().optional(),
  sealDataUrl: z.string().max(82000).nullable().optional(),
});

export const billingImageSchema = z.union([
  z.strictObject({ logoDataUrl: z.string().max(82000).nullable() }),
  z.strictObject({ sealDataUrl: z.string().max(82000).nullable() }),
]);
