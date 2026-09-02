import pg from "pg";

const { Pool } = pg;
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgres://zhiwei:zhiwei@127.0.0.1:54329/zhiwei";
    pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function withTransaction<T>(
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}

