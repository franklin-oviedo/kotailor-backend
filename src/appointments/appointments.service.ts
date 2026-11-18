import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseError, type PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { queryPage } from '../database/pagination.js';
import {
  AppointmentActor, AppointmentKind, AppointmentStatus, AppointmentSyncStatus, appointmentRangeSchema, cancelAppointmentSchema,
  createAppointmentSchema, rescheduleAppointmentSchema,
} from './appointments.schema.js';

interface AppointmentIdentity {
  id: string;
  customerId: string;
  status: AppointmentStatus;
  version: number;
}

export interface AppointmentListItem {
  id: string;
  customerId: string;
  customerName: string;
  orderId: string | null;
  orderNumber: number | null;
  responsibleId: string;
  responsibleName: string;
  kind: AppointmentKind;
  startsAt: string;
  endsAt: string;
  version: number;
  synced: boolean;
  syncStatus: AppointmentSyncStatus;
}

@Injectable()
export class AppointmentsService {
  constructor(@Inject(Database) private readonly database: Database) {}

  async customerOptions(workshopId: string, userId: string) {
    this.validateContext(workshopId, userId, AppointmentActor.Customer);
    const [customers, responsibles] = await Promise.all([
      this.database.pool.query<{ id: string; name: string }>(
        `SELECT c.id, c.name FROM customer_account_links l
         JOIN customers c ON c.id = l.customer_id AND c.workshop_id = l.workshop_id
         WHERE l.workshop_id = $1 AND l.user_id = $2 ORDER BY c.name, c.id`,
        [workshopId, userId],
      ),
      this.database.pool.query<{ id: string; name: string }>(
        `SELECT u.id, u.display_name AS name FROM workshop_memberships m
         JOIN app_users u ON u.id = m.user_id
         WHERE m.workshop_id = $1 ORDER BY u.display_name, u.id`,
        [workshopId],
      ),
    ]);
    if (!customers.rowCount) throw new NotFoundException('Appointment access denied');
    return { customers: customers.rows, responsibles: responsibles.rows };
  }

  async list(workshopId: string, userId: string, actor: AppointmentActor, from: unknown, to: unknown, page?: unknown, pageSize?: unknown) {
    this.validateContext(workshopId, userId, actor);
    const parsed = appointmentRangeSchema.safeParse({ from, to });
    if (!parsed.success) throw new BadRequestException('Invalid appointment date range');
    const access = actor === AppointmentActor.Workshop
      ? `SELECT NULL::uuid AS customer_id FROM workshop_memberships
         WHERE workshop_id = $1 AND user_id = $2 AND role IN ('owner', 'manager')`
      : `SELECT customer_id FROM customer_account_links WHERE workshop_id = $1 AND user_id = $2`;
    const values = [workshopId, userId, parsed.data.from, parsed.data.to];
    const result = await this.database.pool.query(`SELECT 1 FROM (${access}) allowed LIMIT 1`, values.slice(0, 2));
    if (!result.rowCount) throw new NotFoundException('Appointment access denied');
    const records = `WITH access AS (${access})
         SELECT a.id, a.starts_at, json_build_object(
           'id', a.id, 'customerId', a.customer_id, 'customerName', a.customer_name,
           'orderId', a.order_id, 'orderNumber', a.order_number, 'responsibleId', a.responsible_id,
           'responsibleName', a.responsible_name, 'kind', a.kind, 'startsAt', a.starts_at,
           'endsAt', a.ends_at, 'version', a.version, 'synced', a.synced_version = a.version,
           'syncStatus', CASE
             WHEN a.selected_calendar_id IS NULL THEN 'not_connected'
             WHEN a.pending_calendar_id IS NOT NULL THEN 'moving'
             WHEN a.synced_version = a.version THEN 'synced'
             WHEN a.calendar_retry_version = a.version AND a.calendar_sync_failure = 'reconciliation' THEN 'needs_attention'
             WHEN a.calendar_retry_version = a.version AND a.calendar_sync_failure = 'unavailable' THEN 'retrying'
             ELSE 'pending' END
         ) AS appointment
         FROM (
           SELECT a.*, c.name AS customer_name, u.display_name AS responsible_name, o.number AS order_number,
                  cc.selected_calendar_id, cc.pending_calendar_id
           FROM appointments a
           JOIN customers c ON c.id = a.customer_id AND c.workshop_id = a.workshop_id
           JOIN app_users u ON u.id = a.responsible_id
           LEFT JOIN workshop_orders o ON o.workshop_id = a.workshop_id AND o.id = a.order_id
           LEFT JOIN workshop_calendar_connections cc ON cc.workshop_id = a.workshop_id
           WHERE a.workshop_id = $1 AND a.status = 'scheduled'
             AND EXISTS (SELECT 1 FROM access WHERE customer_id IS NULL OR customer_id = a.customer_id)
             AND a.starts_at < ($4::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
             AND a.ends_at > ($3::date::timestamp AT TIME ZONE 'America/Santo_Domingo')
         ) a`;
    const { rows, ...pagination } = await queryPage(this.database.pool, records, values, 'starts_at, id', page, pageSize);
    return { appointments: rows.map((row) => row.appointment as AppointmentListItem), ...pagination };
  }

