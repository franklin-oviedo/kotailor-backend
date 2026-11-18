import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Database } from '../database/database.js';
import { CalendarSyncQueueService } from './calendar-sync-queue.service.js';

@Injectable()
export class CalendarSyncWorker implements OnModuleDestroy {
  private readonly logger = new Logger(CalendarSyncWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CalendarSyncQueueService) private readonly queue: CalendarSyncQueueService,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.running = this.processDue().catch(() => {
        this.logger.error('Calendar synchronization worker failed');
      }).finally(() => {
        this.running = undefined;
        if (!this.stopped) this.schedule(5000);
      });
    }, delay);
  }

  private async processDue(): Promise<void> {
    const workshops = await this.database.pool.query<{ id: string }>(
      `SELECT work.id FROM (
         SELECT c.workshop_id AS id, c.move_retry_at AS due FROM workshop_calendar_connections c
         WHERE c.pending_calendar_id IS NOT NULL AND c.move_retry_at <= now()
         UNION ALL
         SELECT a.workshop_id AS id, a.calendar_retry_at AS due FROM appointments a
         JOIN workshop_calendar_connections c ON c.workshop_id = a.workshop_id
         WHERE c.selected_calendar_id IS NOT NULL AND c.pending_calendar_id IS NULL
           AND a.synced_version < a.version
           AND (a.calendar_retry_version <> a.version OR (
             a.calendar_sync_failure IS DISTINCT FROM 'reconciliation' AND a.calendar_retry_at <= now()
           ))
       ) work GROUP BY work.id ORDER BY MIN(work.due), work.id LIMIT 20`,
    );
    for (const workshop of workshops.rows) {
      if (this.stopped) return;
      try {
        await this.queue.processNext(workshop.id);
      } catch {
        this.logger.error('Unable to process pending calendar synchronization');
      }
    }
  }
}
