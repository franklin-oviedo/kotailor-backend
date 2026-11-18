import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AppointmentKind, AppointmentStatus } from '../appointments/appointments.schema.js';
import { Database } from '../database/database.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';
import { CalendarEventRemoval, GoogleCalendarEvents } from './google-calendar-events.js';
import { CALENDAR_ABSENCE_DELAY_SECONDS } from './calendar-sync.service.js';

export enum CalendarMoveResult {
  Idle = 'idle',
  Progress = 'progress',
  Finished = 'finished',
  AwaitingConfirmation = 'awaiting_confirmation',
}

@Injectable()
export class CalendarMoveService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarTokenCipher) private readonly cipher: CalendarTokenCipher,
    @Inject(GoogleCalendarEvents) private readonly events: GoogleCalendarEvents,
  ) {}

  async processNext(workshopId: string): Promise<CalendarMoveResult> {
    if (!z.uuid().safeParse(workshopId).success) throw new BadRequestException('Invalid calendar move context');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const workshop = await client.query('SELECT id FROM workshops WHERE id = $1 FOR UPDATE', [workshopId]);
      if (!workshop.rowCount) throw new NotFoundException('Workshop not found');
      const connection = await client.query<{
        source: string | null; destination: string | null; selectionVersion: number; token: Buffer;
      }>(
        `SELECT selected_calendar_id AS source, pending_calendar_id AS destination,
                selection_version AS "selectionVersion", encrypted_refresh_token AS token
         FROM workshop_calendar_connections WHERE workshop_id = $1 FOR UPDATE`, [workshopId],
      );
      const target = connection.rows[0];
      if (!target?.source || !target.destination) {
        await client.query('COMMIT');
        return CalendarMoveResult.Idle;
      }
      const appointments = await client.query<{
        id: string; customerId: string; kind: AppointmentKind; status: AppointmentStatus;
        startsAt: Date; endsAt: Date; version: number; syncedVersion: number;
        attempted: boolean; destinationReady: boolean | null; absenceSeen: boolean; absenceReady: boolean;
      }>(
        `SELECT a.id, a.customer_id AS "customerId", a.kind, a.status, a.starts_at AS "startsAt",
                a.ends_at AS "endsAt", a.version, a.synced_version AS "syncedVersion",
                a.calendar_sync_attempted AS attempted, p.destination_ready AS "destinationReady",
                p.source_absence_seen_at IS NOT NULL AS "absenceSeen",
                COALESCE(p.source_absence_seen_at <= now() - make_interval(secs => $3), false) AS "absenceReady"
         FROM appointments a LEFT JOIN calendar_move_progress p ON p.workshop_id = a.workshop_id
           AND p.appointment_id = a.id AND p.selection_version = $2
         WHERE a.workshop_id = $1 AND COALESCE(p.source_removed, false) = false
         ORDER BY a.id LIMIT 1 FOR UPDATE OF a`, [workshopId, target.selectionVersion, CALENDAR_ABSENCE_DELAY_SECONDS],
      );
      if (!appointments.rowCount) {
        if (target.selectionVersion === 2147483647) throw new ConflictException('Calendar selection version limit reached');
        await client.query(
          `UPDATE appointments SET synced_version = version, calendar_sync_attempted = (status = 'scheduled'),
             calendar_retry_version = version, calendar_retry_count = 0, calendar_sync_failure = NULL,
             calendar_retry_at = now(), calendar_absence_seen_at = NULL WHERE workshop_id = $1`, [workshopId],
        );
        await client.query(
          `UPDATE workshop_calendar_connections SET selected_calendar_id = pending_calendar_id,
             pending_calendar_id = NULL, selection_version = selection_version + 1, updated_at = now(),
             move_retry_count = 0, move_retry_at = now(), move_failure = NULL
           WHERE workshop_id = $1`, [workshopId],
        );
        await client.query('DELETE FROM calendar_move_progress WHERE workshop_id = $1', [workshopId]);
        await client.query('COMMIT');
        return CalendarMoveResult.Finished;
      }
      const row = appointments.rows[0];
      if (row.destinationReady && row.absenceSeen && !row.absenceReady) {
        await client.query(
          `UPDATE workshop_calendar_connections SET move_retry_at =
             (SELECT source_absence_seen_at + make_interval(secs => $4)
              FROM calendar_move_progress WHERE workshop_id = $1 AND appointment_id = $2 AND selection_version = $3)
           WHERE workshop_id = $1`, [workshopId, row.id, target.selectionVersion, CALENDAR_ABSENCE_DELAY_SECONDS],
        );
        await client.query('COMMIT');
        return CalendarMoveResult.AwaitingConfirmation;
      }
      const token = this.cipher.decrypt(workshopId, target.token);
      const identity = { workshopId, appointmentId: row.id, version: row.version };
      await client.query(
        `INSERT INTO calendar_move_progress (workshop_id, appointment_id, selection_version)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [workshopId, row.id, target.selectionVersion],
      );
      if (row.status === AppointmentStatus.Scheduled) {
        const customer = await client.query<{ name: string }>(
          'SELECT name FROM customers WHERE workshop_id = $1 AND id = $2 FOR SHARE', [workshopId, row.customerId],
        );
        if (!customer.rowCount) throw new NotFoundException('Appointment customer not found');
        await this.events.upsert(token, target.destination, {
          ...identity, kind: row.kind, customerName: customer.rows[0].name,
          startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(),
        });
      }
      if (!row.destinationReady) {
        await client.query(
          `UPDATE calendar_move_progress SET destination_ready = true
           WHERE workshop_id = $1 AND appointment_id = $2 AND selection_version = $3`,
          [workshopId, row.id, target.selectionVersion],
        );
      } else {
        if (row.attempted) {
          const removal = await this.events.remove(token, target.source, identity);
          if (removal === CalendarEventRemoval.NotFound
              || (removal === CalendarEventRemoval.Cancelled && row.syncedVersion === 0)) {
            if (!row.absenceReady) {
              await client.query(
                `UPDATE calendar_move_progress SET source_absence_seen_at = now()
                 WHERE workshop_id = $1 AND appointment_id = $2 AND selection_version = $3`,
                [workshopId, row.id, target.selectionVersion],
              );
              await client.query(
                `UPDATE workshop_calendar_connections SET move_retry_at = now() + make_interval(secs => $2),
                   move_retry_count = 0, move_failure = NULL WHERE workshop_id = $1`,
                [workshopId, CALENDAR_ABSENCE_DELAY_SECONDS],
              );
              await client.query('COMMIT');
              return CalendarMoveResult.AwaitingConfirmation;
            }
            await client.query(
              'UPDATE workshop_calendar_connections SET move_retry_count = 0, move_retry_at = now(), move_failure = NULL WHERE workshop_id = $1',
              [workshopId],
            );
          }
        }
        await client.query(
          `UPDATE calendar_move_progress SET source_removed = true
           WHERE workshop_id = $1 AND appointment_id = $2 AND selection_version = $3`,
          [workshopId, row.id, target.selectionVersion],
        );
      }
      await client.query('COMMIT');
      return CalendarMoveResult.Progress;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
