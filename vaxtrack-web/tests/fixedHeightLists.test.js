import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * List layout contracts: table and queue panes retain their scroll regions;
 * Cargo Loading cards show every rider and order without a nested scrollbar.
 * No page locks scrolling outright on short screens.
 */
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DISP = read("src/pages/dispatcher/dispatcher-polish.css");
const SR = read("src/pages/salesRep/salesrep-polish.css");

test("Dispatcher Shipments: one toolbar row, a fixed card, the pager at its foot", () => {
  const page = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(page, /<\/table>\s*<\/div>\s*\)\}[\s\S]*?<PageNav page=\{currentPage\} total=\{matchingOrders\.length\} onPageChange=\{setPage\} label="Shipment pages" \/>\s*\)\}\s*<\/section>/);
  assert.doesNotMatch(page, /shp-pagination/);
  assert.match(DISP, /\.dispatcher-main \.shp-filterbar \{\s*display: flex;/);
  assert.match(DISP, /\.dispatcher-main \.shp-card \{[^}]*display: flex;[^}]*height: var\(--shp-card-h\);/);
  assert.match(DISP, /\.dispatcher-main \.shp-table-wrap \{[^}]*flex: 1 1 auto;[^}]*overflow: auto;/);
});

test("Dispatcher Assign Rider: the queue body keeps one height with the shared pager pinned", () => {
  const page = read("src/pages/dispatcher/DispatcherAssignRider.jsx");
  assert.match(page, /<div className="arq-body">/);
  assert.match(page, /<PageNav page=\{currentPage\} total=\{queue\.length\} onPageChange=\{setPage\} label="Queue pages" \/>/);
  const css = read("src/pages/dispatcher/DispatcherAssignRider.css");
  assert.match(css, /\.arq-body \{[^}]*display: flex;[^}]*height: var\(--arq-body-h\);/);
  assert.match(css, /\.arq-body > \.arq-list \{\s*overflow-y: auto;/);
});

test("Dispatcher Cargo Loading: all rider details use a responsive grid without nested scrolling", () => {
  const css = read("src/pages/dispatcher/CargoLoading.css");
  assert.match(css, /\.cl-cards \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 420px\), 1fr\)\);/);
  assert.match(css, /\.cl-card \{[^}]*height: auto;[^}]*overflow: visible;/);
  assert.match(css, /\.cl-card-body \{[^}]*overflow: visible;/);
  assert.match(css, /\.cl-check \{[^}]*width: 104px;/);
  assert.match(css, /\.cl-order-top > \.m-badge \{[^}]*min-width: 86px;/);
  const page = read("src/pages/dispatcher/DispatcherCargoLoading.jsx");
  assert.match(page, /\{groups\.map\(\(group\) => \(\s*<RiderCard/);
  assert.doesNotMatch(page, /cl-pagination|cardMaxHeight|cardsRef|pageSize|currentPage/);
});

test("Med Rep Order Tracking and Order History: fixed table boxes, independent scroll", () => {
  assert.match(SR, /\.salesrep-main \.tracking-v2-table-wrap \{[^}]*display: flex;[^}]*height: var\(--trk-pane-h\);/);
  assert.match(SR, /\.salesrep-main \.tracking-v2-table-scroll \{[^}]*flex: 1 1 auto;[^}]*overflow: auto;/);
  assert.match(SR, /\.salesrep-main \.tracking-v2-side \{[^}]*height: var\(--trk-pane-h\);[^}]*overflow-y: auto !important;/);
  assert.match(SR, /\.salesrep-order-history \.ohx-list-table-wrap \{[^}]*height: var\(--ohx-list-h\);/);
});

test("no page locks scrolling outright", () => {
  for (const css of [DISP, SR]) {
    assert.doesNotMatch(css, /height: 100vh;[^}]*overflow: hidden/);
  }
});
