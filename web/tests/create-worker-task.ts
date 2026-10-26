// 仅供 Python 集成测试调用真实 Web 业务层；不是生产 HTTP 入口。
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createTask, getTask, resumeTask } from "../lib/server/tasks";
import { migrate } from "../scripts/migrations";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL_REQUIRED");
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
try {
  if (process.argv[2] === "migrate") {
    await migrate(pool);
  } else if (process.argv[2] === "detail") {
    console.log(
      JSON.stringify(await getTask(process.argv[3], process.argv[4], pool)),
    );
  } else if (process.argv[2] === "resume") {
    console.log(
      JSON.stringify(
        await resumeTask(
          process.argv[3],
          process.argv[4],
          process.argv[5] ?? randomUUID(),
          pool,
        ),
      ),
    );
  } else {
    const owner = (
      await pool.query("INSERT INTO users DEFAULT VALUES RETURNING id")
    ).rows[0].id;
    const task = await createTask(
      owner,
      JSON.parse(process.argv[2]),
      randomUUID(),
      pool,
    );
    console.log(JSON.stringify({ ...task, user_id: owner }));
  }
} finally {
  await pool.end();
}
