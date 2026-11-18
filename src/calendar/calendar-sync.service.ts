import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AppointmentKind, AppointmentStatus } from '../appointments/appointments.schema.js';
import { Database } from '../database/database.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';
import { CalendarEventRemoval, GoogleCalendarEvents } from './google-calendar-events.js';

export enum CalendarSyncResult {
  Synced = 'synced',
  UpToDate = 'up_to_date',
  NotConnected = 'not_connected',
  MovePending = 'move_pending',
  AwaitingConfirmation = 'awaiting_confirmation',
}

export const CALENDAR_ABSENCE_DELAY_SECONDS = 30;

@Injectable()
export class CalendarSyncService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarTokenCipher) private readonly cipher: CalendarTokenCipher,
    @Inject(GoogleCalendarEvents) private readonly events: GoogleCalendarEvents,
  ) {}

  async synchronize(workshopId: string, appointmentId: string): Promise<CalendarSyncResult> {
    if (!z.uuid().safeParse(workshopId).success || !z.uuid().safeParse(appointmentId).success) {
      throw new BadRequestException('Invalid calendar synchronization context');
    }

    await this.database.pool.query(
      `UPDATE appointments a SET calendar_sync_attempted = true
       FROM workshop_calendar_connections c
       WHERE a.workshop_id = $1 AND a.id = $2 AND a.status = 'scheduled'
         AND a.synced_version < a.version AND c.workshop_id = a.workshop_id
         AND c.selected_calendar_id IS NOT NULL AND c.pending_calendar_id IS NULL`,
      [workshopId, appointmentId],
    );
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const workshop = await client.query('SELECT id FROM workshops WHERE id = $1 FOR UPDATE', [workshopId]);
      if (!workshop.rowCount) throw new NotFoundException('Workshop not found');
      const connection = await client.query<{ calendarId: string | null; pendingId: string | null; token: Buffer }>(
        `SELECT selected_calendar_id AS "calendarId", pending_calendar_id AS "pendingId",
                encrypted_refresh_token AS token
         FROM workshop_calendar_connections WHERE workshop_id = $1 FOR UPDATE`, [workshopId],
      );
      const appointment = await client.query<{
        id: string; customerId: string; kind: AppointmentKind; status: AppointmentStatus;
        startsAt: Date; endsAt: Date; version: number; syncedVersion: number; attempted: boolean;
        absenceSeen: boolean; absenceReady: boolean;
      }>(
        `SELECT id, customer_id AS "customerId", kind, status, starts_at AS "startsAt", ends_at AS "endsAt",
                version, synced_version AS "syncedVersion", calendar_sync_attempted AS attempted,
                calendar_absence_seen_at IS NOT NULL AS "absenceSeen",
                COALESCE(calendar_absence_seen_at <= now() - make_interval(secs => $3), false) AS "absenceReady"
         FROM appointments WHERE workshop_id = $1 AND id = $2 FOR UPDATE`,
        [workshopId, appointmentId, CALENDAR_ABSENCE_DELAY_SECONDS],
      );
      if (!appointment.rowCount) throw new NotFoundException('Appointment not found');
      const row = appointment.rows[0];
      const target = connection.rows[0];
      if (!target?.calendarId) {
        await client.query('COMMIT');
        return CalendarSyncResult.NotConnected;
      }
      if (target.pendingId) {
        await client.query('COMMIT');
        return CalendarSyncResult.MovePending;
      }
      if (row.syncedVersion === row.version) {
        await client.query('COMMIT');
        return CalendarSyncResult.UpToDate;
      }
      const token = this.cipher.decrypt(workshopId, target.token);
      const identity = { workshopId, appointmentId: row.id, version: row.version };
      if (row.status === AppointmentStatus.Cancelled) {
        if (row.attempted) {
          if (row.absenceSeen && !row.absenceReady) {
            await client.query('COMMIT');
            return CalendarSyncResult.AwaitingConfirmation;
          }
          const removal = await this.events.remove(token, target.calendarId, identity);
          if (removal === CalendarEventRemoval.NotFound
              || (removal === CalendarEventRemoval.Cancelled && row.syncedVersion === 0)) {
            if (!row.absenceReady) {
              await client.query(
                `UPDATE appointments SET calendar_absence_seen_at = now(), calendar_retry_version = version,
                   calendar_retry_count = 0, calendar_sync_failure = NULL,
                   calendar_retry_at = now() + make_interval(secs => $3)
                 WHERE workshop_id = $1 AND id = $2`, [workshopId, appointmentId, CALENDAR_ABSENCE_DELAY_SECONDS],
              );
              await client.query('COMMIT');
              return CalendarSyncResult.AwaitingConfirmation;
            }
          }
        }
      } else {
        const customer = await client.query<{ name: string }>(
          'SELECT name FROM customers WHERE workshop_id = $1 AND id = $2 FOR SHARE', [workshopId, row.customerId],
        );
        if (!customer.rowCount) throw new NotFoundException('Appointment customer not found');
        await this.events.upsert(token, target.calendarId, {
          ...identity, kind: row.kind, customerName: customer.rows[0].name,
          startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(),
        });
      }
      await client.query(`UPDATE appointments SET synced_version = $3, calendar_retry_version = $3,
        calendar_retry_count = 0, calendar_sync_failure = NULL, calendar_retry_at = now(), calendar_absence_seen_at = NULL
        WHERE workshop_id = $1 AND id = $2`,
        [workshopId, appointmentId, row.version]);
      await client.query('COMMIT');
      return CalendarSyncResult.Synced;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
