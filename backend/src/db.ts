import { Pool, QueryResult, QueryResultRow, types } from 'pg';

// Return DATE columns as plain "YYYY-MM-DD" strings, not JS Date objects.
// Without this, pg converts DATE → Date, which res.json() serialises to a full
// ISO timestamp ("2026-05-22T00:00:00.000Z"), breaking the frontend date parser.
types.setTypeParser(types.builtins.DATE, (val: string) => val);

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
