import { z } from 'zod';

export enum PlatformInviteKind {
  CreateWorkshop = 'create_workshop',
  AuthorizeCreator = 'authorize_creator',
}

const email = z.email().max(254).transform((value) => value.toLowerCase());
const workshopName = z.string().trim().min(2).max(200);

export const platformInvitationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(PlatformInviteKind.CreateWorkshop), email, workshopName }),
  z.strictObject({ kind: z.literal(PlatformInviteKind.AuthorizeCreator), email }),
]);
export const stageInvitationSchema = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const workshopSchema = z.strictObject({ name: workshopName });

export const customerInvitationSchema = z.strictObject({ email });
export enum CustomerInvitationChoice { Existing = 'existing', New = 'new' }
export const customerAcceptanceSchema = z.discriminatedUnion('choice', [
  z.strictObject({ choice: z.literal(CustomerInvitationChoice.Existing), customerId: z.uuid() }),
  z.strictObject({
    choice: z.literal(CustomerInvitationChoice.New),
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30).regex(/^[0-9+().\s-]+$/),
  }),
]);
