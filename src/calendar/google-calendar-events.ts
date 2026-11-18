import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { AppointmentKind } from '../appointments/appointments.schema.js';
import { type Configuration } from '../config.js';
import { createGoogleCalendarClient, getGoogleCalendarEntry } from './google-calendar-client.js';
import { writableCalendarSchema } from './google-calendar-list.js';

export const CALENDAR_EVENT_CLIENT = Symbol('CALENDAR_EVENT_CLIENT');

export interface CalendarEventBody {
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: { private: Record<string, string> };
}

export interface CalendarEventClient {
  get(token: string, calendarId: string, eventId: string): Promise<unknown>;
  insert(token: string, calendarId: string, eventId: string, body: CalendarEventBody): Promise<unknown>;
  patch(token: string, calendarId: string, eventId: string, etag: string, body: CalendarEventBody): Promise<unknown>;
  remove(token: string, calendarId: string, eventId: string, etag: string): Promise<void>;
  getCalendar(token: string, calendarId: string): Promise<unknown>;
}

export function createCalendarEventClient(config: Configuration): CalendarEventClient {
  const eventUrl = (calendarId: string) =>
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return {
    async get(token, calendarId, eventId) {
      const response = await createGoogleCalendarClient(config, token).request<unknown>({
        url: `${eventUrl(calendarId)}/${eventId}`, method: 'GET', timeout: 10000,
      });
      return response.data;
    },
    async insert(token, calendarId, eventId, body) {
      const response = await createGoogleCalendarClient(config, token).request<unknown>({
        url: eventUrl(calendarId), method: 'POST', data: { id: eventId, ...body }, timeout: 10000,
      });
      return response.data;
    },
    async patch(token, calendarId, eventId, etag, body) {
      const response = await createGoogleCalendarClient(config, token).request<unknown>({
        url: `${eventUrl(calendarId)}/${eventId}`, method: 'PATCH', data: body,
        headers: { 'If-Match': etag }, timeout: 10000,
      });
      return response.data;
    },
    async remove(token, calendarId, eventId, etag) {
      await createGoogleCalendarClient(config, token).request<unknown>({
        url: `${eventUrl(calendarId)}/${eventId}`, method: 'DELETE', headers: { 'If-Match': etag }, timeout: 10000,
      });
    },
    getCalendar: (token, calendarId) => getGoogleCalendarEntry(config, token, calendarId),
  };
}

const identitySchema = z.object({
  workshopId: z.uuid(),
  appointmentId: z.uuid(),
  version: z.number().int().positive(),
});

const appointmentSchema = identitySchema.extend({
  kind: z.enum(AppointmentKind),
  customerName: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
}).refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt));

export type CalendarAppointment = z.infer<typeof appointmentSchema>;
export type CalendarEventIdentity = z.infer<typeof identitySchema>;

export enum CalendarEventRemoval {
  Removed = 'removed',
  Cancelled = 'cancelled',
  NotFound = 'not_found',
}

const eventSchema = z.object({
  kind: z.literal('calendar#event'),
  id: z.string(),
  etag: z.string().min(1),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  summary: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), timeZone: z.string().optional() }).optional(),
  end: z.object({ dateTime: z.string().optional(), timeZone: z.string().optional() }).optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()) }),
});

const eventLabels: Record<AppointmentKind, string> = {
  [AppointmentKind.Fitting]: 'Prueba',
  [AppointmentKind.Measurements]: 'Medidas',
  [AppointmentKind.Delivery]: 'Entrega',
};

@Injectable()
export class GoogleCalendarEvents {
  private readonly logger = new Logger(GoogleCalendarEvents.name);

  constructor(@Inject(CALENDAR_EVENT_CLIENT) private readonly client: CalendarEventClient) {}

  async upsert(token: string, calendarId: string, input: CalendarAppointment): Promise<void> {
    const appointment = appointmentSchema.safeParse(input);
    this.validateTarget(token, calendarId);
    if (!appointment.success) throw new BadRequestException('Invalid calendar event');
    const data = appointment.data;
    const eventId = this.eventId(data.appointmentId);
    const properties = this.properties(data);
    const body: CalendarEventBody = {
      summary: `${eventLabels[data.kind]} - ${data.customerName}`,
      start: { dateTime: data.startsAt, timeZone: 'America/Santo_Domingo' },
      end: { dateTime: data.endsAt, timeZone: 'America/Santo_Domingo' },
      extendedProperties: { private: properties },
    };
    try {
      let existing: unknown;
      let missing = false;
      try {
        existing = await this.client.get(token, calendarId, eventId);
      } catch (error) {
        if (!this.isStatus(error, 404)) throw error;
        missing = true;
      }
      if (missing) {
        const created = await this.client.insert(token, calendarId, eventId, body);
        this.requireAppliedEvent(created, eventId, properties, body);
        return;
      }
      const event = this.requireOwnedEvent(existing, eventId, properties);
      if (!this.isCurrentVersion(event.extendedProperties.private.kotailorVersion, data.version) || event.status === 'cancelled') {
        throw new ConflictException('Calendar event requires reconciliation');
      }
      if (this.matchesAppliedEvent(event, properties, body)
          && event.start?.timeZone === body.start.timeZone && event.end?.timeZone === body.end.timeZone) return;
      body.extendedProperties.private = { ...event.extendedProperties.private, ...properties };
      const updated = await this.client.patch(token, calendarId, eventId, event.etag, body);
      this.requireAppliedEvent(updated, eventId, properties, body);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (this.isStatus(error, 409) || this.isStatus(error, 412)) {
        throw new ServiceUnavailableException('Calendar event changed; retry synchronization');
      }
      this.logger.warn('Google Calendar event synchronization failed');
      throw new ServiceUnavailableException('Google Calendar event could not be synchronized');
    }
  }

