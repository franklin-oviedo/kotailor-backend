import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { CONFIGURATION, type Configuration } from './config.js';
import { configureHttp } from './http.js';
import { Database } from './database/database.js';

async function bootstrap() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<Configuration>(CONFIGURATION);
  configureHttp(app, config);
  app.enableShutdownHooks();
  const requiredMigrations = [
    '001_identity.sql', '002_clients.sql', '003_measurements.sql', '004_measurement_garments.sql', '005_garment_catalog.sql',
    '006_catalog_revision.sql', '007_orders.sql', '008_order_idempotency.sql', '009_administrator_invitations.sql', '010_customer_invitations.sql',
    '011_client_measurement_drafts.sql', '012_measurement_submissions.sql', '013_order_status_history.sql', '014_order_responsible.sql',
    '015_appointments.sql', '016_appointment_operations.sql', '017_calendar_connections.sql',
    '018_calendar_connection_epoch.sql', '019_calendar_selection.sql', '020_calendar_sync_retry.sql',
    '021_calendar_move.sql', '022_calendar_reconciliation.sql', '023_calendar_move_retry.sql', '024_order_payments.sql',
    '025_administrative_invoices.sql', '026_invoice_payment_links.sql', '027_invoice_issued_total_constraint.sql',
    '028_payment_reference.sql', '029_invoice_reissue_after_void.sql', '030_optional_invoice_tax.sql',
    '031_invoice_company_seal.sql', '032_customer_address.sql',
    '033_workshop_commercial_name.sql',
  ];
  const migration = await app.get(Database).pool.query(
    'SELECT COUNT(*)::int AS count FROM schema_migrations WHERE name = ANY($1)',
    [requiredMigrations],
  );
  if (migration.rows[0].count !== requiredMigrations.length) {
    throw new Error('Database migrations are required. Run npm run db:migrate.');
  }
  await app.listen(config.port);
  // The worker must remain stopped until late remote writes can be reconciled safely.
}
await bootstrap();
