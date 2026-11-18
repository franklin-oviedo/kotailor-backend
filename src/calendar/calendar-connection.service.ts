import { createHash } from 'node:crypto';
import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { type OAuthFlow } from '../auth/auth.types.js';
import { Database } from '../database/database.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';
import { GoogleCalendarOAuth } from './google-calendar-oauth.js';

type CalendarAuthorization = Pick<GoogleCalendarOAuth, 'begin' | 'exchange'>;

@Injectable()
export class CalendarConnectionService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(GoogleCalendarOAuth) private readonly oauth: CalendarAuthorization,
    @Inject(CalendarTokenCipher) private readonly cipher: CalendarTokenCipher,
  ) {}

  async begin(workshopId: string, userId: string, sessionId: string): Promise<{ url: string }> {
    this.validateContext(userId, sessionId, workshopId);
    const { flow, url } = this.oauth.begin();
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireManager(client, workshopId, userId);
      const workshop = await client.query<{ epoch: string }>(
        'SELECT calendar_connection_epoch AS epoch FROM workshops WHERE id = $1 FOR SHARE', [workshopId],
      );
      if (!workshop.rowCount) throw new NotFoundException('Calendar access denied');
      await client.query(
        'DELETE FROM calendar_authorization_flows WHERE workshop_id = $1 AND user_id = $2 AND expires_at <= now()',
        [workshopId, userId],
      );
      await client.query(
        `INSERT INTO calendar_authorization_flows
         (state_hash, session_hash, workshop_id, user_id, nonce, verifier, expires_at, connection_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.hash(flow.state), this.hash(sessionId), workshopId, userId,
          flow.nonce, flow.verifier, new Date(flow.expiresAt), workshop.rows[0].epoch],
      );
      await client.query('COMMIT');
      return { url };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(userId: string, sessionId: string, state: unknown, code: unknown): Promise<{ workshopId: string }> {
    if (typeof code !== 'string' || !code || code.length > 4096) {
      throw new UnauthorizedException('Invalid calendar authorization');
    }
    const { workshopId, flow, connectionEpoch } = await this.consume(userId, sessionId, state);
    const connection = await this.oauth.exchange(code, flow);
    const encryptedToken = this.cipher.encrypt(workshopId, connection.refreshToken);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireManager(client, workshopId, userId);
      const workshop = await client.query<{ epoch: string }>(
        'SELECT calendar_connection_epoch AS epoch FROM workshops WHERE id = $1 FOR UPDATE', [workshopId],
      );
      if (!workshop.rowCount || workshop.rows[0].epoch !== connectionEpoch) {
        throw new ConflictException('Calendar authorization was invalidated');
      }
      const current = await client.query<{ subject: string }>(
        'SELECT google_subject AS subject FROM workshop_calendar_connections WHERE workshop_id = $1 FOR UPDATE',
        [workshopId],
      );
      if (current.rowCount && current.rows[0].subject !== connection.subject) {
        throw new ConflictException('Disconnect the existing calendar account before connecting another');
      }
      await client.query(
        `INSERT INTO workshop_calendar_connections
         (workshop_id, google_subject, google_email, encrypted_refresh_token, connected_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workshop_id) DO UPDATE SET google_email = EXCLUDED.google_email,
           encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, connected_by = EXCLUDED.connected_by,
           updated_at = now()`,
        [workshopId, connection.subject, connection.email, encryptedToken, userId],
      );
      await client.query('COMMIT');
      return { workshopId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancel(userId: string, sessionId: string, state: unknown): Promise<void> {
    await this.consume(userId, sessionId, state);
  }

  async status(workshopId: string, userId: string): Promise<{ connected: boolean; email: string | null }> {
    this.validateIdentity(userId, workshopId);
    const result = await this.database.pool.query<{ email: string | null }>(
      `SELECT c.google_email AS email FROM workshop_memberships m
       LEFT JOIN workshop_calendar_connections c ON c.workshop_id = m.workshop_id
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')`,
      [workshopId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Calendar access denied');
    return { connected: result.rows[0].email !== null, email: result.rows[0].email };
  }

  async disconnect(workshopId: string, userId: string): Promise<void> {
    this.validateIdentity(userId, workshopId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.requireManager(client, workshopId, userId);
      await client.query('UPDATE workshops SET calendar_connection_epoch = calendar_connection_epoch + 1 WHERE id = $1', [workshopId]);
      const connection = await client.query<{ pending: string | null }>(
        'SELECT pending_calendar_id AS pending FROM workshop_calendar_connections WHERE workshop_id = $1 FOR UPDATE', [workshopId],
      );
      if (connection.rows[0]?.pending) throw new ConflictException('Calendar move must finish before disconnecting');
      await client.query('DELETE FROM calendar_authorization_flows WHERE workshop_id = $1', [workshopId]);
      await client.query('DELETE FROM workshop_calendar_connections WHERE workshop_id = $1', [workshopId]);
      await client.query(
        `UPDATE appointments SET synced_version = 0, calendar_absence_seen_at = NULL
         WHERE workshop_id = $1 AND (synced_version <> 0 OR calendar_absence_seen_at IS NOT NULL)`, [workshopId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async consume(userId: string, sessionId: string, state: unknown): Promise<{
    workshopId: string; flow: OAuthFlow; connectionEpoch: string;
  }> {
    this.validateContext(userId, sessionId);
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
      throw new UnauthorizedException('Invalid calendar authorization');
    }
    const consumed = await this.database.pool.query<{
      workshopId: string; nonce: string; verifier: string; expiresAt: Date; connectionEpoch: string;
    }>(
      `DELETE FROM calendar_authorization_flows
       WHERE state_hash = $1 AND session_hash = $2 AND user_id = $3 AND expires_at > now()
       RETURNING workshop_id AS "workshopId", nonce, verifier, expires_at AS "expiresAt", connection_epoch AS "connectionEpoch"`,
      [this.hash(state), this.hash(sessionId), userId],
    );
    if (!consumed.rowCount) throw new UnauthorizedException('Invalid or expired calendar authorization');
    const { workshopId, nonce, verifier, expiresAt, connectionEpoch } = consumed.rows[0];
    const flow: OAuthFlow = { state, nonce, verifier, expiresAt: expiresAt.getTime() };
    return { workshopId, flow, connectionEpoch };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private validateContext(userId: string, sessionId: string, workshopId?: string): void {
    this.validateIdentity(userId, workshopId);
    if (!sessionId || sessionId.length > 512) {
      throw new BadRequestException('Invalid calendar authorization context');
    }
  }

  private validateIdentity(userId: string, workshopId?: string): void {
    if (!z.uuid().safeParse(userId).success || (workshopId !== undefined && !z.uuid().safeParse(workshopId).success)) {
      throw new BadRequestException('Invalid calendar authorization context');
    }
  }

  private async requireManager(client: PoolClient, workshopId: string, userId: string): Promise<void> {
    const membership = await client.query(
      `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager') FOR SHARE`, [workshopId, userId],
    );
    if (!membership.rowCount) throw new NotFoundException('Calendar access denied');
  }
}
