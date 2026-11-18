import { BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Database } from '../database/database.js';
import { CalendarSyncResult, CalendarSyncService } from './calendar-sync.service.js';
import { CalendarMoveResult, CalendarMoveService } from './calendar-move.service.js';

export enum CalendarQueueResult {
  Idle = 'idle',
  Processed = 'processed',
  Deferred = 'deferred',
  ReconciliationRequired = 'reconciliation_required',
}

@Injectable()
export class CalendarSyncQueueService {
  private readonly logger = new Logger(CalendarSyncQueueService.name);

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarSyncService) private readonly sync: CalendarSyncService,
    @Inject(CalendarMoveService) private readonly move: CalendarMoveService,
  ) {}

  async processNext(workshopId: string): Promise<CalendarQueueResult> {
    if (!z.uuid().safeParse(workshopId).success) throw new BadRequestException('Invalid synchronization workshop');
    const moving = await this.database.pool.query<{ version: number; due: boolean }>(
      `SELECT selection_version AS version, move_retry_at <= now() AS due
       FROM workshop_calendar_connections WHERE workshop_id = $1 AND pending_calendar_id IS NOT NULL`, [workshopId],
    );
    if (moving.rowCount) {
      if (!moving.rows[0].due) return CalendarQueueResult.Idle;
      try {
        const result = await this.move.processNext(workshopId);
        return result === CalendarMoveResult.Progress || result === CalendarMoveResult.Finished
          ? CalendarQueueResult.Processed : CalendarQueueResult.Idle;
      } catch (error) {
        const conflict = error instanceof ConflictException;
        const unexpected = !conflict && !(error instanceof ServiceUnavailableException);
        await this.database.pool.query(
          `UPDATE workshop_calendar_connections SET move_retry_count = LEAST(move_retry_count, 15) + 1,
             move_failure = $3::calendar_sync_failure,
             move_retry_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(move_retry_count, 7)))::int)
           WHERE workshop_id = $1 AND selection_version = $2 AND pending_calendar_id IS NOT NULL`,
          [workshopId, moving.rows[0].version, conflict ? 'reconciliation' : 'unavailable'],
        );
        if (unexpected) {
          this.logger.error('Unexpected calendar move failure');
          throw error;
        }
        this.logger.warn(conflict ? 'Calendar move needs reconciliation' : 'Calendar move deferred');
        return conflict ? CalendarQueueResult.ReconciliationRequired : CalendarQueueResult.Deferred;
      }
    }
    const pending = await this.database.pool.query<{ id: string; version: number }>(
      `SELECT a.id, a.version FROM appointments a
       JOIN workshop_calendar_connections c ON c.workshop_id = a.workshop_id
       WHERE a.workshop_id = $1 AND c.selected_calendar_id IS NOT NULL AND c.pending_calendar_id IS NULL
         AND a.synced_version < a.version
         AND (a.calendar_retry_version <> a.version OR (
           a.calendar_sync_failure IS DISTINCT FROM 'reconciliation' AND a.calendar_retry_at <= now()
         ))
       ORDER BY a.calendar_retry_at, a.id LIMIT 1`, [workshopId],
    );
    if (!pending.rowCount) return CalendarQueueResult.Idle;
    const { id, version } = pending.rows[0];
    try {
      const result = await this.sync.synchronize(workshopId, id);
      return result === CalendarSyncResult.Synced || result === CalendarSyncResult.UpToDate
        ? CalendarQueueResult.Processed : CalendarQueueResult.Idle;
    } catch (error) {
      const conflict = error instanceof ConflictException;
      const unexpected = !conflict && !(error instanceof ServiceUnavailableException);
      await this.database.pool.query(
        `UPDATE appointments SET
           calendar_retry_count = CASE WHEN calendar_retry_version = $3
             THEN LEAST(calendar_retry_count, 15) + 1 ELSE 1 END,
           calendar_retry_version = $3,
           calendar_sync_failure = $4::calendar_sync_failure,
           calendar_retry_at = now() + make_interval(secs => LEAST(3600,
             30 * power(2, LEAST(CASE WHEN calendar_retry_version = $3 THEN calendar_retry_count ELSE 0 END, 7)))::int)
         WHERE workshop_id = $1 AND id = $2 AND version = $3 AND synced_version < version`,
        [workshopId, id, version, conflict ? 'reconciliation' : 'unavailable'],
      );
      if (unexpected) {
        this.logger.error('Unexpected calendar synchronization failure');
        throw error;
      }
      this.logger.warn(conflict ? 'Calendar event needs reconciliation' : 'Calendar synchronization deferred');
      return conflict ? CalendarQueueResult.ReconciliationRequired : CalendarQueueResult.Deferred;
    }
  }
}
