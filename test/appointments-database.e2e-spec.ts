import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { readConfiguration } from '../src/config.js';

const databaseSuite = process.env.RUN_DB_INTEGRATION === 'true' ? describe : describe.skip;

databaseSuite('Appointment database constraints', () => {
  let pool: Pool;
  const suffix = randomUUID();
  const subjects = [`appointment-${suffix}`, `appointment-other-${suffix}`];
  const workshops: string[] = [];
  let users: string[];
  let customers: string[];

  beforeAll(async () => {
    if (existsSync('.env')) process.loadEnvFile('.env');
    pool = new Pool({ connectionString: readConfiguration().databaseUrl });
    const userRows = await pool.query<{ id: string }>(
      `INSERT INTO app_users (google_subject, email, display_name)
       VALUES ($1, 'appointment@example.invalid', 'Appointment test'),
              ($2, 'appointment-other@example.invalid', 'Other test') RETURNING id`, subjects,
    );
    users = userRows.rows.map((row) => row.id);
    const workshopRows = await pool.query<{ id: string }>(
      `INSERT INTO workshops (name) VALUES ('Appointment test A'), ('Appointment test B') RETURNING id`,
    );
    workshops.push(...workshopRows.rows.map((row) => row.id));
    const customerRows = await pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Test customer A', '8095550100', 'person'),
              ($2, 'Test customer B', '8095550100', 'person') RETURNING id`, workshops,
    );
    customers = customerRows.rows.map((row) => row.id);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (workshops.length) await pool.query('DELETE FROM workshops WHERE id = ANY($1::uuid[])', [workshops]);
      await pool.query('DELETE FROM app_users WHERE google_subject = ANY($1::text[])', [subjects]);
    } finally {
      await pool.end();
    }
  });

  it('prevents overlaps across workshops while allowing adjacent or cancelled appointments', async () => {
    const insert = (workshop: string, customer: string, responsible: string, start: string, end: string) =>
      pool.query<{ id: string }>(
        `INSERT INTO appointments (workshop_id, customer_id, responsible_id, kind, starts_at, ends_at, created_by, updated_by)
         VALUES ($1, $2, $3, 'fitting', $4, $5, $3, $3) RETURNING id`,
        [workshop, customer, responsible, start, end],
      );
    const first = await insert(workshops[0], customers[0], users[0], '2030-01-01T14:00:00Z', '2030-01-01T15:00:00Z');
    await insert(workshops[0], customers[0], users[0], '2030-01-01T15:00:00Z', '2030-01-01T15:30:00Z');
    await insert(workshops[1], customers[1], users[1], '2030-01-01T14:00:00Z', '2030-01-01T15:00:00Z');
    await expect(insert(workshops[1], customers[1], users[0], '2030-01-01T14:30:00Z', '2030-01-01T15:00:00Z'))
      .rejects.toMatchObject({ code: '23P01', constraint: 'appointments_responsible_no_overlap' });
    await expect(insert(workshops[0], customers[1], users[0], '2030-01-02T14:00:00Z', '2030-01-02T15:00:00Z'))
      .rejects.toMatchObject({ code: '23503' });
    await pool.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [first.rows[0].id]);
    await insert(workshops[1], customers[1], users[0], '2030-01-01T14:30:00Z', '2030-01-01T15:00:00Z');
  });

  it('rejects one of two concurrent overlapping reservations', async () => {
    const reserve = (index: number) => pool.query(
      `INSERT INTO appointments (workshop_id, customer_id, responsible_id, kind, starts_at, ends_at, created_by, updated_by)
       VALUES ($1, $2, $3, 'measurements', '2030-01-03T14:00:00Z', '2030-01-03T15:00:00Z', $3, $3)`,
      [workshops[index], customers[index], users[0]],
    );
    const results = await Promise.allSettled([reserve(0), reserve(1)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: '23P01', constraint: 'appointments_responsible_no_overlap' } });
  });

  it('only links an order to its own customer and workshop', async () => {
    const anotherCustomer = await pool.query<{ id: string }>(
      `INSERT INTO customers (workshop_id, name, phone, kind)
       VALUES ($1, 'Another customer', '8095550100', 'person') RETURNING id`, [workshops[0]],
    );
    const order = await pool.query<{ id: string }>(
      `INSERT INTO workshop_orders
         (workshop_id, number, customer_id, customer_name, catalog_name, catalog_instructions,
          tax_treatment, subtotal_cents, measurement_snapshots, delivery_local, created_by)
       VALUES ($1, 1, $2, 'Test customer A', 'Test garment', '', 'exempt', 0, '[]', '2030-01-05 10:00', $3)
       RETURNING id`, [workshops[0], customers[0], users[0]],
    );
    const insert = (customerId: string) => pool.query(
      `INSERT INTO appointments
         (workshop_id, customer_id, order_id, responsible_id, kind, starts_at, ends_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'delivery', '2030-01-05T14:00:00Z', '2030-01-05T14:30:00Z', $4, $4)`,
      [workshops[0], customerId, order.rows[0].id, users[0]],
    );
    await expect(insert(anotherCustomer.rows[0].id)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(customers[0])).resolves.toMatchObject({ rowCount: 1 });
  });
});
