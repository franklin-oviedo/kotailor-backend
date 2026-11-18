import { ConflictException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { type Configuration } from '../config.js';
import { createGoogleCalendarClient, getGoogleCalendarEntry } from './google-calendar-client.js';

export interface CalendarListItem {
  id: string;
  name: string;
  primary: boolean;
}

export interface CalendarListPage {
  calendars: CalendarListItem[];
  nextPageToken: string | null;
}

export const CALENDAR_LIST_CLIENT = Symbol('CALENDAR_LIST_CLIENT');

export interface CalendarListClient {
  list(refreshToken: string, pageToken?: string): Promise<unknown>;
  get(refreshToken: string, calendarId: string): Promise<unknown>;
}

export function createCalendarListClient(config: Configuration): CalendarListClient {
  return {
    async list(refreshToken, pageToken) {
      const client = createGoogleCalendarClient(config, refreshToken);
      const response = await client.request<unknown>({
        url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        method: 'GET',
        params: { maxResults: 100, minAccessRole: 'writer', showHidden: true, ...(pageToken && { pageToken }) },
        timeout: 10000,
      });
      return response.data;
    },
    get: (refreshToken, calendarId) => getGoogleCalendarEntry(config, refreshToken, calendarId),
  };
}

export const writableCalendarSchema = z.object({
  kind: z.literal('calendar#calendarListEntry'),
  id: z.string().min(1),
  accessRole: z.enum(['owner', 'writer']),
  deleted: z.boolean().optional(),
});

const responseSchema = z.object({
  kind: z.literal('calendar#calendarList'),
  items: z.array(z.object({
    id: z.string().min(1),
    summary: z.string().optional(),
    summaryOverride: z.string().optional(),
    primary: z.boolean().optional(),
    accessRole: z.string(),
  })).optional(),
  nextPageToken: z.string().min(1).max(4096).optional(),
});

@Injectable()
export class GoogleCalendarList {
  private readonly logger = new Logger(GoogleCalendarList.name);

  constructor(
    @Inject(CALENDAR_LIST_CLIENT) private readonly client: CalendarListClient,
  ) {}

  async list(refreshToken: string, pageToken?: string): Promise<CalendarListPage> {
    let response: unknown;
    try {
      response = await this.client.list(refreshToken, pageToken);
    } catch {
      this.logger.warn('Google Calendar list request failed');
      throw new ServiceUnavailableException('Google Calendar is unavailable; check the connection and try again');
    }
    const parsed = responseSchema.safeParse(response);
    if (!parsed.success) {
      this.logger.warn('Google Calendar returned an invalid calendar list');
      throw new ServiceUnavailableException('Google Calendar returned an invalid response');
    }
    return {
      calendars: (parsed.data.items ?? [])
        .filter((calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer')
        .map((calendar) => ({
          id: calendar.id,
          name: calendar.summaryOverride || calendar.summary || calendar.id,
          primary: calendar.primary === true,
        })),
      nextPageToken: parsed.data.nextPageToken ?? null,
    };
  }

  async requireWritable(refreshToken: string, calendarId: string): Promise<void> {
    let response: unknown;
    try {
      response = await this.client.get(refreshToken, calendarId);
    } catch (error) {
      const status = z.object({ response: z.object({ status: z.number() }) }).safeParse(error);
      if (status.success && status.data.response.status === 404) {
        throw new ConflictException('Google Calendar is unavailable or not writable');
      }
      this.logger.warn('Google Calendar access verification failed');
      throw new ServiceUnavailableException('Google Calendar is unavailable; check the connection and try again');
    }
    const parsed = writableCalendarSchema.safeParse(response);
    if (!parsed.success || parsed.data.id !== calendarId || parsed.data.deleted === true) {
      throw new ConflictException('Google Calendar is unavailable or not writable');
    }
  }
}
