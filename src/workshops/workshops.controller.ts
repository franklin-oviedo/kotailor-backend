import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { Database } from '../database/database.js';
import {
  customerAcceptanceSchema, CustomerInvitationChoice, customerInvitationSchema,
  platformInvitationSchema, PlatformInviteKind, stageInvitationSchema, workshopSchema,
} from './invitation.schema.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Controller()
export class WorkshopsController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Post('admin/invitations')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async inviteFirstAdministrator(@Req() request: Request, @Body() body: unknown) {
    this.requireOrigin(request);
    const parsed = platformInvitationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invitation');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const admin = await client.query('SELECT 1 FROM platform_administrators WHERE user_id = $1 FOR SHARE', [request.session.userId]);
      if (!admin.rowCount) throw new ForbiddenException('Platform administrator required');
      let workshopId: string | null = null;
      if (parsed.data.kind === PlatformInviteKind.CreateWorkshop) {
        const workshop = await client.query('INSERT INTO workshops (name) VALUES ($1) RETURNING id', [parsed.data.workshopName]);
        workshopId = workshop.rows[0].id;
      }
      const invitation = await this.createInvitation(client, parsed.data.email, workshopId, request.session.userId!, true);
      await client.query('COMMIT');
      return invitation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('workshops/:workshopId/administrator-invitations')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async inviteAdministrator(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    this.requireOrigin(request);
    const parsed = platformInvitationSchema.safeParse(body);
    if (!parsed.success || parsed.data.kind !== PlatformInviteKind.AuthorizeCreator) throw new BadRequestException('Invalid invitation');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        "SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE",
        [workshopId, request.session.userId],
      );
      if (!membership.rowCount) throw new ForbiddenException('Workshop administrator required');
      const invitation = await this.createInvitation(client, parsed.data.email, workshopId, request.session.userId!, false);
      await client.query('COMMIT');
      return invitation;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('workshops/:workshopId/customer-invitations')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async inviteCustomer(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    this.requireOrigin(request);
    const parsed = customerInvitationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invitation');
    const token = randomBytes(32).toString('base64url');
    const result = await this.database.pool.query(
      `INSERT INTO customer_invitations (token_hash, recipient_email, workshop_id, created_by, expires_at)
       SELECT $1, $2, m.workshop_id, m.user_id, now() + (p.ttl_hours * interval '1 hour')
       FROM workshop_memberships m CROSS JOIN administrator_invitation_policy p
       WHERE m.workshop_id = $3 AND m.user_id = $4 AND m.role IN ('owner', 'manager')
       RETURNING expires_at AS "expiresAt"`,
      [hashToken(token), parsed.data.email, workshopId, request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop manager required');
    return { link: `${this.config.frontendOrigin}/invitacion#${token}`, expiresAt: result.rows[0].expiresAt };
  }

  @Post('invitations/stage')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  async stage(@Req() request: Request, @Body() body: unknown) {
    this.requireOrigin(request);
    const parsed = stageInvitationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid invitation');
    const hash = hashToken(parsed.data.token);
    const invitation = await this.database.pool.query(
      `SELECT 1 FROM administrator_invitations WHERE token_hash = $1 AND expires_at > now()
       UNION ALL SELECT 1 FROM customer_invitations WHERE token_hash = $1 AND expires_at > now()`,
      [hash],
    );
    if (!invitation.rowCount) throw new BadRequestException('Invitation unavailable');
    request.session.pendingInvitation = hash;
    await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
    return { staged: true };
  }

  @Get('invitations/pending')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async pending(@Req() request: Request) {
    const result = await this.database.pool.query(
      `SELECT i.kind, w.name AS "workshopName", i.expires_at AS "expiresAt"
       FROM administrator_invitations i JOIN app_users u ON u.id = $2
       LEFT JOIN workshops w ON w.id = i.workshop_id
       WHERE i.token_hash = $1 AND lower(i.recipient_email) = lower(u.email)
         AND i.expires_at > now() AND (i.accepted_at IS NULL OR i.accepted_by = u.id)`,
      [request.session.pendingInvitation ?? null, request.session.userId],
    );
    if (result.rowCount) return result.rows[0];
    const customer = await this.database.pool.query(
      `SELECT 'customer' AS kind, w.name AS "workshopName", i.expires_at AS "expiresAt",
              i.workshop_id AS "workshopId", i.accepted_by AS "acceptedBy",
              EXISTS (SELECT 1 FROM customer_account_links l
                      WHERE l.workshop_id = i.workshop_id AND l.user_id = u.id) AS "alreadyLinked",
              EXISTS (SELECT 1 FROM customer_account_links l
                      WHERE l.customer_id = i.customer_id AND l.user_id = u.id) AS "acceptedLinkExists"
       FROM customer_invitations i JOIN app_users u ON u.id = $2
       JOIN workshops w ON w.id = i.workshop_id
       WHERE i.token_hash = $1 AND lower(i.recipient_email) = lower(u.email)
         AND i.expires_at > now() AND (i.accepted_at IS NULL OR i.accepted_by = u.id)
         AND (i.accepted_at IS NOT NULL OR EXISTS (
           SELECT 1 FROM workshop_memberships m WHERE m.workshop_id = i.workshop_id
           AND m.user_id = i.created_by AND m.role IN ('owner', 'manager')))`,
      [request.session.pendingInvitation ?? null, request.session.userId],
    );
    if (!customer.rowCount) throw new ForbiddenException('Invitation unavailable for this account');
    if (customer.rows[0].acceptedBy && !customer.rows[0].acceptedLinkExists) {
      throw new ForbiddenException('Customer association is no longer available');
    }
    const candidates = await this.database.pool.query(
      `SELECT c.id, c.name FROM customers c JOIN app_users u ON u.id = $2
       LEFT JOIN customer_account_links l ON l.customer_id = c.id
       WHERE c.workshop_id = $1 AND lower(c.email) = lower(u.email)
         AND (l.user_id IS NULL OR l.user_id = u.id)
       ORDER BY c.name, c.id LIMIT 101`,
      [customer.rows[0].workshopId, request.session.userId],
    );
    return { kind: 'customer', workshopName: customer.rows[0].workshopName,
      expiresAt: customer.rows[0].expiresAt, candidates: candidates.rows.slice(0, 100),
      hasMore: candidates.rows.length > 100, accepted: Boolean(customer.rows[0].acceptedBy),
      alreadyLinked: customer.rows[0].alreadyLinked };
  }

  @Post('invitations/accept')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async accept(@Req() request: Request, @Body() body: unknown) {
    this.requireOrigin(request);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT i.id, i.kind, i.workshop_id, i.role, i.accepted_by, i.issued_by_platform, i.created_by
         FROM administrator_invitations i JOIN app_users u ON u.id = $2
         WHERE i.token_hash = $1 AND lower(i.recipient_email) = lower(u.email) AND i.expires_at > now()
         FOR UPDATE OF i`,
        [request.session.pendingInvitation ?? null, request.session.userId],
      );
      if (!result.rowCount) {
        const accepted = await this.acceptCustomer(client, request, body);
        await client.query('COMMIT');
        delete request.session.pendingInvitation;
        await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
        return accepted;
      }
      const invitation = result.rows[0] as {
        id: string; kind: string; workshop_id: string | null; role: string | null;
        accepted_by: string | null; issued_by_platform: boolean; created_by: string;
      };
      if (invitation.accepted_by && invitation.accepted_by !== request.session.userId) {
        throw new ForbiddenException('Invitation unavailable for this account');
      }

      if (!invitation.accepted_by) {
        const issuer = invitation.issued_by_platform
          ? await client.query('SELECT 1 FROM platform_administrators WHERE user_id = $1 FOR SHARE', [invitation.created_by])
          : await client.query(
            "SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE",
            [invitation.workshop_id, invitation.created_by],
          );
        if (!issuer.rowCount) throw new ForbiddenException('Invitation is no longer authorized');
        if (invitation.kind === 'workshop_creator') {
          await client.query('INSERT INTO workshop_creation_grants (user_id, invitation_id) VALUES ($1, $2)',
            [request.session.userId, invitation.id]);
        } else {
          await client.query(
            `INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, $3)
             ON CONFLICT (workshop_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
            [invitation.workshop_id, request.session.userId, invitation.role],
          );
        }
        await client.query('UPDATE administrator_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
          [invitation.id, request.session.userId]);
      }
      await client.query('COMMIT');
      delete request.session.pendingInvitation;
      await new Promise<void>((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
      return { kind: invitation.kind, workshopId: invitation.workshop_id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async acceptCustomer(client: PoolClient, request: Request, body: unknown) {
    const result = await client.query(
      `SELECT i.id, i.workshop_id, i.created_by, i.accepted_by, i.customer_id
       FROM customer_invitations i JOIN app_users u ON u.id = $2
       WHERE i.token_hash = $1 AND lower(i.recipient_email) = lower(u.email) AND i.expires_at > now()
       FOR UPDATE OF i`,
      [request.session.pendingInvitation ?? null, request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Invitation unavailable for this account');
    const invitation = result.rows[0] as {
      id: string; workshop_id: string; created_by: string; accepted_by: string | null; customer_id: string | null;
    };
    if (invitation.accepted_by) {
      if (invitation.accepted_by !== request.session.userId) throw new ForbiddenException('Invitation unavailable for this account');
      const link = await client.query(
        'SELECT 1 FROM customer_account_links WHERE customer_id = $1 AND user_id = $2',
        [invitation.customer_id, request.session.userId],
      );
      if (!link.rowCount) throw new ForbiddenException('Customer association is no longer available');
      return { kind: 'customer', workshopId: invitation.workshop_id, customerId: invitation.customer_id };
    }
    const parsed = customerAcceptanceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid customer selection');
    const issuer = await client.query(
      `SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2
       AND role IN ('owner', 'manager') FOR SHARE`, [invitation.workshop_id, invitation.created_by],
    );
    if (!issuer.rowCount) throw new ForbiddenException('Invitation is no longer authorized');
    await client.query('SELECT id FROM workshops WHERE id = $1 FOR UPDATE', [invitation.workshop_id]);
    const existing = await client.query(
      'SELECT customer_id FROM customer_account_links WHERE workshop_id = $1 AND user_id = $2',
      [invitation.workshop_id, request.session.userId],
    );
    if (existing.rowCount) throw new ConflictException('Account already linked to this workshop');
    let customerId: string;
    if (parsed.data.choice === CustomerInvitationChoice.Existing) {
      const customer = await client.query(
        `SELECT c.id FROM customers c JOIN app_users u ON u.id = $3
         LEFT JOIN customer_account_links l ON l.customer_id = c.id
         WHERE c.workshop_id = $1 AND c.id = $2 AND lower(c.email) = lower(u.email)
           AND l.customer_id IS NULL FOR UPDATE OF c`,
        [invitation.workshop_id, parsed.data.customerId, request.session.userId],
      );
      if (!customer.rowCount) throw new ForbiddenException('Customer record unavailable for this account');
      customerId = customer.rows[0].id;
    } else {
      const customer = await client.query(
        `INSERT INTO customers (workshop_id, name, phone, email, kind)
         SELECT $1, $2, $3, email, 'person' FROM app_users WHERE id = $4 RETURNING id`,
        [invitation.workshop_id, parsed.data.name, parsed.data.phone, request.session.userId],
      );
      customerId = customer.rows[0].id;
    }
    await client.query('INSERT INTO customer_account_links (customer_id, workshop_id, user_id) VALUES ($1, $2, $3)',
      [customerId, invitation.workshop_id, request.session.userId]);
    await client.query('UPDATE customer_invitations SET accepted_at = now(), accepted_by = $2, customer_id = $3 WHERE id = $1',
      [invitation.id, request.session.userId, customerId]);
    return { kind: 'customer', workshopId: invitation.workshop_id, customerId };
  }

  @Get('workshops/creation-permission')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async creationPermission(@Req() request: Request) {
    const result = await this.database.pool.query(
      'SELECT 1 FROM workshop_creation_grants WHERE user_id = $1 AND used_at IS NULL LIMIT 1',
      [request.session.userId],
    );
    return { canCreate: Boolean(result.rowCount) };
  }

  @Post('workshops')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async createWorkshop(@Req() request: Request, @Body() body: unknown) {
    this.requireOrigin(request);
    const parsed = workshopSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid workshop');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const grant = await client.query(
        `SELECT invitation_id FROM workshop_creation_grants WHERE user_id = $1 AND used_at IS NULL
         ORDER BY invitation_id LIMIT 1 FOR UPDATE`,
        [request.session.userId],
      );
      if (!grant.rowCount) throw new ForbiddenException('Workshop creation invitation required');
      const workshop = await client.query('INSERT INTO workshops (name) VALUES ($1) RETURNING id, name', [parsed.data.name]);
      await client.query("INSERT INTO workshop_memberships (workshop_id, user_id, role) VALUES ($1, $2, 'owner')",
        [workshop.rows[0].id, request.session.userId]);
      await client.query('UPDATE workshop_creation_grants SET used_at = now() WHERE user_id = $1 AND invitation_id = $2',
        [request.session.userId, grant.rows[0].invitation_id]);
      await client.query('COMMIT');
      return workshop.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private requireOrigin(request: Request): void {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
  }

  private async createInvitation(
    client: PoolClient, email: string, workshopId: string | null, issuer: string, platform: boolean,
  ) {
    const token = randomBytes(32).toString('base64url');
    const policy = await client.query('SELECT ttl_hours FROM administrator_invitation_policy WHERE id = true');
    if (!policy.rowCount) throw new Error('Invitation policy is missing');
    const kind = workshopId ? 'workshop_member' : 'workshop_creator';
    const result = await client.query(
      `INSERT INTO administrator_invitations
       (token_hash, recipient_email, kind, workshop_id, role, created_by, issued_by_platform, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 * interval '1 hour'))
       RETURNING expires_at AS "expiresAt"`,
      [hashToken(token), email, kind, workshopId, workshopId ? 'owner' : null, issuer, platform, policy.rows[0].ttl_hours],
    );
    return { link: `${this.config.frontendOrigin}/invitacion#${token}`, expiresAt: result.rows[0].expiresAt };
  }
}
