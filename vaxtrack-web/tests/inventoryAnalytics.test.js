import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ANALYTICS_DISCLAIMER,
  BASELINE_LABEL,
  HORIZONS,
  NO_FORECAST_MESSAGE,
  PRIMARY_HORIZON,
  REORDER_CONFIGURATION_REQUIRED,
  STALE_AFTER_DAYS,
  analyticsConfigPayload,
  configChangedSinceForecast,
  configFormFrom,
  forecastRow,
  forecastsByVaccine,
  formatQuantity,
  isStale,
  sortRows,
  summarize,
} from "../src/services/inventoryAnalytics.js";

// Admin › AI Inventory Analytics (web). The page shows only server-generated
// forecasts; these tests pin that nothing is fabricated, that the empty state
// is honest, and that the web and server agree on every shared rule.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const require = createRequire(import.meta.url);
const serverRisk = require("../functions/src/analyticsRisk.js");
const serverEngine = require("../functions/src/forecastEngine.js");
const serverAnalytics = require("../functions/src/inventoryAnalytics.js");
const serverRun = require("../functions/src/inventoryAnalyticsRun.js");

const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const LONG_NAME = "Moderna COVID-19 Vaccine (Bivalent, Original and Omicron BA.4/BA.5) — 0.5 mL multi-dose vial";

/** A real forecast document, produced by the SERVER plan (not hand-written). */
function serverForecasts() {
  const line = (q) => ({ productKey: "vacA", quantity: q, reservedQuantity: q, backorderedQuantity: 0 });
  const plan = serverRun.buildAnalyticsPlan({
    now: new Date("2026-10-09T04:00:00.000Z"),
    orders: Array.from({ length: 10 }, (_, i) => ({
      id: `o${i}`,
      data: { status: "delivered", requestedDeliveryDate: serverAnalytics.addDays("2026-07-27", 7 * i), items: [line(70)] },
    })),
    batches: [{ id: "b1", data: { vaccineId: "vacA", quantity: 500, reservedQuantity: 0, status: "OK", expiryDate: "2027-12-31", arrivalDate: "2026-07-27" } }],
    vaccines: [
      { id: "vacA", data: { vaccineName: LONG_NAME, internalSku: "MOD-STG-001-BIVALENT-0.5ML" } },
      { id: "vacB", data: { vaccineName: "Hepatitis B Vaccine" } },
    ],
    configs: [],
  });
  return { plan, docs: plan.forecasts.map((f) => ({ id: f.id, ...f.data, generatedAt: ts("2026-10-09T05:00:00Z") })) };
}

test("the web's shared constants equal the server's", () => {
  assert.deepEqual(HORIZONS, serverAnalytics.HORIZONS);
  assert.equal(PRIMARY_HORIZON, serverAnalytics.PRIMARY_HORIZON);
  assert.equal(REORDER_CONFIGURATION_REQUIRED, serverRisk.REORDER_CONFIGURATION_REQUIRED);
  assert.equal(BASELINE_LABEL, serverEngine.BASELINE_LABEL);
  assert.equal(ANALYTICS_DISCLAIMER, "Forecasts are advisory and do not change inventory automatically.");
});

test("31 · rows show only stored figures: a missing value is '—' or its reason, never a number", () => {
  const { docs } = serverForecasts();
  const b = forecastRow(docs.find((d) => d.id === "vacB__all__30d"));
  assert.equal(b.predicted, "—", "insufficient history: no forecast");
  assert.equal(b.insufficient, true);
  assert.equal(b.reorder, REORDER_CONFIGURATION_REQUIRED);
  assert.equal(b.sku, "No SKU");
  assert.equal(b.confidence, "Insufficient data");
  assert.equal(b.riskLabel, "Unknown");

  const a = forecastRow(docs.find((d) => d.id === "vacA__all__30d"));
  assert.equal(a.predicted, "300");
  assert.equal(a.available, "500");
  assert.equal(a.reorder, REORDER_CONFIGURATION_REQUIRED, "no configuration → no reorder figure");

  // A document with nothing in it renders nothing invented.
  const empty = forecastRow({ vaccineId: "x", stockoutRiskLevel: "bogus" });
  for (const key of ["available", "reserved", "backordered", "predicted", "shortage"]) assert.equal(empty[key], "—", key);
  assert.equal(empty.reorder, REORDER_CONFIGURATION_REQUIRED);
  assert.equal(empty.risk, "unknown");
  assert.equal(empty.name, "Name not recorded");
  for (const bad of [null, undefined, -1, 1.5, "300", Number.NaN]) assert.equal(formatQuantity(bad), "—", String(bad));
});

