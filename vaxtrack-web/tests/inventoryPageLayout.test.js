import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Admin Inventory layout behaviour (2026-10-31): summary cards bring the
 * filtered table into view, the table box has a fixed height, and the batch
 * drawer shows On hand / Reserved / Available as labelled tiles.
 */
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PAGE = read("src/pages/admin/Inventory.jsx");
const CSS = read("src/pages/admin/Inventory.css");

test("every summary card filters the table and then scrolls it into view", () => {
  const summary = PAGE.slice(PAGE.indexOf('<section className="v2-inventory-summary-grid">'), PAGE.indexOf('<section className="v2-hub-grid">'));
  for (const level of ["all", "watch"]) {
    assert.match(summary, new RegExp(`onClick=\\{\\(\\) => \\{ changeStatusFilter\\("${level}"\\); scrollToTable\\(\\); \\}\\}`), level);
  }
  assert.match(PAGE, /<section className="v2-inventory-table-card" ref=\{tableCardRef\}>/);
  // After the filtered rows render (a scroll started in the click was cut
  // short by the re-render), honouring reduced motion. scrollIntoView, not
  // window.scrollTo: the page scrolls inside the shell's main area.
  assert.match(PAGE, /const scrollToTable = \(\) => setTableScrollRequest\(\(n\) => n \+ 1\);/);
  assert.match(PAGE, /useEffect\(\(\) => \{\s*if \(!tableScrollRequest\) return;[\s\S]*?prefers-reduced-motion: reduce[\s\S]*?scrollIntoView\(\{ behavior: reduceMotion \? "auto" : "smooth", block: "start" \}\);\s*\}, \[tableScrollRequest\]\);/);
});

test("the table box keeps one height whatever the filter returns", () => {
  assert.match(CSS, /\.inventory-page \.v2-inventory-table-card \.v2-table-scroll \{\s*height: min\(62dvh, 640px\);\s*\}/);
  // Same figure as the shared cap, which also makes the header sticky.
  const shared = read("src/styles/paged-tables.css");
  assert.match(shared, /max-height: min\(62dvh, 640px\);/);
  assert.match(shared, /\.inventory-page \.v2-table-scroll thead th,[\s\S]*?position: sticky;\s*top: 0;/);
  assert.match(CSS, /\.inventory-page \.v2-inventory-table-card \{\s*scroll-margin-top: 12px;\s*\}/);
});

test("the batch drawer labels On hand, Reserved and Available in plain words", () => {
  const tiles = PAGE.slice(PAGE.indexOf('<dl className="inv-stock-tiles">'), PAGE.indexOf("</dl>"));
  assert.deepEqual([...tiles.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["On hand", "Reserved", "Available"]);
  assert.match(tiles, /<dd className="tnum">\{drawerItem\.onHand\}<\/dd>\s*<small>Not yet delivered \(includes reserved\)<\/small>/);
  assert.match(tiles, /<dd className="tnum">\{drawerItem\.reserved\}<\/dd>\s*<small>Held for active orders<\/small>/);
  // A voided batch still shows no Available figure.
  assert.match(tiles, /<dd className="tnum">\{drawerItem\.voided \? "—" : drawerItem\.available\}<\/dd>\s*<small>Ready for new orders<\/small>/);
  assert.match(PAGE, /<small>Quantity changes use Correct stock so they are validated and logged\.<\/small>/);
  assert.doesNotMatch(PAGE, /On hand \(not yet delivered\) \/ Reserved \/ Available|or Add Stock so they are validated/);
});

test("stock enters from the header's Add Stock; a batch changes only through Correct stock", () => {
  const actions = PAGE.slice(PAGE.indexOf('<div className="v2-modal-actions">'), PAGE.indexOf("</div>", PAGE.indexOf('<div className="v2-modal-actions">')));
  assert.doesNotMatch(actions, /add-stock|>\s*Add Stock\s*</, "no Add Stock in the batch drawer");
  assert.match(actions, /onClick=\{\(\) => openCorrectDialog\(drawerItem\)\}/);
  // Exactly one Add Stock entry point: the page header's.
  assert.equal((PAGE.match(/navigate\("\/admin\/add-stock"\)/g) || []).length, 1);
});

test("Advanced filters opens the shared catalog filter dialog with Admin's own scope", () => {
  assert.match(PAGE, /<button type="button" className="catalog-filter-trigger" onClick=\{\(\) => setFiltersOpen\(true\)\} aria-haspopup="dialog">\s*<Filter size=\{16\} aria-hidden="true" \/> Advanced filters/);
  assert.match(PAGE, /<CatalogFilterDialog\s+scope=\{adminWrapperClassFor\("\/admin\/inventory"\)\}[\s\S]*?statusOptions=\{STOCK_OPTIONS\}[\s\S]*?expiryOptions=\{EXPIRY_OPTIONS\}/);
  // Status, expiry and types all narrow the same list the table and export use.
  assert.match(PAGE, /const matchesStock = STOCK_FILTERS\[stockFilter\]\?\.test\(item\) \?\? true;/);
  assert.match(PAGE, /const matchesType = typeFilter\.length === 0 \|\| typeFilter\.includes\(item\.type\);/);
  assert.match(PAGE, /return matchesSearch && matchesStatus && matchesStock && matchesType;/);
  // Med Rep keeps its default scope; the dialog CSS covers both, at the old specificity.
  const dialog = read("src/components/inventory/CatalogFilterDialog.jsx");
  assert.match(dialog, /export default function CatalogFilterDialog\(\{ scope = "salesrep-page salesrep-main", \.\.\.props \}\)/);
  const css = read("src/components/inventory/catalogFilterDialog.css");
  assert.doesNotMatch(css, /\.vt-dialog-layer\.salesrep-page\b/);
  assert.match(css, /\.vt-dialog-layer:is\(\.salesrep-page, \.inventory-page\) \.catalog-filter-dialog \{/);
});

test("the Admin table pages with the shared pager, not a page dropdown", () => {
  assert.match(PAGE, /<PageNav page=\{safePage\} total=\{filteredVaccines\.length\} onPageChange=\{setCurrentPage\} label="Inventory pages" \/>/);
  assert.doesNotMatch(PAGE, /v2-page-picker|aria-label="Inventory page"/);
});
