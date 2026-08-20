// Pure, dependency-free invoice logic (no Firebase, no React) — the single
// source of truth for VAT totals, the editor's initial form, the Firestore
// serializer, and the read-only stored-totals normalizer.
//
// Kept free of imports so it can be unit-tested directly under `node --test`.
// invoiceService.js re-exports the VAT helpers; InvoiceEditor.jsx imports the
// rest. Behaviour is identical to the Phase 5B/5C editor code it replaced.

export const COMPANY_NAME = "3MGS PHARMA INC.";

// ---- VAT (Philippine sales invoice, VAT-EXCLUSIVE) ----
// Prices are net of VAT; 12% VAT is added on top of the VATable base only.
export const VAT_STANDARD_RATE = 12;
export const VAT_CLASSIFICATIONS = ["vatable", "vat_exempt", "zero_rated"];

export function vatClassificationLabel(classification) {
  switch (classification) {
    case "vatable":
      return "VATable (12%)";
    case "vat_exempt":
      return "VAT-Exempt";
    case "zero_rated":
      return "Zero-Rated";
    default:
      return "";
  }
}

/**
 * VAT-EXCLUSIVE invoice totals. Line amounts (and the subtotal) are net of VAT;
 * `net = max(0, subtotal - discount)` falls entirely into the selected
 * classification bucket, and 12% VAT is added on top for VATable sales only.
 * Single source of truth shared by the editor and any exporter.
 */
export function computeVatExclusiveTotals({
  items = [],
  discount = 0,
  otherCharges = 0,
  withholdingTax = 0,
  vatClassification = "vatable",
} = {}) {
  const lines = items.map(
    (it) => (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)
  );
  const subtotal = lines.reduce((a, b) => a + b, 0);
  const disc = Number(discount) || 0;
  const other = Number(otherCharges) || 0;
  const wht = Number(withholdingTax) || 0;
  const net = Math.max(0, subtotal - disc);

  const cls = VAT_CLASSIFICATIONS.includes(vatClassification)
    ? vatClassification
    : "vatable";
  const vatRate = cls === "vatable" ? VAT_STANDARD_RATE : 0;
  const vatableSales = cls === "vatable" ? net : 0;
  const vatExemptSales = cls === "vat_exempt" ? net : 0;
  const zeroRatedSales = cls === "zero_rated" ? net : 0;
  const vatAmount = vatableSales * (vatRate / 100);

  // grandTotal is the Phase 5B value (net + VAT + other) — UNCHANGED so issued
  // invoices, the CSV export, and the verified 800/96/896 case are untouched.
  const grandTotal = net + vatAmount + other;
  // Client-template presentation values. Withholding tax is the only additional
  // deduction (discount is already inside `net`); it defaults to 0 so every
  // pre-existing case yields totalAmountDue === grandTotal.
  const totalSalesVatInclusive = net + vatAmount;
  const totalAmountDue = grandTotal - wht;

  return {
    lines,
    subtotal,
    discount: disc,
    otherCharges: other,
    withholdingTax: wht,
    net,
    vatClassification: cls,
    vatRate,
    vatableSales,
    vatExemptSales,
    zeroRatedSales,
    vatAmount,
    grandTotal,
    totalSalesVatInclusive,
    totalAmountDue,
  };
}

