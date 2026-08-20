import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { signOut } from "firebase/auth";
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
import { AdminSidebar } from "./Inventory";
import { getOrderById } from "../../services/orderService";
import { getUserProfile } from "../../services/userService";
import {
  createInvoiceDraft,
  getInvoiceByOrderId,
  issueInvoice,
  updateInvoiceDraft,
} from "../../services/invoiceService";
import {
  buildInitialForm,
  computeVatExclusiveTotals,
  formatOrderDate,
  nextKey,
  normalizeStoredTotals,
  serializeInvoiceDoc,
} from "../../services/invoiceModel";
import "./Invoices.css";

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// VAT-exclusive totals from the live form (single source of truth in the
// service so the editor and CSV export agree).
function computeTotals(form) {
  return computeVatExclusiveTotals({
    items: form.items,
    discount: form.discount,
    otherCharges: form.otherCharges,
    withholdingTax: form.withholdingTax,
    vatClassification: form.vatClassification,
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
  const [message, setMessage] = useState(null); // { type, text }
  const [reloadKey, setReloadKey] = useState(0);

  const autoPrintRef = useRef(location.state?.autoPrint === true);

  const issued = invoice?.invoiceStatus === "issued";
  const readOnly = issued;

  // Load order + invoice on mount (and on retry via reloadKey). All setState
  // runs after an await inside this async effect, so it never fires
  // synchronously during render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const orderData = await getOrderById(orderId);
        if (cancelled) return;
        if (!orderData) {
          setError("This order no longer exists.");
          setLoading(false);
          return;
        }
        const invoiceData = await getInvoiceByOrderId(orderId);
        let repName = orderData.salesRepName || "";
        if (!repName && orderData.createdByUid) {
          try {
            const profile = await getUserProfile(orderData.createdByUid);
            repName = profile?.fullName || profile?.name || profile?.displayName || "";
          } catch {
            /* non-fatal */
          }
        }
        if (cancelled) return;
        setOrder(orderData);
        setInvoice(invoiceData);
        setForm(buildInitialForm(orderData, invoiceData, repName));
        setDirty(false);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        if (err?.code === "permission-denied") {
          setError("You do not have permission to open this invoice.");
        } else {
          setError("Unable to load the invoice.");
        }
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, reloadKey]);

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
    if (!form) return null;
    const live = computeTotals(form);
    if (readOnly && invoice && Number.isFinite(Number(invoice.grandTotal))) {
      return normalizeStoredTotals(invoice, live);
    }
    return live;
  }, [form, readOnly, invoice]);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const setItem = (key, field, value) => {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.key === key ? { ...it, [field]: value } : it)),
    }));
    setDirty(true);
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
    setDirty(true);
  };

  const removeItem = (key) => {
    setForm((prev) => ({ ...prev, items: prev.items.filter((it) => it.key !== key) }));
    setDirty(true);
  };

  const buildInvoiceData = () => serializeInvoiceDoc({ orderId, order, form });

  const admin = () => {
    const u = auth.currentUser;
    return { uid: u?.uid || null, email: u?.email || null };
  };

  const handleSaveDraft = async () => {
    if (saving || readOnly) return;
    setSaving(true);
    setMessage(null);
    try {
      const data = buildInvoiceData();
      if (invoice?.id) {
        await updateInvoiceDraft(invoice.id, data, admin());
      } else {
        await createInvoiceDraft(orderId, data, admin());
      }
      const fresh = await getInvoiceByOrderId(orderId);
      setInvoice(fresh);
      setDirty(false);
      setMessage({ type: "success", text: "Draft saved." });
    } catch (err) {
      setMessage({ type: "error", text: err.message || "Failed to save draft." });
    } finally {
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

  const handleIssue = async () => {
    if (issuing) return;
    setIssuing(true);
    setConfirmIssue(false);
    setMessage(null);
    try {
      await issueInvoice(invoice.id, admin());
      const fresh = await getInvoiceByOrderId(orderId);
      setInvoice(fresh);
      setDirty(false);
      setMessage({ type: "success", text: "Invoice issued." });
    } catch (err) {
      setMessage({ type: "error", text: err.message || "Failed to issue invoice." });
    } finally {
      setIssuing(false);
    }
  };

  const handlePrint = () => window.print();

  const handleBack = () => {
    if (dirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
    navigate("/admin/invoices");
  };

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/login");
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
      <div className="inventory-page">
        <AdminSidebar active="invoices" onLogout={handleLogout} />
        <main className="inv-page">
          <div className="inv-state">
            <Loader2 size={28} className="inv-spin" />
            <p>Loading invoice...</p>
          </div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="inventory-page">
        <AdminSidebar active="invoices" onLogout={handleLogout} />
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
      </div>
    );
  }

  const invoiceNumberLabel = invoice?.invoiceNumber || "Will be assigned on save";
  const docClass = `inv-doc ${preview || readOnly ? "inv-doc--preview" : ""}`;
  // Pad the ruled item grid to a fixed row count so it matches the paper form
  // while still fitting the compact 5.5in landscape sheet.
  const fillerCount = Math.max(0, 5 - form.items.length);

  return (
    <div className="inventory-page">
      <AdminSidebar active="invoices" onLogout={handleLogout} />

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
          <div className={`inv-toast inv-no-print ${message.type === "error" ? "error" : ""}`}>
            {message.type === "error" ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>{message.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setMessage(null)}>
              <X size={14} />
            </button>
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
            <label>
              VAT classification
              <select
                className="inv-input inv-vat-select"
                value={form.vatClassification}
                onChange={(e) => setField("vatClassification", e.target.value)}
                aria-label="VAT classification"
              >
                <option value="vatable">VATable (12%)</option>
                <option value="vat_exempt">VAT-Exempt</option>
                <option value="zero_rated">Zero-Rated</option>
              </select>
            </label>
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

            <div className="sit-head-store">
              <p className="sit-store-1">Store at 2 to 8 degree celsius</p>
              <p className="sit-store-1">Do not freeze vaccines</p>
              <div className="sit-temp">
                <span>Vaccines Temp.</span>
                <TextInput
                  value={form.vaccinesTemp}
                  onChange={(v) => setField("vaccinesTemp", v)}
                  readOnly={readOnly}
                  aria-label="Vaccines temperature"
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
                  <span className="sit-lbl">Sales Rep Code</span>
                  <TextInput
                    value={form.salesRepCode}
                    onChange={(v) => setField("salesRepCode", v)}
                    readOnly={readOnly}
                    aria-label="Sales rep code"
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
                <th>Unit Cost / Price</th>
                <th>Amount</th>
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
                    </div>
                  </td>
                  <td className="sit-qty">
                    <NumberInput
                      value={it.quantity}
                      onChange={(v) => setItem(it.key, "quantity", v)}
                      readOnly={readOnly}
                      aria-label={`Item ${i + 1} quantity`}
                    />
                  </td>
                  <td className="sit-price">
                    <NumberInput
                      value={it.unitPrice}
                      onChange={(v) => setItem(it.key, "unitPrice", v)}
                      readOnly={readOnly}
                      aria-label={`Item ${i + 1} unit price`}
                    />
                  </td>
                  <td className="sit-amt">
                    {formatCurrency(
                      (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)
                    )}
                  </td>
                  {!readOnly && (
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
                  {!readOnly && <td className="inv-no-print" />}
                </tr>
              ))}
            </tbody>
          </table>

          {!readOnly && (
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
              <div className="sit-tt-row sit-tt-input">
                <span>Less: Discount [SC/PWD/NAAC/MOV/SP]</span>
                <NumberInput
                  value={form.discount}
                  onChange={(v) => setField("discount", v)}
                  readOnly={readOnly}
                  aria-label="Discount amount"
                />
              </div>
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
        <ConfirmDialog
          title="Mark invoice as issued?"
          body={`Invoice ${invoice?.invoiceNumber || ""} will be locked and can no longer be edited. Total due: ${formatCurrency(
            totals.grandTotal
          )}.`}
          confirmLabel="Confirm & Issue"
          onCancel={() => setConfirmIssue(false)}
          onConfirm={handleIssue}
        />
      )}
    </div>
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

function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="inv-dialog-overlay inv-no-print" onClick={onCancel}>
      <div
        className="inv-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inv-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="inv-dialog-title">{title}</h2>
        <p>{body}</p>
        <div className="inv-dialog-actions">
          <button type="button" className="inv-btn inv-btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="inv-btn inv-btn-primary" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default InvoiceEditor;
