import { readConfiguration } from '../config.js';
import { Database } from '../database/database.js';
import { CalendarSyncQueueService, CalendarQueueResult } from './calendar-sync-queue.service.js';
import { CalendarSyncService } from './calendar-sync.service.js';
import { CalendarSyncWorker } from './calendar-sync-worker.js';
import { CalendarMoveService } from './calendar-move.service.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';
import { GoogleCalendarEvents } from './google-calendar-events.js';

describe('CalendarSyncWorker', () => {
  it('starts only once, processes due workshops and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    const config = readConfiguration({
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:4200',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      DATABASE_URL: 'postgresql://localhost/kotailor_test',
    });
    const database = new Database(config);
    const events = new GoogleCalendarEvents({ get: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), getCalendar: vi.fn() });
    const sync = new CalendarSyncService(database, new CalendarTokenCipher(config), events);
    const queue = new CalendarSyncQueueService(database, sync, new CalendarMoveService(database, new CalendarTokenCipher(config), events));
    const result = {
      command: 'SELECT', rowCount: 1, oid: 0, fields: [],
      rows: [{ id: '4c871417-8998-4c48-b607-f6db24470ab8' }],
    };
    const query = vi.spyOn(database.pool, 'query')
      .mockImplementation((async () => result) as typeof database.pool.query);
    const process = vi.spyOn(queue, 'processNext').mockResolvedValue(CalendarQueueResult.Processed);
    const worker = new CalendarSyncWorker(database, queue);
    try {
      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(query).toHaveBeenCalledOnce();
      expect(process).toHaveBeenCalledOnce();
      expect(process).toHaveBeenCalledWith('4c871417-8998-4c48-b607-f6db24470ab8');
      await worker.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(10000);
      expect(query).toHaveBeenCalledOnce();
    } finally {
      await worker.onModuleDestroy();
      await database.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
