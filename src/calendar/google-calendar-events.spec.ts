import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { AppointmentKind } from '../appointments/appointments.schema.js';
import { readConfiguration } from '../config.js';
import {
  CalendarEventRemoval, createCalendarEventClient, GoogleCalendarEvents,
  type CalendarAppointment, type CalendarEventBody, type CalendarEventClient,
} from './google-calendar-events.js';

const appointment: CalendarAppointment = {
  workshopId: '4c871417-8998-4c48-b607-f6db24470ab8',
  appointmentId: 'b17cb9a9-9b08-4f2c-8fd3-eb1021a94d7a',
  version: 1,
  kind: AppointmentKind.Fitting,
  customerName: 'Ada',
  startsAt: '2026-11-18T13:00:00.000Z',
  endsAt: '2026-11-18T14:00:00.000Z',
};
const eventId = 'kb17cb9a99b084f2c8fd3eb1021a94d7a';
const notFound = { response: { status: 404 } };
const clientWith = (overrides: Partial<CalendarEventClient>): CalendarEventClient => ({
  get: vi.fn(), insert: vi.fn(), patch: vi.fn(), remove: vi.fn(), getCalendar: vi.fn(), ...overrides,
});
const event = (body: CalendarEventBody, etag = '"1"') => ({
  kind: 'calendar#event', id: eventId, etag, status: 'confirmed', ...body,
});
const body: CalendarEventBody = {
  summary: 'Prueba - Ada',
  start: { dateTime: appointment.startsAt, timeZone: 'America/Santo_Domingo' },
  end: { dateTime: appointment.endsAt, timeZone: 'America/Santo_Domingo' },
  extendedProperties: { private: {
    kotailorWorkshopId: appointment.workshopId,
    kotailorAppointmentId: appointment.appointmentId,
    kotailorVersion: '1',
  } },
};

