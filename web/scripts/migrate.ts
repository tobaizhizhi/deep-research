import nextEnv from "@next/env";
import { getPool } from "../lib/server/db";
import { migrate } from "./migrations";

async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const pool = getPool();
  try {
    const applied = await migrate(pool);
    console.log(
      applied.length ? `已应用：${applied.join(", ")}` : "数据库迁移已是最新。",
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  // 不把连接字符串、SQL 数据或驱动的原始异常打印到日志。
  console.error("MIGRATION_FAILED：检查数据库连接及已应用迁移是否被修改。");
  process.exitCode = 1;
});
