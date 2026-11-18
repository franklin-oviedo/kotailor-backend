import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { CONFIGURATION, type Configuration } from '../config.js';

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly logger = new Logger(Database.name);
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIGURATION) config: Configuration) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 5000,
      max: 10,
    });
    this.pool.on('error', () => {
      this.logger.error('An idle PostgreSQL connection failed');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
