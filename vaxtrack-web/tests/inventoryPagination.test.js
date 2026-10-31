import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Med Rep Inventory shows no more than ten rows per page. The table keeps
 * its natural height so rows are never clipped by a nested vertical scroller;
 * the shared page control follows it in normal document flow.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const src = read("src/pages/salesRep/SalesRepInventory.jsx");
const css = read("src/pages/salesRep/salesrep-polish.css");
const region = src.slice(src.indexOf('className="inventory-v2-table-region"'), src.indexOf('className="inventory-v2-page-nav"'));

test("Inventory renders only the current page's rows in a single table", () => {
  assert.match(src, /const visibleStocks = filteredStocks\.slice\(startIndex, startIndex \+ rowsPerPage\);/);
  assert.equal((region.match(/<table\b/g) || []).length, 1, "one table");
  assert.match(region, /visibleStocks\.map\(\(stock\) => <StockRow key=\{stock\.id\} stock=\{stock\} \/>\)/);
  // No all-pages stack and nothing measured or scrolled for it.
  assert.equal(/pagesOf|aria-hidden=\{isCurrent|useLayoutEffect|ResizeObserver|scrollTo|scrollIntoView|getBoundingClientRect/.test(src), false);
});

test("the table grows to fit its rows and the shared pager follows it", () => {
  assert.match(src, /className="inventory-v2-table-region"/);
  assert.match(src, /<PageNav page=\{currentPage\} total=\{filteredStocks\.length\} onPageChange=\{setPage\} label="Inventory pages" \/>/);
  assert.match(css, /\.salesrep-main \.inventory-v2-table-region \{[^}]*height: fit-content;[^}]*overflow-y: visible;/);
  assert.doesNotMatch(css, /\.inventory-v2-table-region\.is-paged|46dvh/);
  assert.match(css, /\.salesrep-main \.inventory-v2-table th \{[^}]*height: var\(--inv-head-h\);/);
  assert.match(css, /\.salesrep-main \.inventory-v2-table td \{[^}]*height: var\(--inv-row-h\);/);
  // Borders inside each cell's height, so a page is exactly header + rows.
  assert.match(css, /\.salesrep-main \.inventory-v2-table \{\s*border-collapse: separate;\s*border-spacing: 0;\s*\}/);
});

test("cell content is bounded: the name clamps, figures never wrap or clip", () => {
  assert.match(css, /\.salesrep-main \.stock-name-trigger \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;/);
  assert.match(css, /\.salesrep-main \.inventory-expiry-cell strong \{\s*display: block;\s*white-space: nowrap;\s*\}/);
  assert.match(css, /\.salesrep-main \.inventory-qty-cell \{\s*white-space: nowrap;\s*\}/);
  // Batch IDs wrap to at most two lines; longer ones are abbreviated in the markup.
  const batch = css.slice(css.indexOf(".salesrep-main .inventory-v2-table .batch-chip {"));
  assert.match(batch, /^[^}]*-webkit-line-clamp: 2;[^}]*white-space: normal !important;[^}]*overflow-wrap: anywhere;/);
});

test("a long batch ID is abbreviated in the table, in full for assistive technology and in the dialog", () => {
  const row = src.slice(src.indexOf("function StockRow"), src.indexOf("function HBar"));
  assert.match(row, /const abbreviatedBatchId = abbreviateBatchId\(stock\.batchId\);/);
  assert.match(row, /<span className="batch-chip is-abbreviated">\s*<span aria-hidden="true">\{abbreviatedBatchId\}<\/span>\s*<span className="m-visually-hidden">\{stock\.batchId\}<\/span>/);
  assert.match(row, /<span className="batch-chip">\{stock\.batchId\}<\/span>/);
  assert.match(src, /import "\.\.\/\.\.\/components\/ui\/feedback\.css";/);
  assert.match(css, /\.salesrep-main \.stock-name-popover dd \{[^}]*overflow-wrap: anywhere;[^}]*user-select: text;/);
});

test("the full name, manufacturer and type open in a modal dialog from a button", () => {
  const row = src.slice(src.indexOf("function StockRow"), src.indexOf("function HBar"));
  assert.match(row, /<button\s+type="button"\s+className="stock-name-trigger"\s+aria-haspopup="dialog"\s+onClick=\{\(\) => detailsRef\.current\?\.showModal\(\)\}/);
  assert.match(row, /<dialog\s+ref=\{detailsRef\}\s+className="stock-name-popover"/);
  // Only a press that starts and ends on the backdrop closes it: the panel fills
  // the dialog, and a text selection dragged out of the panel must not close it.
  assert.match(row, /pressedBackdrop\.current = event\.target === event\.currentTarget;/);
  assert.match(row, /if \(pressedBackdrop\.current && event\.target === event\.currentTarget\) event\.currentTarget\.close\(\);/);
  assert.match(row, /<form method="dialog">\s*<button type="submit" className="stock-name-popover-close" aria-label="Close details">/);
  for (const field of ["stock.manufacturer", "stock.type", "stock.batchId"]) {
    assert.ok(row.includes(`<dd>{${field}}</dd>`), `${field} in the dialog`);
  }
  // Never a hover-only or title-attribute fallback.
  assert.equal(/\btitle=/.test(row), false);
});

test("Inventory uses the shared ten-item page limit and named controls", () => {
  const nav = read("src/components/ui/PageNav.jsx");
  assert.match(src, /const rowsPerPage = PAGE_SIZE;/);
  assert.match(nav, /export const PAGE_SIZE = 10;/);
  assert.match(nav, /aria-label=\{label\}/);
  assert.match(nav, />Previous<\/button>/);
  assert.match(nav, />Next<\/button>/);
});
