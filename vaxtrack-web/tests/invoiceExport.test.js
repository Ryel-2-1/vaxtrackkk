import assert from "node:assert/strict";
import test from "node:test";
import writeExcelFile from "write-excel-file/node";
import { buildInvoiceWorksheet, downloadInvoiceWorkbook } from "../src/services/invoiceExport.js";
import { computeInvoiceTotals } from "../src/services/invoiceModel.js";

const item = { itemDescription: "Sample vaccine", expiry: "05.2027", batchId: "LOT-01", quantity: 1, unitPrice: 2320 };
const form = { registeredName: "Sample Clinic", invoiceDate: "2026-11-21", customerCode: "00021", items: [item] };
const totals = computeInvoiceTotals({ items: form.items, priceIsVatInclusive: true });

test("the Admin export maps typed values to the INVOICE_ template and leaves the time cell blank", () => {
  const rows = buildInvoiceWorksheet({ form, totals, invoiceNumber: "INV-2026-000021" });
  const cell = (column, row) => rows[row - 1][column.charCodeAt(0) - 65]?.value;
  assert.equal(rows.length, 32);
  assert.equal(cell("C", 6), "Sample Clinic");
  assert.equal(cell("K", 6), "INV-2026-000021");
  assert.equal(cell("K", 7).toISOString(), "2026-11-21T00:00:00.000Z");
  assert.equal(cell("K", 8), undefined);
  assert.equal(cell("F", 9), "00021");
  assert.equal(cell("B", 13), "Sample vaccine");
  assert.equal(cell("D", 13), "Exp: 05.2027");
  assert.equal(cell("E", 13), "LN: LOT-01");
  assert.equal(cell("H", 13), 1);
  assert.equal(cell("J", 13), 2320);
  assert.equal(cell("K", 13), 2320);
  assert.equal(cell("H", 25), 1);
  assert.equal(cell("K", 26), 2320);
  assert.equal(cell("H", 27), 2071.43);
  assert.equal(cell("K", 27), 248.57);
  assert.equal(cell("K", 32), 2320);
});

test("long invoices expand without clipping and retain exact charged line amounts and locked totals", () => {
  const charged = { ...item, quantity: 3, amountIsFinalCharged: true, unitPrice: null, unitPriceCentavos: null, lineTotalCentavos: 10000 };
  const longForm = { ...form, items: [...Array(9).fill(item), charged] };
  const storedTotals = { ...totals, totalAmountDue: 1234.56 };
  const rows = buildInvoiceWorksheet({ form: longForm, totals: storedTotals });
  assert.equal(rows.length, 33);
  assert.equal(rows[21][9].value, null);
  assert.equal(rows[21][10].value, 100);
  assert.equal(rows[25][7].value, 12);
  assert.equal(rows.at(-1)[10].value, 1234.56);
});

test("the export writes an XLSX workbook with the invoice sheet and draft filename", async () => {
  let file;
  const fileName = await downloadInvoiceWorkbook({ form, totals, issued: false }, (rows, options) => ({
    async toFile(name) {
      assert.equal(name, "Sales-Invoice-Draft.xlsx");
      assert.equal(options.sheet, "INVOICE_");
      assert.equal(options.columns.length, 11);
      file = await writeExcelFile(rows, options).toBuffer();
    },
  }));
  assert.equal(fileName, "Sales-Invoice-Draft.xlsx");
  assert.equal(file.subarray(0, 2).toString(), "PK");
});
