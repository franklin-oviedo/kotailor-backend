import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppointmentActor, AppointmentKind } from '../src/appointments/appointments.schema.js';
import { AppointmentsService } from '../src/appointments/appointments.service.js';
import { CalendarConnectionService } from '../src/calendar/calendar-connection.service.js';
import { CalendarMoveResult, CalendarMoveService } from '../src/calendar/calendar-move.service.js';
import { CalendarQueueResult, CalendarSyncQueueService } from '../src/calendar/calendar-sync-queue.service.js';
import { CalendarSyncService } from '../src/calendar/calendar-sync.service.js';
import { CalendarTokenCipher } from '../src/calendar/calendar-token-cipher.js';
import { CalendarEventRemoval, GoogleCalendarEvents } from '../src/calendar/google-calendar-events.js';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Calendar move recovery', () => {
  let database: Database;
  let appointments: AppointmentsService;
  let move: CalendarMoveService;
  let connection: CalendarConnectionService;
  let queue: CalendarSyncQueueService;
  let events: GoogleCalendarEvents;
  let userId: string;
  let workshopId: string;
  let customerId: string;
  const subject = `calendar-move-${randomUUID()}`;

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = readConfiguration();
    database = new Database(config);
    appointments = new AppointmentsService(database);
    const cipher = new CalendarTokenCipher({
      ...config, calendar: {
        redirectUri: 'http://localhost:3000/api/calendar/google/callback',
        tokenKey: Buffer.alloc(32, 7).toString('base64url'),
      },
    });
    events = new GoogleCalendarEvents({ get: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), getCalendar: vi.fn() });
    move = new CalendarMoveService(database, cipher, events);
    queue = new CalendarSyncQueueService(database, new CalendarSyncService(database, cipher, events), move);
    connection = new CalendarConnectionService(database, { begin: vi.fn(), exchange: vi.fn() }, cipher);
    userId = (await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       VALUES ($1, 'move@example.invalid', 'Move test') RETURNING id`, [subject],
    )).rows[0].id;
    workshopId = (await database.pool.query<{ id: string }>(
      "INSERT INTO workshops (name) VALUES ('Calendar move test') RETURNING id",
    )).rows[0].id;
    await database.pool.query(
      "INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')", [workshopId, userId],
    );
    customerId = (await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Synthetic customer', '8095550100', 'person') RETURNING id`, [workshopId],
    )).rows[0].id;
    await database.pool.query(
      `INSERT INTO workshop_calendar_connections
       (workshop_id, google_subject, google_email, encrypted_refresh_token, connected_by, selected_calendar_id, selection_version)
       VALUES ($1, $2, 'move@example.invalid', $3, $4, 'source-calendar', 1)`,
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

  it('copies before removing, resumes a failed deletion and freezes conflicting changes', async () => {
    const appointment = await appointments.create(workshopId, userId, AppointmentActor.Workshop, {
      requestId: randomUUID(), customerId, orderId: null, responsibleId: userId, kind: AppointmentKind.Fitting,
      startsAt: '2032-03-01T14:00:00Z', endsAt: '2032-03-01T15:00:00Z',
    });
    await database.pool.query(
      'UPDATE appointments SET synced_version = version, calendar_sync_attempted = true WHERE id = $1', [appointment.id],
    );
    await database.pool.query(
      `UPDATE workshop_calendar_connections SET pending_calendar_id = 'destination-calendar',
       selection_version = 2 WHERE workshop_id = $1`, [workshopId],
    );
    const upsert = vi.spyOn(events, 'upsert').mockResolvedValue(undefined);
    const remove = vi.spyOn(events, 'remove')
      .mockRejectedValueOnce(new ServiceUnavailableException('response lost'))
      .mockResolvedValueOnce(CalendarEventRemoval.Cancelled);

    await expect(appointments.cancel(workshopId, userId, AppointmentActor.Workshop, appointment.id, { expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(connection.disconnect(workshopId, userId)).rejects.toBeInstanceOf(ConflictException);
    await expect(database.pool.query('DELETE FROM appointments WHERE id = $1', [appointment.id]))
      .rejects.toMatchObject({ code: '23514' });
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Progress);
    expect(upsert).toHaveBeenCalledWith('test-refresh-token', 'destination-calendar', expect.objectContaining({ appointmentId: appointment.id }));
    expect(remove).not.toHaveBeenCalled();
    await expect(move.processNext(workshopId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const saved = await database.pool.query(
      'SELECT destination_ready, source_removed FROM calendar_move_progress WHERE appointment_id = $1', [appointment.id],
    );
    expect(saved.rows[0]).toEqual({ destination_ready: true, source_removed: false });
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Progress);
    expect(remove).toHaveBeenLastCalledWith('test-refresh-token', 'source-calendar', expect.objectContaining({ appointmentId: appointment.id }));
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Finished);
    const result = await database.pool.query(
      `SELECT c.selected_calendar_id AS selected, c.pending_calendar_id AS pending, c.selection_version AS version,
              a.synced_version AS synced FROM workshop_calendar_connections c
       JOIN appointments a ON a.workshop_id = c.workshop_id WHERE c.workshop_id = $1 AND a.id = $2`,
      [workshopId, appointment.id],
    );
    expect(result.rows[0]).toEqual({ selected: 'destination-calendar', pending: null, version: 3, synced: 1 });
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Idle);
  });

  it('never removes the source when the destination copy fails', async () => {
    const appointment = await appointments.create(workshopId, userId, AppointmentActor.Workshop, {
      requestId: randomUUID(), customerId, orderId: null, responsibleId: userId, kind: AppointmentKind.Measurements,
      startsAt: '2032-03-02T14:00:00Z', endsAt: '2032-03-02T15:00:00Z',
    });
    await database.pool.query(
      'UPDATE appointments SET synced_version = version, calendar_sync_attempted = true WHERE id = $1', [appointment.id],
    );
    await database.pool.query(
      `UPDATE workshop_calendar_connections SET pending_calendar_id = 'other-calendar',
       selection_version = 4 WHERE workshop_id = $1`, [workshopId],
    );
    vi.spyOn(events, 'upsert').mockRejectedValue(new ServiceUnavailableException('destination unavailable'));
    const remove = vi.spyOn(events, 'remove');
    await expect(queue.processNext(workshopId)).resolves.toBe(CalendarQueueResult.Deferred);
    expect(await queue.processNext(workshopId)).toBe(CalendarQueueResult.Idle);
    expect(remove).not.toHaveBeenCalled();
    const saved = await database.pool.query(
      `SELECT selected_calendar_id, pending_calendar_id, move_failure, move_retry_count
       FROM workshop_calendar_connections WHERE workshop_id = $1`, [workshopId],
    );
    expect(saved.rows[0]).toEqual({
      selected_calendar_id: 'destination-calendar', pending_calendar_id: 'other-calendar',
      move_failure: 'unavailable', move_retry_count: 1,
    });
  });

  it('rechecks an ambiguous source absence before advancing the move', async () => {
    vi.spyOn(events, 'upsert').mockResolvedValue(undefined);
    const remove = vi.spyOn(events, 'remove').mockResolvedValue(CalendarEventRemoval.NotFound);
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Progress);
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.AwaitingConfirmation);
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.AwaitingConfirmation);
    expect(remove).toHaveBeenCalledOnce();
    const pending = await database.pool.query(
      'SELECT destination_ready, source_removed FROM calendar_move_progress WHERE workshop_id = $1', [workshopId],
    );
    expect(pending.rows[0]).toEqual({ destination_ready: true, source_removed: false });
    await database.pool.query(
      "UPDATE calendar_move_progress SET source_absence_seen_at = now() - interval '1 minute' WHERE workshop_id = $1", [workshopId],
    );
    expect(await move.processNext(workshopId)).toBe(CalendarMoveResult.Progress);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
