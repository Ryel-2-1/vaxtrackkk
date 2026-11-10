/**
 * AI Inventory Analytics — the Admin page's display model (Phase 1).
 *
 * Pure (no Firebase, no React) so node tests import it directly. The page
 * shows ONLY what the server generator stored in inventoryForecasts /
 * inventoryAnalyticsRuns (functions/src/inventoryAnalyticsRun.js). Nothing here
 * computes, estimates or fills in a forecast: a missing figure renders as "—"
 * or as the reason it is missing, never as a number.
 */

export const ANALYTICS_DISCLAIMER = "Forecasts are only a guide and never change stock by themselves.";
export const NO_FORECAST_MESSAGE = "No forecast yet.";
export const BASELINE_LABEL = "Baseline forecasting";
/** Identical to STAGING_DATA_WARNING in functions/src/inventoryAnalyticsRun.js. */
export const STAGING_DATA_WARNING =
  "Staging may contain seed or test orders. Forecasts must not be treated as real client demand.";
export const STAGING_PROJECT = "vaxtrack-staging";
export const PRODUCTION_PROJECT = "vaxtrack-bef1b";
export const HORIZONS = Object.freeze([7, 30, 90]);
export const PRIMARY_HORIZON = 30;
/** A run older than this is flagged stale. */
export const STALE_AFTER_DAYS = 7;
const DAY_MS = 86400000;

/** Risk level → label and tone (green low, amber medium, red high, gray unknown). */
export const RISK_META = Object.freeze({
  high: { label: "High", tone: "high" },
  medium: { label: "Medium", tone: "medium" },
  low: { label: "Low", tone: "low" },
  unknown: { label: "Unknown", tone: "unknown" },
});

/**
 * Why a risk level was given (functions/src/analyticsRisk.js riskBasis). The
 * page keeps a KNOWN shortage (orders already placed) visibly separate from a
 * FORECASTED one and from "not enough history to forecast".
 */
export const RISK_BASIS_LABELS = Object.freeze({
  current_backorder_shortage: "Current shortage",
  forecast_shortage: "Forecasted shortage",
  insufficient_history: "Insufficient forecast history",
  runs_low: "Less than a week left after the period",
  covered: "Covered",
});

export const CONFIDENCE_LABELS = Object.freeze({
  high: "High",
  medium: "Medium",
  low: "Low",
  insufficient: "Insufficient data",
});

const isQuantity = (v) => Number.isSafeInteger(v) && v >= 0;

/** A stored whole-vial figure, or "—" when there is none. Never invents a value. */
export function formatQuantity(value) {
  return isQuantity(value) ? value.toLocaleString("en-PH") : "—";
}

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

export function formatGeneratedAt(ts) {
  const ms = toMillis(ts);
  if (ms === null) return "—";
  return new Date(ms).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
}

/** True when the run is older than STALE_AFTER_DAYS (or has no time at all). */
export function isStale(generatedAt, nowMillis = Date.now()) {
  const ms = toMillis(generatedAt);
  return ms === null || nowMillis - ms > STALE_AFTER_DAYS * DAY_MS;
}

/**
 * Which Firebase project the page (and the run) belongs to, for the header.
 * Null when unknown. Staging carries the seed/test-data warning.
 */
export function environmentNotice(projectId) {
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  const id = projectId.trim();
  if (id === STAGING_PROJECT) return { projectId: id, label: "Staging", warning: STAGING_DATA_WARNING };
  if (id === PRODUCTION_PROJECT) return { projectId: id, label: "Production", warning: null };
  return { projectId: id, label: "Other project", warning: null };
}

/** The forecasts that belong to one run, grouped per vaccine by horizon. */
export function forecastsByVaccine(forecastDocs, runId) {
  const out = new Map();
  if (!runId) return out;
  for (const d of forecastDocs) {
    if (d?.runId !== runId || !HORIZONS.includes(d.horizonDays) || typeof d.vaccineId !== "string") continue;
    const entry = out.get(d.vaccineId) ?? {};
    entry[d.horizonDays] = d;
    out.set(d.vaccineId, entry);
  }
  return out;
}

/**
 * One table row, from the stored 30-day forecast. Every number is the stored
 * one; a null stays "—"; a missing name/SKU is said to be missing.
 */
