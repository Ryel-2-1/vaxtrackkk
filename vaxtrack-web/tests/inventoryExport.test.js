import test from "node:test";
import assert from "node:assert/strict";

import {
  INVENTORY_EXPORT_COLUMN_DEFS,
  INVENTORY_EXPORT_HEADERS,
  INVENTORY_SHEET_NAME,
  coerceExportDate,
  toInventoryExportRow,
  buildInventoryExportRows,
  buildInventoryExportColumns,
  inventoryExportFileName,
  downloadInventoryWorkbook,
  EmptyInventoryExportError,
} from "../src/services/inventoryExport.js";

// A complete, healthy row in the shape Inventory.jsx's normalizeInventoryItem
// produces. `expiryRaw` is the stored "YYYY-MM-DD"; prices are centavos.
function completeItem(overrides = {}) {
  return {
    id: "doc-abc",
    name: "Pfizer-BioNTech",
    type: "mRNA",
    batch: "PFZ-2026-01",
    expiryRaw: "2026-12-31",
    onHandValue: 1200,
    reservedValue: 200,
    availableValue: 1000,
    priceCentavos: 125050,
    temp: "2–8°C",
    status: "In date",
    // fields the exporter must NEVER read:
    level: "stable",
    flags: ["No reserved field yet"],
    ...overrides,
  };
}

test("column headers and order are fixed and in sync with the columns", () => {
  assert.deepEqual(INVENTORY_EXPORT_HEADERS, [
    "Vaccine name",
    "Vaccine type",
    "Batch ID",
    "Expiry date",
    "On hand",
    "Reserved",
    "Available",
    "Unit price (₱)",
    "Storage temp",
    "Status",
  ]);

  const columns = buildInventoryExportColumns();
  assert.equal(columns.length, INVENTORY_EXPORT_COLUMN_DEFS.length);
  assert.deepEqual(
    columns.map((c) => c.header.value),
    INVENTORY_EXPORT_HEADERS
  );
  // Header row is bold.
  for (const c of columns) {
    assert.equal(c.header.fontWeight, "bold");
    assert.equal(typeof c.width, "number");
  }
});

test("a complete row maps every business field, and nothing else", () => {
  const row = toInventoryExportRow(completeItem());
  assert.equal(row.name, "Pfizer-BioNTech");
  assert.equal(row.type, "mRNA");
  assert.equal(row.batch, "PFZ-2026-01");
  assert.ok(row.expiry instanceof Date);
  assert.equal(row.onHand, 1200);
  assert.equal(row.reserved, 200);
  assert.equal(row.available, 1000);
  assert.equal(row.unitPricePesos, 1250.5);
  assert.equal(row.temp, "2–8°C");
  assert.equal(row.status, "In date");

  // No id / level / flags leak into the export row.
  assert.deepEqual(Object.keys(row).sort(), [
    "available",
    "batch",
    "expiry",
    "name",
    "onHand",
    "reserved",
    "status",
    "temp",
    "type",
    "unitPricePesos",
  ]);
});

test("missing optional fields degrade to empty text / null numbers, not zeros", () => {
  const row = toInventoryExportRow({
    name: "Solo vaccine",
    // type, batch, temp, status, expiryRaw absent
    onHandValue: null,
    reservedValue: null,
    availableValue: null,
    priceCentavos: null,
  });
  assert.equal(row.name, "Solo vaccine");
  assert.equal(row.type, "");
  assert.equal(row.batch, "");
  assert.equal(row.temp, "");
  assert.equal(row.status, "");
  assert.equal(row.expiry, null);
  assert.equal(row.onHand, null);
  assert.equal(row.reserved, null);
  assert.equal(row.available, null);
  // Unpriced is null, NOT 0 — 0 would read as a real price.
  assert.equal(row.unitPricePesos, null);

  // The "—" placeholder the table uses collapses to an empty cell.
  const dashed = toInventoryExportRow({ name: "—", type: "—", temp: "—" });
  assert.equal(dashed.name, "");
  assert.equal(dashed.type, "");
  assert.equal(dashed.temp, "");
});

