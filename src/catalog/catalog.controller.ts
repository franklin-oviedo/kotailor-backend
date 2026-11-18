import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject,
  NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { measurementCatalog } from '../customers/measurement.schema.js';
import { Database } from '../database/database.js';
import { queryPage } from '../database/pagination.js';
import { catalogSchema, catalogUpdateSchema } from './catalog.schema.js';

@Controller('workshops/:workshopId/catalog')
@UseGuards(SessionGuard)
export class CatalogController {
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
    const term = typeof search === 'string' ? search.trim().replace(/[\\%_]/g, '\\$&') : '';
    const { rows, ...result } = await queryPage(this.database.pool,
      `SELECT id, name, category, base_price_cents::float8 AS "basePriceCents",
              tax_treatment AS "taxTreatment", measurement_garments::text[] AS "measurementGarments",
              instructions, revision, created_at AS "createdAt"
       FROM garment_catalog
       WHERE workshop_id = $1 AND name ILIKE $2
         AND EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $3)`,
      [workshopId, `%${term}%`, request.session.userId],
      '"createdAt" DESC, id DESC', page, pageSize,
    );
    return { items: rows, ...result, measurementCatalog };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = catalogSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid catalog data');
    await this.requireMembership(request.session.userId!, workshopId);
    const item = parsed.data;
    const result = await this.database.pool.query(
      `INSERT INTO garment_catalog
       (workshop_id, name, category, base_price_cents, tax_treatment, measurement_garments, instructions)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $8)
       RETURNING id`,
      [workshopId, item.name, item.category, item.basePriceCents, item.taxTreatment,
        item.measurementGarments, item.instructions, request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
    return result.rows[0];
  }

  @Patch(':itemId')
  @Header('Cache-Control', 'no-store')
  async update(
    @Req() request: Request,
    @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = catalogUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid catalog data');
    await this.requireMembership(request.session.userId!, workshopId);
    const item = parsed.data;
    const result = await this.database.pool.query(
      `UPDATE garment_catalog
       SET name = $3, category = $4, base_price_cents = $5, tax_treatment = $6,
           measurement_garments = $7, instructions = $8, revision = revision + 1
       WHERE workshop_id = $1 AND id = $2 AND revision = $10
         AND EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $9)
       RETURNING id`,
      [workshopId, itemId, item.name, item.category, item.basePriceCents, item.taxTreatment,
        item.measurementGarments, item.instructions, request.session.userId, item.revision],
    );
    if (!result.rowCount) {
      const current = await this.database.pool.query(
        `SELECT 1 FROM garment_catalog c JOIN workshop_memberships m ON m.workshop_id = c.workshop_id
         WHERE c.workshop_id = $1 AND c.id = $2 AND m.user_id = $3`,
        [workshopId, itemId, request.session.userId],
      );
      if (!current.rowCount) throw new NotFoundException('Catalog item not found');
      throw new ConflictException('Catalog item was modified');
    }
    return result.rows[0];
  }

  private async requireMembership(userId: string, workshopId: string): Promise<void> {
    const result = await this.database.pool.query(
      'SELECT 1 FROM workshop_memberships WHERE user_id = $1 AND workshop_id = $2',
      [userId, workshopId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
  }
}
