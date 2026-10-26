import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { AuthButton } from "@/components/auth-button";
import { getCurrentUser, isAuthConfigured } from "@/lib/server/auth";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  const configured = isAuthConfigured();
  const { error } = await searchParams;
  return (
    <div className="page-enter login-layout">
      <section className="login-story">
        <p className="eyebrow">YOUR RESEARCH SPACE</p>
        <h1>
          把好问题，
          <br />
          留给更深入的探索。
        </h1>
        <p>
          一个属于你的研究空间，
          <br />
          让问题、发现和依据有序相连。
        </p>
        <div className="login-illustration" aria-hidden="true">
          <div className="paper-sheet sheet-back" />
          <div className="paper-sheet sheet-front">
            <Icon name="layers" size={32} />
            <span />
            <span />
            <span />
            <div className="paper-seal">
              <Icon name="check" size={24} />
            </div>
          </div>
          <span className="illustration-caption">
            A QUESTION WORTH EXPLORING.
          </span>
        </div>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <span className="large-icon">
          <Icon name="user" size={28} />
        </span>
        <h2 id="login-title">欢迎来到寻据</h2>
        <p>
          登录后，你将可以保存研究任务、
          <br />
          回看报告并管理自己的研究记录。
        </p>
        {user ? <p>已登录：{user.name ?? user.email ?? "研究者"}</p> : null}
        {error && (
          <p className="field-error" role="alert">
            本次登录未完成，请重试或联系站点维护者。
          </p>
        )}
        {configured ? (
          <AuthButton signedIn={Boolean(user)} />
        ) : (
          <>
            <div className="notice">
              <span className="status-dot" />
              站点尚未启用登录，请联系维护者完成配置。
            </div>
            <button className="button button-primary full-width" disabled>
              登录暂不可用
            </button>
          </>
        )}
        <Link className="text-link" href="/">
          先整理一个研究问题
          <Icon name="arrow" size={15} />
        </Link>
        <div className="login-privacy">
          <Icon name="shield" size={16} />
          <span>通过 GitHub 验证身份，本网站不接收你的 GitHub 密码。</span>
        </div>
      </section>
    </div>
  );
}
