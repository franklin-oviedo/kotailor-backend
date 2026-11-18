import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject,
  NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CONFIGURATION, type Configuration } from '../config.js';
import { Database } from '../database/database.js';
import { queryPage } from '../database/pagination.js';
import { SessionGuard } from '../auth/session.guard.js';
import { customerSchema } from './customer.schema.js';
import { measurementCatalog, measurementSchema, MeasurementGarment } from './measurement.schema.js';

@Controller('workshops/:workshopId/customers')
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('search') search: unknown, @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
  ) {
    if (search !== undefined && (typeof search !== 'string' || search.length > 120)) {
      throw new BadRequestException('Invalid search');
    }
    await this.requireMembership(request.session.userId!, workshopId);
    const term = typeof search === 'string' ? search.trim() : '';
    const escaped = term.replace(/[\\%_]/g, '\\$&');
    const { rows, ...result } = await queryPage(this.database.pool,
      `SELECT id, name, phone, email, kind, document_kind AS "documentKind",
              document_number AS "documentNumber", contact_authorized AS "contactAuthorized",
              created_at AS "createdAt"
       FROM customers WHERE workshop_id = $1 AND
       EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $3) AND
       (name ILIKE $2 OR phone ILIKE $2 OR document_number ILIKE $2)`,
      [workshopId, `%${escaped}%`, request.session.userId],
      '"createdAt" DESC, id DESC', page, pageSize,
    );
    return { customers: rows, ...result };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }
    const parsed = customerSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid customer data');
    await this.requireMembership(request.session.userId!, workshopId);
    const customer = parsed.data;
    const result = await this.database.pool.query(
      `INSERT INTO customers
       (workshop_id, name, phone, email, kind, document_kind, document_number, contact_authorized, address)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$10
       WHERE EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $9)
       RETURNING id, name, phone, email, kind, address, document_kind AS "documentKind",
         document_number AS "documentNumber", contact_authorized AS "contactAuthorized", created_at AS "createdAt"`,
      [workshopId, customer.name, customer.phone, customer.email, customer.kind,
        customer.documentKind, customer.documentNumber, customer.contactAuthorized, request.session.userId, customer.address ?? null],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
    return result.rows[0];
  }

  @Get(':customerId')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    await this.requireMembership(request.session.userId!, workshopId);
    const result = await this.database.pool.query(
      `SELECT c.id, c.name, c.phone, c.email, c.kind, c.address, c.document_kind AS "documentKind",
              c.document_number AS "documentNumber", c.contact_authorized AS "contactAuthorized",
              c.created_at AS "createdAt"
       FROM customers c JOIN workshop_memberships m ON m.workshop_id = c.workshop_id
       WHERE c.workshop_id = $1 AND c.id = $2 AND m.user_id = $3`,
      [workshopId, customerId, request.session.userId],
    );
    if (!result.rowCount) throw new NotFoundException('Customer not found');
    return { ...result.rows[0], measurementCatalog };
  }

  @Get(':customerId/measurements')
  @Header('Cache-Control', 'no-store')
  async measurements(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('before') before: unknown,
    @Query('garment') garment: unknown,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
  ) {
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,8}$/.test(before))) {
      throw new BadRequestException('Invalid version cursor');
    }
    if (garment !== undefined && !Object.values(MeasurementGarment).some((item) => item === garment)) {
      throw new BadRequestException('Invalid garment');
    }
    await this.requireMembership(request.session.userId!, workshopId);
    const customer = await this.database.pool.query(
      `SELECT 1 FROM customers c JOIN workshop_memberships m ON m.workshop_id = c.workshop_id
       WHERE c.workshop_id = $1 AND c.id = $2 AND m.user_id = $3`,
      [workshopId, customerId, request.session.userId],
    );
    if (!customer.rowCount) throw new NotFoundException('Customer not found');
    const sql = `SELECT v.id, v.garment, v.version, v.measurements, v.verified_at AS "verifiedAt",
              u.display_name AS "verifiedBy"
       FROM customer_measurement_versions v
       JOIN app_users u ON u.id = v.verified_by
       JOIN workshop_memberships m ON m.workshop_id = v.workshop_id AND m.user_id = $3
       WHERE v.workshop_id = $1 AND v.customer_id = $2 AND v.garment = $4
         AND ($5::int IS NULL OR v.version < $5)`;
    const values = [workshopId, customerId, request.session.userId, garment ?? MeasurementGarment.WomensTrousers,
      before === undefined ? null : Number(before)];
    if (page !== undefined || pageSize !== undefined) {
      if (before !== undefined) throw new BadRequestException('Cannot combine pagination and version cursor');
      const { rows, ...pagination } = await queryPage(this.database.pool, sql, values, 'version DESC', page, pageSize);
      return { versions: rows, ...pagination };
    }
    const result = await this.database.pool.query(`${sql} ORDER BY v.version DESC LIMIT 21`, values);
    return { versions: result.rows.slice(0, 20), hasMore: result.rows.length > 20 };
  }

  @Post(':customerId/measurements')
  @Header('Cache-Control', 'no-store')
  async createMeasurement(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }
    const parsed = measurementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid measurement data');
    await this.requireMembership(request.session.userId!, workshopId);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const customer = await client.query(
        `SELECT c.id FROM customers c
         JOIN workshop_memberships m ON m.workshop_id = c.workshop_id
         WHERE c.workshop_id = $1 AND c.id = $2 AND m.user_id = $3
         FOR UPDATE OF c, m`,
        [workshopId, customerId, request.session.userId],
      );
      if (!customer.rowCount) throw new NotFoundException('Customer not found');
      const result = await client.query(
        `INSERT INTO customer_measurement_versions
         (workshop_id, customer_id, garment, version, measurements, verified_by)
         SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5
         FROM customer_measurement_versions
         WHERE workshop_id = $1 AND customer_id = $2 AND garment = $3
         RETURNING id, version`,
        [workshopId, customerId, parsed.data.garment, JSON.stringify(parsed.data.measurements),
          request.session.userId],
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

  @Get(':customerId/measurement-submissions')
  @Header('Cache-Control', 'no-store')
  async pendingSubmission(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('garment') garment: unknown,
  ) {
    if (!Object.values(MeasurementGarment).some((item) => item === garment)) {
      throw new BadRequestException('Invalid garment');
    }
    await this.requireMembership(request.session.userId!, workshopId);
    const result = await this.database.pool.query(
      `SELECT c.id AS customer_id, s.id, s.measurements, s.submitted_at AS "submittedAt",
              u.display_name AS "submittedBy"
       FROM customers c JOIN workshop_memberships m ON m.workshop_id = c.workshop_id AND m.user_id = $3
       LEFT JOIN client_measurement_submissions s
         ON s.customer_id = c.id AND s.workshop_id = c.workshop_id
         AND s.garment = $4 AND s.verified_version_id IS NULL
       LEFT JOIN app_users u ON u.id = s.submitted_by
       WHERE c.workshop_id = $1 AND c.id = $2`,
      [workshopId, customerId, request.session.userId, garment],
    );
    if (!result.rowCount) throw new NotFoundException('Customer not found');
    const row = result.rows[0] as { id: string | null; measurements: Record<string, number> | null; submittedAt: Date | null; submittedBy: string | null };
    return { submission: row.id ? { id: row.id, measurements: row.measurements, submittedAt: row.submittedAt, submittedBy: row.submittedBy } : null };
  }

  @Post(':customerId/measurement-submissions/:submissionId/verify')
  @Header('Cache-Control', 'no-store')
  async verifySubmission(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = measurementSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid measurement data');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const customer = await client.query(
        `SELECT c.id FROM customers c JOIN workshop_memberships m ON m.workshop_id = c.workshop_id
         WHERE c.workshop_id = $1 AND c.id = $2 AND m.user_id = $3 FOR UPDATE OF c, m`,
        [workshopId, customerId, request.session.userId],
      );
      if (!customer.rowCount) throw new NotFoundException('Customer not found');
      const submission = await client.query<{ garment: MeasurementGarment; verified_version_id: string | null }>(
        `SELECT garment, verified_version_id FROM client_measurement_submissions
         WHERE id = $1 AND workshop_id = $2 AND customer_id = $3 FOR UPDATE`,
        [submissionId, workshopId, customerId],
      );
      if (!submission.rowCount) throw new NotFoundException('Submission not found');
      if (submission.rows[0].garment !== parsed.data.garment) throw new BadRequestException('Invalid garment');
      if (submission.rows[0].verified_version_id) {
        const previous = await client.query<{ id: string; version: number }>(
          `SELECT id, version FROM customer_measurement_versions WHERE id = $1 AND measurements = $2::jsonb`,
          [submission.rows[0].verified_version_id, JSON.stringify(parsed.data.measurements)],
        );
        if (!previous.rowCount) throw new ConflictException('Submission already reviewed');
        await client.query('COMMIT');
        return previous.rows[0];
      }
      const version = await client.query<{ id: string; version: number }>(
        `INSERT INTO customer_measurement_versions (workshop_id, customer_id, garment, version, measurements, verified_by)
         SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5
         FROM customer_measurement_versions WHERE workshop_id = $1 AND customer_id = $2 AND garment = $3
         RETURNING id, version`,
        [workshopId, customerId, parsed.data.garment, JSON.stringify(parsed.data.measurements), request.session.userId],
      );
      await client.query('UPDATE client_measurement_submissions SET verified_version_id = $1 WHERE id = $2', [version.rows[0].id, submissionId]);
      await client.query('COMMIT');
      return version.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireMembership(userId: string, workshopId: string): Promise<void> {
    const result = await this.database.pool.query(
      'SELECT 1 FROM workshop_memberships WHERE user_id = $1 AND workshop_id = $2',
      [userId, workshopId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
  }
}
