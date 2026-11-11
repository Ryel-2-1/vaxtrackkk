import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, Truck } from "lucide-react";
import {
  batchIdExists,
  addStockBatch,
} from "../../services/vaccineService";
import { addStockBatchWithAllocation } from "../../services/inventoryCallables";
import { subscribeVaccines } from "../../services/vaccineCatalogService";
import { subscribeInventory } from "../../services/inventoryService";
import { manilaToday } from "../../services/requestedDate";
import { addShelfLife, shelfLifeLabel, stockSuggestions } from "../../services/stockSuggestions";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { parsePesosToCentavos } from "../../services/money";
import { validateStockBatchDates } from "../../services/stockBatchDates";
import { isLargeStockQuantity, largeQuantityMessage } from "../../services/stockQuantityLimit";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import AdminDialogLayer from "../../components/admin/AdminDialogLayer";
import "./AdminForms.css";

// Each validated field's input id, and the id of the one field message shown
// at a time (validation stops at the first problem, top to bottom).
const STOCK_FIELD_IDS = {
  vaccine: "stock-vaccine",
  manufacturer: "stock-manufacturer",
  batchId: "stock-batch-id",
  manufacturingDate: "stock-manufacturing-date",
  arrivalDate: "stock-arrival-date",
  expiryDate: "stock-expiry-date",
  quantity: "stock-quantity",
  unitPrice: "stock-unit-price",
};
const STOCK_FIELD_ERROR_ID = "stock-field-error";