test("quantities are written as numeric cells, empties as blank cells", () => {
  const columns = buildInventoryExportColumns();
  const onHand = columns[4];
  const reserved = columns[5];
  const available = columns[6];
  const row = toInventoryExportRow(completeItem());

  assert.deepEqual(onHand.cell(row), { type: Number, value: 1200 });
  assert.deepEqual(reserved.cell(row), { type: Number, value: 200 });
  assert.deepEqual(available.cell(row), { type: Number, value: 1000 });
  assert.equal(onHand.cell.constructor, Function);

  const emptyRow = toInventoryExportRow({ onHandValue: null });
  assert.equal(onHand.cell(emptyRow), null);
});

test("price stays numeric, comes from centavos, and carries peso formatting", () => {
  const priceCol = buildInventoryExportColumns()[7];
  assert.equal(priceCol.header.value, "Unit price (₱)");

  // 125050 centavos -> 1250.50 pesos, numeric with a peso number format.
  const cell = priceCol.cell(toInventoryExportRow(completeItem()));
  assert.equal(cell.type, Number);
  assert.equal(cell.value, 1250.5);
  assert.equal(cell.format, '"₱"#,##0.00');

  // A whole-peso and a sub-peso figure both stay exact.
  assert.equal(toInventoryExportRow({ priceCentavos: 50000 }).unitPricePesos, 500);
  assert.equal(toInventoryExportRow({ priceCentavos: 199 }).unitPricePesos, 1.99);

  // Unpriced -> blank cell, not 0.
  assert.equal(priceCol.cell(toInventoryExportRow({ priceCentavos: null })), null);
});

test("valid dates convert to real Dates from every supported shape", () => {
  // Date-only "YYYY-MM-DD" -> exact UTC calendar day.
  const d = coerceExportDate("2026-12-31");
  assert.ok(d instanceof Date);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 11);
  assert.equal(d.getUTCDate(), 31);

  // A real Date passes through unchanged.
  const now = new Date("2026-01-15T09:30:00Z");
  assert.equal(coerceExportDate(now).getTime(), now.getTime());

  // Firestore Timestamp — SDK instance (.toDate()).
  const viaToDate = coerceExportDate({ toDate: () => new Date("2026-06-01T00:00:00Z") });
  assert.equal(viaToDate.getUTCMonth(), 5);
  assert.equal(viaToDate.getUTCDate(), 1);

  // Firestore Timestamp — plain { seconds } shape.
  const seconds = Math.floor(Date.UTC(2026, 5, 1) / 1000);
  const viaSeconds = coerceExportDate({ seconds });
  assert.equal(viaSeconds.getTime(), seconds * 1000);

  // Full ISO string.
  const iso = coerceExportDate("2026-03-10T12:00:00Z");
  assert.equal(iso.getUTCFullYear(), 2026);
  assert.equal(iso.getUTCMonth(), 2);

  // In a date column this becomes a typed Date cell.
  const expiryCol = buildInventoryExportColumns()[3];
  const cell = expiryCol.cell(toInventoryExportRow(completeItem()));
  assert.equal(cell.type, Date);
  assert.equal(cell.format, "mmm d, yyyy");
  assert.ok(cell.value instanceof Date);
});

