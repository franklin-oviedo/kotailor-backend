import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';

export function parsePage(page: unknown, pageSize: unknown, defaultSize = 100) {
  const requested = page === undefined ? 1 : Number(page);
  const size = pageSize === undefined ? defaultSize : Number(pageSize);
  if ((page !== undefined && (typeof page !== 'string' || !/^[1-9]\d*$/.test(page)))
      || (pageSize !== undefined && typeof pageSize !== 'string')
      || !Number.isSafeInteger(requested) || (pageSize !== undefined && ![10, 25, 50, 100].includes(size))) {
    throw new BadRequestException('Invalid pagination');
  }
  return { page: requested, pageSize: size };
}

export async function queryPage(
  pool: Pick<Pool, 'query'>, query: string, values: readonly unknown[], orderBy: string,
  page: unknown, pageSize: unknown,
) {
  const { page: requested, pageSize: size } = parsePage(page, pageSize);
  const limit = `$${values.length + 1}::int`;
  const wanted = `$${values.length + 2}::bigint`;
  const result = await pool.query<{ rows: Record<string, unknown>[]; total: number; page: number }>(
    `WITH records AS MATERIALIZED (${query}), stats AS (
       SELECT count(*)::int AS total,
              LEAST(${wanted}, GREATEST(1, ceil(count(*)::numeric / ${limit})))::int AS page
       FROM records
     )
     SELECT stats.total, stats.page,
            COALESCE((SELECT json_agg(items ORDER BY ${orderBy})
                      FROM (SELECT * FROM records ORDER BY ${orderBy}
                            LIMIT ${limit} OFFSET ((stats.page::bigint - 1) * ${limit})) items), '[]'::json) AS rows
     FROM stats`,
    [...values, size, requested],
  );
  const record = result.rows[0];
  return {
    rows: record.rows,
    pagination: { page: record.page, pageSize: size, total: record.total },
    hasMore: record.page * size < record.total,
  };
}
