import "server-only";
import { Pool, type PoolClient } from "pg";

const globalDB = globalThis as typeof globalThis & { researchPool?: Pool };

// 新增迁移时同步更新；HTTP 就绪检查不导入只供命令行使用的迁移执行器。
export async function checkDatabaseReady(pool: Pool) {
  const required = [
    "001_auth.sql",
    "002_tasks.sql",
    "003_task_api.sql",
    "004_results.sql",
    "005_p5_events.sql",
    "006_p6_reliability.sql",
    "007_p7_checkpoints.sql",
    "008_reviews.sql",
  ];
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  return required.every((name) => result.rows.some((row) => row.name === name));
}

// 延迟创建：构建页面不需要数据库；开发热更新复用连接池。
export function getPool(): Pool {
  if (!globalDB.researchPool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_NOT_CONFIGURED");
    globalDB.researchPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
    globalDB.researchPool.on("error", () =>
      console.error("DATABASE_POOL_ERROR"),
    );
  }
  return globalDB.researchPool;
}

export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
  pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