// ---- Editor helpers (moved verbatim from InvoiceEditor.jsx) ----

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// The order's "Date Order" (order.createdAt), shown read-only on the invoice.
export function formatOrderDate(ts) {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

let itemKeySeed = 0;
export function nextKey() {
  itemKeySeed += 1;
  return `it-${itemKeySeed}`;
}

export function itemsFromOrder(order) {
  if (Array.isArray(order?.items) && order.items.length > 0) {
    return order.items.map((it) => ({
      key: nextKey(),
      orderItemId: it.id || null,
      inventoryId: it.inventoryId || null,
      itemDescription: it.name || it.itemDescription || "",
      vaccineName: it.name || it.vaccineName || "",
      batchId: it.batchId || it.sku || "",
      // Expiry only from genuine order data — never invented.
      expiry: it.expiry || it.expiryDate || "",
      quantity: Number(it.quantity) || 0,
      unit: it.unit || order.unit || "vials",
      unitPrice: Number(it.unitPrice) || 0,
    }));
  }
  return [
    {
      key: nextKey(),
      orderItemId: null,
      inventoryId: null,
      itemDescription: order?.vaccineName || "",
      vaccineName: order?.vaccineName || "",
      batchId: order?.batchId || "",
      expiry: order?.expiry || order?.expiryDate || "",
      quantity: Number(order?.quantity) || 0,
      unit: order?.unit || "vials",
      unitPrice: 0,
    },
  ];
}

export function buildInitialForm(order, invoice, salesRepName) {
  const base = {
    invoiceDate: todayISO(),
    saleType: "",
    companyName: COMPANY_NAME,
    companyAddress: "",
    companyContact: "",
    companyTin: "",
    // Registered Name / Business Address prefill from the order's clinic (real
    // data). All other client identity fields stay blank until keyed.
    customerName: order?.clinicName || "",
    registeredName: order?.clinicName || "",
    customerAddress: order?.clinicAddress || "",
    customerContact: "",
    customerTin: "",
    customerCode: "",
    shipTo: "",
    salesRepName: salesRepName || order?.createdByEmail || "",
    salesRepCode: "",
    purchaseOrderNumber: "",
    referenceNumber: "",
    vaccinesTemp: "",
    items: itemsFromOrder(order),
    discount: 0,
    vatClassification: "vatable",
    otherCharges: 0,
    withholdingTax: 0,
    paymentTerms: "",
    deliveryTerms: "",
    notes: "",
    remarks: "",
    // Template signatory / handling fields — blank editable lines.
    processedBy: "",
    packedBy: "",
    deliveredBy: "",
    preparedBy: "",
    checkedBy: "",
    approvedBy: "",
    receivedBy: "",
    authorizedRepresentative: "",
    customerAcknowledgment: "",
    soloParentId: "",
    // Legal / printer footer — never pre-filled from the template photo; the
    // client enters their own confirmed BIR/printer identifiers.
    bookletInfo: "",
    atpNumber: "",
    atpDate: "",
    printerBlock: "",
    accreditationNo: "",
    accreditationDates: "",
  };

  if (!invoice) return base;

  return {
    ...base,
    invoiceDate: invoice.invoiceDate || base.invoiceDate,
    saleType: invoice.saleType || "",
    companyName: invoice.companyName || COMPANY_NAME,
    companyAddress: invoice.companyAddress ?? "",
    companyContact: invoice.companyContact ?? "",
    companyTin: invoice.companyTin ?? "",
    customerName: invoice.customerName ?? base.customerName,
    registeredName: invoice.registeredName ?? base.registeredName,
    customerAddress: invoice.customerAddress ?? base.customerAddress,
    customerContact: invoice.customerContact ?? "",
    customerTin: invoice.customerTin ?? "",
    customerCode: invoice.customerCode ?? "",
    shipTo: invoice.shipTo ?? "",
    salesRepName: invoice.salesRepName ?? base.salesRepName,
    salesRepCode: invoice.salesRepCode ?? "",
    purchaseOrderNumber: invoice.purchaseOrderNumber ?? "",
    referenceNumber: invoice.referenceNumber ?? "",
    vaccinesTemp: invoice.vaccinesTemp ?? "",
    items:
      Array.isArray(invoice.items) && invoice.items.length > 0
        ? invoice.items.map((it) => ({ key: nextKey(), ...it }))
        : base.items,
    discount: invoice.discount ?? 0,
    // New invoices carry vatClassification. Legacy drafts only had a numeric
    // taxRate: map >=12% to VATable, anything else to VAT-Exempt (0% VAT).
    vatClassification:
      invoice.vatClassification ??
      (Number(invoice.taxRate) >= 12 ? "vatable" : "vat_exempt"),
    otherCharges: invoice.otherCharges ?? 0,
    withholdingTax: invoice.withholdingTax ?? 0,
    paymentTerms: invoice.paymentTerms ?? "",
    deliveryTerms: invoice.deliveryTerms ?? "",
    notes: invoice.notes ?? "",
    remarks: invoice.remarks ?? "",
    processedBy: invoice.processedBy ?? "",
    packedBy: invoice.packedBy ?? "",
    deliveredBy: invoice.deliveredBy ?? "",
    preparedBy: invoice.preparedBy ?? "",
    checkedBy: invoice.checkedBy ?? "",
    approvedBy: invoice.approvedBy ?? "",
    receivedBy: invoice.receivedBy ?? "",
    authorizedRepresentative: invoice.authorizedRepresentative ?? "",
    customerAcknowledgment: invoice.customerAcknowledgment ?? "",
    soloParentId: invoice.soloParentId ?? "",
    bookletInfo: invoice.bookletInfo ?? "",
    atpNumber: invoice.atpNumber ?? "",
    atpDate: invoice.atpDate ?? "",
    printerBlock: invoice.printerBlock ?? "",
    accreditationNo: invoice.accreditationNo ?? "",
    accreditationDates: invoice.accreditationDates ?? "",
  };
}

/** Whether an invoice document is locked (issued, read-only). */
export function isIssued(invoice) {
  return invoice?.invoiceStatus === "issued";
}

/**
 * Validate that a serialized invoice's stored `subtotal` matches the sum of its
 * line items (quantity x unitPrice) and that `grandTotal` is a finite, non-
 * negative number. Model-agnostic (holds for legacy and Phase 5C invoices,
 * whose subtotal has always been the line-item sum). Throws on inconsistency so
 * the persistence layer never writes tampered/malformed totals. Pure — no I/O.
 */
export function assertConsistentInvoiceTotals(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const sum = items.reduce(
    (acc, it) => acc + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
    0
  );
  if (Math.abs((Number(data?.subtotal) || 0) - sum) > 0.01) {
    throw new Error("Invoice subtotal does not match its line items.");
  }
  if (!(Number(data?.grandTotal) >= 0)) {
    throw new Error("Invoice total is not valid.");
  }
}

/**
 * Build the Firestore invoice document from the current order + form. Pure: it
 * derives totals internally (VAT-exclusive) and NEVER emits an invoiceNumber,
 * createdAt, or create-audit fields — those are owned by the service so the
 * reserved INV-YYYY-###### number and creation trail are preserved on update.
 */
export function serializeInvoiceDoc({ orderId, order, form }) {
  const t = computeVatExclusiveTotals({
    items: form.items,
    discount: form.discount,
    otherCharges: form.otherCharges,
    withholdingTax: form.withholdingTax,
    vatClassification: form.vatClassification,
  });
  return {
    orderId,
    orderNumber: order.orderNumber || order.id,
    customerId: order.clinicId || null,
    clinicId: order.clinicId || null,
    customerName: form.customerName,
    registeredName: form.registeredName,
    customerAddress: form.customerAddress,
    customerContact: form.customerContact,
    customerTin: form.customerTin,
    customerCode: form.customerCode,
    shipTo: form.shipTo,
    salesRepUid: order.createdByUid || null,
    salesRepName: form.salesRepName,
    salesRepCode: form.salesRepCode,
    salesRepEmail: order.createdByEmail || null,
    invoiceDate: form.invoiceDate,
    saleType: form.saleType,
    purchaseOrderNumber: form.purchaseOrderNumber,
    referenceNumber: form.referenceNumber,
    vaccinesTemp: form.vaccinesTemp,
    companyName: form.companyName,
    companyAddress: form.companyAddress,
    companyContact: form.companyContact,
    companyTin: form.companyTin,
    items: form.items.map((it) => ({
      orderItemId: it.orderItemId || null,
      inventoryId: it.inventoryId || null,
      itemDescription: it.itemDescription || "",
      vaccineName: it.vaccineName || "",
      batchId: it.batchId || "",
      expiry: it.expiry || "",
      quantity: Number(it.quantity) || 0,
      unit: it.unit || "vials",
      unitPrice: Number(it.unitPrice) || 0,
      amount: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
    })),
    subtotal: t.subtotal,
    discount: t.discount,
    vatClassification: t.vatClassification,
    vatRate: t.vatRate,
    vatableSales: t.vatableSales,
    vatExemptSales: t.vatExemptSales,
    zeroRatedSales: t.zeroRatedSales,
    vatAmount: t.vatAmount,
    otherCharges: t.otherCharges,
    withholdingTax: t.withholdingTax,
    net: t.net,
    grandTotal: t.grandTotal,
    totalSalesVatInclusive: t.totalSalesVatInclusive,
    totalAmountDue: t.totalAmountDue,
    paymentTerms: form.paymentTerms,
    deliveryTerms: form.deliveryTerms,
    notes: form.notes,
    remarks: form.remarks,
    processedBy: form.processedBy,
    packedBy: form.packedBy,
    deliveredBy: form.deliveredBy,
    preparedBy: form.preparedBy,
    checkedBy: form.checkedBy,
    approvedBy: form.approvedBy,
    receivedBy: form.receivedBy,
    authorizedRepresentative: form.authorizedRepresentative,
    customerAcknowledgment: form.customerAcknowledgment,
    soloParentId: form.soloParentId,
    bookletInfo: form.bookletInfo,
    atpNumber: form.atpNumber,
    atpDate: form.atpDate,
    printerBlock: form.printerBlock,
    accreditationNo: form.accreditationNo,
    accreditationDates: form.accreditationDates,
  };
}

/**
 * For an issued (read-only) invoice, surface the STORED figures exactly as
 * locked — including a legacy `taxAmount` surfaced as `vatAmount`, and derived
 * template totals when absent — so nothing about an already-issued or legacy
 * invoice can shift. `live` is the freshly computed fallback.
 */
export function normalizeStoredTotals(invoice, live) {
  const n = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  const storedGrand = n(invoice.grandTotal, live.grandTotal);
  const storedNet = n(invoice.net, live.net);
  const storedVat = n(invoice.vatAmount ?? invoice.taxAmount, live.vatAmount);
  const storedWht = n(invoice.withholdingTax, live.withholdingTax);
  return {
    ...live,
    subtotal: n(invoice.subtotal, live.subtotal),
    discount: n(invoice.discount, live.discount),
    otherCharges: n(invoice.otherCharges, live.otherCharges),
    withholdingTax: storedWht,
    net: storedNet,
    vatClassification: invoice.vatClassification || live.vatClassification,
    vatRate: n(invoice.vatRate, live.vatRate),
    vatableSales: n(invoice.vatableSales, live.vatableSales),
    vatExemptSales: n(invoice.vatExemptSales, live.vatExemptSales),
    zeroRatedSales: n(invoice.zeroRatedSales, live.zeroRatedSales),
    vatAmount: storedVat,
    grandTotal: storedGrand,
    totalSalesVatInclusive: n(
      invoice.totalSalesVatInclusive,
      storedNet + storedVat
    ),
    totalAmountDue: n(invoice.totalAmountDue, storedGrand - storedWht),
  };
}
