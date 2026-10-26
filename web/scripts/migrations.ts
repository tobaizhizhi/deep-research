import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

export const migrationsDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);

export async function migrate(pool: Pool, directory = migrationsDirectory) {
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // 同一数据库的迁移进程串行执行；进程退出后数据库自动释放会话锁。
    await client.query("SELECT pg_advisory_lock(734901221)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const known = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    if (known.rows.some((row) => !files.includes(row.name)))
      throw new Error("MIGRATION_FILE_MISSING");
    // 先验证全部历史文件，再执行任何新迁移。
    const migrations = await Promise.all(
      files.map(async (name) => {
        const sql = await readFile(`${directory}/${name}`, "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const previous = known.rows.find((row) => row.name === name);
        if (previous && previous.checksum !== checksum)
          throw new Error(`MIGRATION_CHANGED: ${name}`);
        return { name, sql, checksum, previous };
      }),
    );
    for (const migration of migrations) {
      if (migration.previous) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(734901221)");
    } finally {
      client.release();
    }
  }
}
