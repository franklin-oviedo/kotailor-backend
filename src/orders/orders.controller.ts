import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Inject,
  NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { SessionGuard } from '../auth/session.guard.js';
import { CONFIGURATION, type Configuration } from '../config.js';
import { measurementCatalog } from '../customers/measurement.schema.js';
import { Database } from '../database/database.js';
import { parsePage, queryPage } from '../database/pagination.js';
import {
  orderSchema, OrderFilter, OrderStatus, ProductionDeliveryFilter, ProductionResponsibleFilter,
  responsibleFilterSchema, statusChangeSchema, taxSettingsSchema,
} from './orders.schema.js';

const statusSequence = [
  OrderStatus.Received, OrderStatus.Cutting, OrderStatus.Sewing, OrderStatus.Fitting, OrderStatus.Ready, OrderStatus.Delivered,
];

@Controller('workshops/:workshopId')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(CONFIGURATION) private readonly config: Configuration,
  ) {}

  @Get('order-settings')
  @Header('Cache-Control', 'no-store')
  async settings(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    const result = await this.database.pool.query(
      `SELECT w.itbis_basis_points AS "itbisBasisPoints", m.role,
              (SELECT COALESCE(json_agg(json_build_object('id', u.id, 'name', u.display_name)
                         ORDER BY u.display_name, u.id), '[]'::json)
               FROM workshop_memberships wm JOIN app_users u ON u.id = wm.user_id
               WHERE wm.workshop_id = w.id) AS members
       FROM workshops w JOIN workshop_memberships m ON m.workshop_id = w.id
       WHERE w.id = $1 AND m.user_id = $2`,
      [workshopId, request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
    return result.rows[0];
  }

  @Put('order-settings')
  @Header('Cache-Control', 'no-store')
  async updateSettings(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = taxSettingsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid tax settings');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT 1 FROM workshop_memberships
         WHERE workshop_id = $1 AND user_id = $2 AND role = 'owner' FOR UPDATE`,
        [workshopId, request.session.userId],
      );
      if (!membership.rowCount) throw new ForbiddenException('Owner access required');
      const result = await client.query(
        'UPDATE workshops SET itbis_basis_points = $2 WHERE id = $1 RETURNING itbis_basis_points AS "itbisBasisPoints"',
        [workshopId, parsed.data.itbisBasisPoints],
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

  @Get('orders')
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('search') search: unknown, @Query('filter') filter: unknown,
    @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
  ) {
    if (search !== undefined && (typeof search !== 'string' || search.length > 120)) throw new BadRequestException('Invalid search');
    if (filter !== undefined && !Object.values(OrderFilter).some((item) => item === filter)) throw new BadRequestException('Invalid filter');
    await this.requireMembership(request.session.userId!, workshopId);
    const term = typeof search === 'string' ? search.trim().replace(/[\\%_]/g, '\\$&') : '';
    const filterValue = filter ?? OrderFilter.All;
    const match = `o.workshop_id = $1 AND EXISTS
         (SELECT 1 FROM workshop_memberships WHERE workshop_id = o.workshop_id AND user_id = $3)
         AND (o.customer_name ILIKE $2 OR o.catalog_name ILIKE $2 OR
              ('OT-' || CASE WHEN length(o.number::text) < 4 THEN lpad(o.number::text, 4, '0')
                             ELSE o.number::text END) ILIKE $2)`;
    const { rows, ...result } = await queryPage(this.database.pool,
      `SELECT o.id, o.number, o.customer_id AS "customerId", o.customer_name AS "customerName", o.catalog_name AS "catalogName",
              o.status, o.subtotal_cents::float8 AS "subtotalCents", o.tax_cents::float8 AS "taxCents",
              o.tax_treatment AS "taxTreatment", o.tax_basis_points AS "taxBasisPoints",
              to_char(o.delivery_local, 'YYYY-MM-DD"T"HH24:MI') AS "deliveryLocal", o.created_at AS "createdAt"
       FROM workshop_orders o
       WHERE ${match} AND ($4::text = 'all' OR
         ($4 = 'production' AND o.status IN ('received', 'cutting', 'sewing', 'fitting')) OR
         ($4 = 'ready' AND o.status = 'ready') OR ($4 = 'delivered' AND o.status = 'delivered'))`,
      [workshopId, `%${term}%`, request.session.userId, filterValue],
      '"createdAt" DESC, id DESC', page, pageSize,
    );
    const counts = await this.database.pool.query(
      `SELECT count(*)::int AS "all", count(*) FILTER (WHERE o.status IN ('received', 'cutting', 'sewing', 'fitting'))::int AS production,
              count(*) FILTER (WHERE o.status = 'ready')::int AS ready,
              count(*) FILTER (WHERE o.status = 'delivered')::int AS delivered
       FROM workshop_orders o WHERE ${match}`,
      [workshopId, `%${term}%`, request.session.userId],
    );
    return { orders: rows, ...result, counts: counts.rows[0] };
  }

  @Get('order-dashboard')
  @Header('Cache-Control', 'no-store')
  async dashboard(@Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string) {
    await this.requireMembership(request.session.userId!, workshopId);
    const result = await this.database.pool.query(
      `WITH active AS (
         SELECT o.number, o.customer_name, o.catalog_name, o.status, o.delivery_local
         FROM workshop_orders o
         WHERE o.workshop_id = $1 AND o.status <> 'delivered'
           AND EXISTS (SELECT 1 FROM workshop_memberships m
                       WHERE m.workshop_id = o.workshop_id AND m.user_id = $2)
       ), today AS (
         SELECT (now() AT TIME ZONE 'America/Santo_Domingo')::date AS day
       )
       SELECT count(*)::int AS "activeOrders",
              count(*) FILTER (WHERE delivery_local >= today.day
                               AND delivery_local < today.day + INTERVAL '1 day')::int AS "dueToday",
              (SELECT COALESCE(json_agg(json_build_object(
                        'number', p.number, 'customerName', p.customer_name,
                        'catalogName', p.catalog_name, 'status', p.status,
                        'deliveryLocal', to_char(p.delivery_local, 'YYYY-MM-DD"T"HH24:MI')
                      ) ORDER BY p.delivery_local, p.number), '[]'::json)
               FROM (SELECT * FROM active ORDER BY delivery_local, number LIMIT 4) p) AS priorities
       FROM active CROSS JOIN today
       HAVING EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2)`,
      [workshopId, request.session.userId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
    return result.rows[0];
  }

  @Get('production')
  @Header('Cache-Control', 'no-store')
  async production(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Query('delivery') delivery: unknown, @Query('responsible') responsible: unknown,
    @Query('stage') stage: unknown, @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
  ) {
    const pagination = parsePage(page, pageSize, 20);
    if (stage !== undefined && (stage === OrderStatus.Delivered || !Object.values(OrderStatus).some((status) => status === stage))) {
      throw new BadRequestException('Invalid production stage');
    }
    if (delivery !== undefined && !Object.values(ProductionDeliveryFilter).some((value) => value === delivery)) {
      throw new BadRequestException('Invalid delivery filter');
    }
    const parsedResponsible = responsibleFilterSchema.safeParse(responsible ?? ProductionResponsibleFilter.All);
    if (!parsedResponsible.success) throw new BadRequestException('Invalid responsible filter');
    const result = await this.database.pool.query(
      `WITH active AS (
         SELECT o.id, o.number, o.customer_name, o.catalog_name, o.status, o.delivery_local,
                o.responsible_name, o.responsible_id
         FROM workshop_orders o
         WHERE o.workshop_id = $1 AND o.status <> 'delivered'
           AND EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2)
       ), ranked AS (
         SELECT o.id, o.number, o.customer_name, o.catalog_name, o.status, o.delivery_local, o.responsible_name,
                row_number() OVER (PARTITION BY o.status ORDER BY o.delivery_local, o.number) AS position
         FROM active o
         WHERE ($3::text = 'all' OR (
             o.delivery_local >= date_trunc('week', now() AT TIME ZONE 'America/Santo_Domingo')
             AND o.delivery_local < date_trunc('week', now() AT TIME ZONE 'America/Santo_Domingo') + INTERVAL '1 week'
           ))
           AND ($4::text = 'all' OR
                ($4 = 'unassigned' AND o.responsible_id IS NULL AND o.responsible_name IS NULL) OR
                ($4 = 'historical' AND o.responsible_id IS NULL AND o.responsible_name IS NOT NULL) OR
                o.responsible_id::text = lower($4))
       ), counts AS (
         SELECT status, count(*)::int AS total,
                LEAST($5::bigint, GREATEST(1, ceil(count(*)::numeric / $6::int)))::int AS page
         FROM ranked WHERE ($7::text IS NULL OR status::text = $7) GROUP BY status
       ), stages AS (
         SELECT ranked.status, total, page,
                json_agg(json_build_object(
                  'id', id, 'number', number, 'customerName', customer_name, 'catalogName', catalog_name,
                  'deliveryLocal', to_char(delivery_local, 'YYYY-MM-DD"T"HH24:MI'), 'responsibleName', responsible_name
                ) ORDER BY delivery_local, number) AS orders
         FROM ranked JOIN counts USING (status)
         WHERE position > (page::bigint - 1) * $6 AND position <= page::bigint * $6
         GROUP BY ranked.status, total, page
       )
       SELECT COALESCE((SELECT json_agg(json_build_object('status', status, 'total', total, 'orders', orders,
                        'pagination', json_build_object('total', total, 'page', page, 'pageSize', $6)))
                        FROM stages), '[]'::json) AS stages,
              COALESCE((SELECT json_agg(json_build_object('id', members.id, 'name', members.name)
                                       ORDER BY members.name, members.id)
                        FROM (SELECT DISTINCT u.id, u.display_name AS name FROM active o
                              JOIN app_users u ON u.id = o.responsible_id) members), '[]'::json) AS responsibles,
              EXISTS (SELECT 1 FROM active WHERE responsible_id IS NULL AND responsible_name IS NOT NULL) AS "hasHistorical"
       FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2`,
      [workshopId, request.session.userId, delivery ?? ProductionDeliveryFilter.All, parsedResponsible.data,
        pagination.page, pagination.pageSize, stage ?? null],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
    return result.rows[0];
  }

  @Get('orders/:orderId')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query('page') page: unknown, @Query('pageSize') pageSize: unknown,
  ) {
    await this.requireMembership(request.session.userId!, workshopId);
    const result = await this.database.pool.query(
      `SELECT o.id, o.number, o.customer_name AS "customerName", o.catalog_name AS "catalogName",
              o.catalog_instructions AS "instructions", o.status, o.tax_treatment AS "taxTreatment",
              o.subtotal_cents::float8 AS "subtotalCents", o.tax_basis_points AS "taxBasisPoints",
              o.tax_cents::float8 AS "taxCents", o.measurement_snapshots AS "measurementSnapshots",
              o.responsible_name AS "responsibleName", o.created_at AS "createdAt",
              u.display_name AS "createdBy", to_char(o.delivery_local, 'YYYY-MM-DD"T"HH24:MI') AS "deliveryLocal"
       FROM workshop_orders o JOIN app_users u ON u.id = o.created_by
       WHERE o.workshop_id = $1 AND o.id = $2 AND EXISTS
         (SELECT 1 FROM workshop_memberships WHERE workshop_id = o.workshop_id AND user_id = $3)`,
      [workshopId, orderId, request.session.userId],
    );
    if (!result.rowCount) throw new NotFoundException('Order not found');
    const history = await queryPage(this.database.pool,
      `SELECT h.id, h.previous_status AS "previousStatus", h.new_status AS "newStatus",
              h.changed_by_name AS "changedBy", h.changed_at AS "changedAt"
       FROM order_status_history h WHERE h.workshop_id = $1 AND h.order_id = $2
         AND EXISTS (SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $3)`,
      [workshopId, orderId, request.session.userId], '"changedAt" DESC, id DESC', page, pageSize,
    );
    return { ...result.rows[0], history: history.rows, historyHasMore: history.hasMore, historyPagination: history.pagination };
  }

  @Put('orders/:orderId/status')
  @Header('Cache-Control', 'no-store')
  async updateStatus(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string, @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = statusChangeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid status change');
    const { expectedStatus, status } = parsed.data;
    if (Math.abs(statusSequence.indexOf(expectedStatus) - statusSequence.indexOf(status)) !== 1) {
      throw new BadRequestException('Status changes must be between adjacent stages');
    }
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        `SELECT u.display_name FROM workshop_memberships m JOIN app_users u ON u.id = m.user_id
         WHERE m.workshop_id = $1 AND m.user_id = $2 AND m.role IN ('owner', 'manager') FOR SHARE OF m`,
        [workshopId, request.session.userId],
      );
      if (!membership.rowCount) throw new ForbiddenException('Owner or manager access required');
      const order = await client.query(
        'SELECT status FROM workshop_orders WHERE workshop_id = $1 AND id = $2 FOR UPDATE',
        [workshopId, orderId],
      );
      if (!order.rowCount) throw new NotFoundException('Order not found');
      if (order.rows[0].status !== expectedStatus) throw new ConflictException('Order status changed');
      await client.query('UPDATE workshop_orders SET status = $3 WHERE workshop_id = $1 AND id = $2',
        [workshopId, orderId, status]);
      const history = await client.query(
        `INSERT INTO order_status_history (workshop_id, order_id, previous_status, new_status, changed_by, changed_by_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, previous_status AS "previousStatus", new_status AS "newStatus",
                   changed_by_name AS "changedBy", changed_at AS "changedAt"`,
        [workshopId, orderId, expectedStatus, status, request.session.userId, membership.rows[0].display_name],
      );
      await client.query('COMMIT');
      return { status, event: history.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  @Post('orders')
  @Header('Cache-Control', 'no-store')
  async create(
    @Req() request: Request, @Param('workshopId', ParseUUIDPipe) workshopId: string, @Body() body: unknown,
  ) {
    if (request.get('origin') !== this.config.frontendOrigin) throw new ForbiddenException('Invalid request origin');
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid order');
    const input = parsed.data;
    const { requestId, ...requestData } = input;
    const requestHash = createHash('sha256').update(JSON.stringify(requestData)).digest('hex');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const membership = await client.query(
        'SELECT 1 FROM workshop_memberships WHERE workshop_id = $1 AND user_id = $2 FOR SHARE',
        [workshopId, request.session.userId],
      );
      if (!membership.rowCount) throw new ForbiddenException('Workshop access denied');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${workshopId}:${request.session.userId}:${requestId}`]);
      const previous = await client.query(
        `SELECT id, number, request_hash FROM workshop_orders
         WHERE workshop_id = $1 AND created_by = $2 AND request_id = $3`,
        [workshopId, request.session.userId, requestId],
      );
      if (previous.rowCount) {
        if (previous.rows[0].request_hash !== requestHash) throw new ConflictException('Order request changed');
        await client.query('COMMIT');
        return { id: previous.rows[0].id, number: previous.rows[0].number };
      }
      const customer = await client.query(
        'SELECT id, name FROM customers WHERE workshop_id = $1 AND id = $2 FOR SHARE',
        [workshopId, input.customerId],
      );
      if (!customer.rowCount) throw new BadRequestException('Invalid customer');
      const catalog = await client.query(
        `SELECT name, instructions, revision,
                tax_treatment, measurement_garments::text[] AS garments
         FROM garment_catalog WHERE workshop_id = $1 AND id = $2 FOR SHARE`,
        [workshopId, input.catalogId],
      );
      if (!catalog.rowCount) throw new BadRequestException('Invalid catalog item');
      const item = catalog.rows[0] as {
        name: string; instructions: string; revision: number;
        tax_treatment: string; garments: string[];
      };
      if (item.revision !== input.catalogRevision) throw new ConflictException('Catalog item changed');
      const versions = await client.query(
        `SELECT v.id, v.garment, v.version, v.measurements, v.verified_at AS "verifiedAt",
                u.display_name AS "verifiedBy"
         FROM customer_measurement_versions v JOIN app_users u ON u.id = v.verified_by
         WHERE v.workshop_id = $1 AND v.customer_id = $2 AND v.id = ANY($3::uuid[])`,
        [workshopId, input.customerId, input.measurementIds],
      );
      const garments = versions.rows.map((row: { garment: string }) => row.garment);
      if (input.measurementIds.length !== item.garments.length || versions.rowCount !== item.garments.length ||
          new Set(garments).size !== garments.length ||
          !item.garments.every((garment) => garments.includes(garment))) {
        throw new BadRequestException('Measurements do not match required garments');
      }
      const snapshots = versions.rows.map((row: { garment: string }) => {
        const definition = measurementCatalog.find((entry) => entry.id === row.garment);
        if (!definition) throw new BadRequestException('Unknown measurement template');
        return { ...row, label: definition.label, fields: definition.fields };
      });
      let responsibleName: string | null = null;
      if (input.responsibleId) {
        const responsible = await client.query(
          `SELECT u.display_name FROM workshop_memberships m JOIN app_users u ON u.id = m.user_id
           WHERE m.workshop_id = $1 AND m.user_id = $2 FOR SHARE OF m`,
          [workshopId, input.responsibleId],
        );
        if (!responsible.rowCount) throw new BadRequestException('Invalid responsible member');
        responsibleName = responsible.rows[0].display_name;
      }
      const workshop = await client.query('SELECT itbis_basis_points FROM workshops WHERE id = $1 FOR SHARE', [workshopId]);
      const rate: number | null = item.tax_treatment === 'exempt' ? 0 : workshop.rows[0].itbis_basis_points;
      if (rate !== input.expectedTaxBasisPoints) throw new ConflictException('Tax settings changed');
      const taxCents = rate === null ? null : Math.floor((input.subtotalCents * rate + 5000) / 10000);
      const sequence = await client.query(
        `INSERT INTO workshop_order_sequences (workshop_id, last_number) VALUES ($1, 1)
         ON CONFLICT (workshop_id) DO UPDATE SET last_number = workshop_order_sequences.last_number + 1
         RETURNING last_number`, [workshopId],
      );
      const created = await client.query(
        `INSERT INTO workshop_orders
         (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions, tax_treatment,
          subtotal_cents, tax_basis_points, tax_cents, measurement_snapshots, delivery_local, responsible_name, created_by,
          request_id, request_hash, responsible_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, number`,
        [workshopId, sequence.rows[0].last_number, input.customerId, customer.rows[0].name, item.name,
          item.instructions, item.tax_treatment, input.subtotalCents, rate, taxCents, JSON.stringify(snapshots),
          input.deliveryLocal, responsibleName, request.session.userId, requestId, requestHash, input.responsibleId],
      );
      await client.query('COMMIT');
      return created.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireMembership(userId: string, workshopId: string): Promise<void> {
    const result = await this.database.pool.query(
      'SELECT 1 FROM workshop_memberships WHERE user_id = $1 AND workshop_id = $2', [userId, workshopId],
    );
    if (!result.rowCount) throw new ForbiddenException('Workshop access denied');
  }
}
