import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CONFIGURATION, type Configuration } from '../config.js';

const version = 1;
const nonceBytes = 12;
const tagBytes = 16;

@Injectable()
export class CalendarTokenCipher {
  constructor(@Inject(CONFIGURATION) private readonly config: Configuration) {}

  encrypt(workshopId: string, token: string): Buffer {
    const key = this.key(workshopId);
    if (!token) throw new Error('Calendar token cannot be empty');
    const nonce = randomBytes(nonceBytes);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.context(workshopId));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([version]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(workshopId: string, encrypted: Buffer): string {
    const key = this.key(workshopId);
    if (encrypted.length <= 1 + nonceBytes + tagBytes || encrypted[0] !== version) {
      throw new Error('Invalid encrypted calendar token');
    }
    const nonce = encrypted.subarray(1, 1 + nonceBytes);
    const tag = encrypted.subarray(1 + nonceBytes, 1 + nonceBytes + tagBytes);
    const ciphertext = encrypted.subarray(1 + nonceBytes + tagBytes);
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.context(workshopId));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
  }

  private key(workshopId: string): Buffer {
    if (!z.uuid().safeParse(workshopId).success) throw new Error('Invalid calendar workshop');
    if (!this.config.calendar) throw new Error('Google Calendar is not configured');
    return Buffer.from(this.config.calendar.tokenKey, 'base64url');
  }

  private context(workshopId: string): Buffer {
    return Buffer.from(`kotailor:calendar-refresh:v${version}:${workshopId.toLowerCase()}`, 'utf8');
  }
}
