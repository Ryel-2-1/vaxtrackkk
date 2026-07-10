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
import "./Invoices.css";

const COMPANY_NAME = "3MGS PHARMA INC.";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

let itemKeySeed = 0;
function nextKey() {
  itemKeySeed += 1;
  return `it-${itemKeySeed}`;
}

function itemsFromOrder(order) {
  if (Array.isArray(order?.items) && order.items.length > 0) {
    return order.items.map((it) => ({
      key: nextKey(),
      orderItemId: it.id || null,
      inventoryId: it.inventoryId || null,
      itemDescription: it.name || it.itemDescription || "",
      vaccineName: it.name || it.vaccineName || "",
      batchId: it.batchId || it.sku || "",
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
      quantity: Number(order?.quantity) || 0,
      unit: order?.unit || "vials",
      unitPrice: 0,
    },
  ];
}

function buildInitialForm(order, invoice, salesRepName) {
  const base = {
    invoiceDate: todayISO(),
    saleType: "",
    companyName: COMPANY_NAME,
    companyAddress: "",
    companyContact: "",
    companyTin: "",
    customerName: order?.clinicName || "",
    registeredName: order?.clinicName || "",
    customerAddress: order?.clinicAddress || "",
    customerContact: "",
    customerTin: "",
    salesRepName: salesRepName || order?.createdByEmail || "",
    purchaseOrderNumber: "",
    referenceNumber: "",
    items: itemsFromOrder(order),
    discount: 0,
    taxRate: 0,
    otherCharges: 0,
    paymentTerms: "",
    deliveryTerms: "",
    notes: "",
    remarks: "",
    preparedBy: "",
    checkedBy: "",
    approvedBy: "",
    receivedBy: "",
    authorizedRepresentative: "",
    customerAcknowledgment: "",
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
    salesRepName: invoice.salesRepName ?? base.salesRepName,
    purchaseOrderNumber: invoice.purchaseOrderNumber ?? "",
    referenceNumber: invoice.referenceNumber ?? "",
    items:
      Array.isArray(invoice.items) && invoice.items.length > 0
        ? invoice.items.map((it) => ({ key: nextKey(), ...it }))
        : base.items,
    discount: invoice.discount ?? 0,
    taxRate: invoice.taxRate ?? 0,
    otherCharges: invoice.otherCharges ?? 0,
    paymentTerms: invoice.paymentTerms ?? "",
    deliveryTerms: invoice.deliveryTerms ?? "",
    notes: invoice.notes ?? "",
    remarks: invoice.remarks ?? "",
    preparedBy: invoice.preparedBy ?? "",
    checkedBy: invoice.checkedBy ?? "",
    approvedBy: invoice.approvedBy ?? "",
    receivedBy: invoice.receivedBy ?? "",
    authorizedRepresentative: invoice.authorizedRepresentative ?? "",
    customerAcknowledgment: invoice.customerAcknowledgment ?? "",
  };
}

function computeTotals(form) {
  const lines = form.items.map((it) => (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0));
  const subtotal = lines.reduce((a, b) => a + b, 0);
  const discount = Number(form.discount) || 0;
  const taxRate = Number(form.taxRate) || 0;
  const otherCharges = Number(form.otherCharges) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxAmount = taxable * (taxRate / 100);
  const grandTotal = taxable + taxAmount + otherCharges;
  return { lines, subtotal, discount, taxRate, taxAmount, otherCharges, grandTotal };
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

  const totals = useMemo(() => (form ? computeTotals(form) : null), [form]);

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

  const buildInvoiceData = () => {
    const t = computeTotals(form);
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
      salesRepUid: order.createdByUid || null,
      salesRepName: form.salesRepName,
      salesRepEmail: order.createdByEmail || null,
      invoiceDate: form.invoiceDate,
      saleType: form.saleType,
      purchaseOrderNumber: form.purchaseOrderNumber,
      referenceNumber: form.referenceNumber,
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
        quantity: Number(it.quantity) || 0,
        unit: it.unit || "vials",
        unitPrice: Number(it.unitPrice) || 0,
        amount: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
      })),
      subtotal: t.subtotal,
      discount: t.discount,
      taxRate: t.taxRate,
      taxAmount: t.taxAmount,
      otherCharges: t.otherCharges,
      grandTotal: t.grandTotal,
      paymentTerms: form.paymentTerms,
      deliveryTerms: form.deliveryTerms,
      notes: form.notes,
      remarks: form.remarks,
      preparedBy: form.preparedBy,
      checkedBy: form.checkedBy,
      approvedBy: form.approvedBy,
      receivedBy: form.receivedBy,
      authorizedRepresentative: form.authorizedRepresentative,
      customerAcknowledgment: form.customerAcknowledgment,
    };
  };

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

        {/* The printable A4 document */}
        <div className={docClass}>
          <div className="inv-doc-top">
            <div className="inv-doc-company">
              <TextInput
                className="inv-company-name"
                value={form.companyName}
                onChange={(v) => setField("companyName", v)}
                readOnly={readOnly}
                aria-label="Company name"
              />
              <TextArea
                value={form.companyAddress}
                onChange={(v) => setField("companyAddress", v)}
                readOnly={readOnly}
                placeholder="Company address"
                aria-label="Company address"
                rows={2}
              />
              <TextInput
                value={form.companyTin}
                onChange={(v) => setField("companyTin", v)}
                readOnly={readOnly}
                placeholder="VAT Reg. TIN"
                aria-label="Company TIN"
              />
              <TextInput
                value={form.companyContact}
                onChange={(v) => setField("companyContact", v)}
                readOnly={readOnly}
                placeholder="Contact numbers"
                aria-label="Company contact"
              />
              <p className="inv-cold-note">
                Store at 2 to 8 degrees celsius. Do not freeze vaccines.
              </p>
            </div>

            <div className="inv-doc-title">
              <h2>SALES INVOICE</h2>
              <p>
                No. <strong>{invoice?.invoiceNumber || "*****"}</strong>
              </p>
              <label className="inv-doc-date">
                Date
                <input
                  type="date"
                  value={form.invoiceDate}
                  onChange={(e) => setField("invoiceDate", e.target.value)}
                  readOnly={readOnly}
                  disabled={readOnly}
                />
              </label>
              <div className="inv-sale-type">
                <label>
                  <input
                    type="radio"
                    name="saleType"
                    checked={form.saleType === "cash"}
                    onChange={() => setField("saleType", "cash")}
                    disabled={readOnly}
                  />
                  Cash Sales
                </label>
                <label>
                  <input
                    type="radio"
                    name="saleType"
                    checked={form.saleType === "charge"}
                    onChange={() => setField("saleType", "charge")}
                    disabled={readOnly}
                  />
                  Charge Sales
                </label>
              </div>
            </div>
          </div>

          <div className="inv-soldto-grid">
            <LabeledField label="Sold To (Customer / Clinic)">
              <TextInput
                value={form.customerName}
                onChange={(v) => setField("customerName", v)}
                readOnly={readOnly}
                aria-label="Customer name"
              />
            </LabeledField>
            <LabeledField label="Registered Name">
              <TextInput
                value={form.registeredName}
                onChange={(v) => setField("registeredName", v)}
                readOnly={readOnly}
                aria-label="Registered name"
              />
            </LabeledField>
            <LabeledField label="TIN">
              <TextInput
                value={form.customerTin}
                onChange={(v) => setField("customerTin", v)}
                readOnly={readOnly}
                aria-label="Customer TIN"
              />
            </LabeledField>
            <LabeledField label="Business Address">
              <TextInput
                value={form.customerAddress}
                onChange={(v) => setField("customerAddress", v)}
                readOnly={readOnly}
                aria-label="Business address"
              />
            </LabeledField>
            <LabeledField label="Contact Number">
              <TextInput
                value={form.customerContact}
                onChange={(v) => setField("customerContact", v)}
                readOnly={readOnly}
                aria-label="Contact number"
              />
            </LabeledField>
            <LabeledField label="Sales Representative">
              <TextInput
                value={form.salesRepName}
                onChange={(v) => setField("salesRepName", v)}
                readOnly={readOnly}
                aria-label="Sales representative"
              />
            </LabeledField>
            <LabeledField label="Order ID">
              <span className="inv-static">{order.orderNumber || order.id}</span>
            </LabeledField>
            <LabeledField label="P.O. Number">
              <TextInput
                value={form.purchaseOrderNumber}
                onChange={(v) => setField("purchaseOrderNumber", v)}
                readOnly={readOnly}
                aria-label="Purchase order number"
              />
            </LabeledField>
            <LabeledField label="Reference Number">
              <TextInput
                value={form.referenceNumber}
                onChange={(v) => setField("referenceNumber", v)}
                readOnly={readOnly}
                aria-label="Reference number"
              />
            </LabeledField>
          </div>

          <div className="inv-items-wrap">
            <table className="inv-items-table">
              <thead>
                <tr>
                  <th>Item Description / Nature of Service</th>
                  <th>Batch ID</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Unit Cost / Price</th>
                  <th>Amount</th>
                  {!readOnly && <th className="inv-no-print" aria-label="Remove" />}
                </tr>
              </thead>
              <tbody>
                {form.items.map((it, i) => (
                  <tr key={it.key}>
                    <td>
                      <TextInput
                        value={it.itemDescription}
                        onChange={(v) => setItem(it.key, "itemDescription", v)}
                        readOnly={readOnly}
                        placeholder={it.vaccineName || "Item description"}
                        aria-label={`Item ${i + 1} description`}
                      />
                    </td>
                    <td>
                      <TextInput
                        value={it.batchId}
                        onChange={(v) => setItem(it.key, "batchId", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} batch id`}
                      />
                    </td>
                    <td>
                      <NumberInput
                        value={it.quantity}
                        onChange={(v) => setItem(it.key, "quantity", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} quantity`}
                      />
                    </td>
                    <td>
                      <TextInput
                        value={it.unit}
                        onChange={(v) => setItem(it.key, "unit", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} unit`}
                      />
                    </td>
                    <td>
                      <NumberInput
                        value={it.unitPrice}
                        onChange={(v) => setItem(it.key, "unitPrice", v)}
                        readOnly={readOnly}
                        aria-label={`Item ${i + 1} unit price`}
                      />
                    </td>
                    <td className="inv-amount-cell">
                      {formatCurrency((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0))}
                    </td>
                    {!readOnly && (
                      <td className="inv-no-print">
                        <button
                          type="button"
                          className="inv-icon-btn"
                          aria-label={`Remove item ${i + 1}`}
                          onClick={() => removeItem(it.key)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {!readOnly && (
              <button type="button" className="inv-btn inv-btn-outline inv-add-item inv-no-print" onClick={addItem}>
                <Plus size={14} /> Add Item
              </button>
            )}
          </div>

          <div className="inv-bottom-grid">
            <div className="inv-notes-col">
              <LabeledField label="Payment Terms">
                <TextInput
                  value={form.paymentTerms}
                  onChange={(v) => setField("paymentTerms", v)}
                  readOnly={readOnly}
                  aria-label="Payment terms"
                />
              </LabeledField>
              <LabeledField label="Delivery Terms">
                <TextInput
                  value={form.deliveryTerms}
                  onChange={(v) => setField("deliveryTerms", v)}
                  readOnly={readOnly}
                  aria-label="Delivery terms"
                />
              </LabeledField>
              <LabeledField label="Notes">
                <TextArea
                  value={form.notes}
                  onChange={(v) => setField("notes", v)}
                  readOnly={readOnly}
                  rows={2}
                  aria-label="Notes"
                />
              </LabeledField>
              <LabeledField label="Remarks">
                <TextArea
                  value={form.remarks}
                  onChange={(v) => setField("remarks", v)}
                  readOnly={readOnly}
                  rows={2}
                  aria-label="Remarks"
                />
              </LabeledField>
            </div>

            <div className="inv-totals-col">
              <TotalRow label="Subtotal" value={formatCurrency(totals.subtotal)} />
              <div className="inv-total-input-row">
                <span>Discount</span>
                <NumberInput
                  value={form.discount}
                  onChange={(v) => setField("discount", v)}
                  readOnly={readOnly}
                  aria-label="Discount amount"
                />
              </div>
              <div className="inv-total-input-row">
                <span>Tax Rate (%)</span>
                <NumberInput
                  value={form.taxRate}
                  onChange={(v) => setField("taxRate", v)}
                  readOnly={readOnly}
                  aria-label="Tax rate percent"
                />
              </div>
              <TotalRow label="Tax Amount" value={formatCurrency(totals.taxAmount)} />
              <div className="inv-total-input-row">
                <span>Other Charges</span>
                <NumberInput
                  value={form.otherCharges}
                  onChange={(v) => setField("otherCharges", v)}
                  readOnly={readOnly}
                  aria-label="Other charges"
                />
              </div>
              <TotalRow label="Total Amount Due" value={formatCurrency(totals.grandTotal)} grand />
            </div>
          </div>

          <div className="inv-signatures">
            <SignatureField
              label="Prepared By"
              value={form.preparedBy}
              onChange={(v) => setField("preparedBy", v)}
              readOnly={readOnly}
            />
            <SignatureField
              label="Checked By"
              value={form.checkedBy}
              onChange={(v) => setField("checkedBy", v)}
              readOnly={readOnly}
            />
            <SignatureField
              label="Approved By"
              value={form.approvedBy}
              onChange={(v) => setField("approvedBy", v)}
              readOnly={readOnly}
            />
            <SignatureField
              label="Received By"
              value={form.receivedBy}
              onChange={(v) => setField("receivedBy", v)}
              readOnly={readOnly}
            />
            <SignatureField
              label="Authorized Representative"
              value={form.authorizedRepresentative}
              onChange={(v) => setField("authorizedRepresentative", v)}
              readOnly={readOnly}
            />
            <SignatureField
              label="Customer Acknowledgment"
              value={form.customerAcknowledgment}
              onChange={(v) => setField("customerAcknowledgment", v)}
              readOnly={readOnly}
            />
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

function TextArea({ value, onChange, readOnly, rows = 2, ...rest }) {
  return (
    <textarea
      className="inv-input inv-textarea"
      rows={rows}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      disabled={readOnly}
      {...rest}
    />
  );
}

function LabeledField({ label, children }) {
  return (
    <div className="inv-field">
      <span className="inv-field-label">{label}</span>
      {children}
    </div>
  );
}

function TotalRow({ label, value, grand }) {
  return (
    <div className={`inv-total-row ${grand ? "grand" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SignatureField({ label, value, onChange, readOnly }) {
  return (
    <div className="inv-signature">
      <TextInput value={value} onChange={onChange} readOnly={readOnly} aria-label={label} />
      <span>{label}</span>
    </div>
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
