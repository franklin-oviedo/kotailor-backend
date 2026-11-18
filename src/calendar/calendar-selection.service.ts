import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { CalendarListService } from './calendar-list.service.js';

const selectionSchema = z.strictObject({
  calendarId: z.string().min(1).max(1024).refine(
    (value) => value !== '.' && value !== '..'
      && Array.from(value).every((character) => (character.codePointAt(0) ?? 0) >= 32 && character.codePointAt(0) !== 127),
  ),
  expectedVersion: z.number().int().min(0).max(2147483647),
});

export interface CalendarSelection {
  selectedCalendarId: string | null;
  pendingCalendarId: string | null;
  version: number;
}

export enum CalendarMoveFailure {
  Unavailable = 'unavailable',
  Reconciliation = 'reconciliation',
}

@Injectable()
export class CalendarSelectionService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarListService) private readonly calendars: CalendarListService,
  ) {}

  async status(workshopId: string, userId: string): Promise<CalendarSelection> {
    this.validateIdentity(workshopId, userId);
    const result = await this.database.pool.query<Omit<CalendarSelection, 'version'> & { version: number | null }>(
      `SELECT c.selected_calendar_id AS "selectedCalendarId", c.pending_calendar_id AS "pendingCalendarId",
              c.selection_version AS version
       FROM workshop_memberships m
       LEFT JOIN workshop_calendar_connections c ON c.workshop_id = m.workshop_id
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')`,
      [workshopId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Calendar access denied');
    const { selectedCalendarId, pendingCalendarId, version } = result.rows[0];
    if (version === null) throw new ConflictException('Google Calendar is not connected');
    return { selectedCalendarId, pendingCalendarId, version };
  }

  async moveStatus(workshopId: string, userId: string): Promise<{
    inProgress: boolean; failure: CalendarMoveFailure | null; retryAt: Date | null;
  }> {
    this.validateIdentity(workshopId, userId);
    const result = await this.database.pool.query<{
      connected: boolean; inProgress: boolean; failure: CalendarMoveFailure | null; retryAt: Date | null;
    }>(
      `SELECT c.workshop_id IS NOT NULL AS connected, c.pending_calendar_id IS NOT NULL AS "inProgress",
              c.move_failure AS failure, CASE WHEN c.pending_calendar_id IS NULL THEN NULL ELSE c.move_retry_at END AS "retryAt"
       FROM workshop_memberships m LEFT JOIN workshop_calendar_connections c ON c.workshop_id = m.workshop_id
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')`, [workshopId, userId],
    );
    if (!result.rowCount) throw new NotFoundException('Calendar access denied');
    const { connected, inProgress, failure, retryAt } = result.rows[0];
    if (!connected) throw new ConflictException('Google Calendar is not connected');
    return { inProgress, failure: inProgress ? failure : null, retryAt };
  }

  async select(workshopId: string, userId: string, body: unknown): Promise<CalendarSelection> {
    return this.selectCalendar(workshopId, userId, body, true);
  }

  async selectInitial(workshopId: string, userId: string, body: unknown): Promise<CalendarSelection> {
    return this.selectCalendar(workshopId, userId, body, false);
  }

  private async selectCalendar(workshopId: string, userId: string, body: unknown, allowMove: boolean): Promise<CalendarSelection> {
    this.validateIdentity(workshopId, userId);
    const parsed = selectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid calendar selection');
    const { calendarId, expectedVersion } = parsed.data;
    const snapshot = await this.calendars.requireWritable(workshopId, userId, calendarId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
         AND role IN ('owner', 'manager') FOR SHARE`, [workshopId, userId],
      );
      if (!membership.rowCount) throw new NotFoundException('Calendar access denied');
      const workshop = await client.query<{ epoch: string }>(
        'SELECT calendar_connection_epoch AS epoch FROM workshops WHERE id = $1 FOR UPDATE', [workshopId],
      );
      if (!workshop.rowCount || workshop.rows[0].epoch !== snapshot.epoch) {
        throw new ConflictException('Calendar connection changed');
      }
      const connection = await client.query<CalendarSelection & { token: Buffer }>(
        `SELECT selected_calendar_id AS "selectedCalendarId", pending_calendar_id AS "pendingCalendarId",
                selection_version AS version, encrypted_refresh_token AS token
         FROM workshop_calendar_connections WHERE workshop_id = $1 FOR UPDATE`, [workshopId],
      );
      if (!connection.rowCount || !connection.rows[0].token.equals(snapshot.token)) {
        throw new ConflictException('Calendar connection changed');
      }
      const current = connection.rows[0];
      if (current.version !== expectedVersion) throw new ConflictException('Calendar selection changed');
      if (current.pendingCalendarId && current.pendingCalendarId !== calendarId) {
        throw new ConflictException('Calendar migration is already pending');
      }
      if (!allowMove && current.selectedCalendarId !== null && current.selectedCalendarId !== calendarId) {
        throw new ServiceUnavailableException('Changing calendars is not yet available');
      }
      if (current.pendingCalendarId === calendarId || (!current.pendingCalendarId && current.selectedCalendarId === calendarId)) {
        await client.query('COMMIT');
        return { selectedCalendarId: current.selectedCalendarId, pendingCalendarId: current.pendingCalendarId, version: current.version };
      }
      if (current.version === 2147483647) throw new ConflictException('Calendar selection version limit reached');
      if (current.selectedCalendarId !== null && current.version === 2147483646) {
        throw new ConflictException('Calendar selection version limit reached');
      }
      const updated = await client.query<CalendarSelection>(
        `UPDATE workshop_calendar_connections
         SET selected_calendar_id = CASE WHEN selected_calendar_id IS NULL THEN $2 ELSE selected_calendar_id END,
             pending_calendar_id = CASE WHEN selected_calendar_id IS NULL THEN NULL ELSE $2 END,
             selection_version = selection_version + 1, updated_at = now(),
             move_retry_count = 0, move_retry_at = now(), move_failure = NULL
         WHERE workshop_id = $1
         RETURNING selected_calendar_id AS "selectedCalendarId", pending_calendar_id AS "pendingCalendarId",
                   selection_version AS version`,
        [workshopId, calendarId],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private validateIdentity(workshopId: string, userId: string): void {
    if (!z.uuid().safeParse(workshopId).success || !z.uuid().safeParse(userId).success) {
      throw new BadRequestException('Invalid calendar selection context');
    }
  }
}
