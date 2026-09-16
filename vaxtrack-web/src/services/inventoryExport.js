/**
 * Admin Inventory → Excel (.xlsx) export.
 *
 * This module has two layers, kept apart on purpose:
 *
 *   1. PURE transforms (no browser, no Firebase, no React). Given the same
 *      normalized inventory rows the Admin Inventory table already renders, they
 *      produce the workbook's column definitions and the per-cell values. Every
 *      one of them is unit-testable in plain Node.
 *
 *   2. A single BROWSER download function. It dynamically imports
 *      `write-excel-file/browser` only when a download is actually requested, so
 *      the spreadsheet library never enters the initial application bundle.
 *
 * The exporter reads ONLY business fields already shown on the page. It never
 * touches Firestore document ids, internal flags, or any hidden metadata, and
 * it invents nothing that is not implemented (no Manufacturing Date, no VAT
 * classification). Prices come from the authoritative integer-centavo snapshot,
 * converted to pesos for display; quantities and prices are written as real
 * numeric cells and dates as real spreadsheet dates, so the workbook can be
 * sorted and summed rather than merely read.
 *
 * The input row shape (as produced by Inventory.jsx's `normalizeInventoryItem`):
 *   {
 *     name: string,            // vaccine name, "—" when missing
 *     type: string,            // vaccine type, "—" when missing
 *     batch: string,           // batch id, "—" when missing
 *     expiryRaw: string,       // "YYYY-MM-DD" or "" — the source date
 *     onHandValue: number|null,    // quantity on hand, null when not a whole number
 *     reservedValue: number|null,  // reserved quantity, null when invalid
 *     availableValue: number|null, // on hand − reserved, null when either is invalid
 *     priceCentavos: number|null,  // authoritative unit price in centavos, null when unpriced
 *     temp: string,            // storage temperature display, "—" when missing
 *     status: string,          // derived expiry-condition label
 *   }
 */

/**
 * The exported columns, in order. This is the single source of truth for the
 * worksheet's shape, so headers, widths, cell types and the number/date formats
 * all stay in lock-step and can be asserted in one place.
 *
 * Each entry:
 *   key    — the property read from an export row (see `toInventoryExportRow`)
 *   header — the human column title (bold header row)
 *   kind   — "text" | "number" | "date" | "currency"; drives the cell type
 *   width  — column width in characters
 *   format — number/date format string (currency and date only)
 */
export const INVENTORY_EXPORT_COLUMN_DEFS = [
  { key: "name", header: "Vaccine name", kind: "text", width: 28 },
  { key: "type", header: "Vaccine type", kind: "text", width: 18 },
  { key: "batch", header: "Batch ID", kind: "text", width: 18 },
  {
    key: "expiry",
    header: "Expiry date",
    kind: "date",
    width: 14,
    format: "mmm d, yyyy",
  },
  { key: "onHand", header: "On hand", kind: "number", width: 10 },
  { key: "reserved", header: "Reserved", kind: "number", width: 10 },
  { key: "available", header: "Available", kind: "number", width: 10 },
  {
    key: "unitPricePesos",
    header: "Unit price (₱)",
    kind: "currency",
    width: 14,
    format: '"₱"#,##0.00',
  },
  { key: "temp", header: "Storage temp", kind: "text", width: 12 },
  { key: "status", header: "Status", kind: "text", width: 16 },
];

/** The worksheet name. */
export const INVENTORY_SHEET_NAME = "Inventory";

/** The header titles, in order — handy for tests and for a header-only guard. */
export const INVENTORY_EXPORT_HEADERS = INVENTORY_EXPORT_COLUMN_DEFS.map(
  (c) => c.header
);

/**
 * Turn any of the date shapes the data layer might hold into a real `Date`, or
 * `null` when there is nothing usable. Handles: a date-only "YYYY-MM-DD" string
 * (the shape Inventory actually stores), a full ISO string, a `Date`, a
 * Firestore `Timestamp` (either the SDK object with `.toDate()` or a plain
 * `{ seconds }` shape), and every empty/placeholder/garbage value.
 *
 * A date-only string is anchored to UTC midnight so the calendar day shown in
 * the spreadsheet is the day that was stored, regardless of the viewer's time
 * zone.
 */
