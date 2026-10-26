import type { Metadata } from "next";
import Link from "next/link";
import { Navigation } from "@/components/navigation";
import { Icon } from "@/components/icon";
import { getCurrentUser } from "@/lib/server/auth";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "寻据 · Deep Research", template: "%s · 寻据" },
  description: "从一个好问题出发，整理研究范围，追溯结论的依据。",
};

// Layout 是服务端组件。只有导航高亮和表单交互需要在浏览器执行。
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>
        <div className="app-shell">
          <aside className="sidebar">
            <Link href="/" className="brand" aria-label="寻据，返回新建研究">
              <span className="brand-mark">
                <Icon name="layers" size={27} />
              </span>
              <span>
                <strong>
                  寻据<span className="brand-period">.</span>
                </strong>
                <small>DEEP RESEARCH</small>
              </span>
            </Link>
            <div className="nav-label">研究空间</div>
            <Navigation />
            <div className="sidebar-note">
              <span className="note-line" />
              <p>
                好问题是起点，
                <br />
                证据让探索走得更远。
              </p>
              <small>FROM CURIOSITY TO CLARITY</small>
            </div>
            <Link href="/login" className="account-link">
              <span className="account-icon">
                <Icon name="user" size={18} />
              </span>
              <span>
                {user?.name ?? (user ? "我的账户" : "登录账户")}
                <small>{user ? "管理登录状态" : "使用 GitHub 登录"}</small>
              </span>
              <Icon name="arrow" size={16} />
            </Link>
          </aside>
          <div className="workspace">
            <header className="topbar">
              <span className="breadcrumb">
                工作台 <span>/</span> Deep Research
              </span>
              <span className="preview-badge">
                <span />
                研究工作台
              </span>
            </header>
            <main id="main-content" className="main-content">
              {children}
            </main>
            <footer className="workspace-footer">
              <span>寻据 · 让探索有迹可循</span>
              <span>提问 · 求证 · 理解</span>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
