import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../database/database.js';
import type {
  AuthenticatedUser,
  GoogleIdentity,
  WorkshopMembership,
} from './auth.types.js';

@Injectable()
export class IdentityRepository {
  constructor(@Inject(Database) private readonly database: Database) {}

  async signIn(identity: GoogleIdentity): Promise<AuthenticatedUser> {
    const result = await this.database.pool.query<AuthenticatedUser>(
      `INSERT INTO app_users (google_subject, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (google_subject) DO UPDATE
       SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
       RETURNING id, email, display_name AS name`,
      [identity.subject, identity.email, identity.name],
    );
    return result.rows[0];
  }

  async findUser(userId: string): Promise<AuthenticatedUser | undefined> {
    const result = await this.database.pool.query<AuthenticatedUser>(
      'SELECT id, email, display_name AS name FROM app_users WHERE id = $1',
      [userId],
    );
    return result.rows[0];
  }

  async memberships(userId: string): Promise<WorkshopMembership[]> {
    const result = await this.database.pool.query<WorkshopMembership>(
      `SELECT w.id, w.name, m.role
       FROM workshops w JOIN workshop_memberships m ON m.workshop_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at`,
      [userId],
    );
    return result.rows;
  }

  async isPlatformAdministrator(userId: string): Promise<boolean> {
    const result = await this.database.pool.query('SELECT 1 FROM platform_administrators WHERE user_id = $1', [userId]);
    return Boolean(result.rowCount);
  }

  async canCreateWorkshop(userId: string): Promise<boolean> {
    const result = await this.database.pool.query(
      'SELECT 1 FROM workshop_creation_grants WHERE user_id = $1 AND used_at IS NULL LIMIT 1', [userId],
    );
    return Boolean(result.rowCount);
  }
}
