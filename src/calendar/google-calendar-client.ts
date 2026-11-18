import { OAuth2Client } from 'google-auth-library';
import { type Configuration } from '../config.js';

export function createGoogleCalendarClient(config: Configuration, refreshToken: string): OAuth2Client {
  if (!config.calendar) throw new Error('Google Calendar is not configured');
  const client = new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: config.calendar.redirectUri,
  });
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export async function getGoogleCalendarEntry(config: Configuration, refreshToken: string, calendarId: string): Promise<unknown> {
  const response = await createGoogleCalendarClient(config, refreshToken).request<unknown>({
    url: `https://www.googleapis.com/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`,
    method: 'GET', timeout: 10000,
  });
  return response.data;
}
