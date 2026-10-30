import {
  AlertTriangle,
  Bell,
  CalendarDays,
  FileText,
  Loader2,
  MapPin,
  PackagePlus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrderWithReservation } from "../../services/inventoryCallables";
import {
  UNAUTHENTICATED_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
  discardOrderAttempt,
  initialCheckoutSelection,
  initialCheckoutReview,
  loadCartDraft,
  loadCheckoutSelection,
  loadCheckoutReview,
  loadPendingAttempt,
  resolveRestoredDestination,
  saveCheckoutSelection,
  saveCheckoutReview,
  submitOrderDraft,
  updateCartDraftLines,
} from "../../services/orderDraftRequest";
import { loadAuthoritativeConfirmation } from "../../services/orderConfirmation";
import { getOrderById } from "../../services/orderService";
import { auth } from "../../firebase";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { UserMessageError } from "../../services/userMessageError";
import { subscribeClinics } from "../../services/clinicService";
import { subscribeDoctors } from "../../services/doctorService";
import { fetchMedRepDoctorAddresses } from "../../services/medRepDestinations";
import { subscribeInventoryBatches } from "../../services/inventoryService";
import { subscribeVaccinesByIds } from "../../services/vaccineCatalogService";
import {
  NEGOTIATED_PRICE_LABEL,
  agreedInputFor,
  negotiatedRequestLine,
  priceReviewLine,
  reviewProblems,
  summarizeReviewVat,
} from "../../services/negotiatedPricing";
import {
  acceptLiveLine,
  cartBatchIds,
  cartReview,
  lineReview,
  liveCartLines,
} from "../../services/cartLiveStock";
import useOwnProfile from "../../components/profile/useOwnProfile";
import {
  NO_TERRITORY_MESSAGE,
  permittedDoctors,
  readTerritory,
  territoryDestinationOptions,
} from "../../services/territory";
import { manilaToday, validateRequestedDate } from "../../services/requestedDate";
import { checkoutScheduleErrorMessage, validateCheckoutSchedule } from "../../services/checkoutSchedule";
import {
  arrivalPayloadOf,
  normalizeArrivalForm,
  normalizeRequestedArrival,
  requestedArrivalLabel,
  requestedScheduleLabel,
} from "../../services/requestedArrival";
import RequestedArrivalField from "../../components/schedule/RequestedArrivalField";
import { formatCentavos, readPriceCentavos } from "../../services/money";
import { PRODUCT_VAT_LABELS, readVatClassification } from "../../services/vatClassification";
import { VAT_INCLUSIVE_NOTE } from "../../services/pricingConfig";
import DialogLayer from "../../components/ui/DialogLayer";

/**
 * A server error code turned into something a rep can act on.
 *
 * The server already writes a user-facing sentence; this only adds the extra
 * step where the right next action is not obvious from the message alone.
 */
const ORDER_FAILURE_MESSAGE =
  "We couldn't confirm the order. Your cart and entries are still here. Check Order Tracking before trying again.";

function messageForCallableError(error) {
  const scheduleMessage = checkoutScheduleErrorMessage(error?.code);
  if (scheduleMessage) return scheduleMessage;
  switch (error?.code) {
    case "insufficient-stock": {
      const info = error.info;
      return info
        ? `Only ${info.available} left in batch ${info.batchId ?? info.inventoryId}. Adjust the quantity and try again.`
        : friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
    }
    case "batch-expired":
      return "One of these batches has expired and can no longer be ordered. Remove it and pick another.";
    case "price-changed": {
      // The whole point of the check is that a rep sees the real numbers and
      // decides, so both figures are named rather than summarised as "changed".
      const info = error.info;
      if (!info) return friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
      const batch = info.batchId ?? info.inventoryId;
      return `The standard price of batch ${batch} changed from ${formatCentavos(
        info.expectedUnitPriceCentavos
      )} to ${formatCentavos(
        info.currentUnitPriceCentavos
      )} while you were ordering. Nothing was placed. Accept the new standard price on that line, check your agreed price, and confirm again.`;
    }
    case "batch-unpriced":
      return "One of these batches has no selling price yet. An admin needs to price it before it can be ordered.";
    case "price-not-confirmed":
      return "This cart was built before batch pricing. Please rebuild it from the catalog so the prices can be confirmed.";
    case "adjustment-reason-required":
      return "Give a reason for every negotiated price that differs from the standard price. Nothing was placed.";
    case "invalid-agreed-price":
      return "One of the agreed prices is not a valid amount. Correct it and confirm again. Nothing was placed.";
    case "inventory-migration-required":
      return "One of these batches still records its stock as text and needs an admin migration before it can be ordered.";
    case "idempotency-conflict":
      // The server recognised this draft's request ID but with different
      // contents: an earlier attempt of this checkout WAS placed. The ID is
      // deliberately not rotated automatically — that would let the rep place
      // a second order without knowing the first exists.
      return "An earlier attempt of this checkout was already placed with different details. Check Order Tracking first. If you still need this order, discard the previous attempt and finalize again.";
    case "duplicate-inventory-line":
      return "The same batch appears on two lines. Combine them into one.";
    case "requested-date-required":
      return "Choose a delivery date for this order. Nothing was placed.";
    case "invalid-requested-date":
      return friendlyErrorMessage(error, "Choose a valid delivery date, today or later. Nothing was placed.");
    default:
      // A domain refusal keeps the server's own sentence (a trusted domain
      // error); anything else gets a safe mapped message — never raw text.
      return friendlyErrorMessage(error, ORDER_FAILURE_MESSAGE);
  }
}

// One shared empty list, so "no addresses yet" keeps a stable identity and the
// destination options are not rebuilt on every render.
const EMPTY_ADDRESSES = Object.freeze([]);
const EMPTY_BY_DOCTOR = Object.freeze({});

// The confirmation is no longer assembled here from checkout state. It is
// built from the stored order the callable named (services/orderConfirmation.js),
// so a replayed order can never be shown with values the rep edited afterwards.

/**
 * The signed-in Med Rep's own saved cart. Another account's cart on this
 * browser is never loaded; an old unscoped cart is migrated once, to the first
 * Med Rep who opens checkout without a cart of their own (see loadCartDraft).
 */
function getInitialItems(uid) {
  if (!uid) return [];
  try {
    const savedDraft = loadCartDraft(localStorage, uid).draft;

    if (savedDraft?.items?.length) {
      return savedDraft.items.map((item) => ({
        // The authoritative Firestore inventory DOCUMENT id, carried through
        // from the catalog. It used to be dropped here and again in the order
        // service, which is why no order could be traced back to a batch. It is
        // the only field the server treats as identity.
        inventoryId: item.inventoryId || null,
        name: item.name || "Unknown Vaccine",
        sku: item.sku || "—",
        chain: item.category || "Cold Chain",
        quantity: Number(item.quantity) || 1,
        // The price the catalog showed when this line entered the cart, read
        // back through the same validator the catalog used — so a hand-edited
        // localStorage value does not become a price, it becomes null, and the
        // submit guard below refuses the cart rather than quoting it.
        expectedUnitPriceCentavos: readPriceCentavos(item.unitPriceCentavos),
        // Display only: the classification the catalog showed. The server reads
        // the vaccine's own value and snapshots it; this is never sent.
        vatClassification: readVatClassification(item.vatClassification),
        // Available in THIS batch when it entered the cart — display only. The
        // server reserves across the product's batches and backorders the rest.
        availableNow: Number.isInteger(Number(item.stock)) && Number(item.stock) >= 0 ? Number(item.stock) : null,
      }));
    }
  } catch (error) {
    logSafeError("Load Med Rep cart", error);
  }

  return [];
}