test("31 · the page has no sample data and never computes a forecast itself", () => {
  const page = read("src/pages/admin/AiInventoryAnalytics.jsx");
  assert.doesNotMatch(page, /sample(Forecasts?|Data|Rows)|mock|placeholderForecast|fakeForecast|DEMO_/i);
  assert.doesNotMatch(page, /functions\/src|forecastEngine|predict\(/, "no forecasting in the browser");
  assert.match(page, /subscribeInventoryForecasts/);
  const service = read("src/services/inventoryAnalyticsService.js");
  // The only client write is the configuration.
  assert.equal((service.match(/setDoc\(/g) ?? []).length, 1);
  assert.match(service, /setDoc\(doc\(db, CONFIG, vaccineId\)/);
  assert.doesNotMatch(service, /addDoc|updateDoc|deleteDoc|writeBatch|runTransaction/);
});

test("32 · no run, or a run with no forecasts, shows the empty state", () => {
  const { docs, plan } = serverForecasts();
  assert.equal(forecastsByVaccine(docs, null).size, 0, "no run → nothing shown");
  assert.equal(forecastsByVaccine(docs, "some-other-run").size, 0, "forecasts of another run are not shown");
  assert.equal(forecastsByVaccine(docs, plan.runId).size, 2);
  const page = read("src/pages/admin/AiInventoryAnalytics.jsx");
  assert.equal(NO_FORECAST_MESSAGE, "No inventory forecast has been generated yet.");
  assert.match(page, /run === null \|\| rows\.length === 0/);
  assert.match(page, /\{NO_FORECAST_MESSAGE\}/);
  assert.match(page, /permission-denied/);
  assert.match(page, /Loading inventory analytics/);
  assert.match(page, /Stale forecast/);
  assert.match(page, /Insufficient history/);
});

test("33 · full vaccine names and SKUs stay readable — never truncated", () => {
  const { docs } = serverForecasts();
  const a = forecastRow(docs.find((d) => d.id === "vacA__all__30d"));
  assert.equal(a.name, LONG_NAME);
  assert.equal(a.sku, "MOD-STG-001-BIVALENT-0.5ML");
  const css = read("src/pages/admin/AiInventoryAnalytics.css");
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis|line-clamp/);
  const nameRule = css.slice(css.indexOf(".aia-main-table .aia-name"), css.indexOf("}", css.indexOf(".aia-main-table .aia-name")));
  assert.match(nameRule, /white-space: normal/);
  assert.match(nameRule, /overflow-wrap: anywhere/);
});

test("summary cards count the stored 30-day forecasts; rows sort High first", () => {
  const { docs, plan } = serverForecasts();
  const rows = [...forecastsByVaccine(docs, plan.runId).values()].map((h) => forecastRow(h[30]));
  assert.deepEqual(summarize(rows), { vaccinesAnalyzed: 2, highRisk: 0, configurationRequired: 2, lowConfidence: 1 });
  const sorted = sortRows([
    { risk: "low", name: "B" },
    { risk: "high", name: "Z" },
    { risk: "unknown", name: "A" },
    { risk: "medium", name: "C" },
  ]);
  assert.deepEqual(sorted.map((r) => r.risk), ["high", "medium", "unknown", "low"]);
});

test("stale and changed-configuration detection", () => {
  const generated = ts("2026-10-01T00:00:00Z");
  assert.equal(isStale(generated, Date.parse("2026-10-07T00:00:00Z")), false);
  assert.equal(isStale(generated, Date.parse(`2026-10-0${1 + STALE_AFTER_DAYS}T00:00:01Z`)), true);
  assert.equal(isStale(null), true, "no time at all is never treated as fresh");
  assert.equal(configChangedSinceForecast({ updatedAt: ts("2026-10-02T00:00:00Z") }, { generatedAt: generated }), true);
  assert.equal(configChangedSinceForecast({ updatedAt: ts("2026-09-30T00:00:00Z") }, { generatedAt: generated }), false);
});

test("30 · the configuration form accepts exactly what the server and rules accept", () => {
  const cases = [
    [{ leadTimeDays: "14", safetyMode: "quantity", safetyValue: "20", enabled: true }, true],
    [{ leadTimeDays: "1", safetyMode: "days", safetyValue: "0", enabled: false }, true],
    [{ leadTimeDays: "365", safetyMode: "days", safetyValue: "365", enabled: true }, true],
    [{ leadTimeDays: "0", safetyMode: "quantity", safetyValue: "20" }, false],
    [{ leadTimeDays: "366", safetyMode: "quantity", safetyValue: "20" }, false],
    [{ leadTimeDays: "2.5", safetyMode: "quantity", safetyValue: "20" }, false],
    [{ leadTimeDays: "14", safetyMode: "days", safetyValue: "400" }, false],
    [{ leadTimeDays: "14", safetyMode: "quantity", safetyValue: "-1" }, false],
    [{ leadTimeDays: "14", safetyMode: "quantity", safetyValue: "" }, false],
    [{ leadTimeDays: "", safetyMode: "quantity", safetyValue: "20" }, false],
  ];
  for (const [form, ok] of cases) {
    const web = analyticsConfigPayload("vacA", form);
    assert.equal(web.ok, ok, JSON.stringify(form));
    if (ok) {
      const stored = { ...web.value, updatedAt: ts("2026-10-09T00:00:00Z"), updatedByUid: "admin1" };
      assert.equal(serverRisk.validateAnalyticsConfig(stored, "vacA").ok, true, JSON.stringify(form));
      assert.deepEqual(configFormFrom(stored), { ...form, enabled: form.enabled !== false }, "round-trips");
    }
  }
  assert.equal(analyticsConfigPayload("a/b", cases[0][0]).ok, false);
});

test("the page is an Admin route in the persistent shell, linked from the sidebar", () => {
  const app = read("src/App.jsx");
  assert.match(app, /const AiInventoryAnalytics = lazy\(\(\) => import\("\.\/pages\/admin\/AiInventoryAnalytics"\)\);/);
  assert.match(app, /<Route path="\/admin\/ai-inventory-analytics" element=\{<AiInventoryAnalytics \/>\} \/>/);
  const shell = read("src/components/admin/AdminShell.jsx");
  assert.match(shell, /"\/admin\/ai-inventory-analytics": "AI Inventory Analytics"/);
  assert.match(shell, /"\/admin\/ai-inventory-analytics": "inventory-page adl-root"/);
  const sidebar = read("src/components/admin/AdminSidebar.jsx");
  assert.match(sidebar, /to="\/admin\/ai-inventory-analytics"/);
  assert.match(sidebar, /"\/admin\/ai-inventory-analytics": "aiInventoryAnalytics"/);
  const page = read("src/pages/admin/AiInventoryAnalytics.jsx");
  assert.doesNotMatch(page, /<h1\b|<AdminSidebar|className="inventory-page/, "content only — the shell owns title and sidebar");
  assert.match(page, /\{ANALYTICS_DISCLAIMER\}/);
});

test("safety stock in the Admin form: whole vials 0–100,000,000; NaN, decimal, negative and oversized refused", () => {
  const form = (safetyValue, safetyMode = "quantity") => ({ leadTimeDays: "14", safetyMode, safetyValue, enabled: true });
  for (const ok of ["0", "20", "100000000"]) {
    const r = analyticsConfigPayload("vacA", form(ok));
    assert.equal(r.ok, true, ok);
    const stored = { ...r.value, updatedAt: ts("2026-10-09T00:00:00Z"), updatedByUid: "admin1" };
    assert.equal(serverRisk.validateAnalyticsConfig(stored, "vacA").ok, true, ok);
  }
  for (const bad of ["100000001", "NaN", "2.5", "-1", "1e8", "Infinity", " ", "20 vials", "0x10"]) {
    const r = analyticsConfigPayload("vacA", form(bad));
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /whole number of vials from 0 to 100,000,000/);
  }
  for (const bad of ["366", "2.5", "NaN"]) assert.equal(analyticsConfigPayload("vacA", form(bad, "days")).ok, false, bad);
  // The web ceiling is the server's and the rules' ceiling.
  assert.equal(serverRisk.MAX_SAFETY_STOCK_QUANTITY, 100000000);
  assert.match(read("firestore.rules"), /d\.safetyStockQuantity <= 100000000/);
});

test("the page names its environment; staging carries the seed/test-data warning", async () => {
  const { environmentNotice, STAGING_DATA_WARNING } = await import("../src/services/inventoryAnalytics.js");
  assert.equal(STAGING_DATA_WARNING, serverRun.STAGING_DATA_WARNING);
  assert.equal(STAGING_DATA_WARNING, "Staging may contain seed or test orders. Forecasts must not be treated as real client demand.");
  assert.deepEqual(environmentNotice("vaxtrack-staging"), { projectId: "vaxtrack-staging", label: "Staging", warning: STAGING_DATA_WARNING });
  assert.deepEqual(environmentNotice("vaxtrack-bef1b"), { projectId: "vaxtrack-bef1b", label: "Production", warning: null });
  assert.equal(environmentNotice("demo-x").warning, null);
  for (const none of [undefined, null, "", "  "]) assert.equal(environmentNotice(none), null);
  const page = read("src/pages/admin/AiInventoryAnalytics.jsx");
  assert.match(page, /environmentNotice\(import\.meta\.env\.VITE_FIREBASE_PROJECT_ID \|\| run\?\.projectId\)/);
  assert.match(page, /\{ANALYTICS_DISCLAIMER\}/, "the advisory disclaimer stays");
  assert.match(page, /environment\.warning && <> — \{environment\.warning\}<\/>/);
});
