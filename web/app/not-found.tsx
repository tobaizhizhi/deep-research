import Link from "next/link";

export default function NotFound() {
  return (
    <section className="empty-state">
      <p className="eyebrow">404 / PAGE NOT FOUND</p>
      <h1>这里还没有探索的足迹。</h1>
      <p>页面不存在，请检查地址或回到研究工作台。</p>
      <Link href="/" className="button button-primary">
        返回新建研究
      </Link>
    </section>
  );
}
