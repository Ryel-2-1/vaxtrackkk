import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Med Rep Inventory pagination: a short last page must not shrink the table
 * (the card and pager moved, and near the bottom of the document the browser
 * clamped the scroll position). Only the current page is rendered; every row
 * has one fixed height with its content bounded to fit, and a paged result
 * reserves a full page in CSS. No measuring, no hidden pages, no filler rows.
 * The geometry was verified in the browser (1440/1024/768/375 px, resizes on
 * the short page, long names and two-line batch IDs, 1,215 batches); this
 * pins the markup/CSS contract that produces it.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const src = read("src/pages/salesRep/SalesRepInventory.jsx");
const css = read("src/pages/salesRep/salesrep-polish.css");
const region = src.slice(src.indexOf('className={`inventory-v2-table-region'), src.indexOf('className="salesrep-pagination-row'));

test("Inventory renders only the current page's rows in a single table", () => {
  assert.match(src, /const visibleStocks = filteredStocks\.slice\(startIndex, startIndex \+ rowsPerPage\);/);
  assert.equal((region.match(/<table\b/g) || []).length, 1, "one table");
  assert.match(region, /visibleStocks\.map\(\(stock\) => <StockRow key=\{stock\.id\} stock=\{stock\} \/>\)/);
  // No all-pages stack and nothing measured or scrolled for it.
  assert.equal(/pagesOf|aria-hidden=\{isCurrent|useLayoutEffect|ResizeObserver|scrollTo|scrollIntoView|getBoundingClientRect/.test(src), false);
  assert.equal(/visibility: hidden/.test(css.slice(css.indexOf("Pagination: only the current page"), css.indexOf("/* ---- Order Tracking ---- */"))), false);
});

test("a paged result reserves a full page; one page or none stays compact", () => {
  assert.match(src, /className=\{`inventory-v2-table-region\$\{totalPages > 1 \? " is-paged" : ""\}`\}/);
  assert.match(src, /style=\{\{ "--inv-page-rows": rowsPerPage \}\}/);
  assert.match(css, /\.salesrep-main \.inventory-v2-table-region\.is-paged \{\s*min-height: calc\(var\(--inv-head-h\) \+ var\(--inv-page-rows\) \* var\(--inv-row-h\)\);\s*\}/);
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

test("pagination controls are unchanged and keyboard-named", () => {
  assert.match(src, /aria-label="Previous page"/);
  assert.match(src, /aria-label="Next page"/);
  assert.match(src, /aria-current=\{currentPage === index \+ 1 \? "page" : undefined\}/);
  assert.match(src, /const rowsPerPage = 5;/);
});
