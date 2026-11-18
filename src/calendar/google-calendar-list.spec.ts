import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { readConfiguration } from '../config.js';
import { createCalendarListClient, GoogleCalendarList } from './google-calendar-list.js';

describe('GoogleCalendarList', () => {
  it('returns writable calendars and preserves pagination without exposing other fields', async () => {
    const list = vi.fn(async () => ({
      kind: 'calendar#calendarList',
      items: [
        { id: 'one', summary: 'Original', summaryOverride: 'My calendar', primary: true, accessRole: 'owner', description: 'private' },
        { id: 'two', summary: 'Shared', accessRole: 'writer' },
        { id: 'three', summary: 'Read only', accessRole: 'reader' },
        { id: 'four', accessRole: 'writerWithoutPrivateAccess' },
      ],
      nextPageToken: 'next-page',
    }));
    const service = new GoogleCalendarList({ list, get: vi.fn() });
    await expect(service.list('refresh-token', 'current-page')).resolves.toEqual({
      calendars: [
        { id: 'one', name: 'My calendar', primary: true },
        { id: 'two', name: 'Shared', primary: false },
      ],
      nextPageToken: 'next-page',
    });
    expect(list).toHaveBeenCalledWith('refresh-token', 'current-page');
  });

  it('reports provider failures and malformed responses rather than returning an empty list', async () => {
    const service = new GoogleCalendarList({
      list: vi.fn().mockRejectedValueOnce(new Error('sensitive provider details'))
        .mockResolvedValueOnce({ kind: 'calendar#calendarList', items: [{ id: 'missing-access-role' }] })
        .mockResolvedValueOnce({ kind: 'calendar#calendarList' }),
      get: vi.fn(),
    });
    await expect(service.list('token')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.list('token')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.list('token')).resolves.toEqual({ calendars: [], nextPageToken: null });
  });

  it('only accepts the requested, non-deleted calendar with full write access', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'one', accessRole: 'writer' })
      .mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'one', accessRole: 'reader' })
      .mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'two', accessRole: 'owner' })
      .mockResolvedValueOnce({ kind: 'calendar#calendarListEntry', id: 'one', accessRole: 'owner', deleted: true })
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const service = new GoogleCalendarList({ list: vi.fn(), get });
    await expect(service.requireWritable('token', 'one')).resolves.toBeUndefined();
    for (let i = 0; i < 4; i++) {
      await expect(service.requireWritable('token', 'one')).rejects.toBeInstanceOf(ConflictException);
    }
    await expect(service.requireWritable('token', 'one')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(get).toHaveBeenCalledWith('token', 'one');
  });

  it('uses a fresh OAuth client with the writable-list query for each account', async () => {
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
      const client = createCalendarListClient(config);
      await expect(client.list('token-one')).rejects.toThrow('offline');
      await expect(client.list('token-two', 'page-two')).rejects.toThrow('offline');
      await expect(client.get('token-three', 'a/b@example.invalid')).rejects.toThrow('offline');
      expect(credentials).toHaveBeenNthCalledWith(1, { refresh_token: 'token-one' });
      expect(credentials).toHaveBeenNthCalledWith(2, { refresh_token: 'token-two' });
      expect(credentials.mock.contexts[0]).not.toBe(credentials.mock.contexts[1]);
      expect(request).toHaveBeenNthCalledWith(2, {
        url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
        method: 'GET',
        params: { maxResults: 100, minAccessRole: 'writer', showHidden: true, pageToken: 'page-two' },
        timeout: 10000,
      });
      expect(request).toHaveBeenNthCalledWith(3, {
        url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList/a%2Fb%40example.invalid',
        method: 'GET', timeout: 10000,
      });
    } finally {
      request.mockRestore();
      credentials.mockRestore();
    }
  });
});
