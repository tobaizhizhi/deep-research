"use client";

import Link from "next/link";

// Next.js 要求错误边界为客户端组件，reset 会重新尝试渲染当前路由。
export default function ResearchError({ reset }: { reset: () => void }) {
  return (
    <section className="library-card empty-state" role="alert">
      <h1>研究页面暂时无法打开</h1>
      <p>请重试一次，或返回新建研究页面。</p>
      <button className="button button-primary" onClick={reset}>
        重新加载
      </button>
      <Link href="/" className="text-link">
        返回新建研究
      </Link>
    </section>
  );
}
