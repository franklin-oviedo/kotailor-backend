import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../database/database.js';
import { ReportsService } from './reports.service.js';

describe('ReportsService', () => {
  let query: ReturnType<typeof vi.fn>;
  let service: ReportsService;

  beforeEach(() => {
    query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM workshop_memberships m')) return Promise.resolve({ rowCount: 1, rows: [{}] });
      if (sql.includes('WITH selected_orders AS MATERIALIZED')) {
        return Promise.resolve({ rows: [{
          salesCents: 10000, collectedCents: 4000, outstandingCents: 6000, invoicedCents: 10000,
          invoiceOutstandingCents: 6000, invoicesIssued: 1, invoicesPaid: 0, activeOrders: 1, productionOrders: 1,
          completedOrders: 0, totalCustomers: 1, newCustomers: 1, frequentCustomers: 0,
          annualIncomeCents: 4000,
        }] });
      }
      if (sql.includes('WITH periods AS')) return Promise.resolve({ rows: [{ month: '2026-11' }] });
      if (sql.includes('GROUP BY o.status')) return Promise.resolve({ rows: [{ status: 'sewing', count: 1 }] });
      if (sql.includes('GROUP BY o.customer_id')) return Promise.resolve({ rows: [{ customerId: 'customer-id' }] });
      if (sql.includes('GROUP BY o.catalog_name')) return Promise.resolve({ rows: [{ name: 'Camisa' }] });
      throw new Error('Unexpected report query');
    });
    service = new ReportsService({ pool: { query } } as unknown as Database);
  });

  it('rejects invalid date ranges before accessing the database', async () => {
    await expect(service.executive('workshop-id', 'user-id', {
      from: '2025-01-01', to: '2026-01-03',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an authorized workshop role and returns only database report data', async () => {
    query.mockImplementationOnce(() => Promise.resolve({ rowCount: 0, rows: [] }));
    await expect(service.executive('workshop-id', 'user-id', {
      from: '2026-01-01', to: '2026-11-17',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);

    query.mockImplementationOnce(() => Promise.resolve({ rowCount: 1, rows: [{}] }));
    const customerId = 'c3ca2281-494f-427c-9589-6ff3d152e601';
    const result = await service.executive('workshop-id', 'user-id', {
      from: '2026-11-01', to: '2026-11-17', customerId, status: 'sewing',
    });
    expect(result.summary).toMatchObject({ salesCents: 10000, collectedCents: 4000 });
    expect(result.inventoryCritical).toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('America/Santo_Domingo'),
      ['workshop-id', '2026-11-01', '2026-11-17', customerId, 'sewing'],
    );
  });
});
