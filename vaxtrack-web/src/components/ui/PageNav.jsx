import "./PageNav.css";

export const PAGE_SIZE = 10;

export default function PageNav({ page, total, onPageChange, label = "Pages" }) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = total === 0 ? 0 : (current - 1) * PAGE_SIZE + 1;
  const end = Math.min(current * PAGE_SIZE, total);

  return (
    <nav className="page-nav" aria-label={label}>
      <span>Showing {start}–{end} of {total}</span>
      <div className="page-nav-actions">
        <button type="button" disabled={current === 1} onClick={() => onPageChange(current - 1)}>Previous</button>
        <span>Page {current} of {pageCount}</span>
        <button type="button" disabled={current === pageCount} onClick={() => onPageChange(current + 1)}>Next</button>
      </div>
    </nav>
  );
}
