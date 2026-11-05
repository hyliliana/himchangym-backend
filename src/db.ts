import pg, { PoolClient } from 'pg';
import 'dotenv/config';
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined, max: 10, connectionTimeoutMillis: 10000 });
// Date-only columns must stay business dates, independent of the host timezone.
pg.types.setTypeParser(1082, v => v);
export async function transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
