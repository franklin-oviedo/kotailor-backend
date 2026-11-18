import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppointmentActor, AppointmentKind } from '../src/appointments/appointments.schema.js';
import { AppointmentsService } from '../src/appointments/appointments.service.js';
import { readConfiguration } from '../src/config.js';
import { Database } from '../src/database/database.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Appointment operations', () => {
  let database: Database;
  let service: AppointmentsService;
  const suffix = randomUUID();
  const subjects = ['owner', 'staff', 'customer', 'other'].map((name) => `appointment-${name}-${suffix}`);
  const workshops: string[] = [];
  let users: string[];
  let customers: string[];

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    database = new Database(readConfiguration());
    service = new AppointmentsService(database);
    const userRows = await database.pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       SELECT subject, subject || '@example.invalid', subject FROM unnest($1::text[]) subject RETURNING id`, [subjects],
    );
    users = userRows.rows.map((row) => row.id);
    const workshopRows = await database.pool.query<{ id: string }>(
      `INSERT INTO workshops (name) VALUES ('Appointment service A'), ('Appointment service B') RETURNING id`,
    );
    workshops.push(...workshopRows.rows.map((row) => row.id));
    await database.pool.query(
      `INSERT INTO workshop_memberships (workshop_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $3, 'manager'), ($1, $4, 'staff'), ($2, $4, 'staff')`,
      [workshops[0], workshops[1], users[0], users[1]],
    );
    const customerRows = await database.pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Customer one', '8095550100', 'person'),
              ($1, 'Customer two', '8095550100', 'person'),
              ($2, 'Customer three', '8095550100', 'person') RETURNING id`, workshops,
    );
    customers = customerRows.rows.map((row) => row.id);
    await database.pool.query(
      `INSERT INTO customer_account_links (workshop_id, customer_id, user_id)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [workshops[0], customers[0], users[2], customers[1], users[3]],
    );
  });

  afterAll(async () => {
    if (!database) return;
    try {
      if (workshops.length) await database.pool.query('DELETE FROM workshops WHERE id = ANY($1::uuid[])', [workshops]);
      await database.pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [subjects]);
    } finally {
      await database.onModuleDestroy();
    }
  });

  it('creates idempotently and validates roles, customer links and responsible membership', async () => {
    const input = {
      requestId: randomUUID(), customerId: customers[0], orderId: null, responsibleId: users[1],
      kind: AppointmentKind.Fitting, startsAt: '2031-02-01T14:00:00Z', endsAt: '2031-02-01T15:00:00Z',
    };
    await expect(service.create(workshops[0], users[1], AppointmentActor.Workshop, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create(workshops[0], users[3], AppointmentActor.Customer, input)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.create(workshops[0], users[0], AppointmentActor.Workshop, { ...input, responsibleId: users[2] }))
      .rejects.toBeInstanceOf(BadRequestException);
    const results = await Promise.all([
      service.create(workshops[0], users[2], AppointmentActor.Customer, input),
      service.create(workshops[0], users[2], AppointmentActor.Customer, input),
    ]);
    expect(results[0].id).toBe(results[1].id);
    await expect(service.create(workshops[0], users[2], AppointmentActor.Customer, { ...input, kind: AppointmentKind.Delivery }))
      .rejects.toBeInstanceOf(ConflictException);
    const saved = await database.pool.query(
      'SELECT count(*)::int AS count, min(synced_version) AS synced FROM appointments WHERE request_id = $1', [input.requestId],
    );
    expect(saved.rows[0]).toEqual({ count: 1, synced: 0 });
    await expect(service.create(workshops[1], users[0], AppointmentActor.Workshop, {
      ...input, requestId: randomUUID(), customerId: customers[2],
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('authorizes only the linked customer or a manager and protects concurrent changes', async () => {
    const created = await service.create(workshops[0], users[0], AppointmentActor.Workshop, {
      requestId: randomUUID(), customerId: customers[0], orderId: null, responsibleId: users[1],
      kind: AppointmentKind.Measurements, startsAt: '2031-02-02T14:00:00Z', endsAt: '2031-02-02T15:00:00Z',
    });
    const change = {
      expectedVersion: 1, responsibleId: users[1],
      startsAt: '2031-02-02T15:00:00Z', endsAt: '2031-02-02T16:00:00Z',
    };
    await expect(service.reschedule(workshops[0], users[3], AppointmentActor.Customer, created.id, change))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancel(workshops[0], users[1], AppointmentActor.Workshop, created.id, { expectedVersion: 1 }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await service.reschedule(workshops[0], users[2], AppointmentActor.Customer, created.id, change)).toEqual({ version: 2 });
    await expect(service.cancel(workshops[0], users[0], AppointmentActor.Workshop, created.id, { expectedVersion: 1 }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await service.cancel(workshops[0], users[2], AppointmentActor.Customer, created.id, { expectedVersion: 2 }))
      .toEqual({ version: 3 });
    await expect(service.reschedule(workshops[0], users[0], AppointmentActor.Workshop, created.id, { ...change, expectedVersion: 3 }))
      .rejects.toBeInstanceOf(ConflictException);
    const saved = await database.pool.query('SELECT status, version, synced_version FROM appointments WHERE id = $1', [created.id]);
    expect(saved.rows[0]).toEqual({ status: 'cancelled', version: 3, synced_version: 0 });
  });

  it('accepts only one concurrent change and rechecks a revoked customer link', async () => {
    const appointment = await service.create(workshops[1], users[0], AppointmentActor.Workshop, {
      requestId: randomUUID(), customerId: customers[2], orderId: null, responsibleId: users[1],
      kind: AppointmentKind.Fitting, startsAt: '2031-02-03T14:00:00Z', endsAt: '2031-02-03T15:00:00Z',
    });
    const attempts = await Promise.allSettled([
      service.reschedule(workshops[1], users[0], AppointmentActor.Workshop, appointment.id, {
        expectedVersion: 1, responsibleId: users[1], startsAt: '2031-02-03T15:00:00Z', endsAt: '2031-02-03T16:00:00Z',
      }),
      service.cancel(workshops[1], users[0], AppointmentActor.Workshop, appointment.id, { expectedVersion: 1 }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const failed = attempts.find((attempt) => attempt.status === 'rejected');
    expect(failed).toMatchObject({ reason: expect.any(ConflictException) });

    const customerAppointment = await service.create(workshops[0], users[2], AppointmentActor.Customer, {
      requestId: randomUUID(), customerId: customers[0], orderId: null, responsibleId: users[1],
      kind: AppointmentKind.Fitting, startsAt: '2031-02-04T14:00:00Z', endsAt: '2031-02-04T15:00:00Z',
    });
    await database.pool.query('DELETE FROM customer_account_links WHERE workshop_id = $1 AND user_id = $2',
      [workshops[0], users[2]]);
    await expect(service.cancel(workshops[0], users[2], AppointmentActor.Customer, customerAppointment.id, { expectedVersion: 1 }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