export function forecastRow(doc) {
  const risk = RISK_META[doc.stockoutRiskLevel] ? doc.stockoutRiskLevel : "unknown";
  const insufficient = doc.confidenceLevel === "insufficient" || !isQuantity(doc.predictedDemandQuantity);
  return {
    id: doc.forecastId ?? doc.id,
    vaccineId: doc.vaccineId,
    name: typeof doc.vaccineNameSnapshot === "string" && doc.vaccineNameSnapshot ? doc.vaccineNameSnapshot : "Name not recorded",
    nameMissing: !(typeof doc.vaccineNameSnapshot === "string" && doc.vaccineNameSnapshot),
    sku: typeof doc.skuSnapshot === "string" && doc.skuSnapshot ? doc.skuSnapshot : "No SKU",
    skuMissing: !(typeof doc.skuSnapshot === "string" && doc.skuSnapshot),
    available: formatQuantity(doc.availableQuantity),
    reserved: formatQuantity(doc.reservedQuantity),
    backordered: formatQuantity(doc.backorderedQuantity),
    hasBackorders: isQuantity(doc.backorderedQuantity) && doc.backorderedQuantity > 0,
    predicted: insufficient ? "—" : formatQuantity(doc.predictedDemandQuantity),
    // Known now, from placed orders — never depends on a forecast.
    currentShortage: formatQuantity(doc.currentBackorderShortageQuantity),
    hasCurrentShortage: isQuantity(doc.currentBackorderShortageQuantity) && doc.currentBackorderShortageQuantity > 0,
    // Forecast-based; without a forecast it says so instead of showing a number.
    forecastShortage: insufficient ? "Insufficient history" : formatQuantity(doc.forecastShortageQuantity),
    totalShortage: insufficient ? "—" : formatQuantity(doc.totalProjectedShortageQuantity),
    riskBasis: typeof doc.riskBasis === "string" ? doc.riskBasis : null,
    riskBasisLabel: RISK_BASIS_LABELS[doc.riskBasis] ?? "",
    reorderQuantity: isQuantity(doc.recommendedReorderQuantity) ? doc.recommendedReorderQuantity : null,
    reorder: formatQuantity(doc.recommendedReorderQuantity),
    insufficient,
    risk,
    riskLabel: RISK_META[risk].label,
    riskTone: RISK_META[risk].tone,
    riskReason: typeof doc.stockoutRiskReason === "string" ? doc.stockoutRiskReason : "",
    confidence: CONFIDENCE_LABELS[doc.confidenceLevel] ?? "Unknown",
    lowConfidence: doc.confidenceLevel === "insufficient" || doc.confidenceLevel === "low",
    generatedAt: formatGeneratedAt(doc.generatedAt),
  };
}

/** The views above the forecast list, most useful first. */
/**
 * What each status means, in the words an Admin would use. Shown on the page
 * under "What do these mean?" and kept here so the list and the help agree.
 */
export const FORECAST_STATUS_HELP = Object.freeze([
  { status: "Order now", meaning: "Orders expected in the next 30 days, or orders already placed, need more vials than you have. Order the amount shown." },
  { status: "Running low", meaning: "Stock covers the next 30 days, but less than another week's worth will be left. Plan an order soon." },
  { status: "Enough stock", meaning: "Stock covers the next 30 days with at least a week to spare. Nothing to do." },
  { status: "Not enough history", meaning: "Fewer than 4 weeks of orders for this vaccine, so there is no forecast yet." },
]);

export const FORECAST_VIEWS = Object.freeze([
  { key: "attention", label: "Needs attention" },
  { key: "enough", label: "Enough stock" },
  { key: "history", label: "Not enough history" },
  { key: "all", label: "All vaccines" },
]);

const vials = (n) => `${formatQuantity(n)} vial${n === 1 ? "" : "s"}`;

/**
 * A forecast row in plain words: its status, the one thing to do, and why.
 * It rewords what the server already decided and calculates nothing new.
 */
