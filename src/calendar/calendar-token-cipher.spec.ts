import { randomUUID } from 'node:crypto';
import { readConfiguration } from '../config.js';
import { CalendarTokenCipher } from './calendar-token-cipher.js';

describe('CalendarTokenCipher', () => {
  const config = readConfiguration({
    NODE_ENV: 'test', PORT: '3000', FRONTEND_ORIGIN: 'http://localhost:4200',
    GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters',
    DATABASE_URL: 'postgresql://localhost/kotailor_test',
    GOOGLE_CALENDAR_REDIRECT_URI: 'http://localhost:3000/api/calendar/google/callback',
    CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64url'),
  });
  const cipher = new CalendarTokenCipher(config);

  it('encrypts tokens with a fresh nonce and authenticates the workshop', () => {
    const workshop = randomUUID();
    const first = cipher.encrypt(workshop, 'example-refresh-token');
    const second = cipher.encrypt(workshop, 'example-refresh-token');
    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from('example-refresh-token'))).toBe(false);
    expect(cipher.decrypt(workshop, first)).toBe('example-refresh-token');
    expect(cipher.decrypt(workshop.toUpperCase(), first)).toBe('example-refresh-token');
    expect(() => cipher.decrypt(randomUUID(), first)).toThrow();
    const tampered = Buffer.from(first);
    tampered[tampered.length - 1] ^= 1;
    expect(() => cipher.decrypt(workshop, tampered)).toThrow();
  });

  it('rejects invalid ciphertext, context and missing configuration', () => {
    expect(() => cipher.decrypt(randomUUID(), Buffer.alloc(2))).toThrow('Invalid encrypted calendar token');
    expect(() => cipher.encrypt('invalid', 'token')).toThrow('Invalid calendar workshop');
    expect(() => cipher.encrypt(randomUUID(), '')).toThrow('cannot be empty');
    expect(() => new CalendarTokenCipher({ ...config, calendar: undefined }).encrypt(randomUUID(), 'token'))
      .toThrow('not configured');
  });
});
