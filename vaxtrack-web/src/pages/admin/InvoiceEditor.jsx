import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { auth } from "../../firebase";
import { subscribeOrder } from "../../services/orderHistoryService";
import { getUserProfile } from "../../services/userService";
import {
  createInvoiceDraft,
  issueInvoice,
  subscribeInvoice,
  updateInvoiceDraft,
} from "../../services/invoiceService";
import { formSignature, reconcileLiveForm } from "../../services/liveFormSync";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { UserMessageError } from "../../services/userMessageError";
import {
  adjustmentsFromForm,
  buildInitialForm,
  computeInvoiceTotals,
  formatOrderDate,
  invoicePriceConvention,
  ITEMIZED_VAT,
  itemVatLabelForLine,
  isServerPricedOrder,
  isLineDiscountOrder,
  invoiceLineAmount,
  isFinalChargedLine,
  NON_EXACT_UNIT_PRICE_NOTE,
  LINE_DISCOUNT_NOTE,
  nextKey,
  normalizeStoredTotals,
  presentationFromForm,
  serializeInvoiceDoc,
  vatClassificationLabel,
} from "../../services/invoiceModel";
import { priceConventionNote } from "../../services/pricingConfig";
import {
  issueInvoiceForPricedOrder,
  messageForInvoiceError,
  saveInvoiceDraftForPricedOrder,
} from "../../services/invoiceCallables";
import { parseAdjustmentPesosToCentavos } from "../../services/money";
import AppConfirmDialog from "../../components/ui/ConfirmDialog";
import { orderPhrase, orderReference } from "../../services/orderLabel";
import "./Invoices.css";

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Totals from the live form, under the invoice's OWN recorded convention
// (invoicePriceConvention): VAT extracted for VAT-inclusive prices, added on
// top for a legacy VAT-exclusive record (single source of truth in the service
// so the editor and CSV export agree). Display only for a priced order: the
// server computes and stores the authoritative figures.
function computeTotals(form, priceIsVatInclusive, lineLevel = false) {
  return computeInvoiceTotals({
    items: form.items,
    discount: form.discount,
    otherCharges: form.otherCharges,
    withholdingTax: form.withholdingTax,
    vatClassification: form.vatClassification,
    priceIsVatInclusive,
    // Agreement-model order: per-line SC/PWD discounts and per-line VAT.
    lineLevel,
  });
}

