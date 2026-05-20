import { Pool, QueryResult, QueryResultRow } from 'pg';

export const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'solytiq',
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || '',
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}
