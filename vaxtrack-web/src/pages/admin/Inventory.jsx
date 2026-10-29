import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, Download, Package, Plus, Search, X } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { subscribeInventory } from "../../services/inventoryService";
import { useInventoryVisibility } from "../../components/useInventoryVisibility";
import InventoryVisibilityToggle from "../../components/inventory/InventoryVisibilityToggle";
import {
  downloadInventoryWorkbook,
  EmptyInventoryExportError,
} from "../../services/inventoryExport";
import {
  deriveExpiryCondition,
  manilaToday,
  WARNING_WITHIN_DAYS,
} from "../../services/expiry";
import { formatBatchDate, readManufacturingDate } from "../../services/stockBatchDates";
import { saveBatchMetadata } from "../../services/batchMetadataService";
import { setVaccineVatClassification, updateStockPrice } from "../../services/vaccineService";
import { correctStockQuantity, newRequestId } from "../../services/inventoryRemovalService";
import { subscribeVaccines } from "../../services/vaccineCatalogService";
import {
  NOT_CLASSIFIED,
  PRODUCT_VAT_CLASSIFICATIONS,
  PRODUCT_VAT_LABELS,
  batchVatClassification,
} from "../../services/vatClassification";
import {
  CORRECTION_REASON_CODES,
  CORRECTION_REASON_LABELS,
  validateStockCorrection,
} from "../../services/stockCorrection";
import {
  centavosToInputValue,
  formatCentavos,
  parsePesosToCentavos,
  readPriceCentavos,
} from "../../services/money";
import KpiCard from "../../components/ui/KpiCard";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { ToastRegion } from "../../components/ui/Feedback";
import StaleEditNotice from "../../components/ui/StaleEditNotice";
import { staleFields } from "../../services/liveFormSync";
import { useToast } from "../../components/ui/useToast";
import ReservationProvenance from "../../components/admin/ReservationProvenance";
import InventoryBatchDialog, { InventoryDialog } from "./InventoryBatchDialog";
import {
  BatchRemovalHistory,
  ManageVaccinesDialog,
  RemoveStockDialog,
  VoidBatchDialog,
} from "./InventoryRemovalDialogs";
import { OUT_OF_STOCK_LABEL, removalSource } from "../../services/inventoryRemovalModel";
import { MAX_STOCK_QUANTITY } from "../../services/orderEligibility";
import { VAT_INCLUSIVE_NOTE } from "../../services/pricingConfig";
import {
  describePriceReconfirmation,
  priceNeedsReconfirmation,
  priceReconfirmationFlag,
} from "../../services/priceReconfirmation";
import "./Inventory.css";

// What each dialog depends on, compared between the batch as opened and live.
const PRICE_KEYS = ["priceCentavos", "priceIsVatInclusive"];
const CORRECTION_KEYS = ["onHandValue", "reservedValue", "returnPendingValue", "quarantinedValue"];
const CORRECTION_LABELS = {
  onHandValue: "The on-hand quantity",
  reservedValue: "The reserved quantity",
  returnPendingValue: "Returned stock awaiting a decision",
  quarantinedValue: "Quarantined stock",
};
const pickFields = (row, keys) => Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));

/* `getDaysUntilExpiry` was deleted. It built its answer from LOCAL midnight
   while the Expired flag beside it used Manila — two date conventions on the
   same row — and every caller now reads `daysRemaining` off the normalized
   item, which the shared helper derives once, date-only, in Manila. */

