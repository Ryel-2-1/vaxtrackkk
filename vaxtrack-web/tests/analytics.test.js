import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Admin Analytics shows only what its data supports.
 *
 * Negative controls were run first against the unfixed page and all five
 * passed, proving: "Export Report" generated no file, the heatmap presented a
 * normalized 1–4 shade as "Order Load" with a "Peak demand" verdict attached,
 * the operational insight appended invented advice to a real count, region bars
 * were drawn at 3x their true proportion, and the heatmap cells had neither an
 * accessible name nor a visible period label.
 *
 * Nothing was invented to replace them: no collection, field, fallback figure
 * or write was added. Unsupported claims were removed, and the metrics that are
 * genuinely Firestore-derived were left alone.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SRC = read("src/pages/admin/Analytics.jsx");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
const CSS = read("src/pages/admin/Analytics.css");

// ------------------------------------------------ no fabricated claims

test("no success message without a write, and no fake export", () => {
  assert.equal(/Export Report/.test(CODE), false, "the export button is gone");
  assert.equal(/handleExport/.test(CODE), false);
  assert.equal(/report generated/i.test(CODE), false, "nothing claims a report was produced");
  // The toast existed only for that button and went with it.
  assert.equal(/showToast/.test(CODE), false, "no toast remains on this page");
});