export function forecastAdvice(row) {
  const toOrder = row.reorderQuantity > 0 ? `Order ${vials(row.reorderQuantity)}` : null;
  if (row.risk === "high") {
    return {
      view: "attention",
      tone: "high",
      status: "Order now",
      action: toOrder ?? "Review this vaccine",
      why: row.hasCurrentShortage
        ? "Orders already placed need more stock than you have."
        : "Expected orders are more than your stock.",
      button: "See why",
    };
  }
  if (row.risk === "medium") {
    return {
      view: "attention",
      tone: "medium",
      status: "Running low",
      action: "Plan an order soon",
      why: "Less than a week's worth will be left after 30 days.",
      button: "See why",
    };
  }
  if (row.risk === "low") {
    return { view: "enough", tone: "low", status: "Enough stock", action: "No order needed", why: "", button: "Details" };
  }
  if (row.insufficient) {
    return {
      view: "history",
      tone: "unknown",
      status: "Not enough history",
      action: "Nothing to do yet",
      why: "A forecast needs at least 4 weeks of orders.",
      button: "Details",
    };
  }
  // Only an older forecast (made before 2026-11-10) can land here.
  return {
    view: "history",
    tone: "unknown",
    status: "Waiting for update",
    action: "Nothing to do yet",
    why: "This vaccine is worked out again at the next forecast update.",
    button: "Details",
  };
}

/** How many vaccines each view holds. */
export function forecastViewCounts(rows) {
  const counts = { attention: 0, enough: 0, history: 0, all: rows.length };
  rows.forEach((r) => {
    counts[forecastAdvice(r).view] += 1;
  });
  return counts;
}

/** "2026-11-01" as "Nov 1". */
export function shortDay(iso) {
  const ms = typeof iso === "string" ? Date.parse(`${iso}T00:00:00+08:00`) : NaN;
  if (Number.isNaN(ms)) return iso ?? "";
  return new Date(ms).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "Asia/Manila" });
}

/** Sort: High first, then Medium, Unknown, Low; then by name. */
const RISK_ORDER = { high: 0, medium: 1, unknown: 2, low: 3 };
export function sortRows(rows) {
  return [...rows].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.name.localeCompare(b.name));
}

/** Were the vaccine's season settings changed after this forecast was made? */
export function configChangedSinceForecast(config, forecast) {
  // Only a busy season counts: an old reorder setting (removed 2026-11-10) is
  // not used any more, so it changes nothing.
  if (!Array.isArray(config?.busyMonths)) return false;
  const c = toMillis(config?.updatedAt);
  const f = toMillis(forecast?.generatedAt);
  return c !== null && f !== null && c > f;
}

// ---------------------------------------------------------------- busy season (2026-11-10)
//
// The supplier lead time and reserve settings were removed at the user's
// request. What an Admin sets per vaccine now is its busy season: the months
// more is ordered (flu vaccine before Christmas, say) and roughly how much more.

export const MONTH_NAMES = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
export const MAX_BUSY_INCREASE_PERCENT = 300;