// One-shot handoff from the dashboard planner: a day chosen there is read here
// to pre-fill the requested date, then removed so it never re-applies to a later
// order. Validated against the same rule the field enforces, so a stale or past
// value is simply ignored rather than pre-filling something the form rejects.
function getPlannedRequestedDate() {
  try {
    const planned = localStorage.getItem("salesRepPlannedDate");
    if (!planned) return "";
    localStorage.removeItem("salesRepPlannedDate");
    const check = validateRequestedDate(planned);
    return check.ok && check.value ? check.value : "";
  } catch {
    return "";
  }
}

function SalesRepPlaceOrder() {
  const navigate = useNavigate();

  // The draft (cart, request id, submission snapshot) belongs to the signed-in
  // Med Rep. The route guard renders this page only once auth has resolved.
  const uid = auth.currentUser?.uid ?? null;

  /**
   * An earlier checkout attempt that may already have been placed (e.g. the
   * response was lost before a refresh). Its request id is durable and reused
   * by an unchanged retry, so the form is restored from its snapshot: retrying
   * as-is replays the original order instead of creating a second one.
   */
  const [pendingAttempt] = useState(() =>
    uid ? loadPendingAttempt(localStorage, uid) : null
  );
  const restored = pendingAttempt?.submission ?? null;
  const [initialReview] = useState(() => initialCheckoutReview({
    attempt: restored,
    saved: uid ? loadCheckoutReview(localStorage, uid) : null,
  }));

  /**
   * What checkout reopens with: a pending attempt's snapshot, else the rep's
   * saved selection (doctor, destination, date) from their own cart record,
   * with a fresh planner date taking precedence for the date. Read once.
   */
  const [initialCheckout] = useState(() =>
    initialCheckoutSelection({
      attempt: restored,
      saved: uid ? loadCheckoutSelection(localStorage, uid) : null,
      plannedDate: restored ? "" : getPlannedRequestedDate(),
    })
  );
  /**
   * A destination waiting to be restored: shown only once the SAME doctor's
   * destinations have loaded and it is verifiably one of them (see
   * resolveRestoredDestination). Cleared by any explicit doctor or
   * destination choice, so a deliberate change is never overridden.
   */
  const [pendingRestore, setPendingRestore] = useState(() =>
    initialCheckout.doctorAddressId
      ? { doctorId: initialCheckout.doctorId, destinationId: initialCheckout.doctorAddressId }
      : null
  );

  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState(() => getInitialItems(uid));
  // The cart's OWN batches as they are now — a listener on just those
  // document ids, replaced when the cart's set of batches changes, never the
  // whole inventory collection. See cartLiveStock.js: changes are shown and
  // gate the checkout, but only the rep's explicit acceptance edits the cart.
  const batchIdsKey = cartBatchIds(items).join("|");
  const [liveStock, setLiveStock] = useState({ key: null, batches: null, todayIso: null, failed: false });
  useEffect(() => {
    if (!batchIdsKey) return undefined;
    return subscribeInventoryBatches(
      batchIdsKey.split("|"),
      // Today (Manila) is read where the snapshot arrives, never in render.
      (batches) => setLiveStock({ key: batchIdsKey, batches, todayIso: manilaToday(new Date()), failed: false }),
      () => setLiveStock({ key: batchIdsKey, batches: null, todayIso: null, failed: true })
    );
  }, [batchIdsKey]);
  const liveStatus = !batchIdsKey
    ? "live"
    : liveStock.key !== batchIdsKey
      ? "loading"
      : liveStock.failed
        ? "failed"
        : "live";
  // The cart's vaccine products, for the full SKU, the CURRENT VAT class the
  // server will snapshot, and whether the product was archived (only these
  // products, never the whole catalog).
  const vaccineIdsKey = [
    ...new Set((liveStock.batches || []).map((b) => b.vaccineId).filter((id) => typeof id === "string" && id)),
  ]
    .sort()
    .join("|");
  const [catalog, setCatalog] = useState({ key: null, byId: new Map() });
  useEffect(() => {
    if (!vaccineIdsKey) return undefined;
    return subscribeVaccinesByIds(
      vaccineIdsKey.split("|"),
      (docs) => setCatalog({ key: vaccineIdsKey, byId: new Map(docs.map((d) => [d.id, d])) }),
      () => setCatalog({ key: vaccineIdsKey, byId: new Map() })
    );
  }, [vaccineIdsKey]);
  const displayItems = useMemo(
    // An archived product blocks its lines here; the server refuses it anyway.
    () => liveCartLines(items, liveStock.batches, liveStock.todayIso, catalog.byId),
    [items, liveStock, catalog]
  );
  const review = cartReview(displayItems, liveStatus);
  const handleAcceptLine = (line) => setItems((current) => acceptLiveLine(current, line));

  // ---- final price review (negotiated pricing; services/negotiatedPricing.js) ----
  // The rep's agreed-price TEXT and reason per line, keyed by batch. A line
  // with no entry is at its standard price. Nothing here is a total: every
  // figure is derived from quantity × unit price in integer centavos, and the
  // server recomputes all of it from the batch it re-reads.
  const [negotiation, setNegotiation] = useState(initialReview.negotiation);
  const reviewLines = useMemo(() => {
    const batchById = new Map((liveStock.batches || []).map((b) => [b.id, b]));
    return displayItems.map((item) => {
      const vaccine = catalog.byId.get(batchById.get(item.inventoryId)?.vaccineId);
      const vatClassification = readVatClassification(vaccine?.vatClassification) ?? item.vatClassification ?? null;
      const entry = negotiation[item.inventoryId] || {};
      return {
        item,
        catalogSku: typeof vaccine?.internalSku === "string" && vaccine.internalSku.trim() ? vaccine.internalSku.trim() : null,
        vatClassification,
        agreedText: entry.agreedInput ?? agreedInputFor(item.expectedUnitPriceCentavos),
        reasonText: entry.reason ?? "",
        // No SC/PWD discount is entered at checkout, so none is passed: the
        // line is reviewed — and sent — at its agreed price with no discount.
        price: priceReviewLine({
          quantity: item.quantity,
          expectedUnitPriceCentavos: item.expectedUnitPriceCentavos,
          vatClassification,
          agreedInput: entry.agreedInput,
          negotiationReason: entry.reason ?? "",
        }),
      };
    });
  }, [displayItems, liveStock, catalog, negotiation]);
  const priceSummary = summarizeReviewVat(reviewLines.map((l) => l.price));
  const pricingCheck = reviewProblems(reviewLines.map((l) => l.price));
  const reviewByBatch = new Map(reviewLines.map((l) => [l.item.inventoryId, l]));
  const setAgreedInput = (inventoryId, agreedInput) =>
    setNegotiation((current) => ({ ...current, [inventoryId]: { ...current[inventoryId], agreedInput } }));
  const setNegotiationReason = (inventoryId, reason) =>
    setNegotiation((current) => ({ ...current, [inventoryId]: { ...current[inventoryId], reason } }));
  // Reset to standard price: the PRICE follows the standard again and its
  // reason is dropped.
  const resetToStandard = (inventoryId) =>
    setNegotiation((current) => {
      const rest = { ...(current[inventoryId] || {}) };
      delete rest.agreedInput;
      delete rest.reason;
      return { ...current, [inventoryId]: rest };
    });
  // A removed line takes its price and reason with it.
  const clearLinePricing = (inventoryId) =>
    setNegotiation((current) => {
      const next = { ...current };
      delete next[inventoryId];
      return next;
    });
  /** The reconfirmation dialog is open. Nothing is sent until it is confirmed. */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Set only by the dialog's Confirm button, immediately before it submits. */
  const reconfirmedRef = useRef(false);

  /** Synchronous re-entry guard — see handleFinalizeOrder. */
  const submittingRef = useRef(false);

  /** The checkout no longer matches a pending attempt (or the server reported
   *  an idempotency conflict). Cleared only by the confirmed discard below. */
  const [attemptConflict, setAttemptConflict] = useState(false);
  /** The discard warning is open. Cancelling leaves the attempt untouched. */
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Keep the user's saved cart in step with checkout's quantity edits and
  // removals, so a refresh restores exactly what was last on screen.
  useEffect(() => {
    if (uid) updateCartDraftLines(localStorage, uid, items);
  }, [uid, items]);

  const [doctors, setDoctors] = useState([]);
  const [doctorsLoading, setDoctorsLoading] = useState(true);
  const [selectedDoctorId, setSelectedDoctorId] = useState(initialCheckout.doctorId);
  // Every reachable doctor's destinations, keyed by doctor id, tagged with the
  // active-doctor list they were fetched for. The server returns only links
  // inside this Med Rep's territory — a Med Rep cannot read doctor addresses
  // (including private Home addresses) directly. Written only by the fetch's
  // callbacks; everything shown is derived from it below.
  const [destinationBook, setDestinationBook] = useState({ key: null, byDoctor: {} });
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [clinics, setClinics] = useState([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  // One entry per source, so a source that recovers clears only its own
  // failure and never hides another's.
  const [destinationLoadErrors, setDestinationLoadErrors] = useState({});
  const destinationLoadError =
    destinationLoadErrors.clinics || destinationLoadErrors.doctors || destinationLoadErrors.addresses || "";
  const setSourceError = (source, message) =>
    setDestinationLoadErrors((prev) => (prev[source] === message ? prev : { ...prev, [source]: message }));
  const [instructions, setInstructions] = useState(initialReview.deliveryInstructions);
  // Exact 'YYYY-MM-DD' text, never parsed into a Date, so it cannot shift.
  const [requestedDate, setRequestedDate] = useState(initialCheckout.requestedDeliveryDate);
  // Optional requested ARRIVAL at the destination on that date (mode + only
  // the times it needs). Restored like the date: from a pending attempt's
  // snapshot, else the saved draft; any time within the day otherwise.
  const [arrival, setArrival] = useState(() => normalizeArrivalForm(initialCheckout.requestedArrival));
  // Set by Finalize when the arrival is refused (incomplete, reversed, passed…);
  // cleared by the next edit.
  const [arrivalError, setArrivalError] = useState(null);
  const handleArrivalChange = (next) => {
    setArrival(next);
    setArrivalError(null);
  };
  // Shape problems are shown as soon as both times exist (a reversed or equal
  // window); a missing time is reported only when the rep tries to continue.
  // "Already passed" needs the clock and is checked at Finalize.
  const arrivalShape = normalizeRequestedArrival(arrivalPayloadOf(arrival), { requestedDeliveryDate: null });
  const shownArrivalError = arrivalError ?? (arrivalShape.ok || arrivalShape.incomplete ? null : arrivalShape);
  const arrivalSummary = arrivalShape.ok ? `Requested: ${requestedArrivalLabel(arrivalShape.value)}` : "";
  const [urgent, setUrgent] = useState(initialReview.priority === "Urgent");
  useEffect(() => {
    if (uid) saveCheckoutReview(localStorage, uid, {
      priority: urgent ? "Urgent" : "Standard",
      deliveryInstructions: instructions,
      negotiation,
    });
  }, [uid, urgent, instructions, negotiation]);
  const [message, setMessage] = useState(
    pendingAttempt
      ? "An earlier attempt of this order may already have been placed. Its details were restored — finalize again unchanged to safely recover it, or check Order Tracking."
      : ""
  );

  useEffect(() => {
    const unsubscribe = subscribeClinics(
      (docs) => {
        setClinics(docs);
        setClinicsLoading(false);
        setSourceError("clinics", "");
      },
      (error) => {
        setClinicsLoading(false);
        setSourceError("clinics", liveErrorMessage(error, "clinic destinations"));
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeDoctors(
      (docs) => {
        setDoctors(docs);
        setDoctorsLoading(false);
        setSourceError("doctors", "");
      },
      (error) => {
        setDoctorsLoading(false);
        setSourceError("doctors", liveErrorMessage(error, "doctors"));
      }
    );

    return unsubscribe;
  }, []);

  // The Med Rep's own territory (Admin-assigned, read-only to them).
  const { profile: ownProfile, loading: profileLoading } = useOwnProfile();
  const territory = useMemo(() => readTerritory(ownProfile), [ownProfile]);

  // Fetch the reachable destinations again whenever the active-doctor list
  // changes. The effect only fetches; state changes come from its callbacks.
  const activeDoctorKey = doctors
    .filter((doctor) => doctor.active === true)
    .map((doctor) => doctor.id)
    .sort()
    .join("|");
  useEffect(() => {
    if (!activeDoctorKey) return undefined;
    let current = true;
    fetchMedRepDoctorAddresses().then(
      (byDoctor) => {
        if (!current) return;
        setDestinationBook({ key: activeDoctorKey, byDoctor });
        setSourceError("addresses", "");
      },
      (error) => {
        if (!current) return;
        logSafeError("fetchMedRepDoctorAddresses", error);
        // Loaded, with nothing usable — ends the loading state.
        setDestinationBook({ key: activeDoctorKey, byDoctor: {} });
        setSourceError("addresses", liveErrorMessage(error, "doctors' delivery addresses"));
      }
    );
    return () => {
      current = false;
    };
  }, [activeDoctorKey]);
  const territoryAddressesReady = !activeDoctorKey || destinationBook.key === activeDoctorKey;
  const addressesByDoctor = activeDoctorKey ? destinationBook.byDoctor : EMPTY_BY_DOCTOR;
  // Doctors, clinics, the territory and (when one is assigned) every doctor's
  // addresses must all be loaded before the list can be trusted.
  const doctorListLoading =
    doctorsLoading ||
    clinicsLoading ||
    profileLoading ||
    (territory.assigned && !territoryAddressesReady);

  // Derived, never stored: this doctor's reachable destinations once the
  // fetch has arrived, and "loading" until it has. A restored destination is
  // verified against them — see resolveRestoredDestination below.
  const addressesReady = !!selectedDoctorId && territoryAddressesReady;
  const doctorAddresses = addressesReady
    ? addressesByDoctor[selectedDoctorId] ?? EMPTY_ADDRESSES
    : EMPTY_ADDRESSES;
  const addressesLoading = !!selectedDoctorId && !addressesReady;

  // A USER changing (or clearing) the doctor: the new doctor starts with no
  // addresses and no destination, and any destination still waiting to be
  // restored is dropped — the previous doctor's choice must never carry over.
  // Initial restoration after a refresh does not pass through here.
  const handleDoctorChange = (doctorId) => {
    setSelectedDoctorId(doctorId);
    setSelectedDestinationId("");
    setPendingRestore(null);
  };

  // A user's explicit destination choice (including "none") always wins over
  // a restore that has not resolved yet.
  const handleDestinationChange = (destinationId) => {
    setSelectedDestinationId(destinationId);
    setPendingRestore(null);
  };

  // Only doctors with at least one active destination inside the territory;
  // for each, only the destinations inside it. No territory → no doctors.
  const allowedDoctors = useMemo(
    () => permittedDoctors(doctors, addressesByDoctor, clinics, territory),
    [doctors, addressesByDoctor, clinics, territory]
  );
  const selectedDoctor =
    allowedDoctors.find((doctor) => doctor.id === selectedDoctorId) || null;
  // A saved doctor outside the territory is not restored. While the list is
  // still loading the saved id is kept, so it is never cleared prematurely.
  const doctorSelectValue = doctorListLoading || selectedDoctor ? selectedDoctorId : "";
  const destinationOptions = useMemo(
    () => territoryDestinationOptions(doctorAddresses, clinics, territory),
    [doctorAddresses, clinics, territory]
  );
  // The restored destination, once verified against THIS doctor's loaded
  // options; until then it is "pending" and the field stays blank. A doctor
  // who is no longer active (or no longer exists) cannot have a destination
  // restored — but that is only known once the doctors have loaded.
  const restore = resolveRestoredDestination({
    pending: pendingRestore,
    doctorId: doctorListLoading || selectedDoctor ? selectedDoctorId : "",
    ready: addressesReady && !doctorListLoading,
    optionIds: destinationOptions.map((destination) => destination.id),
  });
  const destinationId = selectedDestinationId !== "" ? selectedDestinationId : restore.destinationId;
  const selectedDestination =
    destinationOptions.find((destination) => destination.id === destinationId) || null;
  // A saved doctor or destination that is no longer permitted was dropped, not
  // silently kept: the rep is told to choose again.
  const savedSelectionDropped =
    !doctorListLoading &&
    territory.assigned &&
    ((pendingRestore && restore.status === "rejected") ||
      (Boolean(selectedDoctorId) && !selectedDoctor));

  // Keep the rep's checkout selection in their saved draft so a refresh
  // restores it. While a restored destination is still being verified it is
  // kept as-is rather than overwritten with the blank field. This writes only
  // the browser's own cart record — nothing is submitted or sent anywhere.
  const draftDestinationId =
    selectedDestinationId !== ""
      ? selectedDestinationId
      : restore.status === "pending" || restore.status === "restored"
        ? pendingRestore.destinationId
        : "";
  useEffect(() => {
    if (!uid) return;
    saveCheckoutSelection(localStorage, uid, {
      doctorId: doctorSelectValue,
      doctorAddressId: draftDestinationId,
      requestedDeliveryDate: requestedDate,
      requestedArrival: arrival,
    });
  }, [uid, doctorSelectValue, draftDestinationId, requestedDate, arrival]);

  // Flush every edited field before leaving. Failure keeps checkout open;
  // navigation never discards/rotates an unresolved submission's request id.
  const handleAddMoreItems = () => {
    if (!uid) {
      setMessage(UNAUTHENTICATED_MESSAGE);
      return;
    }
    const saved = updateCartDraftLines(localStorage, uid, items)
      && saveCheckoutSelection(localStorage, uid, {
        doctorId: doctorSelectValue,
        doctorAddressId: draftDestinationId,
        requestedDeliveryDate: requestedDate,
        requestedArrival: arrival,
      })
      && saveCheckoutReview(localStorage, uid, {
        priority: urgent ? "Urgent" : "Standard",
        deliveryInstructions: instructions,
        negotiation,
      });
    if (!saved) {
      setMessage(STORAGE_UNAVAILABLE_MESSAGE);
      return;
    }
    navigate("/sales-rep/request-order");
  };

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return displayItems.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.sku.toLowerCase().includes(query) ||
        item.chain.toLowerCase().includes(query)
    );
  }, [displayItems, searchTerm]);

  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);
  // Any line asking for more than its batch showed as available becomes (at
  // least partly) a future order. An indication only; the server decides.
  const mayBackorder = displayItems.some(
    (item) => item.availableNow !== null && item.quantity > item.availableNow
  );


  const handleQuantityChange = (inventoryId, action) => {
    setItems((current) =>
      current.map((item) => {
        if (item.inventoryId !== inventoryId) return item;
        const nextQuantity =
          action === "increase" ? item.quantity + 1 : Math.max(item.quantity - 1, 1);
        return { ...item, quantity: nextQuantity };
      })
    );
  };

  const handleRemoveItem = (inventoryId) => {
    setItems((current) => current.filter((item) => item.inventoryId !== inventoryId));
    clearLinePricing(inventoryId);
  };

  // Discarding a pending attempt is the ONLY way its request id is ever
  // rotated, and it is two-step: this opens a warning; nothing is cleared yet.
  const handleRequestDiscard = () => {
    setDiscardConfirmOpen(true);
  };

  // Cancel: the saved attempt, its request id and snapshot stay exactly as they were.
  const handleCancelDiscard = () => {
    setDiscardConfirmOpen(false);
  };

  // Confirmed: forget the previous attempt's request id and snapshot. The cart
  // is kept, so the next Finalize is a genuinely NEW order under a new id.
  const handleConfirmDiscard = () => {
    if (!uid) {
      setDiscardConfirmOpen(false);
      setMessage(UNAUTHENTICATED_MESSAGE);
      return;
    }
    discardOrderAttempt(localStorage, uid);
    setDiscardConfirmOpen(false);
    setAttemptConflict(false);
    setMessage(
      "The previous attempt was discarded. Finalizing now starts a new order attempt."
    );
  };

  // First call (Finalize): validate, then open the reconfirmation dialog.
  // From the dialog (reconfirmedRef set): validate again and send. The flag is
  // read once and cleared, so one confirmation authorises exactly one send.
  const handleFinalizeOrder = async () => {
    const confirmed = reconfirmedRef.current;
    reconfirmedRef.current = false;
    // Synchronous re-entry guard, BEFORE any state update or await.
    //
    // `disabled={saving}` is feedback, not concurrency control: setSaving is a
    // React state update, so several clicks delivered in one event turn all
    // reach this handler before any rebuild. The server's idempotency key makes
    // duplicates harmless; this stops them being sent at all.
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (items.length === 0) {
      submittingRef.current = false;
      setMessage("Add at least one order item before finalizing.");
      return;
    }

    // Changed prices, a new shortfall, or a batch that can no longer be
    // ordered must be reviewed first. A fast guard only: the server re-reads
    // every batch and refuses a price that is not the current one regardless.
    if (review.blocked) {
      submittingRef.current = false;
      setMessage(
        review.checking
          ? "Checking current prices and stock — please wait."
          : "Review the highlighted items before finalizing: accept the current price or stock, or remove items that can no longer be ordered."
      );
      return;
    }

    // Every agreed price must be a valid amount and every negotiated line
    // explained. The server refuses either problem itself; this says so first.
    if (!pricingCheck.ok) {
      submittingRef.current = false;
      setConfirmOpen(false);
      setMessage(`Check the final price review: ${pricingCheck.problems[0]}`);
      return;
    }

    // Re-check both stable document ids against the latest subscriptions. This
    // is only the fast user-facing guard: the callable repeats the decision
    // from Firestore inside the same transaction that reserves inventory.
    if (doctorListLoading || addressesLoading) {
      submittingRef.current = false;
      setMessage("Verifying the doctor and delivery address — please wait.");
      return;
    }
    // UI guard only — the callable refuses an order outside the territory itself.
    if (!territory.assigned) {
      submittingRef.current = false;
      setMessage(NO_TERRITORY_MESSAGE);
      return;
    }
    if (!selectedDoctor) {
      submittingRef.current = false;
      setMessage("Select an active doctor for this order.");
      return;
    }
    if (!selectedDestination) {
      submittingRef.current = false;
      setMessage("Select one active Home or Clinic delivery address for this doctor.");
      return;
    }

    // Every line must carry an authoritative batch. A cart built before this
    // checkpoint has none, and guessing one from its name or SKU is exactly
    // what the reservation design forbids.
    const unallocated = items.filter((item) => !item.inventoryId);
    if (unallocated.length > 0) {
      submittingRef.current = false;
      setMessage(
        "This cart was built before batch tracking. Please rebuild it from the catalog."
      );
      return;
    }

    // And every line must carry the price it was quoted at. The server refuses
    // an unconfirmed price anyway; catching it here means the rep is told to
    // rebuild the cart instead of watching a submit fail.
    const unpriced = items.filter((item) => item.expectedUnitPriceCentavos === null);
    if (unpriced.length > 0) {
      submittingRef.current = false;
      setMessage(
        "This cart was built before batch pricing. Please rebuild it from the catalog."
      );
      return;
    }

    // New requests need a future-valid schedule. A durable earlier attempt
    // must be recoverable even after its time/day passes. submitOrderDraft
    // still refuses changed contents, and the server re-checks NEW keys.
    const recovering = Boolean(uid && loadPendingAttempt(localStorage, uid));
    const { date: requestedCheck, arrival: arrivalCheck } = validateCheckoutSchedule({
      requestedDeliveryDate: requestedDate,
      requestedArrival: arrivalPayloadOf(arrival),
      recovering,
    });
    if (!requestedCheck.ok) {
      submittingRef.current = false;
      setMessage(requestedCheck.message);
      return;
    }

    // Nothing is adjusted: a refused request is shown, never rewritten.
    if (!arrivalCheck.ok) {
      submittingRef.current = false;
      setConfirmOpen(false);
      setArrivalError(arrivalCheck);
      setMessage(`Check the requested delivery time: ${arrivalCheck.message}`);
      return;
    }

    // The draft is scoped to the signed-in Med Rep, so there must be one.
    // Refused here, before any id is generated or anything is sent.
    if (!uid) {
      submittingRef.current = false;
      setMessage(UNAUTHENTICATED_MESSAGE);
      return;
    }

    // Explicit reconfirmation: the dialog shows every line, price, reason and
    // the VAT breakdown, and nothing is sent until the rep confirms it.
    if (!confirmed) {
      submittingRef.current = false;
      setMessage("");
      setConfirmOpen(true);
      return;
    }

    // Everything the rep is submitting — including priority and instructions,
    // which are protected by the local snapshot. The server's v3 fingerprint
    // also binds the requested date AND time. The snapshot is saved
    // with the request id before the call, and a retry must match it.
    const submission = {
      doctorId: selectedDoctor.id,
      doctorAddressId: selectedDestination.id,
      priority: urgent ? "Urgent" : "Standard",
      deliveryInstructions: instructions.trim(),
      requestedDeliveryDate: requestedCheck.value,
      requestedArrival: arrivalCheck.value,
      // Per line: the reviewed standard, the agreed UNIT price and (only when
      // negotiated) its reason. No total and no VAT figure is ever sent.
      items: items.map((item) => ({
        inventoryId: item.inventoryId,
        quantity: Number(item.quantity),
        ...negotiatedRequestLine(item, reviewByBatch.get(item.inventoryId).price),
      })),
    };

    setSaving(true);
    setMessage("");
    setAttemptConflict(false);
    setDiscardConfirmOpen(false);

    try {
      // The request id and this snapshot are written to durable storage and
      // read back BEFORE the callable runs; if that cannot be verified, nothing
      // is sent. A retry is sent under the same id only if it matches the saved
      // snapshot. The draft (cart, id, snapshot) is cleared only after `submit`
      // resolves with an order id from the server.
      const result = await submitOrderDraft({
        storage: localStorage,
        uid,
        submission,
        submit: async (requestId) => {
          // The order is created SERVER-SIDE so it commits together with the
          // stock reservation. The two ids name the exact nested Firestore
          // relationship: `doctors/{doctorId}/deliveryAddresses/{doctorAddressId}`.
          // The caller sends no address, coordinates, name, or Area; the server
          // re-derives all of them from the current master records inside the
          // transaction.
          const created = await createOrderWithReservation({
            requestId,
            doctorId: submission.doctorId,
            doctorAddressId: submission.doctorAddressId,
            priority: submission.priority,
            deliveryInstructions: submission.deliveryInstructions,
            // Required: validateRequestedDate has refused a blank date above,
            // and the server refuses one again (requested-date-required).
            requestedDeliveryDate: requestedCheck.value,
            // When it is needed AT THE DESTINATION; the server re-validates it.
            requestedArrival: submission.requestedArrival,
            items: submission.items,
          });
          if (typeof created?.orderId !== "string" || created.orderId === "") {
            // Thrown INSIDE submit so the draft survives: finalizing again
            // replays the saved order under the same id.
            throw new UserMessageError(
              "The order may have been saved, but the server's reply was incomplete. Finalize again to recover it.",
              { code: "reply-incomplete" }
            );
          }
          return created;
        },
      });

      // The server committed (or replayed) the order. The confirmation is built
      // ONLY from the stored order it names — never from this form, which may
      // have been edited since the original attempt. If that read fails, only
      // the server's order id/number is kept and the page points to Tracking.
      const confirmation = await loadAuthoritativeConfirmation({
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        replayed: result.replayed === true,
        loadOrder: getOrderById,
      });
      localStorage.setItem("latestSalesOrderId", result.orderId);
      localStorage.setItem("latestSalesOrderDetails", JSON.stringify(confirmation.details));
      navigate("/sales-rep/order-confirmation");
    } catch (error) {
      // The cart, request id and snapshot all survive: a retry of a recoverable
      // failure must reach the server as the SAME attempt, or a submission that
      // actually committed would be duplicated. The id is never rotated here —
      // not on a changed draft, and not on an idempotency conflict.
      if (error?.code === "draft-changed" || error?.code === "idempotency-conflict") {
        setAttemptConflict(true);
      }
      // Back to the review. On price-changed the live listener has already
      // flagged the line; the rep accepts the new standard and confirms again.
      setConfirmOpen(false);
      setMessage(messageForCallableError(error));
    } finally {
      setSaving(false);
      submittingRef.current = false;
    }
  };

  if (items.length === 0 && !message) {
    return (
      <>
        <div className="inventory-loading-state">
          <AlertTriangle size={32} />
          <strong>No items in cart</strong>
          <p>Go back to the catalog to add vaccines to your order.</p>
          <button
            type="button"
            className="inventory-request-btn"
            style={{ marginTop: 16 }}
            onClick={() => navigate("/sales-rep/request-order")}
          >
            <PackagePlus size={16} />
            Browse Catalog
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="place-order-session place-v2-session">
        <span>Current Session</span>
        <strong>{items.length} {items.length === 1 ? "item" : "items"} in order</strong>
        <Bell size={15} />
      </div>

      <section className="place-order-layout place-v2-layout">
        <div className="place-order-left">
          <div className="place-filter-row place-v2-filter-row">
            <div className="request-search place-v2-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search selected items by name, batch, or type..."
              />
            </div>

            <button
              type="button"
              className="place-v2-add-more"
              onClick={handleAddMoreItems}
            >
              <PackagePlus size={15} />
              Add More Items
            </button>
          </div>

          {message && <div className="place-v2-message">{message}</div>}

          {attemptConflict && !discardConfirmOpen && (
            <button
              type="button"
              className="place-v2-add-more"
              onClick={handleRequestDiscard}
              disabled={saving}
            >
              Discard previous attempt
            </button>
          )}

          {discardConfirmOpen && (
            <div className="place-v2-message" role="alertdialog" aria-labelledby="discard-attempt-title">
              <strong id="discard-attempt-title">Discard the previous order attempt?</strong>
              <p>
                The previous request may already have created an order. Check Order
                Tracking first. Continuing starts a new order attempt and could
                duplicate an existing order.
              </p>
              <button type="button" className="place-v2-add-more" onClick={handleCancelDiscard}>
                Keep previous attempt
              </button>
              <button type="button" className="place-v2-add-more" onClick={handleConfirmDiscard}>
                Discard and start a new attempt
              </button>
            </div>
          )}

          <div className="order-items-card place-v2-items-card">
            <div className="order-items-header">
              <div>
                <h2>Order Items</h2>
                <p>Review selected vaccines before finalizing the order.</p>
              </div>
              <span>{items.length} {items.length === 1 ? "Item" : "Items"} Selected</span>
            </div>

            {review.pending.length > 0 && (
              <p className="place-v2-live-notice" role="alert">
                {review.pending.length === 1
                  ? "1 item changed since it was added to your cart."
                  : `${review.pending.length} items changed since they were added to your cart.`}{" "}
                Review the highlighted {review.pending.length === 1 ? "item" : "items"}: accept the current price or
                stock, or remove what can no longer be ordered. Nothing in your cart was changed, and the order
                cannot be finalized until this is done.
              </p>
            )}
            {review.unverified && (
              <p className="place-v2-live-notice" role="status">
                Current prices and stock could not be checked here. They will be confirmed against each batch
                when the order is placed, and an outdated price is refused.
              </p>
            )}

            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch ID</th>
                  <th>Quantity</th>
                  <th>Unit price</th>
                  <th>Line total</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => (
                    <OrderRow
                      key={item.inventoryId}
                      item={item}
                      price={reviewByBatch.get(item.inventoryId)?.price}
                      review={lineReview(item)}
                      onAccept={() => handleAcceptLine(item)}
                      onDecrease={() => handleQuantityChange(item.inventoryId, "decrease")}
                      onIncrease={() => handleQuantityChange(item.inventoryId, "increase")}
                      onRemove={() => handleRemoveItem(item.inventoryId)}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan="6">
                      <div className="place-v2-empty">
                        No matching order item found.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="order-items-footer">
              <p>
                Total Vials
                <strong>{totalQuantity.toLocaleString()}</strong>
              </p>
            </div>
          </div>

          <PriceReview
            lines={reviewLines}
            disabled={saving}
            onAgreedChange={setAgreedInput}
            onReasonChange={setNegotiationReason}
            onReset={resetToStandard}
          />
        </div>

        <aside className="place-order-side place-v2-side">
          <div className="destination-card">
            <h2>
              <MapPin size={18} />
              Destination Details
            </h2>

            <label htmlFor="checkout-doctor">Select Doctor</label>
            {doctorListLoading ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                <Loader2 size={14} className="spin" style={{ verticalAlign: "middle", marginRight: 6 }} />
                Loading doctors...
              </p>
            ) : !territory.assigned ? (
              <p className="checkout-territory-empty" role="status">
                {NO_TERRITORY_MESSAGE}
              </p>
            ) : allowedDoctors.length === 0 ? (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>
                No doctor in your assigned territory has an active delivery address. Contact an administrator.
              </p>
            ) : (
              <select
                id="checkout-doctor"
                value={doctorSelectValue}
                onChange={(event) => handleDoctorChange(event.target.value)}
              >
                <option value="">Choose a doctor</option>
                {allowedDoctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name} — {doctor.area || "Area unavailable"}
                  </option>
                ))}
              </select>
            )}

            {savedSelectionDropped && (
              <p className="checkout-territory-notice" role="status">
                Your saved doctor or delivery address is no longer available to you — it may
                have left your assigned territory or been deactivated. Select the doctor and
                delivery address again.
              </p>
            )}

            <label htmlFor="checkout-destination">Select Delivery Address</label>
            {doctorSelectValue && (addressesLoading || clinicsLoading) ? (
              <p style={{ fontSize: 13, color: "#64748b" }}>
                <Loader2 size={14} className="spin" style={{ verticalAlign: "middle", marginRight: 6 }} />
                Loading this doctor's addresses...
              </p>
            ) : !doctorSelectValue ? (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>
                Choose a doctor first.
              </p>
            ) : destinationOptions.length === 0 ? (
              <p style={{ fontSize: 13, color: "#94a3b8" }}>
                This doctor has no active delivery address in your assigned territory.
              </p>
            ) : (
              <select
                id="checkout-destination"
                value={destinationId}
                onChange={(event) => handleDestinationChange(event.target.value)}
              >
                <option value="">Choose Home or a linked Clinic</option>
                {destinationOptions.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.type === "home" ? "Home / Doorstep" : `Clinic — ${destination.name}`}
                  </option>
                ))}
              </select>
            )}

            {destinationLoadError && (
              <p style={{ fontSize: 13, color: "#b91c1c" }}>
                {destinationLoadError}
              </p>
            )}

            {selectedDoctor && selectedDestination && (
              <div className="address-box">
                <strong>
                  {selectedDoctor.name} — {selectedDestination.name}
                </strong>
                <p>{selectedDestination.address}</p>
                <small>{selectedDestination.area}</small>
              </div>
            )}
          </div>

          <div className="destination-card">
            <h2>
              <FileText size={18} />
              Delivery Instructions
            </h2>

            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Add special handling notes or gate codes..."
            />

            <label className="place-v2-date-label" htmlFor="place-requested-date">
              <CalendarDays size={14} />
              Requested delivery date
            </label>
            <input
              id="place-requested-date"
              className="place-v2-date-input"
              type="date"
              required
              aria-required="true"
              min={manilaToday()}
              value={requestedDate}
              onChange={(event) => setRequestedDate(event.target.value)}
            />

            <RequestedArrivalField
              value={arrival}
              onChange={handleArrivalChange}
              problem={shownArrivalError}
              disabled={saving}
              summary={arrivalSummary}
            />

            <label className="urgent-row place-v2-urgent-row">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(event) => setUrgent(event.target.checked)}
              />
              <Zap size={13} />
              Mark as Urgent Delivery
            </label>
          </div>

          <div className="pricing-card place-v2-pricing-card">
            <h2>Order Summary</h2>

            <p>
              Total Vials
              <strong>{totalQuantity.toLocaleString()}</strong>
            </p>

            <p>
              Items
              <strong>{items.length}</strong>
            </p>

            <p>
              Priority
              <strong>{urgent ? "Urgent" : "Standard"}</strong>
            </p>

            <p>
              Requested arrival
              <strong>{arrivalShape.ok ? requestedArrivalLabel(arrivalShape.value) : arrivalShape.incomplete ? "Incomplete" : "Check the time"}</strong>
            </p>

            {/* The VAT breakdown of the AGREED prices. VAT is extracted from
                the VAT-inclusive VATable total (12/112), never added on top;
                the server records the binding figures. */}
            <VatBreakdown summary={priceSummary} />
            <p className="place-v2-price-note">
              {VAT_INCLUSIVE_NOTE} Prices are confirmed against the batch when
              the order is placed.
            </p>

            {mayBackorder && (
              <p className="place-v2-backorder-note" role="status">
                Some items are out of stock or short. You can still place this
                as a future order: what is in stock is reserved now and the rest
                is reserved automatically as stock arrives, in priority order.
                The order is dispatched only once every item is fully reserved —
                no delivery date is guaranteed until then.
              </p>
            )}

            <button
              type="button"
              onClick={() => handleFinalizeOrder()}
              disabled={
                saving ||
                items.length === 0 ||
                doctorListLoading ||
                !territory.assigned ||
                addressesLoading ||
                !selectedDoctor ||
                !selectedDestination ||
                review.blocked ||
                !pricingCheck.ok
              }
            >
              {saving ? "Saving Order..." : review.checking ? "Checking prices…" : "Review & Finalize →"}
            </button>
            {!pricingCheck.ok && (
              <p className="place-v2-review-hint" role="status">
                {pricingCheck.problems[0]}
              </p>
            )}
            {!review.checking && review.pending.length > 0 && (
              <p className="place-v2-review-hint" role="status">
                Review the highlighted {review.pending.length === 1 ? "item" : "items"} to continue.
              </p>
            )}

            <small>
              By clicking finalize, you confirm this order complies with medical distribution regulations.
            </small>
          </div>
        </aside>
      </section>

      {/* Portaled: inside the transformed route container a fixed backdrop
          covered the whole long page, so a dialog opened from Finalize could
          sit off-screen. Behaviour (focus, Escape, confirm) is unchanged. */}
      {confirmOpen && (
        <DialogLayer scope="salesrep-page salesrep-main">
        <ReconfirmDialog
          doctorName={selectedDoctor?.name ?? ""}
          destination={selectedDestination ? `${selectedDestination.name}${selectedDestination.address ? ` — ${selectedDestination.address}` : ""}` : ""}
          lines={reviewLines}
          summary={priceSummary}
          schedule={arrivalShape.ok ? requestedScheduleLabel(requestedDate, arrivalShape.value) : ""}
          saving={saving}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            reconfirmedRef.current = true;
            handleFinalizeOrder();
          }}
        />
        </DialogLayer>
      )}
    </>
  );
}