export function coerceExportDate(value) {
  if (value === null || value === undefined) return null;

  // Firestore Timestamp (SDK instance).
  if (typeof value === "object" && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }

  // Plain Timestamp-like object: { seconds, nanoseconds? }.
  if (typeof value === "object" && typeof value.seconds === "number") {
    const d = new Date(value.seconds * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // A real Date.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "—") return null;

    // Date-only "YYYY-MM-DD": build the exact calendar day in UTC.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
      const [, y, m, d] = dateOnly;
      const year = Number(y);
      const month = Number(m);
      const day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const built = new Date(Date.UTC(year, month - 1, day));
      // Reject roll-overs like 2026-02-31 → Mar 3.
      if (
        built.getUTCFullYear() !== year ||
        built.getUTCMonth() !== month - 1 ||
        built.getUTCDate() !== day
      ) {
        return null;
      }
      return built;
    }

    // Any other string: last-resort parse, but only trust a real result.
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

/** A finite number, or `null`. Keeps `NaN`/`Infinity`/text out of the sheet. */
function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Clean a display string for a text cell: nullish and the "—" placeholder both
 * become an empty cell rather than a literal dash in the spreadsheet.
 */
function cleanText(value) {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  return s === "—" ? "" : s;
}

/**
 * Map one normalized inventory row to the plain value object the workbook
 * columns read from. Numbers stay numbers, the date becomes a `Date` (or null),
 * price is converted from authoritative centavos to pesos (or null when the
 * batch is unpriced — never 0, which would read as a real price).
 */
export function toInventoryExportRow(item) {
  const priceCentavos = finiteNumberOrNull(item?.priceCentavos);
  return {
    name: cleanText(item?.name),
    type: cleanText(item?.type),
    batch: cleanText(item?.batch),
    expiry: coerceExportDate(item?.expiryRaw),
    onHand: finiteNumberOrNull(item?.onHandValue),
    reserved: finiteNumberOrNull(item?.reservedValue),
    available: finiteNumberOrNull(item?.availableValue),
    unitPricePesos: priceCentavos === null ? null : priceCentavos / 100,
    temp: cleanText(item?.temp),
    status: cleanText(item?.status),
  };
}

/**
 * Map the on-screen rows to export rows, PRESERVING ORDER. The caller passes the
 * already-filtered, already-ordered list, so the workbook mirrors exactly what
 * the admin is looking at.
 */
export function buildInventoryExportRows(items) {
  if (!Array.isArray(items)) return [];
  return items.map(toInventoryExportRow);
}

/**
 * Build a single write-excel-file column definition (objects API) from one of
 * `INVENTORY_EXPORT_COLUMN_DEFS`.
 *
 * Text cells are explicitly typed as `String`, which is what makes a value that
 * begins with `=`, `+`, `-` or `@` a harmless string rather than a live
 * spreadsheet formula. Empty numeric/date/currency values become a bare `null`
 * (an empty cell) instead of a typed zero.
 */
function toWorkbookColumn(def) {
  const header = { value: def.header, fontWeight: "bold", align: "left" };

  let cell;
  switch (def.kind) {
    case "number":
      cell = (row) => {
        const v = finiteNumberOrNull(row[def.key]);
        return v === null ? null : { type: Number, value: v };
      };
      break;
    case "currency":
      cell = (row) => {
        const v = finiteNumberOrNull(row[def.key]);
        return v === null ? null : { type: Number, value: v, format: def.format };
      };
      break;
    case "date":
      cell = (row) => {
        const v = row[def.key];
        return v instanceof Date && !Number.isNaN(v.getTime())
          ? { type: Date, value: v, format: def.format }
          : null;
      };
      break;
    case "text":
    default:
      cell = (row) => ({ type: String, value: cleanText(row[def.key]) });
      break;
  }

  return { width: def.width, header, cell };
}

/**
 * The full column set for `write-excel-file`'s objects API. Pure: it captures no
 * document and touches no browser global, so a test can call each `cell()` and
 * assert the type/format it produces.
 */
export function buildInventoryExportColumns() {
  return INVENTORY_EXPORT_COLUMN_DEFS.map(toWorkbookColumn);
}

/** Zero-padded local date part, for the filename. */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * `VaxTrack_Inventory_YYYY-MM-DD.xlsx`, dated in Asia/Manila to match the rest
 * of the app's date handling. Falls back to the host's own calendar day only if
 * the Intl time-zone lookup is unavailable.
 */
export function inventoryExportFileName(date = new Date()) {
  const base = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  let ymd;
  try {
    // en-CA renders as YYYY-MM-DD.
    ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(base);
  } catch {
    ymd = `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
  }
  return `VaxTrack_Inventory_${ymd}.xlsx`;
}

/** Raised when there is nothing to export, so no misleading empty file is made. */
export class EmptyInventoryExportError extends Error {
  constructor(message = "There are no inventory rows to export.") {
    super(message);
    this.name = "EmptyInventoryExportError";
  }
}

/**
 * Generate and download the inventory workbook in the browser.
 *
 * @param {Array} items  the page's current filtered, ordered rows.
 * @param {object} [opts]
 * @param {Date}   [opts.now]        clock for the filename (injectable for tests).
 * @param {Function} [opts.writeXlsxFile]  the writer, injectable for tests; when
 *        omitted, `write-excel-file/browser` is imported lazily so it stays out
 *        of the initial bundle.
 * @returns {Promise<{ fileName: string, rowCount: number }>}
 * @throws {EmptyInventoryExportError} when there are no rows.
 */
export async function downloadInventoryWorkbook(items, opts = {}) {
  const rows = buildInventoryExportRows(items);
  if (rows.length === 0) {
    throw new EmptyInventoryExportError();
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const fileName = inventoryExportFileName(now);
  const columns = buildInventoryExportColumns();

  const writeXlsxFile =
    opts.writeXlsxFile ??
    (await import("write-excel-file/browser")).default;

  await writeXlsxFile(rows, {
    columns,
    sheet: INVENTORY_SHEET_NAME,
    // Freeze the header row so it stays visible while scrolling.
    stickyRowsCount: 1,
  }).toFile(fileName);

  return { fileName, rowCount: rows.length };
}
