import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { Database } from '../database/database.js';
import {
  measurementCatalog,
  measurementDraftSchema,
  measurementSchema,
  validDraftFields,
} from './measurement.schema.js';

@Controller('client')
@UseGuards(SessionGuard)
export class ClientPortalController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get('workshops')
  @Header('Cache-Control', 'no-store')
  async workshops(@Req() request: Request) {
    const result = await this.database.pool.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM customer_account_links l
       JOIN workshops w ON w.id = l.workshop_id
       WHERE l.user_id = $1 ORDER BY w.name, w.id LIMIT 101`,
      [request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Customer account link required');
    return { workshops: result.rows.slice(0, 100), hasMore: result.rows.length > 100 };
  }

  @Get('workshops/:workshopId/measurements')
  @Header('Cache-Control', 'no-store')
  async measurements(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    const result = await this.database.pool.query<{
      garment: string | null;
      version: number | null;
      measurements: Record<string, number> | null;
      verifiedAt: Date | null;
      drafts: { garment: string; updatedAt: string }[];
      submissions: { id: string; garment: string; submittedAt: string; verified: boolean }[];
    }>(
      `SELECT v.garment, v.version, v.measurements, v.verified_at AS "verifiedAt",
       COALESCE((SELECT json_agg(json_build_object('garment', d.garment, 'updatedAt', d.updated_at))
                 FROM client_measurement_drafts d WHERE d.customer_id = l.customer_id), '[]'::json) AS drafts,
       COALESCE((SELECT json_agg(json_build_object('id', s.id, 'garment', s.garment,
                 'submittedAt', s.submitted_at, 'verified', s.verified_version_id IS NOT NULL))
                 FROM (SELECT DISTINCT ON (garment) id, garment, submitted_at, verified_version_id
                       FROM client_measurement_submissions
                       WHERE customer_id = l.customer_id AND workshop_id = l.workshop_id AND submitted_by = l.user_id
                       ORDER BY garment, submitted_at DESC, id DESC) s), '[]'::json) AS submissions
       FROM customer_account_links l
       LEFT JOIN LATERAL (
         SELECT DISTINCT ON (garment) garment, version, measurements, verified_at
         FROM customer_measurement_versions
         WHERE workshop_id = l.workshop_id AND customer_id = l.customer_id
         ORDER BY garment, version DESC
       ) v ON true
       WHERE l.workshop_id = $1 AND l.user_id = $2`,
      [workshopId, request.session.userId],
    );
    if (!result.rowCount) throw new NotFoundException('Workshop not found');
    return {
      catalog: measurementCatalog,
      versions: result.rows
        .filter((row) => row.garment !== null)
        .map(({ drafts: _drafts, submissions: _submissions, ...version }) => version),
      drafts: result.rows[0].drafts,
      submissions: result.rows[0].submissions,
    };
  }

  @Get('workshops/:workshopId/measurement-drafts/:garment')
  @Header('Cache-Control', 'no-store')
  async draft(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('garment') garment: string,
  ) {
    const definition = measurementCatalog.find((item) => item.id === garment);
    if (!definition) throw new BadRequestException('Invalid garment');
    const result = await this.database.pool.query<{
      workshopName: string;
      measurements: Record<string, number> | null;
      revision: number | null;
    }>(
      `SELECT w.name AS "workshopName", d.measurements, d.revision
       FROM customer_account_links l JOIN workshops w ON w.id = l.workshop_id
       LEFT JOIN client_measurement_drafts d ON d.customer_id = l.customer_id AND d.garment = $3
       WHERE l.workshop_id = $1 AND l.user_id = $2`,
      [workshopId, request.session.userId, garment],
    );
    if (!result.rowCount) throw new NotFoundException('Workshop not found');
    return {
      garment: definition,
      workshopName: result.rows[0].workshopName,
      measurements: result.rows[0].measurements ?? {},
      revision: result.rows[0].revision ?? 0,
    };
  }

  @Put('workshops/:workshopId/measurement-drafts/:garment')
  @Header('Cache-Control', 'no-store')
  async saveDraft(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('garment') garment: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const definition = measurementCatalog.find((item) => item.id === garment);
    const parsed = measurementDraftSchema.safeParse(body);
    if (!definition || !parsed.success || !validDraftFields(definition.id, parsed.data.measurements)) {
      throw new BadRequestException('Invalid draft');
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const link = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM customer_account_links
         WHERE workshop_id = $1 AND user_id = $2 FOR UPDATE`,
        [workshopId, request.session.userId],
      );
      if (!link.rowCount) throw new NotFoundException('Workshop not found');
      const customerId = link.rows[0].customer_id;
      const existing = await client.query<{ revision: number }>(
        'SELECT revision FROM client_measurement_drafts WHERE customer_id = $1 AND garment = $2',
        [customerId, definition.id],
      );
      if ((existing.rows[0]?.revision ?? 0) !== parsed.data.revision) {
        throw new ConflictException('Draft changed');
      }
      const saved = await client.query<{ revision: number }>(
        `INSERT INTO client_measurement_drafts (customer_id, garment, measurements)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, garment) DO UPDATE
         SET measurements = EXCLUDED.measurements, revision = client_measurement_drafts.revision + 1, updated_at = now()
         RETURNING revision`,
        [customerId, definition.id, JSON.stringify(parsed.data.measurements)],
      );
      await client.query('COMMIT');
      return saved.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('workshops/:workshopId/measurement-drafts/:garment/submit')
  @Header('Cache-Control', 'no-store')
  async submitDraft(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('garment') garment: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const definition = measurementCatalog.find((item) => item.id === garment);
    const parsed = z
      .strictObject({ revision: z.number().int().positive(), confirmed: z.literal(true) })
      .safeParse(body);
    if (!definition || !parsed.success) throw new BadRequestException('Invalid submission');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const link = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM customer_account_links WHERE workshop_id = $1 AND user_id = $2 FOR UPDATE`,
        [workshopId, request.session.userId],
      );
      if (!link.rowCount) throw new NotFoundException('Workshop not found');
      const customerId = link.rows[0].customer_id;
      const draft = await client.query<{ id: string; revision: number; measurements: Record<string, number> }>(
        'SELECT id, revision, measurements FROM client_measurement_drafts WHERE customer_id = $1 AND garment = $2',
        [customerId, definition.id],
      );
      if (!draft.rowCount) throw new ConflictException('Save the draft first');
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM client_measurement_submissions WHERE draft_id = $1 AND draft_revision = $2 AND submitted_by = $3`,
        [draft.rows[0].id, parsed.data.revision, request.session.userId],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      if (draft.rows[0].revision !== parsed.data.revision) throw new ConflictException('Draft changed');
      if (
        !measurementSchema.safeParse({
          garment: definition.id,
          measurements: draft.rows[0].measurements,
          confirmed: true,
        }).success
      ) {
        throw new BadRequestException('Draft is incomplete');
      }
      const pending = await client.query(
        'SELECT 1 FROM client_measurement_submissions WHERE customer_id = $1 AND garment = $2 AND verified_version_id IS NULL',
        [customerId, definition.id],
      );
      if (pending.rowCount) throw new ConflictException('A submission is awaiting review');
      const result = await client.query<{ id: string }>(
        `INSERT INTO client_measurement_submissions
           (workshop_id, customer_id, submitted_by, garment, draft_id, draft_revision, measurements)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          workshopId,
          customerId,
          request.session.userId,
          definition.id,
          draft.rows[0].id,
          draft.rows[0].revision,
          JSON.stringify(draft.rows[0].measurements),
        ],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Get('workshops/:workshopId/measurement-submissions/:submissionId')
  @Header('Cache-Control', 'no-store')
  async submission(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
  ) {
    const result = await this.database.pool.query(
      `SELECT s.id, s.garment, s.measurements, s.submitted_at AS "submittedAt",
                s.verified_version_id IS NOT NULL AS verified, w.name AS "workshopName"
         FROM client_measurement_submissions s
         JOIN customer_account_links l ON l.customer_id = s.customer_id AND l.workshop_id = s.workshop_id
         JOIN workshops w ON w.id = s.workshop_id
         WHERE s.id = $1 AND s.workshop_id = $2 AND l.user_id = $3 AND s.submitted_by = $3`,
      [submissionId, workshopId, request.session.userId],
    );
    if (!result.rowCount) throw new NotFoundException('Submission not found');
    const record = result.rows[0] as { garment: string };
    return { ...record, catalog: measurementCatalog };
  }
}
