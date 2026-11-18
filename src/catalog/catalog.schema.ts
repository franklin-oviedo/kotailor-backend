import { z } from 'zod';
import { MeasurementGarment } from '../customers/measurement.schema.js';

export enum CatalogCategory {
  Tailoring = 'tailoring',
  Alteration = 'alteration',
}

export enum TaxTreatment {
  Taxable = 'taxable',
  Exempt = 'exempt',
}

export const catalogSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  category: z.enum(CatalogCategory),
  basePriceCents: z.number().int().min(0).max(99999999999),
  taxTreatment: z.enum(TaxTreatment),
  measurementGarments: z.array(z.enum(MeasurementGarment)).max(4)
    .refine((items) => new Set(items).size === items.length),
  instructions: z.string().trim().max(1000),
});

export const catalogUpdateSchema = catalogSchema.extend({
  revision: z.number().int().min(1).max(2147483646),
});