test("no invented recommendation, verdict or AI conclusion", () => {
  // The exact sentences that were being asserted. Matched case-insensitively:
  // a case-sensitive list let a fourth instance through on the first pass — the
  // Active alerts modal carried a "Suggested action" row with a lowercase 'a',
  // holding fixed advice that showed even when both counts were zero.
  for (const phrase of [
    "assigning additional riders",
    "cold-chain procedures",
    "prepare backup riders",
    "peak demand",
    "normal demand",
    "ai insight",
    "ai logistics",
  ]) {
    assert.equal(
      CODE.toLowerCase().includes(phrase),
      false,
      `"${phrase}" is a conclusion nothing in the system derives`
    );
  }

  // And the shapes they arrived in, so a differently-worded one is caught too.
  // Banning the bare words instead would forbid honest copy: the insight card
  // now says in as many words that no recommendation is derived, and a test
  // that rejected that sentence would push the page back toward vagueness.
  const ADVICE = /^(suggested|recommend|interpret|verdict|conclusion|diagnos)/i;

  // Every modal row is a ["label", value] pair; two of the removed claims were
  // rows whose label introduced advice.
  const rowLabels = [...CODE.matchAll(/\[\s*"([^"]+)"\s*,/g)].map((m) => m[1]);
  assert.ok(rowLabels.length > 0, "the modal rows must be present");
  for (const label of rowLabels) {
    assert.equal(ADVICE.test(label), false, `modal row "${label}" introduces advice`);
  }

  // The third arrived as visible control text ("View Recommendation").
  const jsxText = [...CODE.matchAll(/>([^<>{}]+)</g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  for (const text of jsxText) {
    assert.equal(
      /\b(recommendation|suggested action|interpretation|verdict)\b/i.test(text),
      false,
      `"${text}" offers a conclusion the page cannot produce`
    );
  }
});

test("no hardcoded operational KPI is rendered", () => {
  // Every KPI value must come from a variable, never a literal figure. Scoped
  // to KpiCard: `<option value="7">` on the range select is a control value,
  // not a metric.
  const kpiValues = [...CODE.matchAll(/<KpiCard[\s\S]*?\n\s*value=\{?([^\n]*)/g)].map((m) => m[1].trim());
  assert.ok(kpiValues.length >= 4, "the four KPI cards must be present");
  for (const v of kpiValues) {
    assert.equal(
      /^"[\d.,]+%?"/.test(v),
      false,
      `KPI value ${v} is a literal — it must be computed`
    );
  }
  // And no fabricated hub/ranking data structure may return.
  assert.equal(/STATIC_HUBS|hubRanking\s*=\s*\[/.test(CODE), false);
});

test("Analytics claims no regional distribution", () => {
  // The section read `order.region`. Nothing writes that field any more, so it
  // could only ever render an empty state or present a handful of legacy
  // documents as a current distribution. Its computation, filter, card, modal
  // and CSS are gone rather than left to sit at zero.
  assert.equal(
    /\bregion\b/i.test(CODE),
    false,
    "no region computation, filter, state or markup may remain"
  );
  assert.equal(
    /analytics-region/.test(CSS),
    false,
    "the section's CSS must go with the section"
  );

  // Nothing was substituted for it. A region is not derivable from what an
  // order does hold — `clinicAddress` is free text, and splitting one would be
  // inference presented as measurement.
  for (const token of ["clinicAddress", "parseRegion", "province", "geocode"]) {
    assert.equal(CODE.includes(token), false, `${token} must not stand in for a region`);
  }
});

test("the live order-creation path still writes no region", () => {
  // The justification above, asserted against its source rather than trusted.
  // If order creation ever does record a canonical region, this fails — which
  // is the point: restoring the section then becomes a decision someone makes
  // deliberately, not a gap nobody notices.
  const live = read("functions/src/operations.js");
  const created = /tx\.set\(orderRef, \{([\s\S]*?)\n {4}\}\);/.exec(live);
  assert.ok(created, "the order document shape must be found");
  assert.equal(
    /\bregion\b/i.test(created[1]),
    false,
    "createOrderWithReservation writes no region — Analytics may not imply one"
  );
  // The only writer that ever set it is the superseded client path, which the
  // rules refuse.
  assert.match(
    read("src/services/orderService.js"),
    /⚠️ SUPERSEDED[\s\S]*?export async function createSalesRepOrder/,
    "the one region writer must still be marked superseded"
  );
});

test("the clock is read to stamp a reference time, never during render", () => {
  // `Date.now()` sat inside a useMemo and inside computeVolumeBuckets, so two
  // renders with identical state could produce different cutoffs. Every read is
  // now a stamp of the one reference time the whole page measures from.
  const reads = CODE.match(/Date\.now\(\)/g) || [];
  const stamps = CODE.match(/setNowMs\(Date\.now\(\)\)/g) || [];
  assert.ok(reads.length > 0, "the page must still establish a reference time");
  assert.equal(
    reads.length,
    stamps.length,
    "every Date.now() must be stamping nowMs, not computing a value inline"
  );

  // Which means the bucket builder is handed the instant rather than fetching
  // its own, so the chart and the filter cannot disagree about "now".
  assert.match(SRC, /function computeVolumeBuckets\(orders, days, now\)/);
  assert.match(SRC, /const cutoff = nowMs - days \* MS_PER_DAY;/);

  // And no useMemo reaches for a clock or a fresh Date.
  for (const body of CODE.matchAll(/useMemo\(\(\) => \{([\s\S]*?)\n {2}\}, \[/g)) {
    assert.equal(
      /Date\.now\(\)|new Date\(\)/.test(body[1]),
      false,
      "a memo must not read the clock"
    );
  }
});

test("hub performance stays an honest empty state", () => {
  assert.match(SRC, /Hub ranking not available yet/);
  assert.match(SRC, /No hub data\s*\n?\s*is fabricated in the meantime/);
});

// ------------------------------------------------- honest derivations

test("the transit-segment average uses authoritative timestamps only", () => {
  // startedAt -> deliveredAt, both server-stamped. updatedAt is never a
  // substitute: it moves on any write, including ones unrelated to delivery.
  assert.match(SRC, /timestampMs\(order\.startedAt\)/);
  assert.match(SRC, /timestampMs\(order\.deliveredAt\)/);
  assert.equal(
    /updatedAt/.test(CODE),
    false,
    "updatedAt must never stand in for a delivery timestamp"
  );
  // Only completed orders, and only when the pair is coherent.
  assert.match(SRC, /if \(start == null \|\| end == null \|\| end <= start\) continue;/);
  // Absent data renders a dash and a reason, not a zero.
  assert.match(SRC, /if \(minutes == null\) return "—";/);
  assert.match(SRC, /No completed delivery timing data yet\./);
});

test("the metric is labelled as the segment it measures, not the whole journey", () => {
  // `startedAt` is stamped on EVERY transition into in_transit, so on a
  // resumed delivery it is the last transit start, not the original dispatch.
  // The figure is therefore the final leg — the earlier transit and the delay
  // are outside it — and the label has to say so.
  assert.match(SRC, /label="Average latest transit segment"/);
  assert.match(SRC, /title: "Average latest transit segment"/);
  assert.match(
    SRC,
    /"Calculated from each delivered order's latest startedAt timestamp to deliveredAt\. Resumed deliveries exclude earlier transit and delayed time\."/,
    "the modal must state what the window excludes"
  );

  // No rendered text may go back to claiming the full journey. Checked against
  // comment-stripped source: the code comment explaining the correction names
  // the old label, but nothing rendered may.
  for (const claim of [
    "Average delivery time",
    "hub dispatch",
    "Dispatch → delivery",
    "(dispatch)",
    "full delivery time",
    "total delivery time",
  ]) {
    assert.equal(
      CODE.toLowerCase().includes(claim.toLowerCase()),
      false,
      `"${claim}" overstates a window that excludes earlier transit and delay`
    );
  }

  // And no replacement timestamp was invented to paper over the gap. Total
  // elapsed time needs a first-dispatch field the schema does not keep, and
  // adding one here would be a lifecycle change, not a label change.
  for (const invented of [
    "firstDispatchedAt",
    "originalStartedAt",
    "firstStartedAt",
    "transitStartedAt",
    "totalTransitMs",
  ]) {
    assert.equal(CODE.includes(invented), false, `${invented} must not be introduced`);
  }
});

test("the label stays honest for as long as resumeTransit re-stamps startedAt", () => {
  // The reason for the wording, asserted against its source rather than
  // trusted. If resuming a delayed delivery ever stops resetting `startedAt`,
  // this fails — and reverting to "Average delivery time" becomes a decision
  // someone makes deliberately, having re-checked the semantics.
  const rider = read("../vaxtrack_mobile/lib/services/delivery_service.dart");
  const resume = /Future<void> resumeTransit\([\s\S]*?\n {2}\}/.exec(rider);
  assert.ok(resume, "resumeTransit must be found");
  assert.match(
    resume[0],
    /'startedAt': FieldValue\.serverTimestamp\(\)/,
    "resumeTransit still re-stamps startedAt, so the metric is a segment"
  );
  assert.match(resume[0], /'status': 'in_transit'/);

  // The rules pin it to server time, which is what makes the segment
  // authoritative even though it is not the whole journey.
  assert.match(
    read("firestore.rules"),
    /function isValidResume\(\)[\s\S]*?request\.resource\.data\.startedAt == request\.time/
  );
});

test("the completion rate is labelled for what it measures", () => {
  // It is delivered/total. It is NOT an on-time rate: no promised or scheduled
  // deadline exists on an order, so on-time cannot be computed at all.
  assert.match(SRC, /label="Completion rate"/);
  assert.equal(/On-Time|On Time/.test(CODE), false, "no on-time claim without a deadline field");
  assert.equal(
    /promisedAt|scheduledFor|dueAt|slaMinutes/.test(CODE),
    false,
    "no deadline field is invented"
  );
  assert.match(SRC, /completedCount \/ totalDeliveries/);
});

test("genuine Firestore-derived metrics remain", () => {
  assert.match(SRC, /subscribeDeliveries/);
  assert.match(SRC, /subscribeAllAlerts/);
  assert.match(SRC, /label="Total orders"/);
  assert.match(SRC, /label="Average latest transit segment"/);
  assert.match(SRC, /label="Active alerts"/);
  assert.match(SRC, /computeVolumeBuckets/);
  assert.match(SRC, /computeHeatmap/);
});

// ---------------------------------------------------------- heatmap

test("the heatmap reports counts, and its shading is explained", () => {
  // The real count travels with the shade and is what the UI reports.
  assert.match(SRC, /count,/);
  assert.match(SRC, /\["Orders created", cell\.count\.toLocaleString\(\)\]/);
  assert.equal(/Level \$\{cell\.level\}/.test(CODE), false, "a shade is not a quantity");
  // The caption says the shading is relative, so a full-colour cell in a quiet
  // week is not read as high volume.
  assert.match(SRC, /Shading is relative to the busiest cell/);
  // An empty cell is visibly empty rather than the lowest shade of "some".
  assert.match(SRC, /level: count === 0 \? 0 :/);
  assert.match(CSS, /\.analytics-heat-cell\.level-0/);
});

test("the heatmap is labelled accurately and implies no geography", () => {
  assert.match(SRC, /Order activity by day and period/);
  assert.equal(/Peak Order Hours/.test(CODE), false, "it does not resolve to hours");
  // Nothing in its visible copy suggests geographic coverage. ("map" is
  // deliberately absent from this list — it is a substring of "heatmap", the
  // feature's own name, and matching it would only catch itself.)
  const heatSection = /analytics-heatmap-card"[\s\S]*?<\/section>/.exec(CODE);
  assert.ok(heatSection, "the heatmap section must exist");
  for (const geo of ["coverage", "zone", "region", "area", "location", "geograph"]) {
    assert.equal(
      new RegExp(geo, "i").test(heatSection[0]),
      false,
      `the heatmap must not imply ${geo}`
    );
  }
  // It says what it counts.
  assert.match(SRC, /Counts orders by their creation time/);
});

test("every heatmap cell has a period label and an accessible name", () => {
  // 18 empty buttons previously announced as unnamed controls.
  assert.match(SRC, /aria-label=\{`\$\{cell\.day\} \$\{cell\.period\}: \$\{cell\.count\}/);
  assert.match(SRC, /className="analytics-heatmap-period">\{HEATMAP_PERIODS\[rowIndex\]\}/);
  assert.match(CSS, /\.analytics-heatmap-period/);
  // The day-label row keeps a matching leading cell so columns stay aligned.
  assert.match(CSS, /\.analytics-heatmap-labels \{[\s\S]*?grid-template-columns: 74px repeat\(6, 1fr\)/);
});

// ------------------------------------------------- no new persistence

test("no collection, field, fallback or write was introduced", () => {
  for (const token of [
    "setDoc", "updateDoc", "addDoc", "deleteDoc", "writeBatch", "runTransaction",
    "localStorage", "sessionStorage",
  ]) {
    assert.equal(CODE.includes(token), false, `Analytics must not use ${token}`);
  }
  assert.equal(
    /from ["']firebase\/firestore["']/.test(CODE),
    false,
    "Analytics reads through services only"
  );
  // Reads are subscriptions to existing collections; no new one appears here.
  assert.equal(/collection\(db,/.test(CODE), false);
});

test("loading, error and empty states stay honest", () => {
  assert.match(SRC, /if \(loading\)/);
  assert.match(SRC, /Loading analytics data…/);
  assert.match(SRC, /if \(loadError\)/);
  assert.match(SRC, /role="alert"/);
  // An empty range shows a dash, not a fabricated zero-percent.
  assert.match(SRC, /totalDeliveries > 0[\s\S]{0,80}: "—"/);
  assert.match(SRC, /No orders in range/);
});

// -------------------------------------------- heatmap column alignment

/**
 * Walk the stylesheet brace-aware, yielding { media, selectors, decls } so a
 * rule inside an @media block is not confused with the base one.
 */
function cssRules(css) {
  const out = [];
  let i = 0;
  const block = (media) => {
    let buf = "";
    while (i < css.length) {
      const ch = css[i];
      if (ch === "}") { i++; return; }
      if (ch === "{") {
        const head = buf.trim();
        buf = "";
        i++;
        if (head.startsWith("@")) {
          block(head);
        } else {
          let body = "";
          let depth = 1;
          while (i < css.length && depth > 0) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}") { depth--; if (!depth) { i++; break; } }
            body += css[i++];
          }
          out.push({
            media,
            selectors: head.split(",").map((s) => s.trim()),
            decls: body,
          });
        }
        continue;
      }
      buf += ch;
      i++;
    }
  };
  block(null);
  return out;
}

const RULES = cssRules(CSS.replace(/\/\*[\s\S]*?\*\//g, ""));
/** Last declared value of `prop` for `selector` within one media context. */
const declared = (selector, prop, media) =>
  RULES.filter((r) => r.media === media && r.selectors.includes(selector))
    .flatMap((r) => r.decls.split(";"))
    .map((d) => {
      const at = d.indexOf(":");
      return at === -1 ? null : [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })
    .filter((d) => d && d[0] === prop)
    .map((d) => d[1])
    .pop();

const MOBILE = RULES.find(
  (r) => r.selectors.includes(".analytics-heatmap-row") && r.media
)?.media;

/**
 * What a selector actually resolves to at a breakpoint. A selector left out of
 * the media block keeps its base value rather than having none — so narrowing
 * two of the three gaps and forgetting the third is a mismatch, not a gap.
 */
const effective = (selector, prop, media) =>
  declared(selector, prop, media) ?? declared(selector, prop, null);

test("the period row stays two columns at every breakpoint", () => {
  // The row holds a period name and the whole day grid. Handing it the label
  // row's seven tracks nests the grid inside one 1fr of seven: at 375px the
  // cells collapsed to 12px and every day name pointed at the wrong column.
  // The two grids are shaped differently and must be declared separately.
  assert.ok(MOBILE, "a narrow-width rule for the row must exist");
  for (const media of [null, MOBILE]) {
    const where = media || "base";
    const cols = effective(".analytics-heatmap-row", "grid-template-columns", media);
    assert.ok(cols, `${where}: the row must declare its columns`);
    assert.equal(
      /repeat\(/.test(cols),
      false,
      `${where}: the row must not take the label row's track list`
    );
    assert.equal(cols.split(/\s+/).length, 2, `${where}: two tracks, got "${cols}"`);

    // The label row, in contrast, is the leading spacer plus the six days.
    const labels = effective(".analytics-heatmap-labels", "grid-template-columns", media);
    assert.match(labels, /repeat\(6, 1fr\)$/, `${where}: six day columns`);
  }
});

test("one gap is shared, so day names sit over the columns they name", () => {
  // The label row spreads six names over six gutters; the cell grid spreads six
  // cells over five gutters plus the row's own. Those two arithmetics land on
  // the same positions only while all three gaps are equal — an 8px row gap
  // against a 7px cell gap drifts the columns apart a fraction at a time.
  for (const media of [null, MOBILE]) {
    const gaps = [
      ".analytics-heatmap-row",
      ".analytics-heatmap-labels",
      ".analytics-heatmap-grid",
    ].map((s) => effective(s, "gap", media));

    assert.equal(
      new Set(gaps).size,
      1,
      `${media || "base"}: row/labels/cell gaps must match, got ${JSON.stringify(gaps)}`
    );
  }
});

// --------------------------------------------------- modal viewport cap

test("every Analytics modal is the one shared dialog", () => {
  // The cap below is a single CSS rule, so it only holds if there is a single
  // dialog. All eight detail modals feed one piece of state rendered by one
  // component; a second hand-rolled dialog would escape the fix.
  assert.equal(
    (CODE.match(/className="analytics-modal-backdrop"/g) || []).length,
    1,
    "exactly one backdrop element may exist"
  );
  assert.equal(
    (CODE.match(/className="analytics-modal"/g) || []).length,
    1,
    "exactly one dialog element may exist"
  );
  assert.equal((CODE.match(/function AnalyticsModal\(/g) || []).length, 1);
  // Every opener routes through that one component's state.
  const openers = (CODE.match(/openModal\(\{/g) || []).length;
  assert.ok(openers >= 8, `all ${openers} openers must share the dialog`);
  assert.match(CODE, /<AnalyticsModal modal=\{selectedModal\}/);
});

test("the modal is capped to the viewport, not to its own width", () => {
  const width = declared(".analytics-modal", "width", null);
  assert.ok(width, "the dialog must declare a width");

  // `width: 580px; max-width: 100%` could not clamp. The backdrop is a grid and
  // `place-items: center` leaves the item unstretched, so its column track
  // sized to the item's own max-content — 580px — and the percentage resolved
  // against that same figure. The dialog rendered 580px wide inside a 375px
  // viewport. A viewport-relative cap breaks the circularity because 100vw does
  // not depend on the item.
  const parsed = /^min\((\d+)px,\s*100vw - (\d+)px\)$/.exec(width);
  assert.ok(parsed, `the width must be a viewport-relative cap, got "${width}"`);

  const desktop = Number(parsed[1]);
  const inset = Number(parsed[2]);
  assert.equal(desktop, 580, "desktop stays approximately 580px");

  assert.equal(
    declared(".analytics-modal", "max-width", null),
    undefined,
    "a percentage max-width would only restore the circular clamp"
  );

  // The backdrop's padding is half the inset on each side, so the dialog sits
  // inside its own grid area at every width instead of overflowing it.
  const pad = declared(".analytics-modal-backdrop", "padding", null);
  assert.equal(
    pad,
    `${inset / 2}px`,
    `backdrop padding ${pad} must match the ${inset / 2}px the cap leaves per side`
  );

  // What the declaration yields at the tested widths — derived from the rule
  // above rather than restated, so editing the rule moves these with it.
  for (const vw of [320, 375, 1440]) {
    const rendered = Math.min(desktop, vw - inset);
    assert.ok(rendered <= vw, `at ${vw}px the dialog must fit the viewport`);
    assert.ok(rendered > 0, `at ${vw}px the dialog must still be visible`);
    if (vw < desktop + inset) {
      assert.equal(
        vw - rendered,
        inset,
        `at ${vw}px the side spacing must stay ${inset / 2}px each side`
      );
    } else {
      assert.equal(rendered, desktop, `at ${vw}px the dialog stays ${desktop}px`);
    }
  }
});

test("the modal keeps its box model, padding and controls", () => {
  // The fix changed two declarations. Nothing that governs the dialog's
  // internals, its close controls or its content may have moved with them.
  assert.equal(declared(".analytics-modal", "padding", null), "28px");
  assert.equal(declared(".analytics-modal", "position", null), "relative");
  assert.equal(declared(".analytics-modal-backdrop", "position", null), "fixed");
  assert.equal(declared(".analytics-modal-backdrop", "place-items", null), "center");
  assert.match(CSS, /\.analytics-modal-close \{/);
  // Both ways out of the dialog survive.
  assert.match(CODE, /className="analytics-modal-close"[\s\S]{0,80}aria-label="Close"/);
  assert.match(CODE, /<div className="analytics-modal-actions">[\s\S]*?Close/);
  // And its content is still rendered from the modal object, not hardcoded.
  assert.match(CODE, /<h2>\{modal\.title\}<\/h2>/);
  assert.match(CODE, /<p>\{modal\.description\}<\/p>/);
  assert.match(CODE, /modal\.rows\.map\(/);
});
