"use client";

import { useState } from "react";
import { signIn, signOut } from "next-auth/react";

export function AuthButton({ signedIn = false }: { signedIn?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function handleClick() {
    setPending(true);
    setError(false);
    try {
      // 库负责获取 CSRF token、提交登录/退出请求和跳转。
      if (signedIn) await signOut({ redirectTo: "/login" });
      else await signIn("github", { redirectTo: "/research" });
    } catch {
      setError(true);
      setPending(false);
    }
  }
  return (
    <>
      <button
        className="button button-primary full-width"
        disabled={pending}
        onClick={handleClick}
      >
        {pending ? "正在处理…" : signedIn ? "退出登录" : "使用 GitHub 登录"}
      </button>
      {error && (
        <p role="alert" className="field-error">
          暂时无法连接登录服务，请稍后重试。
        </p>
      )}
    </>
  );
}
