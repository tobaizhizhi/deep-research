export default function ResearchLoading() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <p>正在打开研究页面…</p>
      <div className="skeleton skeleton-heading" aria-hidden="true" />
      <div className="skeleton skeleton-panel" aria-hidden="true" />
    </div>
  );
}
