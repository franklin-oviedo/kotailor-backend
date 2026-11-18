import { z } from 'zod';

export enum CustomerKind {
  Person = 'person',
  Company = 'company',
}

export enum FiscalDocumentKind {
  Cedula = 'cedula',
  Rnc = 'rnc',
  Passport = 'passport',
}

export const customerSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30).regex(/^[0-9+().\s-]+$/),
  email: z.email().max(254).nullable(),
  address: z.string().trim().min(1).max(500).nullish(),
  kind: z.enum(CustomerKind),
  documentKind: z.enum(FiscalDocumentKind).nullable(),
  documentNumber: z.string().trim().min(1).max(30).nullable(),
  contactAuthorized: z.boolean(),
}).refine(
  (value) => (value.documentKind === null) === (value.documentNumber === null),
  { message: 'Document type and number must both be provided' },
);

export type CreateCustomer = z.infer<typeof customerSchema>;