  async create(workshopId: string, userId: string, actor: AppointmentActor, body: unknown) {
    this.validateContext(workshopId, userId, actor);
    const parsed = createAppointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid appointment');
    const { requestId, ...input } = parsed.data;
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.transaction(async (client) => {
      await this.authorize(client, workshopId, userId, actor, input.customerId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`appointment:${workshopId}:${userId}:${requestId}`]);
      const previous = await client.query<{ id: string; requestHash: string }>(
        `SELECT id, request_hash AS "requestHash" FROM appointments
         WHERE workshop_id = $1 AND created_by = $2 AND request_id = $3`,
        [workshopId, userId, requestId],
      );
      if (previous.rowCount) {
        if (previous.rows[0].requestHash !== requestHash) throw new ConflictException('Appointment request changed');
        return { id: previous.rows[0].id };
      }
      await this.requireNoCalendarMove(client, workshopId);
      await this.requireResponsible(client, workshopId, input.responsibleId);
      const customer = await client.query('SELECT 1 FROM customers WHERE workshop_id = $1 AND id = $2 FOR SHARE',
        [workshopId, input.customerId]);
      if (!customer.rowCount) throw new BadRequestException('Invalid customer');
      if (input.orderId) {
        const order = await client.query(
          'SELECT 1 FROM workshop_orders WHERE workshop_id = $1 AND customer_id = $2 AND id = $3 FOR SHARE',
          [workshopId, input.customerId, input.orderId],
        );
        if (!order.rowCount) throw new BadRequestException('Invalid order');
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO appointments
         (workshop_id, customer_id, order_id, responsible_id, kind, starts_at, ends_at,
          created_by, updated_by, request_id, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING id`,
        [workshopId, input.customerId, input.orderId, input.responsibleId, input.kind,
          input.startsAt, input.endsAt, userId, requestId, requestHash],
      );
      return result.rows[0];
    });
  }

  async reschedule(workshopId: string, userId: string, actor: AppointmentActor, id: string, body: unknown) {
    this.validateContext(workshopId, userId, actor, id);
    const parsed = rescheduleAppointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid appointment change');
    return this.transaction(async (client) => {
      await this.authorizeAppointment(client, workshopId, userId, actor, id);
      await this.requireNoCalendarMove(client, workshopId);
      const appointment = await this.lockAppointment(client, workshopId, id);
      await this.authorize(client, workshopId, userId, actor, appointment.customerId);
      this.requireScheduledVersion(appointment, parsed.data.expectedVersion);
      await this.requireResponsible(client, workshopId, parsed.data.responsibleId);
      const result = await client.query<{ version: number }>(
        `UPDATE appointments SET responsible_id = $3, starts_at = $4, ends_at = $5, calendar_absence_seen_at = NULL,
         version = version + 1, updated_at = now(), updated_by = $6
         WHERE workshop_id = $1 AND id = $2 RETURNING version`,
        [workshopId, id, parsed.data.responsibleId, parsed.data.startsAt, parsed.data.endsAt, userId],
      );
      return result.rows[0];
    });
  }

  async cancel(workshopId: string, userId: string, actor: AppointmentActor, id: string, body: unknown) {
    this.validateContext(workshopId, userId, actor, id);
    const parsed = cancelAppointmentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid appointment cancellation');
    return this.transaction(async (client) => {
      await this.authorizeAppointment(client, workshopId, userId, actor, id);
      await this.requireNoCalendarMove(client, workshopId);
      const appointment = await this.lockAppointment(client, workshopId, id);
      await this.authorize(client, workshopId, userId, actor, appointment.customerId);
      this.requireScheduledVersion(appointment, parsed.data.expectedVersion);
      const result = await client.query<{ version: number }>(
        `UPDATE appointments SET status = 'cancelled', version = version + 1, calendar_absence_seen_at = NULL,
         updated_at = now(), updated_by = $3 WHERE workshop_id = $1 AND id = $2 RETURNING version`,
        [workshopId, id, userId],
      );
      return result.rows[0];
    });
  }

  private validateContext(workshopId: string, userId: string, actor: AppointmentActor, id?: string): void {
    if (!z.uuid().safeParse(workshopId).success || !z.uuid().safeParse(userId).success
        || !z.enum(AppointmentActor).safeParse(actor).success || (id !== undefined && !z.uuid().safeParse(id).success)) {
      throw new BadRequestException('Invalid appointment context');
    }
  }

  private async authorize(client: PoolClient, workshopId: string, userId: string, actor: AppointmentActor, customerId: string) {
    const result = actor === AppointmentActor.Workshop
      ? await client.query(
        `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
         AND role IN ('owner', 'manager') FOR SHARE`, [workshopId, userId],
      )
      : await client.query(
        `SELECT 1 FROM customer_account_links
         WHERE workshop_id = $1 AND user_id = $2 AND customer_id = $3 FOR SHARE`, [workshopId, userId, customerId],
      );
    if (!result.rowCount) throw new NotFoundException('Appointment access denied');
  }

  private async authorizeAppointment(client: PoolClient, workshopId: string, userId: string, actor: AppointmentActor, id: string) {
    const result = actor === AppointmentActor.Workshop
      ? await client.query(
        `SELECT 1 FROM appointments a JOIN workshop_memberships m ON m.workshop_id = a.workshop_id
         WHERE a.workshop_id = $1 AND m.user_id = $2 AND a.id = $3
           AND m.role IN ('owner', 'manager') FOR SHARE OF m`, [workshopId, userId, id],
      )
      : await client.query(
        `SELECT 1 FROM appointments a JOIN customer_account_links l
           ON l.workshop_id = a.workshop_id AND l.customer_id = a.customer_id
         WHERE a.workshop_id = $1 AND l.user_id = $2 AND a.id = $3 FOR SHARE OF l`, [workshopId, userId, id],
      );
    if (!result.rowCount) throw new NotFoundException('Appointment access denied');
  }

  private async requireResponsible(client: PoolClient, workshopId: string, responsibleId: string) {
    const result = await client.query(
      'SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 FOR SHARE',
      [workshopId, responsibleId],
    );
    if (!result.rowCount) throw new BadRequestException('Invalid responsible member');
  }

  private async requireNoCalendarMove(client: PoolClient, workshopId: string): Promise<void> {
    const workshop = await client.query<{ pending: string | null }>(
      `SELECT (SELECT pending_calendar_id FROM workshop_calendar_connections WHERE workshop_id = w.id) AS pending
       FROM workshops w WHERE w.id = $1 FOR UPDATE`, [workshopId],
    );
    if (!workshop.rowCount) throw new NotFoundException('Appointment access denied');
    if (workshop.rows[0].pending) throw new ConflictException('Appointments cannot be changed during a calendar move');
  }

  private async lockAppointment(client: PoolClient, workshopId: string, id: string): Promise<AppointmentIdentity> {
    const result = await client.query<AppointmentIdentity>(
      `SELECT id, customer_id AS "customerId", status, version FROM appointments
       WHERE workshop_id = $1 AND id = $2 FOR UPDATE`, [workshopId, id],
    );
    if (!result.rowCount) throw new NotFoundException('Appointment not found');
    return result.rows[0];
  }

  private requireScheduledVersion(appointment: AppointmentIdentity, expectedVersion: number): void {
    if (appointment.status !== AppointmentStatus.Scheduled || appointment.version !== expectedVersion) {
      throw new ConflictException('Appointment changed');
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof DatabaseError && error.constraint === 'appointments_responsible_no_overlap') {
        throw new ConflictException('Responsible is unavailable');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
