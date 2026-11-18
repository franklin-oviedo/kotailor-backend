import { z } from 'zod';

export enum MeasurementGarment {
  WomensTrousers = 'womens_trousers',
  Shirts = 'shirts',
  Jackets = 'jackets',
  Dresses = 'dresses',
}

export const measurementCatalog = [
  {
    id: MeasurementGarment.WomensTrousers, label: 'Pantalón',
    fields: [
      { key: 'waist', label: 'Cintura' }, { key: 'hip', label: 'Bacinete' },
      { key: 'totalLength', label: 'Largo total' }, { key: 'kneeWidth', label: 'Contorno de rodilla' },
      { key: 'hemWidth', label: 'Contorno de ruedo' }, { key: 'rise', label: 'Altura de tiro' },
    ],
  },
  {
    id: MeasurementGarment.Shirts, label: 'Camisas',
    fields: [
      { key: 'backLength', label: 'Largo de espalda' }, { key: 'waistLength', label: 'Largo de talle' },
      { key: 'totalLength', label: 'Largo total' }, { key: 'chestWidth', label: 'Contorno de pecho' },
      { key: 'waistWidth', label: 'Contorno de cintura' }, { key: 'hipWidth', label: 'Contorno de bacinete' },
      { key: 'sleeveLength', label: 'Largo total de manga' }, { key: 'armWidth', label: 'Contorno de brazo' },
      { key: 'cuffWidth', label: 'Contorno de puños' }, { key: 'chestFrontWidth', label: 'Frente de pecho' },
      { key: 'neckWidth', label: 'Contorno de cuello' }, { key: 'front', label: 'Delantera' },
      { key: 'back', label: 'Trasera' },
    ],
  },
  {
    id: MeasurementGarment.Jackets, label: 'Chaquetas',
    fields: [
      { key: 'backLength', label: 'Largo de espalda' }, { key: 'waistLength', label: 'Largo de talle' },
      { key: 'totalLength', label: 'Largo total' }, { key: 'chestWidth', label: 'Contorno de pecho (busto)' },
      { key: 'waistWidth', label: 'Contorno de cintura' }, { key: 'hipWidth', label: 'Contorno de bacinete (cadera)' },
      { key: 'sleeveLength', label: 'Largo total de manga' }, { key: 'sleeveWidth', label: 'Contorno de manga' },
      { key: 'sleeveOpeningWidth', label: 'Contorno de boca de manga' },
    ],
  },
  {
    id: MeasurementGarment.Dresses, label: 'Vestidos',
    fields: [
      { key: 'backLength', label: 'Largo de espalda' }, { key: 'waistLength', label: 'Largo de talle' },
      { key: 'totalLength', label: 'Largo total' }, { key: 'bustCircumference', label: 'Contorno de busto' },
      { key: 'waistCircumference', label: 'Contorno de cintura' }, { key: 'hipCircumference', label: 'Contorno de cadera' },
      { key: 'bustSeparation', label: 'Separación de busto' }, { key: 'hipHeight', label: 'Altura de cadera' },
      { key: 'backHipHeight', label: 'Altura de cadera trasera' }, { key: 'nippleHeight', label: 'Altura de busto al pezón' },
      { key: 'bustHeight', label: 'Altura de busto completo' }, { key: 'armholeWidth', label: 'Contorno de sisa' },
    ],
  },
] as const;

const centimetres = z.number().positive().max(999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);

export const measurementDraftSchema = z.strictObject({
  measurements: z.record(z.string(), centimetres),
  revision: z.number().int().min(0).max(2147483646),
});

export function validDraftFields(garment: MeasurementGarment, measurements: Record<string, number>): boolean {
  const definition = measurementCatalog.find((item) => item.id === garment);
  return !!definition && Object.keys(measurements).every((key) =>
    definition.fields.some((field) => field.key === key));
}

export const measurementSchema = z.strictObject({
  garment: z.enum(MeasurementGarment),
  measurements: z.record(z.string(), centimetres),
  confirmed: z.literal(true),
}).superRefine((value, context) => {
  const definition = measurementCatalog.find((item) => item.id === value.garment);
  const keys = Object.keys(value.measurements);
  if (!definition || keys.length !== definition.fields.length ||
    !definition.fields.every((field) => Object.hasOwn(value.measurements, field.key))) {
    context.addIssue({ code: 'custom', message: 'Measurements do not match garment' });
  }
});
