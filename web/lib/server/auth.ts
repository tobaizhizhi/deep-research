import "server-only";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getPool } from "./db";
import { createAuthAdapter } from "./auth-adapter";
import { ApiError, appOrigin, assertTrustedHost, safeRedirect } from "./http";
import { uuidSchema } from "../contracts";

export function isAuthConfigured() {
  return Boolean(
    process.env.DATABASE_URL &&
    process.env.AUTH_GITHUB_ID &&
    process.env.AUTH_GITHUB_SECRET &&
    (process.env.AUTH_SECRET?.length ?? 0) >= 32,
  );
}

export const { handlers, auth } = NextAuth(() => {
  if (!isAuthConfigured()) throw new Error("AUTH_NOT_CONFIGURED");
  return {
    adapter: createAuthAdapter(getPool()),
    providers: [
      GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
      }),
    ],
    secret: process.env.AUTH_SECRET,
    basePath: "/api/auth",
    // HTTP 入口与会话入口均先核验 Host；不盲信代理传来的主机名。
    trustHost: true,
    useSecureCookies: appOrigin().startsWith("https:"),
    session: {
      strategy: "database",
      maxAge: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      session({ session, user }) {
        // 不把 OAuth token 或整个数据库用户行带给浏览器。
        return {
          expires: session.expires,
          user: { id: user.id, name: user.name, email: user.email },
        };
      },
      redirect({ url }) {
        return safeRedirect(url);
      },
    },
    logger: {
      error() {
        console.error("AUTH_ERROR");
      },
      warn() {
        console.warn("AUTH_WARNING");
      },
      debug() {},
    },
  };
});

export const getCurrentUser = cache(async () => {
  // 即使尚未填 OAuth 配置，也保持按请求渲染，避免把未登录状态静态固化。
  const requestHeaders = await headers();
  if (!isAuthConfigured()) return null;
  assertTrustedHost(requestHeaders);
  const session = await auth();
  if (!session?.user?.id || !uuidSchema.safeParse(session.user.id).success)
    return null;
  return {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new ApiError(401, "UNAUTHENTICATED");
  return user;
}

export async function requirePageUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