function InvoiceEditor() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [order, setOrder] = useState(null);
  const [invoice, setInvoice] = useState(null);
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirmIssue, setConfirmIssue] = useState(false);
  // "Leave without saving?" — an application dialog, never window.confirm.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [message, setMessage] = useState(null); // { type, text }
  const [reloadKey, setReloadKey] = useState(0);
  // Newer server data arrived while this form had unsaved edits. The edits are
  // kept; the admin loads the newer version explicitly.
  const [stale, setStale] = useState(false);

  // For the snapshot callbacks (refs, never read during render): the latest
  // server data, whether the form holds unsaved edits, whether a save/issue
  // from this page is in flight, and the signature the form was seeded from.
  const liveRef = useRef({ order: undefined, invoice: undefined, repName: undefined });
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const baselineRef = useRef(null);

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const autoPrintRef = useRef(location.state?.autoPrint === true);

  const issued = invoice?.invoiceStatus === "issued";
  const readOnly = issued;

  /**
   * Is this order's invoice priced by the server?
   *
   * When true the base pricing — every line's quantity and unit price, and the
   * subtotal — comes from the order snapshot. The editor stops collecting them,
   * stops sending them, and routes save and issue through the callables.
   *
   * The read-only inputs below are a COURTESY, not the control. The real
   * enforcement is that this page sends no base pricing at all, that Firestore
   * rules refuse a direct client write to such an invoice, and that the
   * callable recomputes everything from the order regardless of what arrives.
   */
  const serverPriced = isServerPricedOrder(order);
  const baseLocked = readOnly || serverPriced;
  // No double discount: a negotiated order is invoiced at its agreed prices,
  // and the server refuses an invoice discount on top (discount-not-allowed-negotiated).
  // Agreement-model orders recorded their SC/PWD discounts PER LINE at
  // placement. Their invoice follows the client's rule: every line shows its
  // FINAL charged amount and there is no separate discount line (the server
  // refuses any invoice discount: discount-recorded-per-line). A negotiated
  // price on its own locks nothing.
  const lineLevel = serverPriced && isLineDiscountOrder(order);
  const discountLocked = readOnly || lineLevel;
  // Lines printed at their final charged amounts: a live agreement-model
  // draft, or an invoice stored that way.
  const finalChargedAmounts = lineLevel || invoice?.lineAmountBasis === "final_charged";
  const hasNonExactUnitPrice =
    finalChargedAmounts && (form?.items || []).some((it) => isFinalChargedLine(it) && it.unitPriceCentavos == null);
  // The recorded convention this invoice is computed and labelled under —
  // never the current configuration applied to an existing record.
  const priceConvention = invoicePriceConvention({ order, invoice });
  const priceNote = priceConventionNote(priceConvention);

  // Puts the latest server data on screen. The form follows it only while it
  // holds no unsaved edits (services/liveFormSync.js); otherwise the edits are
  // kept and the "newer version" notice is shown. `force` is the admin's own
  // "Load latest", which discards the edits.
  const applyServer = useCallback((force = false) => {
    const live = liveRef.current;
    if (live.order === undefined || live.invoice === undefined || live.repName === undefined) return;
    if (live.order === null) {
      setError("This order no longer exists.");
      setLoading(false);
      return;
    }
    if (invoicePriceConvention({ order: live.order, invoice: live.invoice }) === null) {
      // A priced order that does not record whether its prices include
      // VAT. The server refuses to invoice it too; nothing is guessed.
      setError("This order does not record whether its prices include VAT, so it cannot be invoiced.");
      setLoading(false);
      return;
    }
    setOrder(live.order);
    setInvoice(live.invoice);
    const seeded = buildInitialForm(live.order, live.invoice, live.repName);
    const serverKey = formSignature(seeded, {
      status: live.invoice?.invoiceStatus ?? null,
      number: live.invoice?.invoiceNumber ?? null,
    });
    const action = force
      ? "seed"
      : reconcileLiveForm({
          dirty: dirtyRef.current,
          busy: busyRef.current,
          baselineKey: baselineRef.current,
          serverKey,
        });
    if (action === "seed") {
      setForm(seeded);
      baselineRef.current = serverKey;
      dirtyRef.current = false;
      setDirty(false);
      setStale(false);
    } else if (action === "stale") {
      setStale(true);
    }
    setError("");
    setLoading(false);
  }, []);

  // The order and its invoice are LIVE (re-subscribed on retry via
  // reloadKey). They used to be read once on open and re-read after each save,
  // so a draft saved or issued in another browser stayed invisible here.
  // State is set only in the listeners' callbacks; both close on unmount.
  useEffect(() => {
    const live = { order: undefined, invoice: undefined, repName: undefined };
    liveRef.current = live;
    baselineRef.current = null;
    let active = true;
    // The default Med Rep name for an empty field, read once per creator. A
    // documented one-time read: it only pre-fills a blank, and the stored
    // invoice value always wins over it.
    const profileNames = {};
    const repNameFor = (orderData) => {
      if (!orderData) return "";
      if (orderData.salesRepName) return orderData.salesRepName;
      const uid = orderData.createdByUid;
      if (!uid) return "";
      if (uid in profileNames) return profileNames[uid];
      profileNames[uid] = undefined;
      getUserProfile(uid)
        .then((p) => p?.fullName || p?.name || p?.displayName || "")
        .catch(() => "")
        .then((name) => {
          if (!active) return;
          profileNames[uid] = name;
          live.repName = repNameFor(live.order);
          applyServer();
        });
      return undefined;
    };
    const fail = (err) => {
      if (!active) return;
      setError(
        err?.code === "permission-denied"
          ? "You do not have permission to open this invoice."
          : liveErrorMessage(err, "the invoice")
      );
      setLoading(false);
    };
    const unsubOrder = subscribeOrder(
      orderId,
      (orderData) => {
        live.order = orderData;
        live.repName = repNameFor(orderData);
        applyServer();
      },
      fail
    );
    const unsubInvoice = subscribeInvoice(
      orderId,
      (invoiceData) => {
        live.invoice = invoiceData;
        applyServer();
      },
      fail
    );
    return () => {
      active = false;
      unsubOrder();
      unsubInvoice();
    };
  }, [orderId, reloadKey, applyServer]);

  // After this page's own save/issue: the form is clean, and the stored
  // version replaces it as soon as the listener has it — now, if the snapshot
  // carrying the write already arrived during the save, otherwise on arrival.
  const settleAfterOwnWrite = (invoiceBefore) => {
    dirtyRef.current = false;
    setDirty(false);
    setStale(false);
    baselineRef.current = null;
    if (liveRef.current.invoice !== invoiceBefore) applyServer();
  };

  const loadLatest = () => applyServer(true);

  const handleRetry = () => {
    setError("");
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  // Warn on tab close / reload when there are unsaved edits.
  useEffect(() => {
    const handler = (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Editable drafts recompute live; an issued (read-only) invoice shows its
  // STORED figures exactly as locked — including a legacy taxAmount surfaced as
  // vatAmount — so nothing about an already-issued invoice can shift.
  const totals = useMemo(() => {
    if (!form || priceConvention === null) return null;
    const live = computeTotals(form, priceConvention, lineLevel);
    if (readOnly && invoice && Number.isFinite(Number(invoice.grandTotal))) {
      return normalizeStoredTotals(invoice, live);
    }
    return live;
  }, [form, readOnly, invoice, priceConvention, lineLevel]);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    markDirty();
  };

  const setItem = (key, field, value) => {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.key === key ? { ...it, [field]: value } : it)),
    }));
    markDirty();
  };

  const addItem = () => {
    setForm((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          key: nextKey(),
          orderItemId: null,
          inventoryId: null,
          itemDescription: "",
          vaccineName: "",
          batchId: "",
          expiry: "",
          quantity: 1,
          unit: "vials",
          unitPrice: 0,
        },
      ],
    }));
    markDirty();
  };

  const removeItem = (key) => {
    setForm((prev) => ({ ...prev, items: prev.items.filter((it) => it.key !== key) }));
    markDirty();
  };

  const buildInvoiceData = () =>
    serializeInvoiceDoc({ orderId, order, form, priceIsVatInclusive: priceConvention });

  const admin = () => {
    const u = auth.currentUser;
    return { uid: u?.uid || null, email: u?.email || null };
  };

  const handleSaveDraft = async () => {
    if (saving || readOnly || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    setMessage(null);
    const invoiceBefore = liveRef.current.invoice;
    try {
      if (serverPriced) {
        // Presentation text and explicit adjustments only. No item, quantity,
        // price or total leaves this page — the callable reads all of those
        // from the order inside its transaction.
        await saveInvoiceDraftForPricedOrder({
          orderId,
          presentation: presentationFromForm(form),
          adjustments: adjustmentsFromForm(form, parseAdjustmentPesosToCentavos, { recordedDiscount: lineLevel }),
        });
      } else if (invoice?.id) {
        await updateInvoiceDraft(invoice.id, buildInvoiceData(), admin());
      } else {
        await createInvoiceDraft(orderId, buildInvoiceData(), admin());
      }
      // No re-read: the invoice listener delivers what was stored, and the
      // form is re-seeded from it, so the screen shows the server's figures
      // rather than the ones this page computed for preview.
      settleAfterOwnWrite(invoiceBefore);
      setMessage({ type: "success", text: "Draft saved." });
    } catch (err) {
      setMessage({
        type: "error",
        text: serverPriced
          ? messageForInvoiceError(err)
          : friendlyErrorMessage(err, "The draft could not be saved. Your changes are still here — please try again."),
      });
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };

  const validateForIssue = () => {
    if (!form.customerName.trim()) return "Customer name is required.";
    if (form.items.length === 0) return "Add at least one invoice item.";
    const bad = form.items.some(
      (it) => !(Number(it.quantity) > 0) || Number(it.unitPrice) < 0
    );
    if (bad) return "Each item needs a quantity greater than zero and a valid price.";
    return "";
  };

  const openIssueConfirm = () => {
    const problem = validateForIssue();
    if (problem) {
      setMessage({ type: "error", text: problem });
      return;
    }
    if (dirty || !invoice?.id) {
      setMessage({ type: "error", text: "Save the draft before issuing." });
      return;
    }
    setConfirmIssue(true);
  };

  // Runs from the confirmation dialog, which stays open until the issue is
  // confirmed by the server: a failure is shown INSIDE it (it rethrows) and
  // the Admin can retry or cancel. Success closes it.
  const handleIssue = async () => {
    if (issuing || busyRef.current) return;
    busyRef.current = true;
    setIssuing(true);
    setMessage(null);
    const invoiceBefore = liveRef.current.invoice;
    try {
      if (serverPriced) {
        // Re-checks the stored draft against the order before locking it, so a
        // base price substituted directly in Firestore cannot become an issued,
        // legally-meaningful bill.
        await issueInvoiceForPricedOrder(orderId);
      } else {
        await issueInvoice(invoice.id, admin());
      }
      settleAfterOwnWrite(invoiceBefore);
      setConfirmIssue(false);
      setMessage({ type: "success", text: "Invoice issued." });
    } catch (err) {
      logSafeError("Issue invoice", err);
      throw new UserMessageError(
        serverPriced
          ? messageForInvoiceError(err)
          : friendlyErrorMessage(err, "The invoice could not be issued. It is still a draft — please try again."),
        { code: err?.code, cause: err }
      );
    } finally {
      busyRef.current = false;
      setIssuing(false);
    }
  };

  const handlePrint = () => window.print();

  const handleBack = () => {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    navigate("/admin/invoices");
  };


  // Auto-open the print dialog when navigated here via the queue "Print" action
  // (only for already-issued invoices).
  useEffect(() => {
    if (!loading && issued && autoPrintRef.current) {
      autoPrintRef.current = false;
      const timer = window.setTimeout(() => window.print(), 200);
      return () => window.clearTimeout(timer);
    }
  }, [loading, issued]);

  if (loading) {
    return (
      <main className="inv-page">
          <div className="inv-state">
            <Loader2 size={28} className="inv-spin" />
            <p>Loading invoice...</p>
          </div>
        </main>
    );
  }

  if (error) {
    return (
      <main className="inv-page">
          <div className="inv-state">
            <AlertTriangle size={28} />
            <p>{error}</p>
            <div className="inv-row-actions">
              <button type="button" className="inv-btn inv-btn-outline" onClick={handleRetry}>
                <RotateCcw size={14} /> Retry
              </button>
              <button
                type="button"
                className="inv-btn inv-btn-primary"
                onClick={() => navigate("/admin/invoices")}
              >
                Back to Queue
              </button>
            </div>
          </div>
        </main>
    );
  }

  const invoiceNumberLabel = invoice?.invoiceNumber || "Will be assigned on save";
  const docClass = `inv-doc ${preview || readOnly ? "inv-doc--preview" : ""}`;
  // Pad the ruled item grid to a fixed row count so it matches the paper form
  // while still fitting the compact 5.5in landscape sheet.
  const fillerCount = Math.max(0, 5 - form.items.length);

  return (
    <>
    <main className="inv-page inv-editor-page">
        {/* Action bar (hidden when printing) */}
        <div className="inv-editor-bar inv-no-print">
          <button type="button" className="inv-btn inv-btn-ghost" onClick={handleBack}>
            <ArrowLeft size={15} /> Back
          </button>

          <div className="inv-editor-bar-title">
            <strong>Sales Invoice</strong>
            <span>{invoiceNumberLabel}</span>
            {issued && <span className="inv-status-badge issued">Issued</span>}
            {dirty && !issued && <span className="inv-unsaved">Unsaved changes</span>}
          </div>

          <div className="inv-editor-actions">
            {!readOnly && (
              <button
                type="button"
                className="inv-btn inv-btn-outline"
                onClick={handleSaveDraft}
                disabled={saving}
              >
                {saving ? <Loader2 size={14} className="inv-spin" /> : <Save size={14} />} Save Draft
              </button>
            )}

            <button
              type="button"
              className="inv-btn inv-btn-outline"
              onClick={() => setPreview((p) => !p)}
            >
              <Eye size={14} /> {preview ? "Edit" : "Preview"}
            </button>

            <button type="button" className="inv-btn inv-btn-outline" onClick={handlePrint}>
              <Printer size={14} /> Print
            </button>

            {!readOnly && (
              <button
                type="button"
                className="inv-btn inv-btn-primary"
                onClick={openIssueConfirm}
                disabled={issuing}
              >
                {issuing ? <Loader2 size={14} className="inv-spin" /> : <CheckCircle2 size={14} />}{" "}
                Mark as Issued
              </button>
            )}
          </div>
        </div>

        {message && (
          <div
            className={`inv-toast inv-no-print ${message.type === "error" ? "error" : ""}`}
            role={message.type === "error" ? "alert" : "status"}
          >
            {message.type === "error" ? <AlertTriangle size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            <span>{message.text}</span>
            <button type="button" aria-label="Dismiss message" onClick={() => setMessage(null)}>
              <X size={14} />
            </button>
          </div>
        )}

        {stale && (
          <div className="inv-stale-banner inv-no-print" role="status">
            <AlertTriangle size={16} />
            <span>
              {issued
                ? "This invoice was issued in another session, so your unsaved edits can no longer be saved."
                : "This invoice was changed in another session. Your unsaved edits are still here; loading the latest version discards them."}
            </span>
            <button type="button" className="inv-btn inv-btn-outline" onClick={loadLatest}>
              <RotateCcw size={14} /> Load latest
            </button>
          </div>
        )}

        {discountLocked && !readOnly && (
          <div className="inv-priced-banner inv-no-print" role="note">
            <CheckCircle2 size={16} />
            <span>{LINE_DISCOUNT_NOTE}</span>
          </div>
        )}

        {serverPriced && !issued && (
          <div className="inv-priced-banner inv-no-print">
            <CheckCircle2 size={16} />
            <span>
              Prices and quantities on this invoice come from the order and
              cannot be edited here.{" "}
              {form.vatClassification === ITEMIZED_VAT
                ? "VAT comes from each item's own classification. Discounts, other charges and withholding tax are still yours to set."
                : "Discounts, other charges, withholding tax and the VAT classification are still yours to set."}
            </span>
          </div>
        )}

        {/* The pricing convention THIS record was recorded under — the
            VAT-inclusive wording never appears on a legacy record. */}
        {priceNote && (
          <div
            className={`inv-price-convention inv-no-print${priceConvention === false ? " legacy" : ""}`}
            data-price-convention={priceConvention ? "vat-inclusive" : "legacy-vat-exclusive"}
          >
            {priceNote}
          </div>
        )}

        {issued && (
          <div className="inv-issued-banner inv-no-print">
            <CheckCircle2 size={16} />
            This invoice has been issued and is now read-only.
          </div>
        )}

        {/* No-print editing helper: VAT classification has no cell on the paper
            form, so it lives here; the chosen bucket shows in the totals. */}
        {!readOnly && (
          <div className="inv-tmpl-controls inv-no-print">
            {form.vatClassification === ITEMIZED_VAT ? (
              /* Per-item VAT: each line carries its vaccine's classification
                 (snapshotted on the order). Nothing to choose here; an
                 invoice discount is split pro-rata between the two. */
              <span className="inv-vat-itemized">
                VAT classification: <strong>Per item</strong> — {vatClassificationLabel("vatable")} or{" "}
                {vatClassificationLabel("vat_exempt")}, as recorded on each order item.
              </span>
            ) : (
              <label>
                VAT classification
                <select
                  className="inv-input inv-vat-select"
                  value={form.vatClassification}
                  onChange={(e) => setField("vatClassification", e.target.value)}
                  aria-label="VAT classification"
                >
                  <option value="vatable">{vatClassificationLabel("vatable")}</option>
                  <option value="vat_exempt">{vatClassificationLabel("vat_exempt")}</option>
                  <option value="zero_rated">{vatClassificationLabel("zero_rated")}</option>
                </select>
              </label>
            )}
            <span className="inv-tmpl-hint">
              Blank TIN, signature, and legal/printer lines are intentional —
              fill only with confirmed client data.
            </span>
          </div>
        )}

        {/* Printable client template (3MGS Pharma landscape sales invoice) */}
        <div className={docClass}>
          {/* ===== Header ===== */}
          <div className="sit-head">
            <div className="sit-head-co">
              <TextInput
                className="sit-co-name"
                value={form.companyName}
                onChange={(v) => setField("companyName", v)}
                readOnly={readOnly}
                aria-label="Company name"
              />
              <div className="sit-co-line">
                <span>VAT Reg. TIN:</span>
                <TextInput
                  value={form.companyTin}
                  onChange={(v) => setField("companyTin", v)}
                  readOnly={readOnly}
                  placeholder="__________"
                  aria-label="Company TIN"
                />
              </div>
              <TextInput
                className="sit-co-addr"
                value={form.companyAddress}
                onChange={(v) => setField("companyAddress", v)}
                readOnly={readOnly}
                placeholder="Business address"
                aria-label="Company address"
              />
              <div className="sit-co-line">
                <span>Tel. Nos.:</span>
                <TextInput
                  value={form.companyContact}
                  onChange={(v) => setField("companyContact", v)}
                  readOnly={readOnly}
                  placeholder="__________"
                  aria-label="Company contact"
                />
              </div>
            </div>

            <div className="sit-head-title">
              <h2>
                SALES <b>INVOICE</b>
              </h2>
              <p className="sit-no">
                No. <strong>{invoice?.invoiceNumber || "—"}</strong>
              </p>
            </div>
          </div>

          {/* ===== Meta grid: cash/charge, date, sold-to ===== */}
          <div className="sit-meta">
            <div className="sit-meta-left">
              <div className="sit-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={form.saleType === "cash"}
                    onChange={() =>
                      setField("saleType", form.saleType === "cash" ? "" : "cash")
                    }
                    disabled={readOnly}
                  />
                  CASH SALES
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.saleType === "charge"}
                    onChange={() =>
                      setField(
                        "saleType",
                        form.saleType === "charge" ? "" : "charge"
                      )
                    }
                    disabled={readOnly}
                  />
                  CHARGE SALES
                </label>
              </div>
              <div className="sit-soldto">
                <span className="sit-lbl">SOLD TO:</span>
                <TextInput
                  value={form.customerCode}
                  onChange={(v) => setField("customerCode", v)}
                  readOnly={readOnly}
                  placeholder="Customer code"
                  aria-label="Customer code"
                />
                <TextInput
                  value={form.customerContact}
                  onChange={(v) => setField("customerContact", v)}
                  readOnly={readOnly}
                  placeholder="Phone"
                  aria-label="Customer phone"
                />
              </div>
            </div>
            <div className="sit-meta-right">
              <div className="sit-mr-row">
                <div className="sit-mr-cell">
                  <span className="sit-lbl">Date Order:</span>
                  <span className="sit-static">
                    {formatOrderDate(order.createdAt)}
                  </span>
                </div>
                <div className="sit-mr-cell">
                  <span className="sit-lbl">Payment Terms</span>
                  <TextInput
                    value={form.paymentTerms}
                    onChange={(v) => setField("paymentTerms", v)}
                    readOnly={readOnly}
                    aria-label="Payment terms"
                  />
                </div>
              </div>
              <div className="sit-mr-row">
                <div className="sit-mr-cell">
                  <span className="sit-lbl">Order ID</span>
                  <span className="sit-static sit-static-id">{order.id}</span>
                </div>
                <div className="sit-mr-cell">
                  <span className="sit-lbl">Med Rep Code</span>
                  <TextInput
                    value={form.salesRepCode}
                    onChange={(v) => setField("salesRepCode", v)}
                    readOnly={readOnly}
                    aria-label="Med Rep code"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ===== Registered name block ===== */}
          <div className="sit-reg">
            <div className="sit-reg-row">
              <span className="sit-lbl">Registered Name</span>
              <span>:</span>
              <TextInput
                value={form.registeredName}
                onChange={(v) => setField("registeredName", v)}
                readOnly={readOnly}
                aria-label="Registered name"
              />
            </div>
            <div className="sit-reg-row">
              <span className="sit-lbl">TIN</span>
              <span>:</span>
              <TextInput
                value={form.customerTin}
                onChange={(v) => setField("customerTin", v)}
                readOnly={readOnly}
                aria-label="Customer TIN"
              />
              <span className="sit-lbl sit-shipto">SHIP TO:</span>
              <TextInput
                value={form.shipTo}
                onChange={(v) => setField("shipTo", v)}
                readOnly={readOnly}
                aria-label="Ship to"
              />
            </div>
            <div className="sit-reg-row">
              <span className="sit-lbl">Business Address</span>
              <span>:</span>
              <TextInput
                value={form.customerAddress}
                onChange={(v) => setField("customerAddress", v)}
                readOnly={readOnly}
                aria-label="Business address"
              />
            </div>
          </div>

          {/* ===== Item grid ===== */}
          <table className="sit-items">
            <thead>
              <tr>
                <th className="sit-desc-h">
                  Item Description / Nature of Service
                </th>
                <th>Quantity</th>
                <th>{finalChargedAmounts ? "Unit Price (Net)" : "Unit Cost / Price"}</th>
                <th>{finalChargedAmounts ? "Amount Charged (Net)" : "Amount"}</th>
                {!readOnly && (
                  <th className="inv-no-print sit-rm-h" aria-label="Remove" />
                )}
              </tr>
            </thead>
            <tbody>
              {form.items.map((it, i) => (
                <tr key={it.key}>
                  <td>
                    <div className="sit-desc">
                      <TextInput
                        className="sit-desc-name"
                        value={it.itemDescription}
                        onChange={(v) => setItem(it.key, "itemDescription", v)}
                        readOnly={readOnly}
                        placeholder={it.vaccineName || "Item description"}
                        aria-label={`Item ${i + 1} description`}
                      />
                      <span className="sit-exp">Exp:</span>
                      <TextInput
                        className="sit-exp-in"
                        value={it.expiry}
                        onChange={(v) => setItem(it.key, "expiry", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} expiry`}
                      />
                      <span className="sit-bn">BN:</span>
                      <TextInput
                        className="sit-bn-in"
                        value={it.batchId}
                        onChange={(v) => setItem(it.key, "batchId", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} batch id`}
                      />
                      {/* The order item's VAT snapshot — printed with the line. */}
                      <span className="sit-vat">{itemVatLabelForLine(it)}</span>
                    </div>
                  </td>
                  <td className="sit-qty">
                    <NumberInput
                      value={it.quantity}
                      onChange={(v) => setItem(it.key, "quantity", v)}
                      readOnly={baseLocked}
                      aria-label={`Item ${i + 1} quantity`}
                    />
                  </td>
                  <td className="sit-price">
                    {isFinalChargedLine(it) && it.unitPriceCentavos == null ? (
                      // Never a rounded figure: the charged amount does not
                      // divide exactly by the quantity.
                      <span aria-label={`Item ${i + 1} unit price not shown`}>—</span>
                    ) : (
                      <NumberInput
                        value={it.unitPrice}
                        onChange={(v) => setItem(it.key, "unitPrice", v)}
                        readOnly={baseLocked}
                        aria-label={`Item ${i + 1} unit price`}
                      />
                    )}
                  </td>
                  <td className="sit-amt">
                    {formatCurrency(invoiceLineAmount(it))}
                  </td>
                  {!baseLocked && (
                    <td className="inv-no-print">
                      <button
                        type="button"
                        className="inv-icon-btn"
                        aria-label={`Remove item ${i + 1}`}
                        onClick={() => removeItem(it.key)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {Array.from({ length: fillerCount }).map((_, i) => (
                <tr key={`filler-${i}`} className="sit-filler">
                  <td />
                  <td />
                  <td />
                  <td className="sit-amt">-</td>
                  {!baseLocked && <td className="inv-no-print" />}
                </tr>
              ))}
            </tbody>
          </table>

          {hasNonExactUnitPrice && (
            <p className="sit-net-note">{NON_EXACT_UNIT_PRICE_NOTE}</p>
          )}

          {!baseLocked && (
            <button
              type="button"
              className="inv-btn inv-btn-outline inv-add-item inv-no-print"
              onClick={addItem}
            >
              <Plus size={13} /> Add Item
            </button>
          )}

          {/* ===== Bottom: VAT breakdown | handling | totals ===== */}
          <div className="sit-bottom">
            <div className="sit-vatbox">
              <div className="sit-vat-row">
                <span>VATable Sales</span>
                <b>{formatCurrency(totals.vatableSales)}</b>
              </div>
              <div className="sit-vat-row">
                <span>VAT</span>
                <b>{formatCurrency(totals.vatAmount)}</b>
              </div>
              <div className="sit-vat-row">
                <span>Zero Rated Sales</span>
                <b>{formatCurrency(totals.zeroRatedSales)}</b>
              </div>
              <div className="sit-vat-row">
                <span>VAT-Exempt Sales</span>
                <b>{formatCurrency(totals.vatExemptSales)}</b>
              </div>
            </div>

            <div className="sit-handling">
              <div className="sit-hd-row">
                <span>Processed By:</span>
                <TextInput
                  value={form.processedBy}
                  onChange={(v) => setField("processedBy", v)}
                  readOnly={readOnly}
                  aria-label="Processed by"
                />
              </div>
              <div className="sit-hd-row">
                <span>Packed By:</span>
                <TextInput
                  value={form.packedBy}
                  onChange={(v) => setField("packedBy", v)}
                  readOnly={readOnly}
                  aria-label="Packed by"
                />
              </div>
              <div className="sit-hd-row">
                <span>Delivered By:</span>
                <TextInput
                  value={form.deliveredBy}
                  onChange={(v) => setField("deliveredBy", v)}
                  readOnly={readOnly}
                  aria-label="Delivered by"
                />
              </div>
            </div>

            <div className="sit-totals">
              <div className="sit-tt-row">
                <span>Total Sales (VAT Inclusive)</span>
                <b>{formatCurrency(totals.totalSalesVatInclusive)}</b>
              </div>
              <div className="sit-tt-row">
                <span>Less: VAT</span>
                <b>{formatCurrency(totals.vatAmount)}</b>
              </div>
              <div className="sit-tt-row">
                <span>Amount: Net of VAT</span>
                <b>{formatCurrency(totals.net)}</b>
              </div>
              {/* Agreement-model invoices: no separate discount line — the
                  lines are already the final charged amounts. Every other
                  invoice keeps its discount row, labels unchanged. */}
              {!finalChargedAmounts && (
                <div className="sit-tt-row sit-tt-input">
                  <span>Less: Discount [SC/PWD/NAAC/MOV/SP]</span>
                  <NumberInput
                    value={form.discount}
                    onChange={(v) => setField("discount", v)}
                    readOnly={discountLocked}
                    aria-label="Discount amount"
                  />
                </div>
              )}
              <div className="sit-tt-row">
                <span>Add: VAT</span>
                <b>{formatCurrency(totals.vatAmount)}</b>
              </div>
              <div className="sit-tt-row sit-tt-input">
                <span>Less: Withholding Tax</span>
                <NumberInput
                  value={form.withholdingTax}
                  onChange={(v) => setField("withholdingTax", v)}
                  readOnly={readOnly}
                  aria-label="Withholding tax"
                />
              </div>
              <div className="sit-tt-row sit-tt-input">
                <span>Other Charges</span>
                <NumberInput
                  value={form.otherCharges}
                  onChange={(v) => setField("otherCharges", v)}
                  readOnly={readOnly}
                  aria-label="Other charges"
                />
              </div>
              <div className="sit-tt-row sit-tt-grand">
                <span>TOTAL AMOUNT DUE</span>
                <b>{formatCurrency(totals.totalAmountDue)}</b>
              </div>
            </div>
          </div>

          {/* ===== Acknowledgment + SC/PWD ids ===== */}
          <div className="sit-ack">
            <div className="sit-ack-left">
              <div className="sit-recv">
                <span className="sit-box" aria-hidden="true" />
                <span>Received the amount of</span>
                <TextInput
                  value={form.customerAcknowledgment}
                  onChange={(v) => setField("customerAcknowledgment", v)}
                  readOnly={readOnly}
                  aria-label="Received the amount of"
                />
              </div>
              <div className="sit-sign">
                <TextInput
                  className="sit-sign-in"
                  value={form.authorizedRepresentative}
                  onChange={(v) => setField("authorizedRepresentative", v)}
                  readOnly={readOnly}
                  aria-label="Cashier / Authorized Representative"
                />
                <span className="sit-sign-lbl">
                  Cashier / Authorized Representative
                </span>
              </div>
            </div>
            <div className="sit-ack-right">
              <div className="sit-id-row">
                <span>SC/PWD/NAAC/MOV/ Solo Parent ID No.:</span>
                <TextInput
                  value={form.soloParentId}
                  onChange={(v) => setField("soloParentId", v)}
                  readOnly={readOnly}
                  aria-label="Solo Parent ID No."
                />
              </div>
              <div className="sit-id-row">
                <span>SC/PWD/NAAC/MOV/ Signature:</span>
                <TextInput
                  value={form.receivedBy}
                  onChange={(v) => setField("receivedBy", v)}
                  readOnly={readOnly}
                  aria-label="SC/PWD signature"
                />
              </div>
            </div>
          </div>

          {/* ===== Legal / printer footer — blank until confirmed client data
              (never pre-filled from the template photo) ===== */}
          <div className="sit-footer">
            <div className="sit-foot-left">
              <div className="sit-foot-line">
                <TextInput
                  value={form.bookletInfo}
                  onChange={(v) => setField("bookletInfo", v)}
                  readOnly={readOnly}
                  placeholder="Booklets / serial range"
                  aria-label="Booklet info"
                />
              </div>
              <div className="sit-foot-line">
                <span>BIR Authority to Print No.:</span>
                <TextInput
                  value={form.atpNumber}
                  onChange={(v) => setField("atpNumber", v)}
                  readOnly={readOnly}
                  aria-label="BIR Authority to Print No."
                />
              </div>
              <div className="sit-foot-line">
                <span>Date of ATP:</span>
                <TextInput
                  value={form.atpDate}
                  onChange={(v) => setField("atpDate", v)}
                  readOnly={readOnly}
                  aria-label="Date of ATP"
                />
              </div>
              <TextArea
                className="sit-foot-printer"
                value={form.printerBlock}
                onChange={(v) => setField("printerBlock", v)}
                readOnly={readOnly}
                rows={2}
                placeholder="Printer name / address / TIN / tel"
                aria-label="Printer details"
              />
            </div>
            <div className="sit-foot-right">
              <div className="sit-foot-line">
                <span>Printer&apos;s Accreditation No.:</span>
                <TextInput
                  value={form.accreditationNo}
                  onChange={(v) => setField("accreditationNo", v)}
                  readOnly={readOnly}
                  aria-label="Printer's Accreditation No."
                />
              </div>
              <div className="sit-foot-line">
                <TextInput
                  value={form.accreditationDates}
                  onChange={(v) => setField("accreditationDates", v)}
                  readOnly={readOnly}
                  placeholder="Date Issued / Expiry"
                  aria-label="Accreditation dates"
                />
              </div>
            </div>
          </div>
        </div>
      </main>

      {confirmIssue && (
        <AppConfirmDialog
          title="Mark invoice as issued?"
          target={`Invoice ${invoice?.invoiceNumber || "draft"} · ${orderReference(order, "order without a number")} · Total due ${formatCurrency(
            totals.grandTotal
          )}`}
          consequence="It will be locked and can no longer be edited."
          confirmLabel="Confirm & Issue"
          busyLabel="Issuing…"
          tone="primary"
          failureMessage="The invoice could not be issued. It is still a draft — please try again."
          onCancel={() => setConfirmIssue(false)}
          onConfirm={handleIssue}
        />
      )}

      {confirmLeave && (
        <AppConfirmDialog
          title="Leave without saving?"
          target={`Invoice ${invoice?.invoiceNumber || "draft"} for ${orderPhrase(order)}`}
          consequence="Your unsaved changes to this invoice will be lost. The last saved draft is kept."
          confirmLabel="Leave without saving"
          cancelLabel="Keep editing"
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            navigate("/admin/invoices");
          }}
        />
      )}
    </>
  );
}

/* ---------- small presentational helpers ---------- */

function TextInput({ value, onChange, readOnly, className = "", ...rest }) {
  return (
    <input
      type="text"
      className={`inv-input ${className}`}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      disabled={readOnly}
      {...rest}
    />
  );
}

function NumberInput({ value, onChange, readOnly, ...rest }) {
  return (
    <input
      type="number"
      min="0"
      step="0.01"
      className="inv-input inv-input-number"
      value={value ?? 0}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      disabled={readOnly}
      {...rest}
    />
  );
}

function TextArea({ value, onChange, readOnly, rows = 2, className = "", ...rest }) {
  return (
    <textarea
      className={`inv-input inv-textarea ${className}`}
      rows={rows}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      disabled={readOnly}
      {...rest}
    />
  );
}

export default InvoiceEditor;