function AddStock() {
  const navigate = useNavigate();

  const [vaccines, setVaccines] = useState([]);
  const [selectedVaccineId, setSelectedVaccineId] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [batchId, setBatchId] = useState("");
  // Date-only 'YYYY-MM-DD' straight from the date input; never a browser Date.
  const [manufacturingDate, setManufacturingDate] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  // Starts empty rather than a pre-filled figure: a default quantity is a
  // number nobody entered, and it could be submitted unchanged.
  const [quantity, setQuantity] = useState("");
  // Also starts empty. A default price would be worse than a default quantity:
  // a plausible-looking figure nobody chose is exactly what gets invoiced.
  const [unitPrice, setUnitPrice] = useState("");

  const [loadingVaccines, setLoadingVaccines] = useState(true);
  /** Earlier batches, only to suggest values (stockSuggestions.js). */
  const [pastBatches, setPastBatches] = useState([]);
  /** The batch whose price was filled in, while that price is kept. */
  const [prefilledFrom, setPrefilledFrom] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("error");
  // The server's report of what the new stock did: how much was added, how
  // much went straight to waiting future orders (and which), and what is left.
  const [result, setResult] = useState(null);

  // Duplicate-submit guard. `saving` drives the disabled button, but it is set
  // AFTER an async validation that queries Firestore for the batch id — two
  // submits dispatched before that resolves would both pass and both write.
  // A ref flips synchronously, so only one write is ever in flight.
  const submittingRef = useRef(false);
  // The last load-failure message shown, so recovery clears only that one.
  const loadMessageRef = useRef("");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  // The field a validation message belongs to. Shown beside that field (tied
  // with aria-describedby, marked aria-invalid) and focused; the banner above
  // the actions only summarises. Nothing typed is cleared.
  const [fieldError, setFieldError] = useState(null); // { field, text } | null
  const failField = (field, text) => {
    setFieldError({ field, text });
    showMessage("Check the highlighted field. Nothing was saved.");
    const el = document.getElementById(STOCK_FIELD_IDS[field]);
    el?.focus();
    el?.scrollIntoView?.({ block: "center" });
    return false;
  };
  const a11y = (field, hint) => {
    const invalid = fieldError?.field === field;
    const describedBy = [invalid ? STOCK_FIELD_ERROR_ID : null, hint].filter(Boolean).join(" ");
    return { "aria-invalid": invalid ? "true" : undefined, "aria-describedby": describedBy || undefined };
  };
  const fieldMessage = (field) =>
    fieldError?.field === field ? (
      <small id={STOCK_FIELD_ERROR_ID} className="form-field-error">
        {fieldError.text}
      </small>
    ) : null;
  // Editing the flagged field clears its message; other fields keep theirs.
  const clearFieldErrorFor = (event) => {
    if (fieldError && event.target?.id === STOCK_FIELD_IDS[fieldError.field]) setFieldError(null);
  };

  // Registered vaccines are LIVE (the catalog listener every page shares), so
  // a vaccine added in another tab appears here without a reload. Newest first,
  // as the one-time read ordered them. The typed form is never touched by a
  // snapshot: the manufacturer is filled only when the admin picks a vaccine.
  useEffect(
    () =>
      subscribeVaccines(
        (docs) => {
          // An archived vaccine takes no new stock (the server refuses it);
          // it is restored from Inventory → Manage vaccines first.
          setVaccines(
            docs.filter((v) => v.archived !== true).sort(
              (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
            )
          );
          setLoadingVaccines(false);
          // A recovered listener clears ITS message — never a validation
          // message the admin is reading.
          setMessage((prev) => (prev && prev === loadMessageRef.current ? "" : prev));
        },
        (error) => {
          setMessage(liveErrorMessage(error, "registered vaccines"));
          loadMessageRef.current = liveErrorMessage(error, "registered vaccines");
          setMessageType("error");
          setLoadingVaccines(false);
        }
      ),
    []
  );

  // Earlier batches for suggestions. A failure only means no suggestions;
  // the form works the same without them.
  useEffect(() => subscribeInventory(setPastBatches, () => setPastBatches([])), []);

  const selectedVaccine = vaccines.find(
    (item) => item.id === selectedVaccineId
  );
  const suggestion = useMemo(
    () => stockSuggestions({ batches: pastBatches, vaccine: selectedVaccine, manufacturer }),
    [pastBatches, selectedVaccine, manufacturer]
  );
  const today = manilaToday();
  const suggestedExpiry = suggestion?.shelfLife && manufacturingDate ? addShelfLife(manufacturingDate, suggestion.shelfLife) : null;
  const shortDate = (iso) => new Date(`${iso}T12:00:00+08:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });

  const handleVaccineChange = (value) => {
    setSelectedVaccineId(value);
    setMessage("");

    const vaccine = vaccines.find((item) => item.id === value);

    if (vaccine) {
      setManufacturer(vaccine.manufacturer || "");
    } else {
      setManufacturer("");
    }

    // Fill the price (VAT included) from the matching earlier batch, but only
    // into an empty field: anything already typed is left alone.
    const offer = vaccine ? stockSuggestions({ batches: pastBatches, vaccine, manufacturer: vaccine.manufacturer || "" }) : null;
    const pricePristine = unitPrice.trim() === "" || prefilledFrom !== null;
    if (offer?.price && pricePristine) {
      setUnitPrice(offer.price);
      setPrefilledFrom({ batchId: offer.sourceBatchId, price: offer.price, converted: offer.priceConverted });
    } else if (prefilledFrom !== null) {
      // The vaccine changed and nothing matches: don't leave another
      // vaccine's price behind as if it were this one's.
      setUnitPrice("");
      setPrefilledFrom(null);
    }
  };
  const priceStillPrefilled = prefilledFrom !== null && unitPrice === prefilledFrom.price;

  const validateForm = async () => {
    const cleanedBatchId = batchId.trim().toUpperCase();
    const quantityNumber = Number(String(quantity).trim());

    if (!selectedVaccine) {
      return failField("vaccine", "Please select a registered vaccine.");
    }

    if (!selectedVaccine.vaccineName || !selectedVaccine.vaccineType) {
      return failField(
        "vaccine",
        "Selected vaccine is missing required details. Please check the vaccine record."
      );
    }

    if (!manufacturer.trim()) {
      return failField("manufacturer", "Manufacturer is required.");
    }

    if (!cleanedBatchId) {
      return failField("batchId", "Batch ID is required.");
    }

    if (cleanedBatchId.length < 3) {
      return failField("batchId", "Batch ID must be at least 3 characters.");
    }

    // Manufacturing, arrival and expiry, compared as date-only strings against
    // today in Asia/Manila (services/stockBatchDates.js). Same arrival/expiry
    // rules as before; the service repeats this check before writing.
    const dates = validateStockBatchDates({ manufacturingDate, arrivalDate, expiryDate });
    if (!dates.ok) {
      return failField(dates.field, dates.message);
    }

    if (String(quantity).trim() === "" || Number.isNaN(quantityNumber)) {
      return failField("quantity", "Vial quantity is required.");
    }

    if (!Number.isInteger(quantityNumber)) {
      return failField("quantity", "Vial quantity must be a whole number.");
    }

    if (quantityNumber <= 0) {
      return failField("quantity", "Vial quantity must be greater than zero.");
    }

    if (quantityNumber > 1000000) {
      return failField("quantity", "Vial quantity is too large. Please check the encoded amount.");
    }

    // A batch cannot enter inventory unpriced. Sales Rep ordering reads this
    // figure and the invoice bills from it, so "price it later" means shipping
    // a vaccine at ₱0.00 the moment someone forgets.
    const price = parsePesosToCentavos(unitPrice);
    if (!price.ok) {
      return failField(
        "unitPrice",
        {
          empty: "Unit selling price is required.",
          "not-positive": "Selling price must be greater than zero.",
          "not-safe-integer":
            "That amount is too large to record exactly. Please check the encoded figure.",
        }[price.reason] ??
          "Enter the selling price in pesos, e.g. 1250 or 1250.50."
      );
    }

    if (await batchIdExists(cleanedBatchId)) {
      return failField("batchId", "This Batch ID already exists in inventory.");
    }

    return true;
  };

  // A quantity above the usual batch size waits here for the Admin's "yes".
  const [largeQuantityPrompt, setLargeQuantityPrompt] = useState(null);

  const handleSubmit = async (e, { largeQuantityConfirmed = false } = {}) => {
    e?.preventDefault();
    // One write at a time. Set before the await, because validateForm queries
    // Firestore and a second submit could otherwise slip through behind it.
    if (submittingRef.current) return;
    submittingRef.current = true;

    setMessage("");
    setMessageType("error");
    setFieldError(null);

    try {
      const isValid = await validateForm();
      if (!isValid) return;

      const typedQuantity = Number(String(quantity).trim());
      if (isLargeStockQuantity(typedQuantity) && !largeQuantityConfirmed) {
        setLargeQuantityPrompt(typedQuantity);
        return;
      }

      setSaving(true);

      const cleanedBatchId = batchId.trim().toUpperCase();
      const cleanedManufacturer = manufacturer.trim();

      // Identity: `selectedVaccine.id` is the Firestore DOCUMENT id, kept
      // distinct from internalSku (the business SKU) and from the batch id.
      // No storage temperature is sent — none was collected. Name, type, SKU
      // and the expiry-derived status are set by the SERVER from the vaccine
      // document, which also reserves the new stock for waiting future orders
      // in the same transaction.
      const report = await addStockBatch({
        vaccineId: selectedVaccine.id,
        manufacturer: cleanedManufacturer,
        batchId: cleanedBatchId,
        manufacturingDate,
        arrivalDate,
        expiryDate,
        quantity: Number(String(quantity).trim()),
        // Re-parsed rather than carried from validateForm: parsing the typed
        // text in one place means the value written is the value validated,
        // even if the two ever drift apart.
        sellingPriceCentavos: parsePesosToCentavos(unitPrice).value,
        // Every batch price is entered with VAT included (2026-11-11).
        priceIsVatInclusive: true,
        largeQuantityConfirmed,
      }, { submit: addStockBatchWithAllocation });

      setResult(report ?? null);
      showMessage("Stock added successfully.", "success");
    } catch (error) {
      logSafeError("Add stock", error);
      // A duplicate batch id found by the server belongs to that field. Any
      // other domain refusal keeps the server's own sentence (a trusted
      // domain error); everything else gets a safe, mapped message. The form
      // keeps every value the admin typed.
      if (error?.code === "batch-id-exists") {
        failField("batchId", "This Batch ID already exists in inventory.");
      } else {
        showMessage(
          friendlyErrorMessage(
            error,
            "The stock could not be added. Nothing was saved — your entries are still here; please try again."
          )
        );
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <main className="inventory-main">
        <header className="form-page-header">
          <div>
            <p>
              Inventory / <span>Add New Stock</span>
            </p>
            <small>
              Enter vaccine batch details accurately to maintain supply chain
              integrity.
            </small>
          </div>
        </header>

        <form className="stock-form" onSubmit={handleSubmit} onInput={clearFieldErrorFor} onChange={clearFieldErrorFor} noValidate>
          {/* The decorative two-step strip at the top of this form is gone. It
              was not a real stepper — both entries were inert spans on a
              single-page form — and its second entry merely restated the
              batch/logistics section below. The real section headings are
              unchanged. */}
          <section className="form-section-card">
            <h2>
              <ClipboardList size={18} />
              Product Identification
            </h2>

            <div className="two-col-form">
              <div>
                <label htmlFor="stock-vaccine">Registered Vaccine</label>
                <select
                  id="stock-vaccine"
                  value={selectedVaccineId}
                  onChange={(e) => handleVaccineChange(e.target.value)}
                  disabled={loadingVaccines}
                  {...a11y("vaccine")}
                >
                  <option value="">
                    {loadingVaccines
                      ? "Loading vaccines..."
                      : "Select registered vaccine..."}
                  </option>

                  {vaccines.map((vaccine) => (
                    <option key={vaccine.id} value={vaccine.id}>
                      {vaccine.vaccineName}{" "}
                      {vaccine.vaccineType ? `(${vaccine.vaccineType})` : ""}
                    </option>
                  ))}
                </select>
                {fieldMessage("vaccine")}

                {/* Empty state: stock can only be added against a registered
                    vaccine, so point the admin at the one action that unblocks
                    them. No vaccine is created automatically. */}
                {!loadingVaccines && vaccines.length === 0 && (
                  <small className="input-helper" role="status">
                    No vaccines are registered yet. Stock must be added against
                    a registered vaccine —{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => navigate("/admin/add-vaccine")}
                    >
                      Register New Vaccine
                    </button>{" "}
                    first.
                  </small>
                )}
              </div>

              <div>
                <label htmlFor="stock-manufacturer">Manufacturer</label>
                <input
                  id="stock-manufacturer"
                  placeholder="e.g. Pfizer-BioNTech"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  {...a11y("manufacturer", "stock-manufacturer-note")}
                />
                {fieldMessage("manufacturer")}
                <small id="stock-manufacturer-note" className="input-helper">
                  Filled in from the selected vaccine when it has one on record.
                </small>
              </div>
            </div>

            {selectedVaccine && (
              <small className="input-helper">
                Type: {selectedVaccine.vaccineType || "N/A"} | SKU:{" "}
                {selectedVaccine.internalSku || "N/A"}
              </small>
            )}
            {selectedVaccine && suggestion && (
              <p className="stock-suggest-source" role="status">
                Suggestions below are from batch <strong>{suggestion.sourceBatchId || "—"}</strong>
                {suggestion.sourceAddedMs ? `, added ${new Date(suggestion.sourceAddedMs).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" })}` : ""}
                {suggestion.match === "same_vaccine" ? " (this vaccine)." : " (same vaccine type and manufacturer)."}
              </p>
            )}
          </section>

          <section className="form-section-card">
            <h2>
              <Truck size={18} />
              Logistics & Quantity
            </h2>

            {/* Batch ID, Manufacturing, Arrival, Expiry — a responsive 2 × 2. */}
            <div className="two-col-form">
              <div>
                <label htmlFor="stock-batch-id">Batch ID</label>
                <input
                  id="stock-batch-id"
                  placeholder="BT-2026-X90"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value.toUpperCase())}
                  {...a11y("batchId")}
                />
                {fieldMessage("batchId")}
                {!batchId && suggestion?.nextBatchId && (
                  <button type="button" className="stock-suggest-chip" onClick={() => setBatchId(suggestion.nextBatchId)}>
                    Use {suggestion.nextBatchId} <span>next after {suggestion.sourceBatchId}</span>
                  </button>
                )}
              </div>

              <div>
                <label htmlFor="stock-manufacturing-date">Manufacturing Date</label>
                <input
                  id="stock-manufacturing-date"
                  type="date"
                  required
                  value={manufacturingDate}
                  onChange={(e) => setManufacturingDate(e.target.value)}
                  {...a11y("manufacturingDate")}
                />
                {fieldMessage("manufacturingDate")}
              </div>

              <div>
                <label htmlFor="stock-arrival-date">Arrival Date</label>
                <input
                  id="stock-arrival-date"
                  type="date"
                  value={arrivalDate}
                  onChange={(e) => setArrivalDate(e.target.value)}
                  {...a11y("arrivalDate")}
                />
                {fieldMessage("arrivalDate")}
                {!arrivalDate && selectedVaccine && (
                  <button type="button" className="stock-suggest-chip" onClick={() => setArrivalDate(today)}>
                    Use today <span>{shortDate(today)}</span>
                  </button>
                )}
              </div>

              <div>
                <label htmlFor="stock-expiry-date">Expiry Date</label>
                <input
                  id="stock-expiry-date"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  {...a11y("expiryDate")}
                />
                {fieldMessage("expiryDate")}
                {!expiryDate && suggestedExpiry && (
                  <button type="button" className="stock-suggest-chip" onClick={() => setExpiryDate(suggestedExpiry)}>
                    Use {shortDate(suggestedExpiry)} <span>{shelfLifeLabel(suggestion.shelfLife)} shelf life, like {suggestion.sourceBatchId}</span>
                  </button>
                )}
                {!expiryDate && !manufacturingDate && suggestion?.shelfLife && (
                  <small className="input-helper">
                    Enter the manufacturing date to get an expiry suggestion ({shelfLifeLabel(suggestion.shelfLife)} shelf life, like {suggestion.sourceBatchId}). Always check it against the label.
                  </small>
                )}

                {arrivalDate &&
                  expiryDate &&
                  isExpiryAfterArrival(arrivalDate, expiryDate) && (
                    <small className="valid-note">
                      Valid lifecycle detected
                    </small>
                  )}
              </div>
            </div>

            <div className="two-col-form stock-controls">
              <div>
                <label htmlFor="stock-quantity">Unit Quantity (Vials)</label>

                <div className="number-stepper">
                  <button
                    type="button"
                    aria-label="Decrease vial quantity by 100"
                    onClick={() =>
                      setQuantity(Math.max(1, Number(quantity || 0) - 100))
                    }
                  >
                    −
                  </button>

                  <input
                    id="stock-quantity"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 1000"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    {...a11y("quantity")}
                  />

                  <button
                    type="button"
                    aria-label="Increase vial quantity by 100"
                    onClick={() => setQuantity(Number(quantity || 0) + 100)}
                  >
                    +
                  </button>
                </div>
                {fieldMessage("quantity")}
              </div>

              <div>
                <label htmlFor="stock-unit-price">Unit Selling Price (₱)</label>
                <input
                  id="stock-unit-price"
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 1250.00"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(e.target.value)}
                  {...a11y("unitPrice", "stock-unit-price-help")}
                />
                {fieldMessage("unitPrice")}
                <small id="stock-unit-price-help">
                  The amount per vial, with VAT included. This applies to this batch only.
                </small>
                {priceStillPrefilled && (
                  <small className="stock-suggest-filled" role="status">
                    Filled in from batch {prefilledFrom.batchId || "—"}{prefilledFrom.converted ? ", with 12% VAT added (it was entered before VAT)" : ""}. Change it if this delivery&apos;s price differs.
                  </small>
                )}
              </div>


            </div>
          </section>

          {/* Announced, so a validation or write failure is not silent for
              screen-reader users. assertive because it reports the outcome of
              an action the admin just took. */}
          <div aria-live="assertive">
            {message && (
              <p
                role={messageType === "success" ? "status" : "alert"}
                className={
                  messageType === "success"
                    ? "form-response success"
                    : "form-error"
                }
              >
                {message}
              </p>
            )}

            {result && (
              <div className="stock-allocation-report" role="status">
                <dl>
                  <div><dt>Added</dt><dd className="tnum">{result.added.toLocaleString()} vials</dd></div>
                  <div><dt>Reserved for waiting orders</dt><dd className="tnum">{result.allocatedToOrders.toLocaleString()}</dd></div>
                  <div><dt>Left available</dt><dd className="tnum">{result.leftAvailable.toLocaleString()}</dd></div>
                </dl>
                {Array.isArray(result.allocations) && result.allocations.length > 0 ? (
                  <ul>
                    {result.allocations.map((a) => (
                      <li key={a.orderId}>
                        {a.orderNumber || a.orderId}: {a.units.toLocaleString()} reserved —{" "}
                        {a.allocationState === "fully_reserved" ? "now fully reserved" : "still waiting for more stock"}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No future orders were waiting for this vaccine.</p>
                )}
                <button type="button" onClick={() => navigate("/admin/inventory")}>
                  Go to inventory
                </button>
              </div>
            )}
          </div>

          <div className="stock-form-footer">
            <button
              type="button"
              className="outline-btn"
              onClick={() => navigate("/admin/inventory")}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="blue-btn"
              disabled={saving || loadingVaccines || vaccines.length === 0}
            >
              {saving ? "Adding..." : "+ Add Stock"}
            </button>
          </div>
        </form>

        {/* Portaled: this page's <main> is transformed (AdminDialogLayer). */}
        {largeQuantityPrompt !== null && (
          <AdminDialogLayer>
            <ConfirmDialog
              title="Is this quantity correct?"
              target={`Batch ${batchId.trim().toUpperCase()}`}
              consequence={`${largeQuantityMessage(largeQuantityPrompt)} Check the delivery documents. If the figure is right, it will be saved as entered.`}
              confirmLabel={`Yes, add ${largeQuantityPrompt.toLocaleString("en-PH")} vials`}
              busyLabel="Adding…"
              cancelLabel="Change the quantity"
              tone="primary"
              onCancel={() => {
                setLargeQuantityPrompt(null);
                document.getElementById("stock-quantity")?.focus();
              }}
              onConfirm={async () => {
                await handleSubmit(null, { largeQuantityConfirmed: true });
                setLargeQuantityPrompt(null);
              }}
            />
          </AdminDialogLayer>
        )}
      </main>
  );
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isExpiryAfterArrival(arrivalDate, expiryDate) {
  const arrival = normalizeDate(new Date(arrivalDate));
  const expiry = normalizeDate(new Date(expiryDate));

  if (Number.isNaN(arrival.getTime()) || Number.isNaN(expiry.getTime())) {
    return false;
  }

  return expiry > arrival;
}

export default AddStock;