/** Available now vs. what this line would backorder, in words. */
function stockText(item) {
  const vials = (n) => `${n.toLocaleString()} ${n === 1 ? "vial" : "vials"}`;
  if (item.availableNow === 0) return "Out of stock — future order";
  if (item.quantity > item.availableNow) {
    return `Available now: ${vials(item.availableNow)} · about ${vials(item.quantity - item.availableNow)} backordered`;
  }
  return `Available: ${vials(item.availableNow)}`;
}

function OrderRow({ item, price, review, onAccept, onDecrease, onIncrease, onRemove }) {
  return (
    <tr className={review ? "place-v2-row-review" : undefined}>
      <td>
        <strong>{item.name}</strong>
        {item.batchGone ? (
          <small className="place-v2-line-alert">This batch is no longer available. Remove it to continue.</small>
        ) : item.liveBlockedReason ? (
          <small className="place-v2-line-alert">{item.liveBlockedReason} Remove it to continue.</small>
        ) : (
          item.availableNow !== null && <small>{stockText(item)}</small>
        )}
        {item.live && item.priceChanged && (
          <small className="place-v2-line-alert">
            {item.livePriceCentavos === null
              ? "This batch no longer has a price. Remove it to continue."
              : `Price changed: ${formatCentavos(item.expectedUnitPriceCentavos)} in your cart, ${formatCentavos(item.livePriceCentavos)} now.`}
          </small>
        )}
        {review === "accept-stock" && (
          <small className="place-v2-line-alert">
            Stock changed: you saw {Number(item.cartAvailable).toLocaleString()} available; part of this line would now be backordered.
          </small>
        )}
        {(review === "accept-price" || review === "accept-stock") && (
          <button type="button" className="place-v2-accept-btn" onClick={onAccept}>
            {review === "accept-price" ? `Accept ${formatCentavos(item.livePriceCentavos)}` : "Accept current stock"}
          </button>
        )}
        <small className="place-v2-vat">
          {item.vatClassification ? PRODUCT_VAT_LABELS[item.vatClassification] : "VAT status confirmed when placed"}
        </small>
      </td>

      <td>
        {item.sku}
      </td>

      <td>
        <div className="qty-mini place-v2-qty-mini">
          <button type="button" onClick={onDecrease}>−</button>
          <span>{item.quantity}</span>
          <button type="button" onClick={onIncrease}>+</button>
        </div>
      </td>

      {/* The AGREED price (the standard unless negotiated below), and the
          line's FINAL total. A figure that could not be read shows a dash
          rather than a zero. */}
      <td className="tnum">
        {price?.agreedUnitPriceCentavos != null ? formatCentavos(price.agreedUnitPriceCentavos) : "—"}
        {price?.priceNegotiated && <small className="place-v2-negotiated-tag">{NEGOTIATED_PRICE_LABEL}</small>}
      </td>

      <td className="tnum">
        {price?.finalLineTotalCentavos != null ? formatAmount(price.finalLineTotalCentavos) : "—"}
      </td>

      <td>
        <button type="button" className="place-v2-remove-btn" onClick={onRemove}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

/** Signed peso amount for an adjustment ("−₱450.00" / "+₱50.00" / "₱0.00"). */
function formatAdjustment(centavos) {
  if (centavos === null || centavos === undefined) return "—";
  if (centavos === 0) return "₱0.00";
  const sign = centavos < 0 ? "−" : "+";
  return `${sign}${formatCentavos(Math.abs(centavos))}`;
}

/** formatCentavos shows "—" for zero (not a price); a line or breakdown amount of ₱0.00 is real. */
function formatAmount(centavos) {
  return centavos === 0 ? "₱0.00" : formatCentavos(centavos);
}

function vatLabelFor(cls) {
  return cls ? PRODUCT_VAT_LABELS[cls] : "VAT status confirmed when placed";
}

/**
 * The final price review, per line: the standard unit price, an editable AGREED
 * unit price (VAT-inclusive) with its reason, and the negotiated and final line
 * totals. Totals are derived in integers; there is no total input. Checkout
 * offers no SC/PWD discount entry, so every line is placed without one.
 */
function PriceReview({
  lines,
  disabled,
  onAgreedChange,
  onReasonChange,
  onReset,
}) {
  if (lines.length === 0) return null;
  return (
    <section className="place-v2-price-review" aria-labelledby="price-review-title">
      <div className="place-v2-price-review-head">
        <h2 id="price-review-title">Final price review</h2>
        <p>
          Confirm each line&apos;s agreed unit price. Prices are VAT-inclusive for VATable products; change
          a price only when it has been agreed with the client, and give the reason.
        </p>
      </div>
      <ul className="place-v2-price-lines">
        {lines.map(({ item, catalogSku, vatClassification, agreedText, reasonText, price }) => {
          const inputId = `agreed-${item.inventoryId}`;
          const reasonId = `reason-${item.inventoryId}`;
          const errorId = `agreed-error-${item.inventoryId}`;
          const flagged = price.priceNegotiated;
          return (
            <li key={item.inventoryId} className={`place-v2-price-line${flagged ? " negotiated" : ""}`}>
              <div className="place-v2-price-product">
                <strong>{item.name}</strong>
                <span className="place-v2-price-meta">
                  {catalogSku ? <>SKU {catalogSku} · </> : null}Batch {item.sku} · Qty {item.quantity.toLocaleString()}
                </span>
                <span className="place-v2-price-meta">
                  {vatLabelFor(vatClassification)}
                  {vatClassification === "vatable" && " · VAT included"}
                </span>
                {price.priceNegotiated && <span className="place-v2-negotiated-tag">{NEGOTIATED_PRICE_LABEL}</span>}
              </div>

              <dl className="place-v2-price-figures">
                <div>
                  <dt>Standard unit price</dt>
                  <dd className="tnum">{formatCentavos(price.standardUnitPriceCentavos)}</dd>
                </div>
                <div>
                  <dt>Negotiated line total</dt>
                  <dd className="tnum">{price.negotiatedGrossCentavos != null ? formatCentavos(price.negotiatedGrossCentavos) : "—"}</dd>
                </div>
                <div>
                  <dt>Price adjustment</dt>
                  <dd className="tnum">{formatAdjustment(price.negotiatedAdjustmentCentavos)}</dd>
                </div>
                <div>
                  <dt>Final line total</dt>
                  <dd className="tnum">{price.finalLineTotalCentavos != null ? formatAmount(price.finalLineTotalCentavos) : "—"}</dd>
                </div>
              </dl>

              <div className="place-v2-price-edit">
                <label htmlFor={inputId}>
                  Agreed unit price (VAT-inclusive) for {item.name}
                </label>
                <div className="place-v2-price-input">
                  <span aria-hidden="true">₱</span>
                  <input
                    id={inputId}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={agreedText}
                    disabled={disabled}
                    aria-invalid={price.priceError ? "true" : "false"}
                    aria-describedby={price.priceError ? errorId : undefined}
                    onChange={(event) => onAgreedChange(item.inventoryId, event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="place-v2-reset-btn"
                  onClick={() => onReset(item.inventoryId)}
                  disabled={disabled || (!price.priceNegotiated && !price.priceError)}
                  aria-label={`Reset ${item.name} to the standard price`}
                >
                  Reset to standard price
                </button>
                {price.priceError && (
                  <p id={errorId} className="place-v2-price-error" role="alert">
                    {price.priceError}
                  </p>
                )}
              </div>

              {price.priceNegotiated && (
                <div className="place-v2-price-reason">
                  <label htmlFor={reasonId}>Reason for the negotiated price (required)</label>
                  <textarea
                    id={reasonId}
                    rows={2}
                    maxLength={500}
                    value={reasonText}
                    disabled={disabled}
                    aria-invalid={price.reasonError ? "true" : "false"}
                    onChange={(event) => onReasonChange(item.inventoryId, event.target.value)}
                    placeholder="e.g. Volume agreement with the clinic"
                  />
                  {price.reasonError && (
                    <p className="place-v2-price-error" role="alert">
                      {price.reasonError}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The order's figures: negotiated subtotal, the VAT breakdown and the final
 * total. They reconcile: negotiated subtotal = final total = the VAT parts.
 */
function VatBreakdown({ summary }) {
  if (!summary) {
    return (
      <p className="place-v2-price-note" role="status">
        The totals appear once every line has a valid agreed price and VAT classification.
      </p>
    );
  }
  return (
    <dl className="place-v2-vat-breakdown">
      {summary.negotiatedAdjustmentCentavos !== 0 && (
        <div>
          <dt>Standard total</dt>
          <dd className="tnum">{formatAmount(summary.standardTotalCentavos)}</dd>
        </div>
      )}
      <div>
        <dt>Negotiated subtotal</dt>
        <dd className="tnum">{formatAmount(summary.negotiatedSubtotalCentavos)}</dd>
      </div>
      <div>
        <dt>VATable sales (net of VAT)</dt>
        <dd className="tnum">{formatAmount(summary.vatableSalesCentavos)}</dd>
      </div>
      <div>
        <dt>VAT-exempt sales</dt>
        <dd className="tnum">{formatAmount(summary.vatExemptSalesCentavos)}</dd>
      </div>
      <div>
        <dt>Zero-rated sales</dt>
        <dd className="tnum">{formatAmount(summary.zeroRatedSalesCentavos)}</dd>
      </div>
      <div>
        <dt>VAT (12%)</dt>
        <dd className="tnum">{formatAmount(summary.vatAmountCentavos)}</dd>
      </div>
      <div className="place-v2-final-total">
        <dt>Final total (VAT-inclusive)</dt>
        <dd className="tnum">{formatAmount(summary.totalCentavos)}</dd>
      </div>
    </dl>
  );
}

/**
 * Explicit reconfirmation before the order is created: who and where, every
 * line with its classification, standard vs agreed price and reason where
 * negotiated, the totals and the final total.
 */
function ReconfirmDialog({ doctorName, destination, lines, summary, schedule, saving, onCancel, onConfirm }) {
  const focusFirst = useCallback((node) => node?.focus(), []);
  return (
    <div className="place-v2-confirm-backdrop">
      <div
        className="place-v2-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconfirm-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onCancel();
        }}
      >
        <h2 id="reconfirm-title" tabIndex={-1} ref={focusFirst}>
          Confirm order and prices
        </h2>
        <p className="place-v2-confirm-dest">
          <strong>{doctorName}</strong>
          <span>{destination}</span>
        </p>
        {schedule && (
          <p className="place-v2-confirm-schedule">
            <span>Requested delivery (arrival at the destination)</span>
            <strong>{schedule}</strong>
          </p>
        )}
        <ul className="place-v2-confirm-lines">
          {lines.map(({ item, vatClassification, price }) => (
            <li key={item.inventoryId}>
              <div>
                <strong>{item.name}</strong>
                <span>
                  Qty {item.quantity.toLocaleString()} · {vatLabelFor(vatClassification)}
                </span>
              </div>
              <div className="tnum">
                {price.priceNegotiated ? (
                  <>
                    <span>
                      {NEGOTIATED_PRICE_LABEL}: {formatCentavos(price.agreedUnitPriceCentavos)}
                      <small> (standard {formatCentavos(price.standardUnitPriceCentavos)})</small>
                    </span>
                    <span className="place-v2-confirm-reason">Reason: {price.negotiationReason}</span>
                  </>
                ) : (
                  <span>{formatCentavos(price.agreedUnitPriceCentavos)} each</span>
                )}
                <strong>{formatAmount(price.finalLineTotalCentavos)}</strong>
              </div>
            </li>
          ))}
        </ul>
        <VatBreakdown summary={summary} />
        <div className="place-v2-confirm-actions">
          <button type="button" className="place-v2-add-more" onClick={onCancel} disabled={saving}>
            Back to review
          </button>
          <button type="button" className="place-v2-confirm-btn" onClick={onConfirm} disabled={saving} aria-busy={saving}>
            {saving ? "Placing order…" : "Confirm and place order"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SalesRepPlaceOrder;
