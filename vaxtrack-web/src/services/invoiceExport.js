import { coerceExportDate } from "./inventoryExport.js";
import { invoiceLineAmount, invoiceLotText, isFinalChargedLine } from "./invoiceModel.js";

// The A:K invoice area of the client's INVOICE_ sheet. The pricing checks
// beside it refer to another workbook and are outside the invoice area.
const COLUMN_WIDTHS = [3.57, 6, 14.57, 14.57, 10.71, 5.71, 6.43, 6.29, 4.57, 10.43, 12.86];
const STANDARD_ITEM_ROWS = 9;
const RED = "#FF0000";
const MONEY_FORMAT = "#,##0.00";

function row(height, cells = {}) {
  const result = COLUMN_WIDTHS.map(() => null);
  for (const [column, entry] of Object.entries(cells)) {
    const cell = typeof entry === "object" && entry !== null ? entry : { value: entry };
    result[column.charCodeAt(0) - 65] = { height, ...cell };
  }
  if (!Object.keys(cells).length) result[0] = { height, value: "" };
  return result;
}

function numeric(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value, style = {}) {
  return { value: numeric(value), format: MONEY_FORMAT, align: "right", ...style };
}

function itemRow(item) {
  if (!item) return row(13.5);
  const expiry = item.expiry || "";
  // The lots actually reserved/delivered when the server recorded them; the
  // Batch ID otherwise. Same cell (E, 3 columns, wrapping) as always.
  const lot = invoiceLotText(item);
  const unitPrice = isFinalChargedLine(item) && item.unitPriceCentavos == null ? null : item.unitPrice;
  return row(24, {
    B: { value: item.itemDescription || "", columnSpan: 2, fontWeight: "bold", wrap: true },
    D: { value: expiry && (/^exp\s*:/i.test(expiry) ? expiry : `Exp: ${expiry}`), wrap: true },
    E: { value: lot && (/^(?:LN|LOT)\s*:/i.test(lot) ? lot : `LN: ${lot}`), columnSpan: 3, wrap: true },
    H: { value: numeric(item.quantity), align: "center" },
    J: money(unitPrice),
    K: money(invoiceLineAmount(item)),
  });
}

/** Use the same draft or locked amounts the editor is displaying. */
export function buildInvoiceWorksheet({ form, totals, invoiceNumber }) {
  const items = form.items;
  const date = coerceExportDate(form.invoiceDate);
  const header = { color: RED, fontWeight: "bold" };
  const bold = { fontWeight: "bold" };
  const italic = { fontStyle: "italic" };
  const centeredAmount = { columnSpan: 2, ...italic };
  const rows = [
    row(18),
    row(11.25),
    row(21),
    row(11.25),
    row(13.5),
    row(15.75, {
      C: { value: form.registeredName, columnSpan: 7, fontSize: 14, ...bold },
      K: { value: invoiceNumber || "", ...header },
    }),
    row(20, {
      C: { value: form.customerAddress, columnSpan: 7, wrap: true, ...bold },
      K: { value: date, format: "d-mmm-yy", align: "left", ...header },
    }),
    row(16.5, { A: { value: "SHIP TO:", columnSpan: 2, ...header } }),
    row(18, {
      C: { value: form.shipTo, columnSpan: 3, wrap: true, ...bold },
      F: { value: form.customerCode, columnSpan: 3, ...header },
      K: { value: form.paymentTerms, wrap: true, ...header },
    }),
    row(18, {
      C: { value: form.customerTin, columnSpan: 3 },
      F: { value: form.customerContact, columnSpan: 3, ...header },
      K: { value: form.salesRepCode, ...header },
    }),
    row(10.5),
    row(13.5),
    ...Array.from({ length: Math.max(STANDARD_ITEM_ROWS, items.length) }, (_, index) => itemRow(items[index])),
    row(13.5),
    row(13.5),
    row(22.5),
    row(18.75, { H: { value: items.reduce((sum, item) => sum + (numeric(item.quantity) ?? 0), 0), align: "center" } }),
    row(18, { K: money(totals.totalSalesVatInclusive, bold) }),
    row(13.5, { H: money(totals.vatableSales, { columnSpan: 2, ...bold }), K: money(totals.vatAmount, italic) }),
    row(13.5, { H: money(totals.vatExemptSales + totals.zeroRatedSales, centeredAmount), K: money(totals.net, italic) }),
    row(9),
    row(12),
    row(10.5, { H: money(totals.net, { columnSpan: 2, ...bold }) }),
    row(16, { H: money(totals.vatAmount, centeredAmount), K: money(totals.totalAmountDue, { ...bold, fontSize: 13 }) }),
  ];

  return rows;
}

export async function downloadInvoiceWorkbook(invoice, writeXlsxFile) {
  const writer = writeXlsxFile ?? (await import("write-excel-file/browser")).default;
  const name = (invoice.invoiceNumber || "Sales-Invoice").replace(/[^a-z\d_-]/gi, "-");
  const fileName = `${name}${invoice.issued ? "" : "-Draft"}.xlsx`;
  await writer(buildInvoiceWorksheet(invoice), {
    sheet: "INVOICE_",
    columns: COLUMN_WIDTHS.map((width) => ({ width })),
    orientation: "portrait",
    fontFamily: "Arial",
    fontSize: 10,
  }).toFile(fileName);
  return fileName;
}
