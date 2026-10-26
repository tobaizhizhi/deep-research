import "server-only";
import PostgresAdapter from "@auth/pg-adapter";
import type { Pool } from "pg";
import type { Adapter, AdapterSession } from "next-auth/adapters";

export function createAuthAdapter(pool: Pool): Adapter {
  return {
    ...PostgresAdapter(pool),
    // 1.11.3 的 UPDATE 缺少 RETURNING；补上以符合 Adapter 返回契约。
    async updateSession(session) {
      const result = await pool.query<AdapterSession>(
        `UPDATE sessions SET expires = COALESCE($2, expires)
         WHERE "sessionToken" = $1 RETURNING "sessionToken", "userId", expires`,
        [session.sessionToken, session.expires ?? null],
      );
      return result.rows[0] ?? null;
    },
  };
}