  async remove(token: string, calendarId: string, input: CalendarEventIdentity): Promise<CalendarEventRemoval> {
    this.validateTarget(token, calendarId);
    const identity = identitySchema.safeParse(input);
    if (!identity.success) throw new BadRequestException('Invalid calendar event');
    const data = identity.data;
    const eventId = this.eventId(data.appointmentId);
    try {
      let existing: unknown;
      try {
        existing = await this.client.get(token, calendarId, eventId);
      } catch (error) {
        const deleted = this.isDeleted(error);
        if (!this.isStatus(error, 404) && !deleted) throw error;
        const calendar = writableCalendarSchema.safeParse(await this.client.getCalendar(token, calendarId));
        if (!calendar.success || calendar.data.id !== calendarId || calendar.data.deleted === true) {
          throw new ConflictException('Calendar access could not be verified');
        }
        return deleted ? CalendarEventRemoval.Cancelled : CalendarEventRemoval.NotFound;
      }
      const deleted = z.object({
        kind: z.literal('calendar#event'), id: z.string(), status: z.literal('cancelled'),
      }).safeParse(existing);
      if (deleted.success && deleted.data.id === eventId) return CalendarEventRemoval.Cancelled;
      const event = this.requireOwnedEvent(existing, eventId, this.properties(data));
      if (!this.isCurrentVersion(event.extendedProperties.private.kotailorVersion, data.version)) {
        throw new ConflictException('Calendar event requires reconciliation');
      }
      try {
        await this.client.remove(token, calendarId, eventId, event.etag);
      } catch (error) {
        if (this.isDeleted(error)) return CalendarEventRemoval.Cancelled;
        throw error;
      }
      return CalendarEventRemoval.Removed;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (this.isStatus(error, 409) || this.isStatus(error, 412)) {
        throw new ServiceUnavailableException('Calendar event changed; retry synchronization');
      }
      this.logger.warn('Google Calendar event deletion failed');
      throw new ServiceUnavailableException('Google Calendar event could not be removed');
    }
  }

  private validateTarget(token: string, calendarId: string): void {
    if (!token || !calendarId || calendarId.length > 1024 || calendarId === '.' || calendarId === '..') {
      throw new BadRequestException('Invalid calendar event');
    }
  }

  private eventId(appointmentId: string): string {
    return `k${appointmentId.replaceAll('-', '').toLowerCase()}`;
  }

  private properties(data: CalendarEventIdentity): Record<string, string> {
    return {
      kotailorWorkshopId: data.workshopId.toLowerCase(),
      kotailorAppointmentId: data.appointmentId.toLowerCase(),
      kotailorVersion: String(data.version),
    };
  }

  private isCurrentVersion(versionText: string | undefined, maximum: number): boolean {
    const version = Number(versionText);
    return Number.isSafeInteger(version) && version > 0 && String(version) === versionText && version <= maximum;
  }

  private requireAppliedEvent(value: unknown, eventId: string, properties: Record<string, string>, body: CalendarEventBody): void {
    const event = this.requireOwnedEvent(value, eventId, properties);
    if (!this.matchesAppliedEvent(event, properties, body)) {
      throw new ConflictException('Calendar event requires reconciliation');
    }
  }

  private matchesAppliedEvent(event: z.infer<typeof eventSchema>, properties: Record<string, string>, body: CalendarEventBody): boolean {
    return event.extendedProperties.private.kotailorVersion === properties.kotailorVersion && event.status !== 'cancelled'
      && event.summary === body.summary && Date.parse(event.start?.dateTime ?? '') === Date.parse(body.start.dateTime)
      && Date.parse(event.end?.dateTime ?? '') === Date.parse(body.end.dateTime);
  }

  private requireOwnedEvent(value: unknown, eventId: string, properties: Record<string, string>) {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== eventId
        || parsed.data.extendedProperties.private.kotailorWorkshopId !== properties.kotailorWorkshopId
        || parsed.data.extendedProperties.private.kotailorAppointmentId !== properties.kotailorAppointmentId) {
      throw new ConflictException('Calendar event ownership could not be verified');
    }
    return parsed.data;
  }

  private isStatus(error: unknown, status: number): boolean {
    const result = z.object({ response: z.object({ status: z.number() }) }).safeParse(error);
    return result.success && result.data.response.status === status;
  }

  private isDeleted(error: unknown): boolean {
    const result = z.object({
      response: z.object({
        status: z.literal(410),
        data: z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })) }) }),
      }),
    }).safeParse(error);
    return result.success && result.data.response.data.error.errors.some((entry) => entry.reason === 'deleted');
  }
}