const validMonths = (months) =>
  [...new Set((Array.isArray(months) ? months : []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);

/** "Nov and Dec", "Oct, Nov and Dec". */
export function monthList(months) {
  const names = validMonths(months).map((m) => MONTH_NAMES[m - 1]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The form's starting values. Months are kept as "11,12" (a plain string) so
 * the live-draft comparison sees an unchanged list as unchanged.
 */
export function configFormFrom(config) {
  const months = validMonths(config?.busyMonths);
  return {
    busyMonths: months.join(","),
    busyIncreasePercent: months.length > 0 && Number.isInteger(config?.busyIncreasePercent) ? String(config.busyIncreasePercent) : "",
  };
}

/** One line for a vaccine's busy season, or null when none is set. */
export function seasonSummary(config) {
  const months = validMonths(config?.busyMonths);
  const pct = config?.busyIncreasePercent;
  if (months.length === 0 || !Number.isInteger(pct) || pct <= 0) return null;
  return `Busy in ${monthList(months)} · about ${pct}% more`;
}

const wholeIn = (text, min, max) => {
  const t = String(text ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

/**
 * The season fields to save, validated as firestore.rules and
 * functions/src/analyticsRisk.js validate them. The service adds the server
 * time and the signed-in Admin's uid. Returns { ok, value } or
 * { ok: false, error, field } — `field` names the input the error belongs to.
 */
export function analyticsConfigPayload(vaccineId, form) {
  if (typeof vaccineId !== "string" || vaccineId === "" || vaccineId.includes("/")) {
    return { ok: false, error: "This vaccine cannot be set up." };
  }
  const months = String(form?.busyMonths ?? "").split(",").filter((t) => t.trim() !== "").map(Number);
  if (months.some((m) => !Number.isInteger(m) || m < 1 || m > 12) || new Set(months).size !== months.length) {
    return { ok: false, field: "busyMonths", error: "Choose the busy months again." };
  }
  let busyIncreasePercent = 0;
  if (months.length > 0) {
    busyIncreasePercent = wholeIn(form?.busyIncreasePercent, 1, MAX_BUSY_INCREASE_PERCENT);
    if (busyIncreasePercent === null) {
      return {
        ok: false,
        field: "busyIncreasePercent",
        error: `Enter how much more is ordered in the busy months, from 1% to ${MAX_BUSY_INCREASE_PERCENT}%.`,
      };
    }
  }
  return { ok: true, value: { vaccineId, busyMonths: [...months].sort((a, b) => a - b), busyIncreasePercent } };
}

// ---------------------------------------------------------------- plain words
//
// The server stores its workings in technical terms ("weighted moving
// average", "horizon", "backorder shortage"). The people reading this page
// order vaccines, they are not analysts, so the page retells the same stored
// numbers in everyday words. Nothing here calculates a new figure.

/** How sure the estimate is, in words. It reflects how many weeks of orders exist. */
export const PLAIN_CONFIDENCE = Object.freeze({
  high: "Fairly sure",
  medium: "Somewhat sure",
  low: "Rough estimate",
  insufficient: "Too little data",
});

/** "Next 30 days" for a stored horizon. */
export function periodLabel(days) {
  return Number.isInteger(days) ? `Next ${days} days` : "—";
}

const plainVials = (n) => `${formatQuantity(n)} vial${n === 1 ? "" : "s"}`;

/** The vials-per-week figure the server wrote into its explanation, or null. */
function weeklyRateOf(doc) {
  const factor = (doc?.explanationFactors ?? []).find((f) => f?.key === "weekly_rate");
  const rate = factor ? Number.parseFloat(String(factor.value)) : NaN;
  return Number.isFinite(rate) ? rate : null;
}

/**
 * The forecast as a short story: what was ordered, what is expected, what you
 * have, and what that leaves. Every number comes from the stored forecast.
 */
export function plainForecastStory(doc) {
  const calc = doc?.calculation ?? {};
  const days = Number.isInteger(doc?.horizonDays) ? doc.horizonDays : 30;
  const weeks = Number.isInteger(doc?.usableWeekCount) ? doc.usableWeekCount : 0;
  if (!isQuantity(calc.predictedDemandQuantity)) {
    return [
      `There ${weeks === 1 ? "is" : "are"} only ${weeks} week${weeks === 1 ? "" : "s"} of orders for this vaccine. VaxTrack needs at least 4 weeks before it can estimate future orders.`,
    ];
  }
  const rate = weeklyRateOf(doc);
  const used = (doc.explanationFactors ?? []).find((f) => f?.key === "recent_weeks");
  const weeksUsed = used ? String(used.value).split(",").filter(Boolean).length : weeks;
  const seasonLine = plainSeasonLine(doc);
  const lines = [
    rate === null
      ? `Based on the last ${weeksUsed} weeks of orders, clinics are expected to order about ${plainVials(calc.predictedDemandQuantity)} in the next ${days} days.`
      : `In the last ${weeksUsed} weeks, clinics ordered about ${rate.toLocaleString("en-PH", { maximumFractionDigits: 1 })} vials a week (recent weeks count more). That comes to about ${plainVials(calc.predictedDemandQuantity)} in the next ${days} days.`,
  ];
  if (seasonLine) lines.push(seasonLine);
  const waiting = isQuantity(calc.backorderedQuantity) && calc.backorderedQuantity > 0
    ? `, and ${plainVials(calc.backorderedQuantity)} are already promised to orders waiting for stock`
    : "";
  lines.push(`You have ${plainVials(calc.availableQuantity)} free to use${waiting}.`);
  if (isQuantity(calc.totalProjectedShortageQuantity) && calc.totalProjectedShortageQuantity > 0) {
    lines.push(`That leaves you ${plainVials(calc.totalProjectedShortageQuantity)} short.`);
  } else if (Number.isSafeInteger(calc.remainingAfterHorizonQuantity)) {
    lines.push(`That leaves about ${plainVials(Math.max(0, calc.remainingAfterHorizonQuantity))} after ${days} days.`);
  }
  const reorder = isQuantity(calc.recommendedReorderQuantity) ? calc.recommendedReorderQuantity : isQuantity(doc.recommendedReorderQuantity) ? doc.recommendedReorderQuantity : null;
  if (reorder !== null) {
    lines.push(
      reorder > 0
        ? `To cover the next ${days} days, order ${plainVials(reorder)}.`
        : `No order is needed for the next ${days} days.`
    );
  }
  return lines;
}

/**
 * Why the season changed the estimate, in a sentence, or null when it did not.
 * Older forecasts (before seasons) have no seasonAdjustment and get null.
 */
export function plainSeasonLine(doc) {
  const season = doc?.seasonAdjustment;
  const pct = season?.percent;
  if (!season || season.source === "none" || !Number.isInteger(pct) || pct === 0) return null;
  const amount = `about ${Math.abs(pct)}% ${pct > 0 ? "more" : "less"}`;
  if (season.source === "last_year") {
    return `Last year these same weeks were ${pct > 0 ? "busier" : "quieter"} than the weeks before them, so ${amount} is expected than recent weeks suggest.`;
  }
  const months = monthList(season.busyMonths);
  return pct > 0
    ? `${months} ${season.busyMonths.length === 1 ? "is a busy month" : "are busy months"} for this vaccine, so ${amount} is expected than usual.`
    : `The busy months (${months}) are ending, so ${amount} is expected than in recent weeks.`;
}

/** The detailed figures, each with an everyday label. Unset figures show "—". */
export function plainFigures(doc) {
  const c = doc?.calculation ?? {};
  const days = Number.isInteger(doc?.horizonDays) ? doc.horizonDays : 30;
  const seasonal = doc?.seasonAdjustment && doc.seasonAdjustment.source !== "none" && doc.seasonAdjustment.percent !== 0;
  return [
    ...(seasonal ? [{ label: `Usual orders, next ${days} days, without the season`, value: formatQuantity(c.baseDemandQuantity) }] : []),
    { label: `Expected orders, next ${days} days`, value: formatQuantity(c.predictedDemandQuantity) },
    { label: "Vials free to use now", value: formatQuantity(c.availableQuantity) },
    { label: "Already ordered, waiting for stock", value: formatQuantity(c.backorderedQuantity) },
    { label: "Short now, for orders already placed", value: formatQuantity(c.currentBackorderShortageQuantity) },
    { label: `Short in the next ${days} days, if orders come as expected`, value: formatQuantity(c.forecastShortageQuantity) },
    { label: "Short in total", value: formatQuantity(c.totalProjectedShortageQuantity) },
    {
      label: `Left after ${days} days`,
      value: Number.isSafeInteger(c.remainingAfterHorizonQuantity) && c.remainingAfterHorizonQuantity < 0
        ? "0 (short)"
        : formatQuantity(c.remainingAfterHorizonQuantity),
    },
    { label: "About one week of orders", value: formatQuantity(c.oneWeekDemandQuantity) },
    { label: "Suggested order", value: formatQuantity(doc?.recommendedReorderQuantity) },
  ];
}

const PLAIN_DATA_NOTES = Object.freeze({
  missing_order_date: "orders without a date were left out",
  missing_product_id: "order lines without a vaccine were left out",
  ambiguous_product_sku: "order lines whose product code matched more than one vaccine were left out",
  allocation_may_be_pending: "orders waiting for stock may soon be filled from stock you already have, so this is not a shortage yet",
  unknown_sku: "order lines with an unknown product code were left out",
  invalid_quantity: "order lines with an unreadable number of vials were left out",
  cancelled_excluded: "cancelled orders are not counted",
  unrecognised_status: "orders with an unknown status were left out",
  order_without_lines: "orders with no vaccines listed were left out",
  inventory_quantity_inconsistency: "some stock records have figures that do not add up",
  batch_without_product: "some stock batches are not linked to a vaccine",
  insufficient_weekly_history: "there are fewer than 4 weeks of orders",
});

/** A data note in everyday words; an unknown code keeps the server's sentence. */
export function plainDataNote(note) {
  if (note?.code === "confidence_lowered") {
    const share = /^(\d+)%/.exec(String(note.message ?? ""))?.[1];
    return `${share ? `${share}% of order lines` : "Some order lines"} had no date or no vaccine and were left out, so this estimate is less sure.`;
  }
  const text = PLAIN_DATA_NOTES[note?.code];
  if (!text) return note?.message ?? "";
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return Number.isSafeInteger(note?.count) && note.count > 0 ? `${sentence} (${formatQuantity(note.count)}).` : `${sentence}.`;
}
