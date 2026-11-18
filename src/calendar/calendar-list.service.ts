import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';
import { GoogleCalendarList, type CalendarListPage } from './google-calendar-list.js';

export interface CalendarConnectionSnapshot {
  token: Buffer;
  epoch: string;
}

@Injectable()
export class CalendarListService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarTokenCipher) private readonly cipher: CalendarTokenCipher,
    @Inject(GoogleCalendarList) private readonly google: GoogleCalendarList,
  ) {}

  async list(workshopId: string, userId: string, pageToken: unknown): Promise<CalendarListPage> {
    if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken || pageToken.length > 4096)) {
      throw new BadRequestException('Invalid calendar list request');
    }
    const { token, epoch } = await this.connection(workshopId, userId);
    const result = await this.google.list(this.cipher.decrypt(workshopId, token), pageToken);
    const current = await this.database.pool.query(
      `SELECT 1 FROM workshop_memberships m
       JOIN workshops w ON w.id = m.workshop_id
       JOIN workshop_calendar_connections c ON c.workshop_id = m.workshop_id
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')
         AND w.calendar_connection_epoch = $3 AND c.encrypted_refresh_token = $4`,
      [workshopId, userId, epoch, token],
    );
    if (!current.rowCount) throw new ConflictException('Calendar connection or access changed');
    return result;
  }

  async requireWritable(workshopId: string, userId: string, calendarId: string): Promise<CalendarConnectionSnapshot> {
    const connection = await this.connection(workshopId, userId);
    await this.google.requireWritable(this.cipher.decrypt(workshopId, connection.token), calendarId);
    return connection;
  }

  private async connection(workshopId: string, userId: string): Promise<CalendarConnectionSnapshot> {
    if (!z.uuid().safeParse(workshopId).success || !z.uuid().safeParse(userId).success) {
      throw new BadRequestException('Invalid calendar list request');
    }
    const connection = await this.database.pool.query<{ token: Buffer | null; epoch: string }>(
      `SELECT c.encrypted_refresh_token AS token, w.calendar_connection_epoch AS epoch
       FROM workshop_memberships m
       JOIN workshops w ON w.id = m.workshop_id
       LEFT JOIN workshop_calendar_connections c ON c.workshop_id = m.workshop_id
       WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager')`,
      [workshopId, userId],
    );
    if (!connection.rowCount) throw new NotFoundException('Calendar access denied');
    const { token, epoch } = connection.rows[0];
    if (!token) throw new ConflictException('Google Calendar is not connected');

    return { token, epoch };
  }
}
