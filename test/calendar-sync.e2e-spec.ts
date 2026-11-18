import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AppointmentActor, AppointmentKind, AppointmentSyncStatus } from '../src/appointments/appointments.schema.js';
import { AppointmentsService } from '../src/appointments/appointments.service.js';
import { CalendarConnectionService } from '../src/calendar/calendar-connection.service.js';
import { CalendarSyncResult, CalendarSyncService } from '../src/calendar/calendar-sync.service.js';
import { CalendarQueueResult, CalendarSyncQueueService } from '../src/calendar/calendar-sync-queue.service.js';
import { CalendarMoveService } from '../src/calendar/calendar-move.service.js';
import { CalendarTokenCipher } from '../src/calendar/calendar-token-cipher.js';
import { CalendarEventRemoval, GoogleCalendarEvents } from '../src/calendar/google-calendar-events.js';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Calendar appointment synchronization', () => {
  let database: Database;
  let appointments: AppointmentsService;
  let sync: CalendarSyncService;
  let queue: CalendarSyncQueueService;
  let events: GoogleCalendarEvents;
  let cipher: CalendarTokenCipher;
  let workshopId: string;
  let userId: string;
  let customerId: string;
  const subject = `calendar-sync-${randomUUID()}`;

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = readConfiguration();
    database = new Database(config);
    appointments = new AppointmentsService(database);
    cipher = new CalendarTokenCipher({
      ...config, calendar: {
        redirectUri: 'http://localhost:3000/api/calendar/google/callback',
        tokenKey: Buffer.alloc(32, 7).toString('base64url'),
      },
    });
    events = new GoogleCalendarEvents({
      get: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), getCalendar: vi.fn(),
    });
    sync = new CalendarSyncService(database, cipher, events);
    queue = new CalendarSyncQueueService(database, sync, new CalendarMoveService(database, cipher, events));
    userId = (await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       VALUES ($1, 'sync@example.invalid', 'Sync test') RETURNING id`, [subject],
    )).rows[0].id;
    workshopId = (await database.pool.query<{ id: string }>(
      "INSERT INTO workshops (name) VALUES ('Calendar sync test') RETURNING id",
    )).rows[0].id;
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workshopId, userId],
    );
    customerId = (await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Synthetic customer', '8095550100', 'person') RETURNING id`, [workshopId],
    )).rows[0].id;
    await database.pool.query(
      `INSERT INTO workshop_calendar_connections
       (workshop_id, google_subject, google_email, encrypted_refresh_token, connected_by, selected_calendar_id)
       VALUES ($1, $2, 'sync@example.invalid', $3, $4, 'test-calendar')`,
      [workshopId, subject, cipher.encrypt(workshopId, 'test-refresh-token'), userId],
    );
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (!database) return;
    try {
      if (workshopId) await database.pool.query('DELETE FROM workshops WHERE id = $1', [workshopId]);
      await database.pool.query('DELETE FROM app_users WHERE google_subject = $1', [subject]);
    } finally {
      await database.onModuleDestroy();
    }
  });

  const create = (day: number) => appointments.create(workshopId, userId, AppointmentActor.Workshop, {
    requestId: randomUUID(), customerId, orderId: null, responsibleId: userId, kind: AppointmentKind.Fitting,
    startsAt: `2032-01-${String(day).padStart(2, '0')}T14:00:00Z`,
    endsAt: `2032-01-${String(day).padStart(2, '0')}T15:00:00Z`,
  });

  it('synchronizes each version once and removes a cancelled appointment', async () => {
    const upsert = vi.spyOn(events, 'upsert').mockResolvedValue(undefined);
    const remove = vi.spyOn(events, 'remove').mockResolvedValue(CalendarEventRemoval.Removed);
    const created = await create(1);
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(upsert).toHaveBeenCalledWith('test-refresh-token', 'test-calendar', {
      workshopId, appointmentId: created.id, version: 1, kind: AppointmentKind.Fitting,
      customerName: 'Synthetic customer', startsAt: '2032-01-01T14:00:00.000Z', endsAt: '2032-01-01T15:00:00.000Z',
    });
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.UpToDate);
    expect(upsert).toHaveBeenCalledOnce();
    await appointments.cancel(workshopId, userId, AppointmentActor.Workshop, created.id, { expectedVersion: 1 });
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(remove).toHaveBeenCalledWith('test-refresh-token', 'test-calendar', {
      workshopId, appointmentId: created.id, version: 2,
    });
    const saved = await database.pool.query('SELECT version, synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0]).toEqual({ version: 2, synced_version: 2 });
  });

  it('keeps the appointment pending after a provider failure and retries', async () => {
    const upsert = vi.spyOn(events, 'upsert').mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValueOnce(undefined);
    const created = await create(2);
    await expect(sync.synchronize(workshopId, created.id)).rejects.toThrow('provider unavailable');
    const saved = await database.pool.query('SELECT synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0].synced_version).toBe(0);
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('sends a newer appointment version after a reschedule', async () => {
    const upsert = vi.spyOn(events, 'upsert').mockResolvedValue(undefined);
    const created = await create(6);
    await sync.synchronize(workshopId, created.id);
    await appointments.reschedule(workshopId, userId, AppointmentActor.Workshop, created.id, {
      expectedVersion: 1, responsibleId: userId, startsAt: '2032-01-06T15:00:00Z', endsAt: '2032-01-06T16:00:00Z',
    });
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(upsert).toHaveBeenLastCalledWith('test-refresh-token', 'test-calendar', expect.objectContaining({
      version: 2, startsAt: '2032-01-06T15:00:00.000Z', endsAt: '2032-01-06T16:00:00.000Z',
    }));
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('leaves a concurrent reschedule pending after the previous version is sent', async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const upsert = vi.spyOn(events, 'upsert').mockImplementationOnce(async () => {
      started();
      await waiting;
    }).mockResolvedValue(undefined);
    const created = await create(7);
    const synchronization = sync.synchronize(workshopId, created.id);
    await entered;
    const change = appointments.reschedule(workshopId, userId, AppointmentActor.Workshop, created.id, {
      expectedVersion: 1, responsibleId: userId, startsAt: '2032-01-07T15:00:00Z', endsAt: '2032-01-07T16:00:00Z',
    });
    release();
    await synchronization;
    await change;
    const saved = await database.pool.query('SELECT version, synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0]).toEqual({ version: 2, synced_version: 1 });
    await sync.synchronize(workshopId, created.id);
    expect(upsert).toHaveBeenLastCalledWith('test-refresh-token', 'test-calendar', expect.objectContaining({ version: 2 }));
  });

  it('serializes competing syncs and does not send an appointment during a pending calendar move', async () => {
    const upsert = vi.spyOn(events, 'upsert').mockResolvedValue(undefined);
    const created = await create(3);
    const results = await Promise.all([sync.synchronize(workshopId, created.id), sync.synchronize(workshopId, created.id)]);
    expect(results.sort()).toEqual([CalendarSyncResult.Synced, CalendarSyncResult.UpToDate].sort());
    expect(upsert).toHaveBeenCalledOnce();
    await appointments.reschedule(workshopId, userId, AppointmentActor.Workshop, created.id, {
      expectedVersion: 1, responsibleId: userId, startsAt: '2032-01-03T15:00:00Z', endsAt: '2032-01-03T16:00:00Z',
    });
    await database.pool.query(
      "UPDATE workshop_calendar_connections SET pending_calendar_id = 'another-calendar' WHERE workshop_id = $1", [workshopId],
    );
    try {
      expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.MovePending);
      expect(upsert).toHaveBeenCalledOnce();
    } finally {
      await database.pool.query('UPDATE workshop_calendar_connections SET pending_calendar_id = NULL WHERE workshop_id = $1', [workshopId]);
    }
  });

  it('rechecks ambiguous absence after a delay before confirming a cancellation', async () => {
    const remove = vi.spyOn(events, 'remove').mockResolvedValueOnce(CalendarEventRemoval.NotFound)
      .mockResolvedValueOnce(CalendarEventRemoval.Cancelled);
    const created = await create(4);
    await database.pool.query('UPDATE appointments SET calendar_sync_attempted = true WHERE id = $1', [created.id]);
    await appointments.cancel(workshopId, userId, AppointmentActor.Workshop, created.id, { expectedVersion: 1 });
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.AwaitingConfirmation);
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.AwaitingConfirmation);
    expect(remove).toHaveBeenCalledOnce();
    const saved = await database.pool.query('SELECT synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0].synced_version).toBe(0);
    await database.pool.query(
      "UPDATE appointments SET calendar_absence_seen_at = now() - interval '1 minute' WHERE id = $1", [created.id],
    );
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('does not call Google for an appointment cancelled before its first sync attempt', async () => {
    const remove = vi.spyOn(events, 'remove');
    const created = await create(8);
    await appointments.cancel(workshopId, userId, AppointmentActor.Workshop, created.id, { expectedVersion: 1 });
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.Synced);
    expect(remove).not.toHaveBeenCalled();
  });

  it('persists retry delay and lets a newer version bypass it', async () => {
    await database.pool.query('UPDATE appointments SET synced_version = version WHERE workshop_id = $1', [workshopId]);
    const created = await create(9);
    const upsert = vi.spyOn(events, 'upsert')
      .mockRejectedValueOnce(new ServiceUnavailableException('provider unavailable')).mockResolvedValue(undefined);
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Deferred);
    const stored = await database.pool.query<{ count: number; delayed: boolean; failure: string }>(
      `SELECT calendar_retry_count AS count, calendar_retry_at > now() AS delayed,
              calendar_sync_failure AS failure FROM appointments WHERE id = $1`, [created.id],
    );
    expect(stored.rows[0]).toEqual({ count: 1, delayed: true, failure: 'unavailable' });
    const listed = await appointments.list(workshopId, userId, AppointmentActor.Workshop, '2032-01-09', '2032-01-10');
    expect(listed.appointments.find((item) => item.id === created.id)?.syncStatus).toBe(AppointmentSyncStatus.Retrying);
    await appointments.reschedule(workshopId, userId, AppointmentActor.Workshop, created.id, {
      expectedVersion: 1, responsibleId: userId, startsAt: '2032-01-09T15:00:00Z', endsAt: '2032-01-09T16:00:00Z',
    });
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Processed);
    expect(upsert).toHaveBeenLastCalledWith('test-refresh-token', 'test-calendar', expect.objectContaining({ version: 2 }));
  });

  it('stops retrying a conflicting version until the appointment changes', async () => {
    await database.pool.query('UPDATE appointments SET synced_version = version WHERE workshop_id = $1', [workshopId]);
    const created = await create(10);
    const upsert = vi.spyOn(events, 'upsert')
      .mockRejectedValueOnce(new ConflictException('event requires reconciliation')).mockResolvedValue(undefined);
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.ReconciliationRequired);
    const listed = await appointments.list(workshopId, userId, AppointmentActor.Workshop, '2032-01-10', '2032-01-11');
    expect(listed.appointments.find((item) => item.id === created.id)?.syncStatus).toBe(AppointmentSyncStatus.NeedsAttention);
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Idle);
    expect(upsert).toHaveBeenCalledOnce();
    await appointments.reschedule(workshopId, userId, AppointmentActor.Workshop, created.id, {
      expectedVersion: 1, responsibleId: userId, startsAt: '2032-01-10T15:00:00Z', endsAt: '2032-01-10T16:00:00Z',
    });
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Processed);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('backs off unexpected errors while still surfacing them to the caller', async () => {
    await database.pool.query('UPDATE appointments SET synced_version = version WHERE workshop_id = $1', [workshopId]);
    const created = await create(11);
    vi.spyOn(events, 'upsert').mockRejectedValue(new Error('unexpected failure'));
    await expect(queue.processNext(workshopId)).rejects.toThrow('unexpected failure');
    const saved = await database.pool.query<{ delayed: boolean; failure: string }>(
      `SELECT calendar_retry_at > now() AS delayed, calendar_sync_failure AS failure
       FROM appointments WHERE id = $1`, [created.id],
    );
    expect(saved.rows[0]).toEqual({ delayed: true, failure: 'unavailable' });
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Idle);
  });

  it('invalidates synchronization markers on disconnect without removing Google events', async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const upsert = vi.spyOn(events, 'upsert').mockImplementation(async () => {
      started();
      await waiting;
    });
    const remove = vi.spyOn(events, 'remove');
    const created = await create(5);
    const synchronization = sync.synchronize(workshopId, created.id);
    await entered;
    const service = new CalendarConnectionService(database, { begin: vi.fn(), exchange: vi.fn() }, cipher);
    const disconnect = service.disconnect(workshopId, userId);
    release();
    await synchronization;
    await disconnect;
    const saved = await database.pool.query('SELECT synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0].synced_version).toBe(0);
    expect(await sync.synchronize(workshopId, created.id)).toBe(CalendarSyncResult.NotConnected);
    expect(upsert).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });
});