test("invalid or missing dates yield null and never throw", () => {
  for (const bad of [
    "",
    "   ",
    "—",
    null,
    undefined,
    "not-a-date",
    "2026-02-31", // rolls over -> rejected
    "2026-13-01", // impossible month
    {},
    { toDate: () => new Date("nope") },
    NaN,
    new Date("invalid"),
  ]) {
    assert.equal(coerceExportDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }

  // The date column renders a blank cell rather than crashing.
  const expiryCol = buildInventoryExportColumns()[3];
  assert.equal(expiryCol.cell(toInventoryExportRow({ expiryRaw: "" })), null);
});

test("text cells stay text so leading =, +, -, @ cannot become formulas", () => {
  const columns = buildInventoryExportColumns();
  const nameCol = columns[0];

  for (const dangerous of ["=SUM(A1:A9)", "+1+2", "-1", "@rce", "=cmd|'/c calc'!A1"]) {
    const cell = nameCol.cell(toInventoryExportRow({ name: dangerous }));
    assert.equal(cell.type, String, "must be an explicit String cell");
    assert.equal(cell.value, dangerous, "value must be preserved verbatim as text");
  }

  // Every text column is typed String.
  const textCols = INVENTORY_EXPORT_COLUMN_DEFS
    .map((def, i) => ({ def, i }))
    .filter(({ def }) => def.kind === "text");
  const sample = toInventoryExportRow(completeItem());
  for (const { i } of textCols) {
    assert.equal(columns[i].cell(sample).type, String);
  }
});

test("row order is preserved end to end", () => {
  const items = [
    completeItem({ name: "AAA", batch: "B1" }),
    completeItem({ name: "BBB", batch: "B2" }),
    completeItem({ name: "CCC", batch: "B3" }),
  ];
  const rows = buildInventoryExportRows(items);
  assert.deepEqual(rows.map((r) => r.name), ["AAA", "BBB", "CCC"]);
  assert.deepEqual(rows.map((r) => r.batch), ["B1", "B2", "B3"]);
});

test("empty / non-array input produces no rows and no workbook", async () => {
  assert.deepEqual(buildInventoryExportRows([]), []);
  assert.deepEqual(buildInventoryExportRows(null), []);
  assert.deepEqual(buildInventoryExportRows(undefined), []);

  await assert.rejects(
    () => downloadInventoryWorkbook([]),
    (err) => err instanceof EmptyInventoryExportError
  );
});

test("filename is VaxTrack_Inventory_YYYY-MM-DD.xlsx, dated in Manila", () => {
  assert.match(
    inventoryExportFileName(),
    /^VaxTrack_Inventory_\d{4}-\d{2}-\d{2}\.xlsx$/
  );

  // 20:00 UTC is 04:00 the next day in Manila (UTC+8): the Manila calendar day wins.
  assert.equal(
    inventoryExportFileName(new Date("2026-09-16T20:00:00Z")),
    "VaxTrack_Inventory_2026-09-17.xlsx"
  );
  // 02:00 UTC is 10:00 the same day in Manila.
  assert.equal(
    inventoryExportFileName(new Date("2026-09-16T02:00:00Z")),
    "VaxTrack_Inventory_2026-09-16.xlsx"
  );
});

test("the download adapter is separate from the pure transforms", async () => {
  // A fake writer captures what the browser adapter would hand write-excel-file,
  // proving the transforms build the payload and the adapter only wires it up.
  let captured = null;
  const fakeWriter = (rows, options) => {
    captured = { rows, options };
    return { toFile: async (fileName) => { captured.fileName = fileName; } };
  };

  const result = await downloadInventoryWorkbook([completeItem({ name: "Only" })], {
    now: new Date("2026-09-16T02:00:00Z"),
    writeXlsxFile: fakeWriter,
  });

  assert.deepEqual(result, {
    fileName: "VaxTrack_Inventory_2026-09-16.xlsx",
    rowCount: 1,
  });
  assert.equal(captured.rows.length, 1);
  assert.equal(captured.rows[0].name, "Only");
  assert.equal(captured.options.sheet, INVENTORY_SHEET_NAME);
  assert.equal(captured.options.stickyRowsCount, 1);
  assert.equal(captured.options.columns.length, INVENTORY_EXPORT_HEADERS.length);
  assert.equal(captured.fileName, "VaxTrack_Inventory_2026-09-16.xlsx");
});

test("smoke: the real write-excel-file/node engine produces a valid .xlsx buffer", async () => {
  // Uses the package's Node entry point and the SAME rows/columns the browser
  // path builds. Produces a Buffer only — nothing is written to disk, so no
  // generated workbook can be committed.
  const { default: writeXlsxFile } = await import("write-excel-file/node");
  const rows = buildInventoryExportRows([
    completeItem(),
    completeItem({ name: "=inject", priceCentavos: null, expiryRaw: "" }),
  ]);
  const columns = buildInventoryExportColumns();

  const buffer = await writeXlsxFile(rows, {
    columns,
    sheet: INVENTORY_SHEET_NAME,
    stickyRowsCount: 1,
  }).toBuffer();

  // A Node Buffer is a Uint8Array subclass; assert on that to stay within the
  // tests' browser-globals lint config.
  assert.ok(buffer instanceof Uint8Array);
  assert.ok(buffer.length > 0);
  // .xlsx is a ZIP: the local file header signature is PK\x03\x04.
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});