describe('GoogleCalendarEvents', () => {
  it('creates a minimal event and retries an ambiguous creation without duplicating it', async () => {
    let remote: ReturnType<typeof event> | undefined;
    const get = vi.fn(async () => {
      if (!remote) throw notFound;
      return remote;
    });
    const insert = vi.fn(async (_token: string, _calendar: string, _id: string, payload: CalendarEventBody) => {
      remote = event(payload);
      throw new Error('connection lost after creation');
    });
    const patch = vi.fn(async (_token: string, _calendar: string, _id: string, _etag: string, payload: CalendarEventBody) => event(payload, '"2"'));
    const service = new GoogleCalendarEvents(clientWith({ get, insert, patch }));
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.upsert('token', 'calendar', appointment)).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith('token', 'calendar', eventId, body);
    expect(patch).not.toHaveBeenCalled();
  });

  it('does not overwrite unrelated, newer, or concurrently changed events', async () => {
    const get = vi.fn().mockResolvedValueOnce(event({
      ...body, extendedProperties: { private: { ...body.extendedProperties.private, kotailorWorkshopId: 'other' } },
    })).mockResolvedValueOnce(event({
      ...body, extendedProperties: { private: { ...body.extendedProperties.private, kotailorVersion: '2' } },
    })).mockResolvedValueOnce(event({ ...body, summary: 'Changed externally' }));
    const patch = vi.fn().mockRejectedValue({ response: { status: 412 } });
    const insert = vi.fn();
    const service = new GoogleCalendarEvents(clientWith({ get, insert, patch }));
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    expect(patch).not.toHaveBeenCalled();
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(patch).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
  });

  it('updates an event whose content differs even if its version matches', async () => {
    const get = vi.fn().mockResolvedValueOnce(event({ ...body, summary: 'Changed externally' }))
      .mockResolvedValueOnce(event({ ...body, start: { ...body.start, timeZone: 'UTC' } }));
    const patch = vi.fn(async (_token: string, _calendar: string, _id: string, _etag: string, payload: CalendarEventBody) => event(payload));
    const service = new GoogleCalendarEvents(clientWith({ get, patch }));
    await expect(service.upsert('token', 'calendar', appointment)).resolves.toBeUndefined();
    await expect(service.upsert('token', 'calendar', appointment)).resolves.toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledWith('token', 'calendar', eventId, '"1"', body);
  });

  it('surfaces provider and insert conflicts without treating them as successful synchronization', async () => {
    const get = vi.fn().mockRejectedValueOnce({ response: { status: 403 } }).mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);
    const insert = vi.fn().mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce(event({ ...body, extendedProperties: { private: { ...body.extendedProperties.private, kotailorVersion: '0' } } }))
      .mockResolvedValueOnce(event({ ...body, end: { ...body.end, dateTime: '2026-11-18T15:00:00.000Z' } }));
    const patch = vi.fn();
    const service = new GoogleCalendarEvents(clientWith({ get, insert, patch }));
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(insert).not.toHaveBeenCalled();
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    expect(patch).not.toHaveBeenCalled();
  });

  it('preserves other private properties and refuses malformed or cancelled events', async () => {
    const current = event({ ...body, extendedProperties: { private: { ...body.extendedProperties.private, other: 'keep' } } });
    const get = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, status: 'cancelled' })
      .mockResolvedValueOnce(undefined);
    const patch = vi.fn(async (_token: string, _calendar: string, _id: string, _etag: string, payload: CalendarEventBody) => event(payload));
    const insert = vi.fn();
    const service = new GoogleCalendarEvents(clientWith({ get, insert, patch }));
    await service.upsert('token', 'calendar', { ...appointment, version: 2, kind: AppointmentKind.Delivery });
    expect(patch.mock.calls[0][4].extendedProperties.private).toEqual({ ...body.extendedProperties.private, other: 'keep', kotailorVersion: '2' });
    expect(patch.mock.calls[0][4].summary).toBe('Entrega - Ada');
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.upsert('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.upsert('token', '..', appointment)).rejects.toBeInstanceOf(BadRequestException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('conditionally removes only the expected event and detects conflicts', async () => {
    const otherEvent = event({
      ...body, extendedProperties: { private: { ...body.extendedProperties.private, kotailorAppointmentId: 'other' } },
    });
    const newerEvent = event({
      ...body, extendedProperties: { private: { ...body.extendedProperties.private, kotailorVersion: '3' } },
    });
    const get = vi.fn().mockResolvedValueOnce(otherEvent).mockResolvedValueOnce(newerEvent)
      .mockResolvedValueOnce(event(body)).mockResolvedValueOnce(event(body));
    const remove = vi.fn().mockRejectedValueOnce({ response: { status: 412 } }).mockResolvedValueOnce(undefined);
    const service = new GoogleCalendarEvents(clientWith({ get, remove }));
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    expect(remove).not.toHaveBeenCalled();
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.remove('token', 'calendar', { ...appointment, version: 2 })).resolves.toBe(CalendarEventRemoval.Removed);
    expect(remove).toHaveBeenLastCalledWith('token', 'calendar', eventId, '"1"');
  });

  it('distinguishes cancelled and missing events and does not mistake lost calendar access for deletion', async () => {
    const get = vi.fn().mockResolvedValueOnce({ kind: 'calendar#event', id: eventId, status: 'cancelled' })
      .mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);
    const getCalendar = vi.fn().mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'calendar', accessRole: 'writer' })
      .mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'calendar', accessRole: 'reader' })
      .mockRejectedValueOnce(notFound);
    const remove = vi.fn();
    const service = new GoogleCalendarEvents(clientWith({ get, getCalendar, remove }));
    await expect(service.remove('token', 'calendar', appointment)).resolves.toBe(CalendarEventRemoval.Cancelled);
    await expect(service.remove('token', 'calendar', appointment)).resolves.toBe(CalendarEventRemoval.NotFound);
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(remove).not.toHaveBeenCalled();
  });

  it('can retry a delete whose response was lost without deleting twice', async () => {
    const get = vi.fn().mockResolvedValueOnce(event(body))
      .mockResolvedValueOnce({ kind: 'calendar#event', id: eventId, status: 'cancelled' });
    const remove = vi.fn().mockRejectedValueOnce(new Error('connection lost after deletion'));
    const service = new GoogleCalendarEvents(clientWith({ get, remove }));
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.remove('token', 'calendar', appointment)).resolves.toBe(CalendarEventRemoval.Cancelled);
    expect(remove).toHaveBeenCalledOnce();
  });

  it('recognizes Google deleted responses without treating other 410 errors as deletions', async () => {
    const deleted = { response: { status: 410, data: { error: { errors: [{ reason: 'deleted' }] } } } };
    const get = vi.fn().mockRejectedValueOnce(deleted).mockResolvedValueOnce(event(body))
      .mockRejectedValueOnce({ response: { status: 410, data: { error: { errors: [{ reason: 'fullSyncRequired' }] } } } });
    const getCalendar = vi.fn().mockResolvedValue({ kind: 'calendar#calendarListEntry', id: 'calendar', accessRole: 'writer' });
    const remove = vi.fn().mockRejectedValueOnce(deleted);
    const service = new GoogleCalendarEvents(clientWith({ get, getCalendar, remove }));
    await expect(service.remove('token', 'calendar', appointment)).resolves.toBe(CalendarEventRemoval.Cancelled);
    await expect(service.remove('token', 'calendar', appointment)).resolves.toBe(CalendarEventRemoval.Cancelled);
    await expect(service.remove('token', 'calendar', appointment)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getCalendar).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('encodes calendar IDs and sends conditional patches using separate OAuth clients', async () => {
    const config = readConfiguration({
      NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:4200',
      GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      DATABASE_URL: 'postgresql://localhost/kotailor_test',
      GOOGLE_CALENDAR_REDIRECT_URI: 'http://localhost:3000/api/calendar/google/callback',
      CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const request = vi.spyOn(OAuth2Client.prototype, 'request').mockRejectedValue(new Error('offline'));
    const credentials = vi.spyOn(OAuth2Client.prototype, 'setCredentials');
    try {
      const client = createCalendarEventClient(config);
      await expect(client.insert('token-one', 'a/b@example.invalid', eventId, body)).rejects.toThrow('offline');
      await expect(client.patch('token-two', 'a/b@example.invalid', eventId, '"etag"', body)).rejects.toThrow('offline');
      await expect(client.remove('token-three', 'a/b@example.invalid', eventId, '"etag"')).rejects.toThrow('offline');
      await expect(client.getCalendar('token-four', 'a/b@example.invalid')).rejects.toThrow('offline');
      expect(credentials.mock.contexts[0]).not.toBe(credentials.mock.contexts[1]);
      expect(request).toHaveBeenNthCalledWith(1, {
        url: 'https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.invalid/events',
        method: 'POST', data: { id: eventId, ...body }, timeout: 10000,
      });
      expect(request).toHaveBeenNthCalledWith(2, {
        url: `https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.invalid/events/${eventId}`,
        method: 'PATCH', data: body, headers: { 'If-Match': '"etag"' }, timeout: 10000,
      });
      expect(request).toHaveBeenNthCalledWith(3, {
        url: `https://www.googleapis.com/calendar/v3/calendars/a%2Fb%40example.invalid/events/${eventId}`,
        method: 'DELETE', headers: { 'If-Match': '"etag"' }, timeout: 10000,
      });
      expect(request).toHaveBeenNthCalledWith(4, {
        url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList/a%2Fb%40example.invalid',
        method: 'GET', timeout: 10000,
      });
    } finally {
      request.mockRestore();
      credentials.mockRestore();
    }
  });
});
