import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CalendarConnectionService } from '../src/calendar/calendar-connection.service.js';
import { CalendarListService } from '../src/calendar/calendar-list.service.js';
import { CalendarSelectionService } from '../src/calendar/calendar-selection.service.js';
import { CalendarTokenCipher } from '../src/calendar/calendar-token-cipher.js';
import { GoogleCalendarList } from '../src/calendar/google-calendar-list.js';
import { type GoogleCalendarOAuth } from '../src/calendar/google-calendar-oauth.js';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Calendar connection authorization', () => {
  let database: Database;
  let service: CalendarConnectionService;
  let cipher: CalendarTokenCipher;
  const suffix = randomUUID();
  const subjects = [`calendar-manager-${suffix}`, `calendar-staff-${suffix}`];
  const workshops: string[] = [];
  let users: string[];
  let calendarSubject = 'google-account-one';
  const exchange = vi.fn(async () => ({
    subject: calendarSubject, email: 'calendar@example.invalid', refreshToken: 'test-calendar-refresh-token',
  }));
  const oauth: Pick<GoogleCalendarOAuth, 'begin' | 'exchange'> = {
    begin: () => {
      const state = randomBytes(32).toString('base64url');
      return {
        flow: {
          state, nonce: randomBytes(32).toString('base64url'),
          verifier: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000,
        },
        url: `https://accounts.google.com/test?state=${state}`,
      };
    },
    exchange,
  };

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    const config = readConfiguration();
    database = new Database(config);
    cipher = new CalendarTokenCipher({
      ...config, calendar: {
        redirectUri: 'http://localhost:3000/api/calendar/google/callback',
        tokenKey: Buffer.alloc(32, 7).toString('base64url'),
      },
    });
    service = new CalendarConnectionService(database, oauth, cipher);
    const result = await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       SELECT subject, subject || '@example.invalid', subject FROM unnest($1::text[]) subject RETURNING id`, [subjects],
    );
    users = result.rows.map((row) => row.id);
    const created = await database.pool.query<{ id: string }>("INSERT INTO workshops (name) VALUES ('Calendar test') RETURNING id");
    workshops.push(created.rows[0].id);
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'staff')`,
      [workshops[0], users[0], users[1]],
    );
  });

  afterAll(async () => {
    if (!database) return;
    try {
      if (workshops.length) await database.pool.query('DELETE FROM workshops WHERE id = ANY($1::uuid[])', [workshops]);
      await database.pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [subjects]);
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('binds one-time authorization to the session and encrypts the refresh token', async () => {
    const sessionId = randomUUID();
    await expect(service.begin(workshops[0], users[1], sessionId)).rejects.toBeInstanceOf(NotFoundException);
    const start = await service.begin(workshops[0], users[0], sessionId);
    const state = new URL(start.url).searchParams.get('state')!;
    await expect(service.complete(users[0], randomUUID(), state, 'test-code')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.complete(users[1], sessionId, state, 'test-code')).rejects.toBeInstanceOf(UnauthorizedException);
    const results = await Promise.allSettled([
      service.complete(users[0], sessionId, state, 'test-code'),
      service.complete(users[0], sessionId, state, 'test-code'),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((entry) => entry.status === 'rejected')).toMatchObject({ reason: expect.any(UnauthorizedException) });
    expect(exchange).toHaveBeenCalledTimes(1);
    const saved = await database.pool.query<{ token: Buffer; subject: string }>(
      'SELECT encrypted_refresh_token AS token, google_subject AS subject FROM workshop_calendar_connections WHERE workshop_id = $1',
      [workshops[0]],
    );
    expect(saved.rows[0].subject).toBe(calendarSubject);
    expect(saved.rows[0].token.includes(Buffer.from('test-calendar-refresh-token'))).toBe(false);
    expect(cipher.decrypt(workshops[0], saved.rows[0].token)).toBe('test-calendar-refresh-token');
    await expect(service.complete(users[0], sessionId, state, 'test-code')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects expired flows, revoked roles and account replacement', async () => {
    const sessionId = randomUUID();
    const expired = await service.begin(workshops[0], users[0], sessionId);
    const expiredState = new URL(expired.url).searchParams.get('state')!;
    await database.pool.query(
      "UPDATE calendar_authorization_flows SET expires_at = now() - interval '1 second' WHERE workshop_id = $1 AND state_hash = $2",
      [workshops[0], createHash('sha256').update(expiredState).digest('hex')],
    );
    await expect(service.complete(users[0], sessionId, expiredState, 'test-code')).rejects.toBeInstanceOf(UnauthorizedException);

    const revoked = await service.begin(workshops[0], users[0], sessionId);
    const revokedState = new URL(revoked.url).searchParams.get('state')!;
    await database.pool.query("UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2",
      [workshops[0], users[0]]);
    await expect(service.complete(users[0], sessionId, revokedState, 'test-code')).rejects.toBeInstanceOf(NotFoundException);
    await database.pool.query("UPDATE workshop_memberships SET role = 'manager' WHERE workshop_id = $1 AND user_id = $2",
      [workshops[0], users[0]]);

    const replacement = await service.begin(workshops[0], users[0], sessionId);
    const replacementState = new URL(replacement.url).searchParams.get('state')!;
    calendarSubject = 'google-account-two';
    await expect(service.complete(users[0], sessionId, replacementState, 'test-code')).rejects.toBeInstanceOf(ConflictException);
    const saved = await database.pool.query<{ subject: string }>(
      'SELECT google_subject AS subject FROM workshop_calendar_connections WHERE workshop_id = $1', [workshops[0]],
    );
    expect(saved.rows[0].subject).toBe('google-account-one');
  });

  it('disconnects without reactivating a callback already in flight', async () => {
    calendarSubject = 'google-account-one';
    const sessionId = randomUUID();
    expect(await service.status(workshops[0], users[0])).toEqual({ connected: true, email: 'calendar@example.invalid' });
    await expect(service.status(workshops[0], users[1])).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.disconnect(workshops[0], users[1])).rejects.toBeInstanceOf(NotFoundException);

    let release!: () => void;
    let markStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    exchange.mockImplementationOnce(async () => {
      markStarted();
      await waiting;
      return { subject: calendarSubject, email: 'calendar@example.invalid', refreshToken: 'test-calendar-refresh-token' };
    });
    const pending = await service.begin(workshops[0], users[0], sessionId);
    const unused = await service.begin(workshops[0], users[0], sessionId);
    const state = new URL(pending.url).searchParams.get('state')!;
    const unusedState = new URL(unused.url).searchParams.get('state')!;
    const completion = service.complete(users[0], sessionId, state, 'test-code');
    await started;
    await service.disconnect(workshops[0], users[0]);
    release();
    await expect(completion).rejects.toBeInstanceOf(ConflictException);
    expect(await service.status(workshops[0], users[0])).toEqual({ connected: false, email: null });
    await expect(service.complete(users[0], sessionId, unusedState, 'test-code')).rejects.toBeInstanceOf(UnauthorizedException);
    const stored = await database.pool.query(
      'SELECT 1 FROM workshop_calendar_connections WHERE workshop_id = $1', [workshops[0]],
    );
    expect(stored.rowCount).toBe(0);
    const reconnect = await service.begin(workshops[0], users[0], sessionId);
    await service.complete(users[0], sessionId, new URL(reconnect.url).searchParams.get('state'), 'test-code');
    expect(await service.status(workshops[0], users[0])).toEqual({ connected: true, email: 'calendar@example.invalid' });
  });

  it('does not return a calendar list when the manager role is revoked during the request', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const google = new GoogleCalendarList({ get: vi.fn(), list: async () => {
      markStarted();
      await waiting;
      return { kind: 'calendar#calendarList', items: [{ id: 'calendar', accessRole: 'writer' }] };
    } });
    const calendars = new CalendarListService(database, cipher, google);
    const result = calendars.list(workshops[0], users[0], undefined);
    await started;
    await database.pool.query("UPDATE workshop_memberships SET role = 'staff' WHERE workshop_id = $1 AND user_id = $2",
      [workshops[0], users[0]]);
    release();
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await database.pool.query("UPDATE workshop_memberships SET role = 'manager' WHERE workshop_id = $1 AND user_id = $2",
      [workshops[0], users[0]]);
  });

  it('does not return a calendar list when disconnected during the Google request', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const google = new GoogleCalendarList({ get: vi.fn(), list: async () => {
      markStarted();
      await waiting;
      return { kind: 'calendar#calendarList', items: [{ id: 'calendar', accessRole: 'writer' }] };
    } });
    const calendars = new CalendarListService(database, cipher, google);
    await expect(calendars.list(workshops[0], users[1], undefined)).rejects.toBeInstanceOf(NotFoundException);
    const result = calendars.list(workshops[0], users[0], undefined);
    await started;
    await service.disconnect(workshops[0], users[0]);
    release();
    await expect(result).rejects.toBeInstanceOf(ConflictException);
  });

  it('serializes competing calendar selections and rejects a disconnected in-flight selection', async () => {
    const sessionId = randomUUID();
    const start = await service.begin(workshops[0], users[0], sessionId);
    await service.complete(users[0], sessionId, new URL(start.url).searchParams.get('state'), 'test-code');
    const get = vi.fn(async (_token: string, id: string) => ({
      kind: 'calendar#calendarListEntry', id, accessRole: 'writer',
    }));
    const google = new GoogleCalendarList({ list: vi.fn(), get });
    const selection = new CalendarSelectionService(database, new CalendarListService(database, cipher, google));
    const results = await Promise.allSettled([
      selection.select(workshops[0], users[0], { calendarId: 'first', expectedVersion: 0 }),
      selection.select(workshops[0], users[0], { calendarId: 'second', expectedVersion: 0 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictException) });
    const current = await selection.status(workshops[0], users[0]);
    expect(current.version).toBe(1);
    expect(current.pendingCalendarId).toBeNull();
    await expect(selection.select(workshops[0], users[0], { calendarId: 'third', expectedVersion: 1 }))
      .resolves.toEqual({ selectedCalendarId: current.selectedCalendarId, pendingCalendarId: 'third', version: 2 });
    await expect(selection.select(workshops[0], users[0], { calendarId: 'fourth', expectedVersion: 2 }))
      .rejects.toBeInstanceOf(ConflictException);

    let release!: () => void;
    let markStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    get.mockImplementationOnce(async (_token, id) => {
      markStarted();
      await waiting;
      return { kind: 'calendar#calendarListEntry', id, accessRole: 'writer' };
    });
    const pending = selection.select(workshops[0], users[0], { calendarId: 'third', expectedVersion: 2 });
    await started;
    await expect(service.disconnect(workshops[0], users[0])).rejects.toBeInstanceOf(ConflictException);
    await database.pool.query('UPDATE workshop_calendar_connections SET pending_calendar_id = NULL WHERE workshop_id = $1', [workshops[0]]);
    await service.disconnect(workshops[0], users[0]);
    release();
    await expect(pending).rejects.toBeInstanceOf(ConflictException);
    await expect(selection.status(workshops[0], users[0])).rejects.toBeInstanceOf(ConflictException);
  });
});