function formatExpiry(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * One row per batch, showing on hand / reserved / available.
 *
 * Available is DERIVED (`quantity - reserved - returnPending - quarantined`),
 * never stored — a third
 * persisted total would be a number nothing could keep honest. Data problems
 * are surfaced as flags rather than smoothed over: a quantity stored as text
 * reads "—", not "0", because those mean very different things to whoever has
 * to act on the row.
 */
function normalizeInventoryItem(raw, todayIso) {
  // The CURRENT expiry condition, derived from the date. The stored `status` is
  // not consulted: it was stamped when the batch was created and nothing has
  // recomputed it since, so it describes what was true then, not now.
  const expiryCondition = deriveExpiryCondition(raw, todayIso);
  const onHandOk = typeof raw.quantity === "number" && Number.isInteger(raw.quantity);
  const reservedRaw = raw.reservedQuantity;
  const reservedOk =
    reservedRaw === undefined ||
    reservedRaw === null ||
    (typeof reservedRaw === "number" && Number.isInteger(reservedRaw) && reservedRaw >= 0);
  const reserved = typeof reservedRaw === "number" ? reservedRaw : 0;
  // Units back from a failed delivery (awaiting an Admin decision) and units
  // in quarantine are on hand but NOT available. Absent means zero.
  const heldOk = (v) =>
    v === undefined || v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
  const returnPendingOk = heldOk(raw.returnPendingQuantity);
  const quarantinedOk = heldOk(raw.quarantinedQuantity);
  const returnPending = typeof raw.returnPendingQuantity === "number" ? raw.returnPendingQuantity : 0;
  const quarantined = typeof raw.quarantinedQuantity === "number" ? raw.quarantinedQuantity : 0;
  const available =
    onHandOk && reservedOk && returnPendingOk && quarantinedOk
      ? raw.quantity - reserved - returnPending - quarantined
      : null;

  const flags = [];
  if (!onHandOk) {
    flags.push(
      typeof raw.quantity === "string"
        ? "Quantity stored as text — needs migration"
        : "Quantity is not a whole number"
    );
  }
  if (!reservedOk) flags.push("Reserved figure is invalid");
  if (!returnPendingOk || !quarantinedOk) flags.push("Return or quarantine figure is invalid");
  if (onHandOk && raw.quantity > MAX_STOCK_QUANTITY) {
    flags.push("On hand is above 100,000,000 — not allocated or orderable until an Admin confirms it");
  }
  if (returnPending > 0) flags.push(`${returnPending} returned, awaiting decision`);
  if (quarantined > 0) flags.push(`${quarantined} quarantined`);
  // Surfaced as a flag, not smoothed over: an unpriced batch is invisible to
  // ordering, and the admin looking at this row is the person who can fix it.
  const priceCentavos = readPriceCentavos(raw.sellingPriceCentavos);
  if (priceCentavos === null) {
    flags.push(
      raw.sellingPriceCentavos === undefined || raw.sellingPriceCentavos === null
        ? "No selling price — cannot be ordered"
        : "Selling price is invalid — cannot be ordered"
    );
  }
  // Priced under the legacy VAT-exclusive convention (or with none recorded):
  // the server refuses to quote it until an Admin re-confirms the price.
  const reconfirmFlag = priceReconfirmationFlag(raw);
  if (reconfirmFlag) flags.push(reconfirmFlag);
  if (reservedRaw === undefined || reservedRaw === null) flags.push("No reserved field yet");
  if (available !== null && available < 0) flags.push("Held units exceed stock on hand");
  if (expiryCondition.level === "expired") flags.push("Expired");
  // A batch nobody can date is a batch nobody can judge, and the server refuses
  // it for that reason. Surfaced rather than quietly treated as healthy.
  if (expiryCondition.level === "unknown") {
    flags.push("No usable expiry date — cannot be ordered");
  }
  const voided = raw.voided === true;
  // Leads the list so the table's ⚠ title and the Excel export both say it first.
  if (voided) flags.unshift("Voided — kept as a record; not stock and not orderable");

  return {
    id: raw.id,
    // Voided (a mistaken entry, kept as a record): never stock, never ordered.
    voided,
    voidReason: typeof raw.voidReason === "string" ? raw.voidReason : "",
    voidedAt: raw.voidedAt ?? null,
    voidedByEmail: typeof raw.voidedByEmail === "string" ? raw.voidedByEmail : "",
    // Zero available is shown as "Out of stock"; the batch is never removed for it.
    outOfStock: !voided && available === 0,
    // The stored figures the removal dialogs check (inventoryRemovalModel.js).
    source: removalSource(raw),
    name: raw.vaccineName || "—",
    type: raw.vaccineType || "—",
    batch: raw.batchId || "—",
    expiry: formatExpiry(raw.expiryDate),
    expiryRaw: raw.expiryDate || "",
    // Batches created before this field existed have none: "Not recorded",
    // never an invented date and never "Invalid Date".
    manufacturing: formatBatchDate(raw.manufacturingDate),
    // The vaccine product, which holds the VAT classification.
    vaccineId: typeof raw.vaccineId === "string" && raw.vaccineId ? raw.vaccineId : null,
    manufacturingRaw: readManufacturingDate(raw) ?? "",
    onHand: onHandOk ? raw.quantity.toLocaleString() : "—",
    reserved: reservedOk ? reserved.toLocaleString() : "—",
    available: available === null ? "—" : available.toLocaleString(),
    // Numeric counterparts of the display strings above, so the Excel export can
    // write real numeric cells instead of parsing formatted text. Null carries
    // the same "unusable figure" meaning the "—" display does.
    onHandValue: onHandOk ? raw.quantity : null,
    reservedValue: reservedOk ? reserved : null,
    returnPendingValue: returnPendingOk ? returnPending : null,
    quarantinedValue: quarantinedOk ? quarantined : null,
    availableValue: available,
    priceCentavos,
    price: formatCentavos(priceCentavos),
    // The convention the stored price was recorded under, as stored.
    priceIsVatInclusive: typeof raw.priceIsVatInclusive === "boolean" ? raw.priceIsVatInclusive : null,
    priceNeedsReconfirm: priceNeedsReconfirmation(raw),
    flags,
    qty: raw.quantity != null ? Number(raw.quantity).toLocaleString() : "—",
    qtyRaw: raw.quantity != null ? Number(raw.quantity) : 0,
    // `status` is the derived condition's label, `level` its key. Both used to
    // come from the stored field; every consumer of them — the chip, the drawer,
    // the filter and the KPI cards — now follows the expiry date instead.
    status: expiryCondition.label,
    level: expiryCondition.level,
    daysRemaining: expiryCondition.daysRemaining,
    location: raw.location || "—",
    manufacturer: raw.manufacturer || "—",
    metadata: {
      batchId: typeof raw.batchId === "string" ? raw.batchId : "",
      manufacturingDate: typeof raw.manufacturingDate === "string" ? raw.manufacturingDate : "",
      expiryDate: typeof raw.expiryDate === "string" ? raw.expiryDate : "",
      location: typeof raw.location === "string" ? raw.location : "",
      manufacturer: typeof raw.manufacturer === "string" ? raw.manufacturer : "",
    },
    arrivalRaw: typeof raw.arrivalDate === "string" ? raw.arrivalDate : "",
    batchIdLocked: Boolean(raw.firstUsedAt) || raw.usageTracked !== true,
  };
}

function Inventory() {
  const navigate = useNavigate();

  const [inventory, setInventory] = useState([]);
  const [rawInventory, setRawInventory] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  // A failed listener is its own state, never an empty inventory.
  const [loadError, setLoadError] = useState("");
  const [catalogError, setCatalogError] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedVaccine, setSelectedVaccine] = useState(null);
  const [batchDraft, setBatchDraft] = useState(null);
  const [batchBaseline, setBatchBaseline] = useState(null);
  const [savingBatch, setSavingBatch] = useState(false);
  const [batchError, setBatchError] = useState("");
  const { toast, showToast, dismissToast } = useToast();
  const [exporting, setExporting] = useState(false);
  // Vaccine catalog (VAT classification), and the drawer's classification edit.
  const [vaccines, setVaccines] = useState([]);
  const [vatChoice, setVatChoice] = useState("");
  const [savingVat, setSavingVat] = useState(false);

  /**
   * Price-management dialog state.
   *
   * `pricing` holds the batch being re-priced, or null. Deliberately a separate
   * piece of state from `selectedVaccine` so opening the price editor does not
   * also open the detail drawer behind it.
   */
  const [pricing, setPricing] = useState(null);
  const [priceInput, setPriceInput] = useState("");
  const [priceError, setPriceError] = useState("");
  const [savingPrice, setSavingPrice] = useState(false);

  // Stock correction: its own state, separate from the detail drawer, so the
  // corrected figure and reason cannot bleed between batches.
  const [correcting, setCorrecting] = useState(null);
  const [correctInput, setCorrectInput] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  // entry_error | count_discrepancy — damaged/expired/recalled is not a correction.
  const [correctReasonCode, setCorrectReasonCode] = useState("");
  // One id per correction ATTEMPT, kept across retries so the server replays.
  const [correctRequestId, setCorrectRequestId] = useState(() => newRequestId());
  const [correctError, setCorrectError] = useState("");
  // Which field the correction message belongs to: "quantity" | "reasonCode" | "reason" | null.
  const [correctErrorField, setCorrectErrorField] = useState(null);

  // The price and correction dialogs keep the batch as it was when opened.
  // The live row is compared with it on every snapshot: a change made
  // elsewhere is flagged and blocks saving until the Admin loads it or keeps
  // their own figure; a deleted batch blocks saving outright.
  const pricingLive = pricing ? inventory.find((i) => i.id === pricing.id) ?? null : null;
  const pricingGone = Boolean(pricing) && !loading && !loadError && !pricingLive;
  const priceStale = pricingLive ? staleFields(pickFields(pricing, PRICE_KEYS), pickFields(pricingLive, PRICE_KEYS)) : [];
  const priceBlocked = priceStale.length > 0 || pricingGone;
  const correctingLive = correcting ? inventory.find((i) => i.id === correcting.id) ?? null : null;
  const correctingGone = Boolean(correcting) && !loading && !loadError && !correctingLive;
  const correctionStale = correctingLive
    ? staleFields(pickFields(correcting, CORRECTION_KEYS), pickFields(correctingLive, CORRECTION_KEYS))
    : [];
  const correctionBlocked = correctionStale.length > 0 || correctingGone;
  const [savingCorrection, setSavingCorrection] = useState(false);

  // Removal controls (InventoryRemovalDialogs.jsx): each dialog keeps the batch
  // as opened and reads its LIVE row, so its figures never go stale.
  const [removing, setRemoving] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [managingVaccines, setManagingVaccines] = useState(false);
  const removingLive = removing ? inventory.find((i) => i.id === removing.id) ?? null : null;
  const removingGone = Boolean(removing) && !loading && !loadError && !removingLive;
  const voidingLive = voiding ? inventory.find((i) => i.id === voiding.id) ?? null : null;
  const voidingGone = Boolean(voiding) && !loading && !loadError && !voidingLive;

  useEffect(() => {
    const unsubscribe = subscribeInventory((raw) => {
      // Today in Manila, resolved once per snapshot, where the data arrives.
      // The clock is never read during render, so normalization stays pure and
      // two renders of the same batch cannot disagree about what day it is.
      const today = manilaToday(Date.now());
      setRawInventory(raw);
      setInventory(raw.map((item) => normalizeInventoryItem(item, today)));
      setLoadError("");
      setLoading(false);
    }, (error) => {
      setLoadError(liveErrorMessage(error, "inventory"));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const pageSize = 3;

  const openPriceDialog = (item) => {
    setPricing(item);
    // A legacy (VAT-exclusive) price is NOT pre-filled: saving it unchanged
    // would silently re-read it as VAT-inclusive. The Admin enters or picks
    // the figure deliberately.
    setPriceInput(item.priceNeedsReconfirm ? "" : centavosToInputValue(item.priceCentavos));
    setPriceError("");
  };

  const closePriceDialog = () => {
    setPricing(null);
    setPriceInput("");
    setPriceError("");
  };

  /**
   * Save a new selling price for one batch.
   *
   * FORWARD-ONLY, and the dialog says so. Orders already placed keep the price
   * snapshot they were created with; re-pricing here changes what the NEXT
   * order will be quoted and nothing else.
   */
  const handleSavePrice = async () => {
    if (savingPrice || !pricing || priceBlocked) return;

    const parsed = parsePesosToCentavos(priceInput);
    if (!parsed.ok) {
      setPriceError(
        {
          empty: "Enter a selling price.",
          "not-positive": "The price must be greater than zero.",
          "not-safe-integer":
            "That amount is too large to record exactly. Please check the figure.",
        }[parsed.reason] ?? "Enter an amount in pesos, e.g. 1250 or 1250.50."
      );
      document.getElementById("inv-price-input")?.focus();
      return;
    }

    setSavingPrice(true);
    setPriceError("");
    try {
      // No uid is passed: the service reads the authenticated session
      // itself, and the rules refuse anything that is not the caller.
      await updateStockPrice({
        inventoryId: pricing.id,
        sellingPriceCentavos: parsed.value,
      });
      // The live subscription re-renders the row; nothing is patched locally,
      // so what is on screen is what Firestore actually holds.
      closePriceDialog();
      showToast(
        pricing.priceNeedsReconfirm
          ? `Price re-confirmed as VAT-inclusive for batch ${pricing.batch}. It can be ordered again.`
          : `Price updated for batch ${pricing.batch}.`,
        "success"
      );
    } catch (error) {
      logSafeError("Update price", error);
      setPriceError(
        friendlyErrorMessage(error, "The price could not be saved. The previous price still applies — please try again.")
      );
    } finally {
      setSavingPrice(false);
    }
  };

  const openCorrectDialog = (item) => {
    setCorrecting(item);
    setCorrectInput(item.onHandValue != null ? String(item.onHandValue) : "");
    setCorrectReason("");
    setCorrectReasonCode("");
    setCorrectRequestId(newRequestId());
    setCorrectError("");
    setCorrectErrorField(null);
    // Opened from the batch details, it stacks ABOVE them (both are portaled
    // to the viewport and share one dialog stack): Escape or Cancel returns to
    // the batch, with its figures read from the live row.
  };

  const closeCorrectDialog = () => {
    setCorrecting(null);
    setCorrectInput("");
    setCorrectReason("");
    setCorrectReasonCode("");
    setCorrectError("");
    setCorrectErrorField(null);
  };

  /**
   * Correct a batch's on-hand quantity.
   *
   * The same validation the service and the rules apply runs here first, so an
   * impossible figure (below the reserved amount, not a whole number, no reason)
   * is refused before any write. The write itself re-reads the batch and is
   * bounded again server-side, so a stale on-screen figure cannot slip through.
   */
  const handleSaveCorrection = async () => {
    if (savingCorrection || !correcting || correctionBlocked) return;

    const raw = correctInput.trim();
    if (raw === "") {
      setCorrectError("Enter the corrected quantity.");
      setCorrectErrorField("quantity");
      document.getElementById("inv-correct-input")?.focus();
      return;
    }

    const pre = validateStockCorrection({
      newQuantity: Number(raw),
      currentQuantity: correcting.onHandValue,
      reservedQuantity: correcting.reservedValue,
      returnPendingQuantity: correcting.returnPendingValue,
      quarantinedQuantity: correcting.quarantinedValue,
      reasonCode: correctReasonCode,
      reason: correctReason,
      expired: correcting.level === "expired",
    });
    if (!pre.ok) {
      setCorrectError(pre.message);
      setCorrectErrorField(pre.field ?? null);
      document
        .getElementById(
          pre.field === "reason" ? "inv-correct-reason" : pre.field === "reasonCode" ? "inv-correct-code" : "inv-correct-input"
        )
        ?.focus();
      return;
    }

    setSavingCorrection(true);
    setCorrectError("");
    setCorrectErrorField(null);
    try {
      // A server callable: it re-checks the batch as it is NOW (the figure
      // shown must still be the stored one), the held-units floor and the
      // expired-stock rule, and writes a permanent before/after audit entry.
      const result = await correctStockQuantity({
        requestId: correctRequestId,
        inventoryId: correcting.id,
        expectedQuantity: correcting.source.quantity,
        newQuantity: pre.value.newQuantity,
        reasonCode: pre.value.reasonCode,
        reason: pre.value.reason,
      });
      const batch = correcting.batch;
      const freed = (result?.reallocated ?? []).reduce((sum, a) => sum + (a.units || 0), 0);
      closeCorrectDialog();
      showToast(
        freed > 0
          ? `Stock corrected for batch ${batch}. ${freed} vial${freed === 1 ? "" : "s"} went to waiting orders.`
          : `Stock corrected for batch ${batch}.`,
        "success"
      );
    } catch (error) {
      logSafeError("Correct stock", error);
      // A reused id means an earlier attempt already went through.
      if (error?.code === "idempotency-conflict") setCorrectRequestId(newRequestId());
      setCorrectError(
        friendlyErrorMessage(error, "The stock could not be corrected. Nothing was changed — please try again.")
      );
    } finally {
      setSavingCorrection(false);
    }
  };

  // One catalog listener for the page; each batch inherits its product's VAT.
  // A failed catalog is flagged: without it every batch would read "Not
  // classified", which would be a statement nothing checked.
  useEffect(
    () =>
      subscribeVaccines(
        (docs) => {
          setVaccines(docs);
          setCatalogError(false);
        },
        () => setCatalogError(true)
      ),
    []
  );
  const vaccinesById = useMemo(() => new Map(vaccines.map((v) => [v.id, v])), [vaccines]);
  const inactiveIds = useInventoryVisibility(catalogError ? null : vaccines, rawInventory);
  const listedInventory = useMemo(
    () => showInactive ? inventory : inventory.filter((item) => !inactiveIds.has(item.vaccineId)),
    [inventory, showInactive, inactiveIds]
  );
  const inventoryWithVat = useMemo(
    () =>
      inventory.map((item) => {
        const cls = batchVatClassification(item, vaccinesById);
        return {
          ...item,
          vatClassification: cls,
          vatLabel: cls ? PRODUCT_VAT_LABELS[cls] : NOT_CLASSIFIED,
          vaccineProductName: vaccinesById.get(item.vaccineId)?.vaccineName || item.name,
          vaccineArchived: vaccinesById.get(item.vaccineId)?.archived === true,
        };
      }),
    [inventory, vaccinesById]
  );
  // The drawer reads the live row, so a classification saved from it shows at once.
  const drawerItem = selectedVaccine
    ? inventoryWithVat.find((item) => item.id === selectedVaccine.id) ?? selectedVaccine
    : null;

  const openBatchDetails = (item) => {
    setSelectedVaccine(item);
    setBatchBaseline({ ...item.metadata });
    setBatchDraft({ ...item.metadata });
    setBatchError("");
  };
  const closeBatchDetails = () => {
    if (savingBatch) return;
    setSelectedVaccine(null);
    setBatchDraft(null);
    setBatchBaseline(null);
    setBatchError("");
  };
  const saveBatchDetails = async () => {
    if (!drawerItem || !batchDraft || !batchBaseline || savingBatch) return;
    if (Object.keys(batchBaseline).every((key) => batchDraft[key]?.trim() === batchBaseline[key])) {
      closeBatchDetails();
      return;
    }
    if (!batchDraft.batchId.trim() || !batchDraft.manufacturingDate || !batchDraft.expiryDate ||
        !batchDraft.location.trim() || !batchDraft.manufacturer.trim()) {
      setBatchError("Complete all batch detail fields before saving.");
      return;
    }
    setSavingBatch(true);
    setBatchError("");
    try {
      await saveBatchMetadata({ inventoryId: drawerItem.id, expected: batchBaseline, ...batchDraft });
      showToast("Batch details saved. Stock quantities were unchanged.", "success");
      setSelectedVaccine(null);
      setBatchDraft(null);
      setBatchBaseline(null);
    } catch (error) {
      logSafeError("Save batch details", error);
      setBatchError(friendlyErrorMessage(error, "Batch details could not be saved. Review the current record and try again."));
    } finally {
      setSavingBatch(false);
    }
  };

  const saveVatClassification = async () => {
    if (!drawerItem?.vaccineId || savingVat || !vatChoice) return;
    setSavingVat(true);
    try {
      await setVaccineVatClassification(drawerItem.vaccineId, vatChoice);
      setVatChoice("");
      showToast(
        `${drawerItem.vaccineProductName} is now ${PRODUCT_VAT_LABELS[vatChoice]}. Future orders use it; existing orders are unchanged.`,
        "success"
      );
    } catch (error) {
      logSafeError("Set VAT classification", error);
      showToast(
        friendlyErrorMessage(error, "The VAT classification could not be saved. Nothing was changed — please try again."),
        "error"
      );
    } finally {
      setSavingVat(false);
    }
  };

  const filteredVaccines = useMemo(() => {
    return inventoryWithVat.filter((item) => {
      if (!showInactive && inactiveIds.has(item.vaccineId)) return false;
      const searchValue =
        `${item.name} ${item.type} ${item.batch} ${item.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "all" || item.level === statusFilter;

      // Read off the row rather than recomputed, so the window filter and the
      // level it sits beside can never be measured from two different days.
      const daysUntilExpiry = item.daysRemaining ?? Infinity;
      const matchesExpiry =
        expiryFilter === "all" ||
        (daysUntilExpiry >= 0 && daysUntilExpiry <= Number(expiryFilter));

      return matchesSearch && matchesStatus && matchesExpiry;
    });
  }, [inventoryWithVat, searchTerm, statusFilter, expiryFilter, showInactive, inactiveIds]);

  /**
   * Download the currently filtered inventory as a real .xlsx workbook.
   *
   * Exports every matching in-memory row in the order shown — not just the
   * paginated page — so the file reflects the admin's active search and filters.
   * The heavy spreadsheet library is imported lazily inside the service, so it
   * stays out of the initial bundle until this button is pressed.
   */
  const handleExport = async () => {
    // Guard against a second click while a workbook is already being built, and
    // against generating a misleading empty file.
    if (exporting || filteredVaccines.length === 0) return;

    setExporting(true);
    try {
      const { fileName } = await downloadInventoryWorkbook(filteredVaccines);
      showToast(`Downloaded ${filteredVaccines.length} batches to ${fileName}.`, "success");
    } catch (error) {
      if (error instanceof EmptyInventoryExportError) return;
      logSafeError("Inventory export", error);
      showToast("The inventory download failed. Please try again.", "error");
    } finally {
      setExporting(false);
    }
  };

  // Voided batches are records of mistaken entries, not stock: they stay in the
  // table (tagged) but never count toward the stock figures and expiry cards.
  const stockBatches = useMemo(() => listedInventory.filter((i) => !i.voided), [listedInventory]);
  // Batches per vaccine product, for Manage vaccines.
  const batchCounts = useMemo(() => {
    const counts = new Map();
    for (const i of inventory) if (!i.voided && i.vaccineId) counts.set(i.vaccineId, (counts.get(i.vaccineId) ?? 0) + 1);
    return counts;
  }, [inventory]);

  const stockByType = useMemo(() => {
    if (stockBatches.length === 0) return [];
    const totals = {};
    stockBatches.forEach((item) => {
      const key = item.type !== "—" ? item.type : "Unknown";
      totals[key] = (totals[key] || 0) + item.qtyRaw;
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const maxQty = sorted[0]?.[1] || 1;
    const tones = ["blue", "green", "gold", "red", "purple"];
    return sorted.map(([label, totalQty], i) => ({
      label,
      totalQty,
      percentage: Math.max(4, Math.round((totalQty / maxQty) * 100)),
      tone: tones[i % tones.length],
    }));
  }, [stockBatches]);

  const criticalAndExpiring = useMemo(() => {
    const days = (i) => i.daysRemaining ?? Infinity;
    return stockBatches
      .filter((i) => i.level === "expired" || i.level === "critical")
      .sort((a, b) => days(a) - days(b))
      .slice(0, 4);
  }, [stockBatches]);

  const criticalCount = useMemo(
    () => stockBatches.filter((i) => i.level === "critical").length,
    [stockBatches]
  );
  const expiringSoonCount = useMemo(
    () =>
      stockBatches.filter((i) => {
        const days = i.daysRemaining ?? Infinity;
        return days >= 0 && days <= WARNING_WITHIN_DAYS;
      }).length,
    [stockBatches]
  );
  const stableCount = useMemo(
    () => stockBatches.filter((i) => i.level === "stable").length,
    [stockBatches]
  );

  const totalPages = Math.max(1, Math.ceil(filteredVaccines.length / pageSize));

  // Changing a filter can leave the current page past the end of the results.
  // Clamped here during render rather than reset from an effect: setting state
  // in an effect body renders once with the stale page and again with the new
  // one, and the intermediate frame is the wrong page.
  const safePage = Math.min(currentPage, totalPages);

  const paginatedVaccines = filteredVaccines.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  // The open price dialog's legacy-price choice (VAT recorded as exclusive),
  // or null for an ordinary re-price.
  const reconfirm = pricing
    ? describePriceReconfirmation({
        priceCentavos: pricing.priceCentavos,
        priceIsVatInclusive: pricing.priceIsVatInclusive,
        vatClassification: pricing.vatClassification ?? null,
      })
    : null;

  const startItem =
    filteredVaccines.length === 0 ? 0 : (safePage - 1) * pageSize + 1;

  const endItem = Math.min(safePage * pageSize, filteredVaccines.length);

  return (
    <AdminLayout
      active="inventory"
      title="Inventory"
      description="Real-time vaccine stock and batch status."
      actions={
        <>
          {/* Exports the currently filtered inventory to a real .xlsx workbook.
              Disabled while loading, while a workbook is generating, or when no
              rows match — so it never produces a misleading empty file. */}
          <button
            type="button"
            className="v2-light-action"
            onClick={handleExport}
            disabled={loading || exporting || filteredVaccines.length === 0}
          >
            <Download size={16} aria-hidden="true" />
            {exporting ? "Exporting…" : "Export to Excel"}
          </button>
          <button
            type="button"
            className="v2-light-action"
            onClick={() => setManagingVaccines(true)}
            disabled={loading}
          >
            <Archive size={16} aria-hidden="true" />
            Manage vaccines
          </button>
          <button
            type="button"
            className="v2-light-action"
            onClick={() => navigate("/admin/add-vaccine")}
          >
            <Plus size={16} aria-hidden="true" />
            Add Vaccine
          </button>
          <button
            type="button"
            className="v2-blue-action"
            onClick={() => navigate("/admin/add-stock")}
          >
            <Plus size={16} aria-hidden="true" />
            Add Stock
          </button>
        </>
      }
    >
      <ToastRegion toast={toast} onDismiss={dismissToast} />

        <section className="v2-inventory-summary-grid">
          <KpiCard
            label="Total batches"
            value={loading || loadError ? "—" : listedInventory.length}
            context={showInactive ? "Including inactive inventory" : "Excluding long-empty inventory"}
            tone="neutral"
            onClick={() => setStatusFilter("all")}
          />

          {/* Each card counts one derived expiry level, so its figure always
              matches the list its click filters to. The old set counted the
              stored status and mislabelled it: "Warning batches / Temperature
              exceptions" described a temperature check this page has never
              performed, and "Stable batches / No action required" pronounced a
              batch fine on its expiry date alone — quantity, reserved figures
              and pricing are separate concerns, surfaced as row flags. */}
          <KpiCard
            label="Expired"
            value={loading || loadError ? "—" : stockBatches.filter((i) => i.level === "expired").length}
            context="Past expiry date — not orderable"
            tone="danger"
            attention
            onClick={() => setStatusFilter("expired")}
          />

          <KpiCard
            label="Expiring within 30 days"
            value={loading || loadError ? "—" : stockBatches.filter((i) => i.level === "critical").length}
            context="By expiry date"
            tone="warning"
            onClick={() => setStatusFilter("critical")}
          />

          {/* The three ranges are exclusive, so each batch is counted once and
              the labels say which band they cover. "Expiring within 90 days"
              read as 0–90 while the count was only the warning level, so a
              batch expiring next week was missing from the figure its label
              promised. */}
          <KpiCard
            label="Expiring in 31–90 days"
            value={loading || loadError ? "—" : stockBatches.filter((i) => i.level === "warning").length}
            context="By expiry date"
            tone="neutral"
            onClick={() => setStatusFilter("warning")}
          />
        </section>

        <section className="v2-hub-grid">
          <StockOverviewCard groups={stockByType} loading={loading} unavailable={Boolean(loadError)} />

          <CriticalExpiringCard batches={criticalAndExpiring} loading={loading} unavailable={Boolean(loadError)} />

          <InventoryAlertCard
            critical={criticalCount}
            expiringSoon={expiringSoonCount}
            stable={stableCount}
            loading={loading || Boolean(loadError)}
          />
        </section>

        <section className="v2-inventory-table-card">
          <InventoryVisibilityToggle checked={showInactive} count={inactiveIds.size}
            onChange={(value) => { setShowInactive(value); setCurrentPage(1); }} />
          <div className="v2-inventory-toolbar">
            <div className="v2-inventory-search">
              <Search size={15} />
              <input
                placeholder="Search vaccine name, batch ID, or type..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <div className="v2-inventory-filters">
              <button
                type="button"
                className={statusFilter === "all" ? "active" : ""}
                onClick={() => setStatusFilter("all")}
              >
                All
              </button>

              {/* One chip per derived level, so every batch is reachable —
                  including the two the old chips had no way to show: expired,
                  and undated. */}
              <button
                type="button"
                className={statusFilter === "expired" ? "active" : ""}
                onClick={() => setStatusFilter("expired")}
              >
                Expired
              </button>

              <button
                type="button"
                className={statusFilter === "critical" ? "active" : ""}
                onClick={() => setStatusFilter("critical")}
              >
                Within 30 days
              </button>

              <button
                type="button"
                className={statusFilter === "warning" ? "active" : ""}
                onClick={() => setStatusFilter("warning")}
              >
                Within 90 days
              </button>

              <button
                type="button"
                className={statusFilter === "stable" ? "active" : ""}
                onClick={() => setStatusFilter("stable")}
              >
                In date
              </button>

              <button
                type="button"
                className={statusFilter === "unknown" ? "active" : ""}
                onClick={() => setStatusFilter("unknown")}
              >
                No expiry date
              </button>

              <select
                className="v2-expiry-select"
                value={expiryFilter}
                onChange={(e) => setExpiryFilter(e.target.value)}
              >
                <option value="all">Expiry: All Batches</option>
                <option value="30">Expiry: Next 30 Days</option>
                <option value="90">Expiry: Next 90 Days</option>
                <option value="180">Expiry: Next 180 Days</option>
              </select>
            </div>
          </div>

          {/* The bulk bar is gone.
              "Mark as Checked" and "Generate Report" only raised a toast — no
              batch was marked, no report produced — and "Clear" existed solely
              to undo a selection that did nothing. Selecting rows had no
              supported operation behind it at all, so the checkboxes went with
              it. Per-batch actions are unaffected: Set/Edit price still writes,
              and a row still opens its detail drawer. */}
          {/* "On hand" is the batch's `quantity`: every unit the business holds
              and has not yet DELIVERED. It drops only when a delivery is
              completed, a return is written off as missing, or an Admin
              corrects it — so it includes stock out with riders. */}
          <p className="inv-onhand-note">
            On hand counts every unit not yet delivered, including stock reserved for orders, out with
            riders, returned from a failed delivery and awaiting a decision, or quarantined. Available is
            what remains for new orders.
          </p>
          <div className="v2-table-scroll">
            <table className="v2-vaccine-table">
              <thead>
                <tr>
                  <th>Vaccine name</th>
                  <th>Batch ID</th>
                  <th>Expiry date</th>
                  <th title="Not yet delivered — includes stock out with riders">On hand</th>
                <th>Reserved</th>
                <th title="On hand minus reserved, returned-awaiting-decision and quarantined">Available</th>
                  <th>Unit price</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {paginatedVaccines.map((item) => (
                  <tr
                    key={item.id}
                    className={`v2-row-${item.level}`}
                    onClick={() => openBatchDetails(item)}
                  >
                    <td>
                      <div className="v2-vaccine-cell">
                        <span>
                          <Package size={15} />
                        </span>

                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.type}</small>
                          {item.voided && <span className="inv-tag inv-tag-voided">Voided</span>}
                          {item.vaccineArchived && <span className="inv-tag inv-tag-archived">Vaccine archived</span>}
                          {inactiveIds.has(item.vaccineId) && <span className="inv-tag">Inactive — long-empty stock</span>}
                        </div>
                      </div>
                    </td>

                    <td>{item.batch}</td>
                    <td>{item.expiry}</td>
                    <td>{item.onHand}</td>
                    <td>{item.reserved}</td>
                    <td>
                      {item.voided ? "—" : item.available}
                      {item.outOfStock && <small className="inv-out-of-stock">{OUT_OF_STOCK_LABEL}</small>}
                      {item.flags.length > 0 && (
                        <span className="inv-flag" title={item.flags.join(" · ")}>
                          {' '}⚠
                        </span>
                      )}
                    </td>

                    {/* An unpriced batch reads "—", never "₱0.00". Zero is a
                        price someone chose; this is the absence of one, and
                        the two lead to different actions. */}
                    <td className={item.priceCentavos === null ? "inv-unpriced" : "tnum"}>
                      {item.price}
                      {item.priceNeedsReconfirm && (
                        <small className="inv-price-legacy-tag">
                          {item.priceIsVatInclusive === false ? "Legacy · VAT exclusive" : "VAT not recorded"}
                        </small>
                      )}
                    </td>

                    <td>
                      <span className={`v2-stock-status ${item.level}`}>
                        {item.status}
                      </span>
                    </td>

                    <td onClick={(e) => e.stopPropagation()}>
                      {/* A voided batch is a record, not stock: nothing to price. */}
                      {!item.voided && <button
                        type="button"
                        className="inv-price-btn"
                        onClick={() => openPriceDialog(item)}
                      >
                        {item.priceCentavos === null
                          ? "Set price"
                          : item.priceNeedsReconfirm
                            ? "Re-confirm price"
                            : "Edit price"}
                      </button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {loading && (
            <div className="v2-empty-inventory">
              <Package size={28} />
              <strong>Loading inventory...</strong>
              <p>Fetching vaccine batches from Firestore.</p>
            </div>
          )}

          {!loading && loadError && (
            <div className="v2-empty-inventory" role="alert">
              <Package size={28} />
              <strong>Inventory unavailable</strong>
              <p>{loadError}</p>
            </div>
          )}

          {!loading && !loadError && catalogError && (
            <p className="v2-catalog-notice" role="status">
              Product VAT classifications could not be loaded, so they are not shown accurately here.
            </p>
          )}

          {!loading && !loadError && filteredVaccines.length === 0 && (
            <div className="v2-empty-inventory">
              <Package size={28} />
              <strong>No vaccine batches found</strong>
              <p>
                {inventory.length === 0
                  ? "No stock has been added yet. Use Add Stock to register a batch."
                  : "Try changing the search keyword or selected filters."}
              </p>
            </div>
          )}

          <div className="v2-inventory-footer">
            <p>
              Showing {startItem}–{endItem} of {filteredVaccines.length} filtered
              batches. Full inventory count: {inventory.length} batches.
            </p>

            <div className="v2-pagination">
              <button
                type="button"
                disabled={safePage === 1}
                onClick={() => setCurrentPage(Math.max(safePage - 1, 1))}
              >
                Previous
              </button>

              {Array.from({ length: totalPages }, (_, index) => index + 1).map(
                (page) => (
                  <button
                    key={page}
                    type="button"
                    className={safePage === page ? "active" : ""}
                    onClick={() => setCurrentPage(page)}
                  >
                    {page}
                  </button>
                )
              )}

              <button
                type="button"
                disabled={safePage === totalPages}
                onClick={() =>
                  setCurrentPage(Math.min(safePage + 1, totalPages))
                }
              >
                Next
              </button>
            </div>
          </div>
        </section>

      {drawerItem && (
        <InventoryBatchDialog
          resetKey={drawerItem.id}
          badge={drawerItem.voided ? "Voided" : drawerItem.status}
          badgeTone={drawerItem.voided ? "unknown" : drawerItem.level}
          title={drawerItem.name}
          description={`${drawerItem.type} vaccine batch details.`}
          onClose={closeBatchDetails}
          footer={
            <div className="inv-batch-footer-stack">
            <div className="inv-batch-save-actions">
              <button type="button" className="inv-price-cancel" onClick={closeBatchDetails} disabled={savingBatch}>Cancel</button>
              <button type="button" className="v2-blue-action" onClick={saveBatchDetails} disabled={savingBatch || drawerItem.voided || !batchDraft || Object.keys(batchBaseline || {}).every((key) => batchDraft[key]?.trim() === batchBaseline[key])}>
                {savingBatch ? "Saving…" : "Save Changes"}
              </button>
            </div>
            <div className="v2-modal-actions">
              <button
                type="button"
                className="v2-blue-action"
                onClick={() => navigate("/admin/add-stock")}
              >
                Add Stock
              </button>

              <button
                type="button"
                className="inv-price-cancel"
                onClick={() => openCorrectDialog(drawerItem)}
                disabled={drawerItem.voided}
              >
                Correct stock
              </button>

              {/* Removal controls — server-checked, audited, never a delete. */}
              <button
                type="button"
                className="inv-price-cancel"
                onClick={() => setRemoving(drawerItem)}
                disabled={drawerItem.voided}
              >
                Remove unusable stock
              </button>

              <button
                type="button"
                className="inv-price-cancel inv-danger-outline"
                onClick={() => setVoiding(drawerItem)}
                disabled={drawerItem.voided}
              >
                Void batch
              </button>

              {/* "View Batch History" and "Flag for Review" were removed.
                  Neither had anything behind it: there is no history source to
                  open — a batch document holds only its current state, with no
                  audit trail of changes — and no flag schema, writer, reader or
                  review workflow exists, so "flagged for review" recorded
                  nothing and no one would ever have seen it.

                  Both are worth building, and neither is invented here: a
                  history view needs an append-only trail that does not exist
                  yet, and a review flag needs a decision about what a flag
                  means and who acts on it. "Add Stock" stays because it really
                  navigates, and the batch's price is edited from its table row. */}
            </div>
            </div>
          }
        >
            {drawerItem.voided && (
              <p className="inv-removal-warning" role="note">
                Voided{drawerItem.voidedByEmail ? ` by ${drawerItem.voidedByEmail}` : ""}
                {drawerItem.voidReason ? ` — ${drawerItem.voidReason}` : ""}. This batch is kept as a record only: it is
                not stock and cannot be ordered.
              </p>
            )}
            {drawerItem.vaccineArchived && !drawerItem.voided && (
              <p className="inv-removal-warning" role="note">
                {drawerItem.vaccineProductName} is archived, so this batch is not offered for new orders. Orders already
                waiting for it can still receive its stock. Restore the vaccine from Manage vaccines.
              </p>
            )}
            <div className="v2-modal-detail-grid">
              <div>
                <label htmlFor="inv-batch-id">Batch ID</label>
                <input id="inv-batch-id" value={batchDraft?.batchId ?? ""} maxLength={64} disabled={savingBatch || drawerItem.voided || drawerItem.batchIdLocked} onChange={(e) => setBatchDraft((old) => ({ ...old, batchId: e.target.value }))} />
                {drawerItem.batchIdLocked && <small>Locked after first use or where usage history is unknown.</small>}
              </div>

              <div>
                <span>On hand (not yet delivered) / Reserved / Available</span>
                <strong>
                  {drawerItem.onHand} / {drawerItem.reserved} /{" "}
                  {drawerItem.voided ? "—" : drawerItem.available}
                  {drawerItem.outOfStock && <small className="inv-out-of-stock">{OUT_OF_STOCK_LABEL}</small>}
                </strong>
                {drawerItem.flags.length > 0 && (
                  <small className="inv-flag-list">
                    {drawerItem.flags.join(" · ")}
                  </small>
                )}
                <small>Quantity changes use Correct stock or Add Stock so they are validated and logged.</small>
              </div>

              <div>
                <label htmlFor="inv-batch-manufacturing">Manufacturing Date</label>
                <input id="inv-batch-manufacturing" type="date" value={batchDraft?.manufacturingDate ?? ""} disabled={savingBatch || drawerItem.voided} onChange={(e) => setBatchDraft((old) => ({ ...old, manufacturingDate: e.target.value }))} />
              </div>

              <div>
                <label htmlFor="inv-batch-expiry">Expiry Date</label>
                <input id="inv-batch-expiry" type="date" value={batchDraft?.expiryDate ?? ""} disabled={savingBatch || drawerItem.voided} onChange={(e) => setBatchDraft((old) => ({ ...old, expiryDate: e.target.value }))} />
              </div>

              <div>
                <label htmlFor="inv-batch-location">Location</label>
                <input id="inv-batch-location" value={batchDraft?.location ?? ""} maxLength={120} disabled={savingBatch || drawerItem.voided} onChange={(e) => setBatchDraft((old) => ({ ...old, location: e.target.value }))} />
              </div>

              <div>
                <label htmlFor="inv-batch-manufacturer">Manufacturer</label>
                <input id="inv-batch-manufacturer" value={batchDraft?.manufacturer ?? ""} maxLength={120} disabled={savingBatch || drawerItem.voided} onChange={(e) => setBatchDraft((old) => ({ ...old, manufacturer: e.target.value }))} />
              </div>

              <div className="inv-vat-field">
                <span>VAT Classification</span>
                <strong>{drawerItem.vatLabel}</strong>
                {drawerItem.vaccineId ? (
                  <div className="inv-vat-edit">
                    <select
                      id="inv-vat-choice"
                      aria-label="Set VAT classification for this vaccine"
                      value={vatChoice}
                      onChange={(e) => setVatChoice(e.target.value)}
                      disabled={savingVat}
                    >
                      <option value="">{drawerItem.vatClassification ? "Change…" : "Classify…"}</option>
                      {PRODUCT_VAT_CLASSIFICATIONS.filter((v) => v !== drawerItem.vatClassification).map((v) => (
                        <option key={v} value={v}>
                          {PRODUCT_VAT_LABELS[v]}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={saveVatClassification} disabled={!vatChoice || savingVat}>
                      {savingVat ? "Saving…" : "Save"}
                    </button>
                    <small>Applies to {drawerItem.vaccineProductName} for future orders only.</small>
                  </div>
                ) : (
                  <small>
                    Not linked to a registered vaccine, so it cannot be classified
                    or ordered.
                  </small>
                )}
              </div>
            </div>
            {batchError && <p className="inv-batch-error" role="alert">{batchError}</p>}

            {/* "2 reserved" is always inspectable: which orders hold it,
                and whether those add up to the batch's counter. */}
            <ReservationProvenance key={drawerItem.id} inventoryId={drawerItem.id} />

            {/* Quarantine, disposal and void entries for this batch (audit). */}
            <BatchRemovalHistory inventoryId={drawerItem.id} />
        </InventoryBatchDialog>
      )}

      {removing && (
        <RemoveStockDialog
          key={removing.id}
          item={removing}
          live={removingLive}
          gone={removingGone}
          onClose={() => setRemoving(null)}
          onDone={(message) => {
            setRemoving(null);
            showToast(message, "success");
          }}
        />
      )}

      {voiding && (
        <VoidBatchDialog
          key={voiding.id}
          item={voiding}
          live={voidingLive}
          gone={voidingGone}
          onClose={() => setVoiding(null)}
          onDone={(message) => {
            setVoiding(null);
            showToast(message, "success");
          }}
          onRemoveInstead={() => {
            const batch = voiding;
            setVoiding(null);
            setRemoving(batch);
          }}
        />
      )}

      {managingVaccines && (
        <ManageVaccinesDialog
          vaccines={vaccines}
          batchCounts={batchCounts}
          onClose={() => setManagingVaccines(false)}
          onDone={(message) => showToast(message, "success")}
        />
      )}

      {pricing && (
        <InventoryDialog
          labelledBy="inv-price-title"
          onClose={closePriceDialog}
          busy={savingPrice}
          className="inv-price-modal"
        >
            <button
              type="button"
              className="v2-inventory-modal-close"
              onClick={closePriceDialog}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <h2 id="inv-price-title">{reconfirm ? "Re-confirm selling price" : "Set selling price"}</h2>

            <p className="inv-price-batch">
              <strong>{pricing.name}</strong>
              <span>Batch {pricing.batch}</span>
            </p>

            {/* A legacy price: show what was recorded and what it came to, and
                let the Admin choose. Nothing is converted automatically — a
                choice only fills the field; Save is still required. */}
            {reconfirm && (
              <div className="inv-price-legacy" role="note">
                <p className="inv-price-legacy-note">{reconfirm.recordedNote}</p>
                <p>{reconfirm.recordedLine}</p>
                <p>{reconfirm.explanation}</p>
                <p>Enter the new price including VAT, or pick one:</p>
                <div className="inv-price-legacy-options">
                  {reconfirm.options.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className="inv-price-legacy-option"
                      onClick={() => {
                        setPriceInput(centavosToInputValue(option.centavos));
                        setPriceError("");
                      }}
                      disabled={savingPrice}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label htmlFor="inv-price-input">Unit selling price (₱)</label>
            <input
              id="inv-price-input"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 1250.00"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              aria-invalid={priceError ? "true" : undefined}
              aria-describedby={priceError ? "inv-price-error inv-price-help" : "inv-price-help"}
            />
            <small id="inv-price-help">
              Price per vial charged to the clinic. {VAT_INCLUSIVE_NOTE} Applies
              to this batch only, and only to orders placed from now on — orders
              already placed keep the price they were quoted.
            </small>

            <StaleEditNotice
              labels={priceStale.length > 0 ? ["The selling price"] : []}
              gone={pricingGone}
              what="this batch"
              disabled={savingPrice}
              onLoadLatest={() => {
                setPricing(pricingLive);
                setPriceInput(pricingLive.priceNeedsReconfirm ? "" : centavosToInputValue(pricingLive.priceCentavos));
                setPriceError("");
              }}
              onKeepMine={() => setPricing(pricingLive)}
            />

            {/* assertive: it reports the outcome of an action just taken. */}
            <div aria-live="assertive">
              {priceError && (
                <p id="inv-price-error" className="inv-price-error" role="alert">
                  {priceError}
                </p>
              )}
            </div>

            <div className="inv-price-actions">
              <button
                type="button"
                className="inv-price-cancel"
                onClick={closePriceDialog}
                disabled={savingPrice}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inv-price-save"
                onClick={handleSavePrice}
                disabled={savingPrice || priceBlocked}
              >
                {savingPrice ? "Saving…" : reconfirm ? "Confirm VAT-inclusive price" : "Save price"}
              </button>
            </div>
        </InventoryDialog>
      )}

      {correcting && (
        <InventoryDialog
          labelledBy="inv-correct-title"
          onClose={closeCorrectDialog}
          busy={savingCorrection}
          className="inv-price-modal"
        >
            <button
              type="button"
              className="v2-inventory-modal-close"
              onClick={closeCorrectDialog}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <h2 id="inv-correct-title">Correct stock quantity</h2>

            <p className="inv-price-batch">
              <strong>{correcting.name}</strong>
              <span>Batch {correcting.batch}</span>
            </p>

            <p className="inv-correct-current">
              On hand <strong>{correcting.onHand}</strong> · Reserved{" "}
              <strong>{correcting.reserved}</strong> · Available{" "}
              <strong>{correcting.available}</strong>
            </p>

            <label htmlFor="inv-correct-input">Corrected on-hand quantity (vials)</label>
            <input
              id="inv-correct-input"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              placeholder="e.g. 120"
              value={correctInput}
              onChange={(e) => setCorrectInput(e.target.value)}
              aria-invalid={correctErrorField === "quantity" ? "true" : undefined}
              aria-describedby={
                correctError && correctErrorField !== "reason" ? "inv-correct-error inv-correct-help" : "inv-correct-help"
              }
            />
            <small id="inv-correct-help">
              Fixes the recorded on-hand figure. It cannot go below the doses
              reserved, returned awaiting a decision or quarantined, and
              it does not change reservations or any order already placed.
              Damaged, expired or recalled doses are not a correction — use
              Remove unusable stock.
            </small>

            <label htmlFor="inv-correct-code">What kind of correction is this?</label>
            <select
              id="inv-correct-code"
              className="inv-correct-code"
              value={correctReasonCode}
              onChange={(e) => setCorrectReasonCode(e.target.value)}
              aria-invalid={correctErrorField === "reasonCode" ? "true" : undefined}
            >
              <option value="">Choose…</option>
              {CORRECTION_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {CORRECTION_REASON_LABELS[code]}
                </option>
              ))}
            </select>

            <label htmlFor="inv-correct-reason">Reason — at least 10 characters (kept permanently in the audit trail)</label>
            <textarea
              id="inv-correct-reason"
              rows={2}
              placeholder="e.g. Miscounted at intake — recount confirms 120"
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              aria-invalid={correctErrorField === "reason" ? "true" : undefined}
              aria-describedby={correctErrorField === "reason" ? "inv-correct-error" : undefined}
            />

            <StaleEditNotice
              labels={correctionStale.map((f) => CORRECTION_LABELS[f] ?? f)}
              gone={correctingGone}
              what="this batch"
              disabled={savingCorrection}
              onLoadLatest={() => {
                setCorrecting(correctingLive);
                setCorrectInput(correctingLive.onHandValue != null ? String(correctingLive.onHandValue) : "");
                setCorrectError("");
                setCorrectErrorField(null);
              }}
              onKeepMine={() => setCorrecting(correctingLive)}
            />

            {/* assertive: it reports the outcome of an action just taken. */}
            <div aria-live="assertive">
              {correctError && (
                <p id="inv-correct-error" className="inv-price-error" role="alert">
                  {correctError}
                </p>
              )}
            </div>

            <div className="inv-price-actions">
              <button
                type="button"
                className="inv-price-cancel"
                onClick={closeCorrectDialog}
                disabled={savingCorrection}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inv-price-save"
                onClick={handleSaveCorrection}
                disabled={savingCorrection || correctionBlocked}
              >
                {savingCorrection ? "Saving…" : "Save correction"}
              </button>
            </div>
        </InventoryDialog>
      )}
    </AdminLayout>
  );
}

function StockOverviewCard({ groups, loading, unavailable }) {
  return (
    <div className="v2-hub-card">
      <div className="v2-card-head">
        <h2>Current Stock Overview</h2>
        <p>Total doses available by vaccine type</p>
      </div>

      {loading ? (
        <p className="v2-stock-empty">Loading...</p>
      ) : unavailable ? (
        <p className="v2-stock-empty">Inventory could not be loaded.</p>
      ) : groups.length === 0 ? (
        <p className="v2-stock-empty">No inventory data yet. Add stock to see the overview.</p>
      ) : (
        <div className="v2-stock-list">
          {groups.map((g) => (
            <div className="v2-stock-row" key={g.label}>
              <span className="v2-stock-row-label" title={g.label}>{g.label}</span>
              <div className="v2-stock-row-track">
                <div className={`v2-stock-row-fill ${g.tone}`} style={{ width: `${g.percentage}%` }} />
              </div>
              <span className="v2-stock-row-qty">{g.totalQty.toLocaleString()} doses</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CriticalExpiringCard({ batches, loading, unavailable }) {
  return (
    <div className="v2-hub-card v2-cold-card">
      <div className="v2-card-head">
        <h2>Critical &amp; Expiring</h2>
        <p>Critical stock and batches expiring within 30 days</p>
      </div>

      <div className="v2-cold-list">
        {loading ? (
          <div><span>Loading...</span></div>
        ) : unavailable ? (
          <div><span>Inventory could not be loaded.</span></div>
        ) : batches.length === 0 ? (
          <div><span>No critical or near-expiry batches</span></div>
        ) : (
          batches.map((item) => {
            const days = item.daysRemaining;
            return (
              <div key={item.id}>
                <span>{item.name}</span>
                <strong>{item.expiry}</strong>
                <small className={item.level}>
                  {item.level === "expired"
                    ? "Expired"
                    : days === null
                      ? "No expiry date"
                      : `${days} day${days !== 1 ? "s" : ""} left`}
                </small>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function InventoryAlertCard({ critical, expiringSoon, stable, loading }) {
  const dash = "—";
  return (
    <div className="v2-hub-card v2-alert-summary-card">
      <div className="v2-card-head">
        <h2>Inventory Alerts</h2>
        <p>Action required today</p>
      </div>

      <div className="v2-alert-summary-list">
        <div className="critical">
          <strong>{loading ? dash : critical}</strong>
          <span>Critical stock</span>
        </div>

        <div className="warning">
          <strong>{loading ? dash : expiringSoon}</strong>
          <span>Expiring in 90 days</span>
        </div>

        <div className="stable">
          <strong>{loading ? dash : stable}</strong>
          <span>Stable batches</span>
        </div>
      </div>
    </div>
  );
}

export default Inventory;
