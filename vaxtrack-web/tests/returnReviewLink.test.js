import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * A batch's returned stock links straight to its review: the Inventory
 * drawer's "Review" links open Stock Allocation at that one pending return
 * (`?return=<id>` — the inventoryReturns document id, which both the drawer's
 * provenance rows and the allocation list carry).
 */
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const PROV = read("src/components/admin/ReservationProvenance.jsx");
const ALLOC = read("src/pages/admin/AdminAllocation.jsx");

test("the drawer links each returned order, and the helper text, to Stock Allocation", () => {
  assert.match(PROV, /return ret\?\.returnId\s*\? `\/admin\/allocation\?return=\$\{encodeURIComponent\(ret\.returnId\)\}`\s*: "\/admin\/allocation";/);
  // One link per returned-order row…
  assert.match(PROV, /<Link\s+className="inv-prov-link"\s+to=\{allocationHref\(r\)\}\s+aria-label=\{`Review the return for \$\{r\.orderNumber \|\| r\.orderId\} in Stock Allocation`\}/);
  // …and one beside the helper text: the return itself when there is only one.
  assert.match(PROV, /Confirm their condition under Stock Allocation\.\{" "\}\s*<Link className="inv-prov-link" to=\{allocationHref\(returns\.length === 1 \? returns\[0\] : null\)\}>\s*Review in Stock Allocation/);
  // The server's provenance rows carry that id.
  assert.match(read("functions/src/inventoryWorkflow.js"), /returnId: d\.id,/);
});

test("Stock Allocation opens the named return: its page, scrolled to and highlighted", () => {
  assert.match(ALLOC, /const focusReturnId = searchParams\.get\("return"\) \|\| "";/);
  // The page is derived until the Admin pages by hand.
  assert.match(ALLOC, /const autoReturnsPage = focusIndex >= 0 \? Math\.floor\(focusIndex \/ PAGE_SIZE\) \+ 1 : 1;/);
  assert.match(ALLOC, /Math\.min\(returnsPage \?\? autoReturnsPage,/);
  // Scrolled once, when it first renders; never pulled back by later updates.
  assert.match(ALLOC, /if \(!focusVisible \|\| scrolledToReturn\.current === focusReturnId\) return;\s*scrolledToReturn\.current = focusReturnId;/);
  assert.match(ALLOC, /document\.getElementById\(`alloc-return-\$\{focusReturnId\}`\)/);
  assert.match(ALLOC, /id=\{`alloc-return-\$\{ret\.id\}`\}\s*className=\{`alloc-return\$\{ret\.id === focusReturnId \? " is-focused" : ""\}`\}/);
  // A return confirmed meanwhile is said so, not silently ignored.
  assert.match(ALLOC, /const focusMissing = Boolean\(focusReturnId\) && !returnsLoading && !returnsError && focusIndex < 0;/);
  assert.match(ALLOC, /The return you opened is no longer waiting — its condition has already been confirmed\./);
});
