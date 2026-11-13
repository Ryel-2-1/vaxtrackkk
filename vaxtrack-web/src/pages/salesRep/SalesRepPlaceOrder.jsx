import {
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  FileText,
  Loader2,
  MapPin,
  PackagePlus,
  Search,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrderWithReservation } from "../../services/inventoryCallables";
import {
  UNAUTHENTICATED_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
  discardOrderAttempt,
  initialCheckoutSelection,
  initialCheckoutReview,
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
import { negotiatedRequestLine } from "../../services/negotiatedPricing";
import {
  acceptLiveLine,
  cartReview,
  lineReview,
} from "../../services/cartLiveStock";
import useOwnProfile from "../../components/profile/useOwnProfile";
import {
  NO_TERRITORY_MESSAGE,
  permittedDoctors,
  readTerritory,
  territoryDestinationOptions,
} from "../../services/territory";
import { manilaToday } from "../../services/requestedDate";
import { validateCheckoutSchedule } from "../../services/checkoutSchedule";
import {
  arrivalPayloadOf,
  formatRequestedDate,
  normalizeArrivalForm,
  normalizeRequestedArrival,
  requestedArrivalLabel,
  requestedScheduleLabel,
} from "../../services/requestedArrival";
import RequestedArrivalField from "../../components/schedule/RequestedArrivalField";
import { requestZeroRateApproval, subscribeOwnZeroRateRequests } from "../../services/zeroRateRequests";
import { approvedZeroRateForOrder, matchingZeroRateOrderRequests, zeroRateCheckoutBlock, zeroRateRequestNoLongerMatching } from "../../services/zeroRateOrderMatch";
import {
  ZERO_RATE_STEP,
  answerChangeClearsPrices,
  pricingLockedReason,
  zeroRateStep,
  zeroRateStepBlock,
} from "../../services/zeroRateStep";
import { formatAmount } from "./priceReviewFormat";
import DialogLayer from "../../components/ui/DialogLayer";
import { PriceReview, ReconfirmDialog, VatBreakdown } from "./OrderPriceReview";
import OrderCartRow from "./OrderCartRow";
import useCheckoutPriceReview from "./useCheckoutPriceReview";
import useCartLiveStock from "./useCartLiveStock";
import { messageForCallableError } from "../../services/checkoutErrorMessages";
import { restoreCartItems, takePlannedRequestedDate } from "../../services/checkoutDraftRestore";
import { lateStockArrival } from "../../services/stockArrival";

// One shared empty list, so "no addresses yet" keeps a stable identity and the
// destination options are not rebuilt on every render.
const EMPTY_ADDRESSES = Object.freeze([]);
const EMPTY_BY_DOCTOR = Object.freeze({});

// The confirmation is no longer assembled here from checkout state. It is
// built from the stored order the callable named (services/orderConfirmation.js),
// so a replayed order can never be shown with values the rep edited afterwards.

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
  const [recoveryAllowed, setRecoveryAllowed] = useState(Boolean(restored));
  const [recoveryApprovalId, setRecoveryApprovalId] = useState(restored?.zeroRateRequestId ?? "");
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
      plannedDate: restored ? "" : takePlannedRequestedDate(localStorage),
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
  const [items, setItems] = useState(() => restoreCartItems(localStorage, uid));
  // The cart's OWN batches and products as they are now (useCartLiveStock.js):
  // changes are shown and gate the checkout, but only the rep's explicit
  // acceptance edits the cart.
  const { displayItems, liveStatus, batches: liveBatches, vaccinesById } = useCartLiveStock(items);
  const review = cartReview(displayItems, liveStatus);
  const handleAcceptLine = (line) => setItems((current) => acceptLiveLine(current, line));
  const [selectedDoctorId, setSelectedDoctorId] = useState(initialCheckout.doctorId);
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [requestedDate, setRequestedDate] = useState(initialCheckout.requestedDeliveryDate);
  // Stock in the cart that arrives after the requested date (stockArrival.js).
  const lateArrival = lateStockArrival(items, liveBatches, requestedDate);
  const [zeroRateRequests, setZeroRateRequests] = useState([]);
  const [zeroRateError, setZeroRateError] = useState("");
  const [zeroRateLoadError, setZeroRateLoadError] = useState(null);
  const [zeroRateReady, setZeroRateReady] = useState(false);
  const [zeroRateReason, setZeroRateReason] = useState("");
  const [zeroRateBusy, setZeroRateBusy] = useState(false);
  const zeroRateSendingRef = useRef(false);
  /** The rep's answer to "Is this a zero-rated sale?" ("" until answered). */
  const [zeroRateAnswer, setZeroRateAnswer] = useState("");
  const [pricesClearedNote, setPricesClearedNote] = useState("");
  const [zeroRateSentId, setZeroRateSentId] = useState("");
  const [submittedZeroRate, setSubmittedZeroRate] = useState(null);
  useEffect(() => {
    if (!uid) return undefined;
    return subscribeOwnZeroRateRequests(uid, (rows) => {
      setZeroRateRequests(rows);
      setZeroRateReady(true);
      setZeroRateLoadError(null);
      setSubmittedZeroRate((current) => current && rows.some((row) => row.id === current.id) ? null : current);
    }, setZeroRateLoadError);
  }, [uid]);
  const visibleZeroRateRequests = submittedZeroRate && !zeroRateRequests.some((row) => row.id === submittedZeroRate.id)
    ? [...zeroRateRequests, submittedZeroRate] : zeroRateRequests;
  const approvalOrder = {
    doctorId: selectedDoctorId,
    doctorAddressId: selectedDestinationId || pendingRestore?.destinationId,
    requestedDeliveryDate: requestedDate,
    items,
  };
  const approvedRequest = approvedZeroRateForOrder(visibleZeroRateRequests, {
    ...approvalOrder, recoveryAllowed, recoveryApprovalId, restored,
  });

  // ---- final price review (negotiated pricing; useCheckoutPriceReview.js) ----
  const {
    negotiation,
    reviewLines,
    priceSummary,
    pricingCheck,
    reviewByBatch,
    setAgreedInput,
    setNegotiationReason,
    resetToStandard,
    clearLinePricing,
  } = useCheckoutPriceReview({
    initialNegotiation: initialReview.negotiation,
    displayItems,
    batches: liveBatches,
    vaccinesById,
    approvedZeroRate: Boolean(approvedRequest),
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
  // Every reachable doctor's destinations, keyed by doctor id, tagged with the
  // active-doctor list they were fetched for. The server returns only links
  // inside this Med Rep's territory — a Med Rep cannot read doctor addresses
  // (including private Home addresses) directly. Written only by the fetch's
  // callbacks; everything shown is derived from it below.
  const [destinationBook, setDestinationBook] = useState({ key: null, byDoctor: {} });
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
  const matchingRequests = matchingZeroRateOrderRequests(visibleZeroRateRequests, {
    doctorId: selectedDoctor?.id, doctorAddressId: selectedDestination?.id,
    requestedDeliveryDate: requestedDate, items,
  });
  const zeroRateBlock = zeroRateCheckoutBlock({
    requests: matchingRequests, ready: zeroRateReady, loadError: zeroRateLoadError,
    sending: zeroRateBusy, recovering: Boolean(uid && loadPendingAttempt(localStorage, uid)),
  });
  // Zero-rating is asked BEFORE pricing (zeroRateStep.js): the answer decides
  // whether VAT applies, so the price review and Finalize wait for it.
  const zeroStep = zeroRateStep({
    hasVatable: reviewLines.some((line) => line.productVatClassification === "vatable"),
    approved: Boolean(approvedRequest),
    pending: matchingRequests.some((row) => row.status === "pending"),
    denied: matchingRequests[0]?.status === "rejected",
    answer: zeroRateAnswer,
    recovering: Boolean(uid && loadPendingAttempt(localStorage, uid)),
  });
  const zeroStepBlock = zeroRateStepBlock(zeroStep);
  // An open request made for other details (the cart was edited after it was
  // sent): say so instead of silently asking the question again.
  const staleZeroRate = zeroRateReady && zeroStep !== ZERO_RATE_STEP.APPROVED && zeroStep !== ZERO_RATE_STEP.PENDING
    ? zeroRateRequestNoLongerMatching(visibleZeroRateRequests, {
      items, doctorId: selectedDoctor?.id, doctorAddressId: selectedDestination?.id,
      requestedDeliveryDate: requestedDate, today: manilaToday(),
    })
    : null;
  const vatRemovedLines = reviewLines.filter((line) => line.vatRemoved);
  const vatRemovedTotal = vatRemovedLines.reduce((sum, line) => sum + line.vatRemoved.lineCentavos, 0);
  const chooseZeroRateAnswer = (next) => {
    if (answerChangeClearsPrices(zeroRateAnswer, next)) {
      // The VAT basis changes, so prices agreed on the old basis no longer
      // mean the same amount.
      const typed = reviewLines.filter((line) => line.productVatClassification === "vatable"
        && negotiation[line.item.inventoryId]?.agreedInput !== undefined);
      typed.forEach((line) => resetToStandard(line.item.inventoryId));
      setPricesClearedNote(typed.length > 0
        ? "Negotiated prices on VATable items were cleared because the VAT changed. Re-enter them if they still apply."
        : "");
    }
    setZeroRateError("");
    setZeroRateAnswer(next);
  };
  const handleZeroRateRequest = async () => {
    if (zeroRateSendingRef.current || submittingRef.current || saving) return;
    if (!selectedDoctor || !selectedDestination || !requestedDate) {
      setZeroRateError("Select a doctor, delivery address and date first."); return;
    }
    zeroRateSendingRef.current = true;
    setZeroRateBusy(true); setZeroRateError("");
    try {
      const result = await requestZeroRateApproval({
        doctorId: selectedDoctor.id, doctorAddressId: selectedDestination.id,
        requestedDeliveryDate: requestedDate, reason: zeroRateReason.trim(),
        items: items.map((item) => ({ inventoryId: item.inventoryId, quantity: Number(item.quantity) })),
      });
      setSubmittedZeroRate({
        id: result.requestId, status: "pending", doctorId: selectedDoctor.id,
        doctorAddressId: selectedDestination.id, requestedDeliveryDate: requestedDate,
        items: items.map((item) => ({ inventoryId: item.inventoryId, quantity: Number(item.quantity) })),
        createdAt: { toMillis: () => Number.MAX_SAFE_INTEGER },
      });
      setZeroRateSentId(result.requestId);
      setZeroRateReason("");
    } catch (error) {
      setZeroRateError(error?.code === "functions/not-found"
        ? "Zero-rating review is not available in this environment yet. Ask an administrator to enable it."
        : friendlyErrorMessage(error, "The zero-rating review request could not be sent. The review service may not be available here yet; please contact an administrator."));
    } finally { zeroRateSendingRef.current = false; setZeroRateBusy(false); }
  };
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
    setRecoveryAllowed(false);
    setRecoveryApprovalId("");
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

    // Re-check on both Review and Confirm. A request submitted while the
    // confirmation was open must not silently become a standard-VAT order.
    const reviewBlock = zeroRateCheckoutBlock({
      requests: matchingRequests, ready: zeroRateReady, loadError: zeroRateLoadError,
      sending: zeroRateSendingRef.current,
      recovering: Boolean(uid && loadPendingAttempt(localStorage, uid)),
    });
    if (reviewBlock || zeroStepBlock) {
      submittingRef.current = false;
      setConfirmOpen(false);
      setMessage(reviewBlock || zeroStepBlock);
      return;
    }

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
      ...(approvedRequest ? { zeroRateRequestId: approvedRequest.id } : {}),
      // Per line: the reviewed standard, the agreed UNIT price and (only when
      // negotiated) its reason. No total and no VAT figure is ever sent.
      items: items.map((item) => ({
        inventoryId: item.inventoryId,
        quantity: Number(item.quantity),
        ...negotiatedRequestLine(item, reviewByBatch.get(item.inventoryId).price),
      })),
    };

    setSaving(true);
    if (approvedRequest) { setRecoveryAllowed(true); setRecoveryApprovalId(approvedRequest.id); }
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
            zeroRateRequestId: submission.zeroRateRequestId,
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

            {/* On a phone each line becomes a card (m-phone-cards), so the
                quantity buttons and totals never sit off-screen. */}
            <table className="m-phone-cards">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch ID</th>
                  <th>Quantity</th>
                  <th>Unit price</th>
                  <th>Line total</th>
                  <th aria-label="Remove"></th>
                </tr>
              </thead>

              <tbody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((item) => (
                    <OrderCartRow
                      key={item.inventoryId}
                      item={item}
                      price={reviewByBatch.get(item.inventoryId)?.price}
                      vatRemoved={reviewByBatch.get(item.inventoryId)?.vatRemoved}
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

          {zeroStep !== ZERO_RATE_STEP.NOT_NEEDED && items.length > 0 && (
            <section className="destination-card zero-rate-checkout-card zero-rate-step" aria-labelledby="zero-rate-step-title">
              <div className="zero-rate-checkout-heading">
                <h2 id="zero-rate-step-title">Is this a zero-rated sale?</h2>
                <span>
                  {zeroStep === ZERO_RATE_STEP.APPROVED ? "Approved" : zeroStep === ZERO_RATE_STEP.PENDING ? "Waiting for Admin" : "Required"}
                </span>
              </div>
              {zeroStep === ZERO_RATE_STEP.PENDING ? (
                <div className="zero-rate-checkout-status is-pending" role="status">
                  <CheckCircle2 size={19} aria-hidden="true" />
                  <div>
                    <strong>{matchingRequests.some((row) => row.id === zeroRateSentId) ? "Request sent for Admin review" : "Waiting for Admin review"}</strong>
                    <p>Prices and Finalize open when Admin decides. Approval removes the VAT from the VATable items; denial keeps standard VAT.</p>
                  </div>
                </div>
              ) : zeroStep === ZERO_RATE_STEP.APPROVED ? (
                <div className="zero-rate-checkout-status is-approved" role="status">
                  <CheckCircle2 size={19} aria-hidden="true" />
                  <div>
                    <strong>Zero-rating approved — VAT removed</strong>
                    <p>
                      {vatRemovedLines.length > 0
                        ? "VAT was taken off " + vatRemovedLines.length + (vatRemovedLines.length === 1 ? " item" : " items") + " (−" + formatAmount(vatRemovedTotal) + "). The prices below have no VAT."
                        : "Admin approved zero-rating for this order. The prices below have no VAT."}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {staleZeroRate && (
                    <p className="zero-rate-checkout-stale" role="status">{staleZeroRate.text}</p>
                  )}
                  <p className="zero-rate-checkout-intro">
                    Answer before pricing. Choose Yes only when the customer&apos;s sale may qualify for zero-rating;
                    Admin reviews it before the order can be placed.
                  </p>
                  <div className="zero-rate-answer" role="radiogroup" aria-labelledby="zero-rate-step-title">
                    <label className={zeroStep === ZERO_RATE_STEP.STANDARD ? "is-on" : ""}>
                      <input type="radio" name="zero-rate-answer" value="no" checked={zeroStep === ZERO_RATE_STEP.STANDARD}
                        disabled={saving || zeroRateBusy} onChange={() => chooseZeroRateAnswer("no")} />
                      <span><strong>No</strong> — standard VAT</span>
                    </label>
                    <label className={zeroRateAnswer === "yes" ? "is-on" : ""}>
                      <input type="radio" name="zero-rate-answer" value="yes" checked={zeroRateAnswer === "yes"}
                        disabled={saving || zeroRateBusy} onChange={() => chooseZeroRateAnswer("yes")} />
                      <span><strong>Yes</strong> — request zero-rating</span>
                    </label>
                  </div>
                  {zeroStep === ZERO_RATE_STEP.STANDARD && (
                    <p className="zero-rate-standard-note">Standard VAT applies: VATable items include 12% VAT.</p>
                  )}
                  {zeroStep === ZERO_RATE_STEP.DENIED && (
                    <p className="zero-rate-checkout-denied" role="status">
                      Admin denied the last request for this order. Send a new reason, or choose No for standard VAT.
                    </p>
                  )}
                  {(zeroStep === ZERO_RATE_STEP.REQUESTING || zeroStep === ZERO_RATE_STEP.DENIED) && (
                    <div id="zero-rate-request-form" className="zero-rate-checkout-form">
                      {(!selectedDoctor || !selectedDestination || !requestedDate) && (
                        <p role="status">Choose the doctor, delivery address and requested date in Destination Details first.</p>
                      )}
                      <label htmlFor="zero-rate-reason">Reason for requesting zero-rating</label>
                      <textarea id="zero-rate-reason" value={zeroRateReason} onChange={(event) => setZeroRateReason(event.target.value)} maxLength={500} placeholder="Explain why this customer’s order may qualify" />
                      <button type="button" className="zero-rate-checkout-submit" onClick={handleZeroRateRequest}
                        disabled={zeroRateBusy || saving || !selectedDoctor || !selectedDestination || !requestedDate || !zeroRateReason.trim()}>
                        {zeroRateBusy ? "Sending request…" : "Send to Admin for review"}
                      </button>
                      {zeroRateError && <p role="alert" className="zero-rate-checkout-error">{zeroRateError}</p>}
                    </div>
                  )}
                </>
              )}
              {zeroRateLoadError && <p role="alert" className="zero-rate-checkout-error">{liveErrorMessage(zeroRateLoadError, "zero-rating requests")} Approval status will appear when access is restored.</p>}
            </section>
          )}

          <PriceReview
            lines={reviewLines}
            lockedReason={pricingLockedReason(zeroStep)}
            clearedNote={pricesClearedNote}
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
                    {/* Client ID first, so typing it in the list jumps to the clinic. */}
                    {destination.type === "home"
                      ? "Home / Doorstep"
                      : `${destination.clientId ? `${destination.clientId} · ` : ""}Clinic — ${destination.name}`}
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
              aria-describedby={lateArrival ? "place-late-stock" : undefined}
            />
            {lateArrival && (
              <p id="place-late-stock" className="place-v2-late-stock" role="status">
                {lateArrival.text}
                <button type="button" onClick={() => setRequestedDate(lateArrival.latestArrival)}>
                  Use {formatRequestedDate(lateArrival.latestArrival)}
                </button>
              </p>
            )}

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
              Batch prices use the basis set by Admin. {approvedRequest ? "Zero-rating is approved: VAT is removed from the VATable items." : "VATable items include 12% VAT."} Prices are confirmed when the order is placed.
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
                saving || Boolean(zeroRateBlock) || Boolean(zeroStepBlock) ||
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
              {saving ? "Saving Order..." : zeroRateBusy ? "Sending request…" : zeroRateBlock ? (matchingRequests.some((row) => row.status === "pending") ? "Waiting for Admin review" : "Checking review status…") : review.checking ? "Checking prices…" : "Review & Finalize →"}
            </button>
            {zeroRateBlock && <p className="place-v2-review-hint" role="status">{zeroRateBlock}</p>}
            {!zeroRateBlock && zeroStepBlock && <p className="place-v2-review-hint" role="status">{zeroStepBlock}</p>}
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

export default SalesRepPlaceOrder;
