import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "../src/db";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(currentDir, "..", "migrations");
const pool = getPool();

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

for (const file of (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) {
  const applied = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
  if (applied.rowCount) continue;
  const sql = await readFile(join(migrationDir, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();

