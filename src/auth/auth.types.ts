export enum MembershipRole {
  Owner = 'owner',
  Manager = 'manager',
  Staff = 'staff',
}

export enum AuthenticationError {
  Cancelled = 'cancelled',
  InvalidFlow = 'invalid_flow',
  GoogleUnavailable = 'google_unavailable',
}

export enum AuthDestination {
  Workshop = 'workshop',
  ClientPortal = 'client_portal',
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

export interface WorkshopMembership {
  id: string;
  name: string;
  role: MembershipRole;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  name: string;
}

export interface OAuthFlow {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export const SESSION_COOKIE = 'kotailor.sid';
export const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
export const OAUTH_DURATION_MS = 5 * 60 * 1000;

declare module 'express-session' {
  interface SessionData {
    oauth?: OAuthFlow;
    userId?: string;
    authenticatedUntil?: number;
    pendingInvitation?: string;
    authDestination?: AuthDestination;
  }
}
