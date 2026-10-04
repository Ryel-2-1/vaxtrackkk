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
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createOrderWithReservation } from "../../services/inventoryCallables";
import {
  UNAUTHENTICATED_MESSAGE,
  discardOrderAttempt,
  initialCheckoutSelection,
  loadCartDraft,
  loadCheckoutSelection,
  loadPendingAttempt,
  resolveRestoredDestination,
  saveCheckoutSelection,
  submitOrderDraft,
  updateCartDraftLines,
} from "../../services/orderDraftRequest";
import { loadAuthoritativeConfirmation } from "../../services/orderConfirmation";
import { getOrderById } from "../../services/orderService";
import { auth } from "../../firebase";
import { subscribeClinics } from "../../services/clinicService";
import { subscribeDoctors } from "../../services/doctorService";
import { subscribeDoctorAddresses } from "../../services/doctorAddressService";
import useOwnProfile from "../../components/profile/useOwnProfile";
import {
  NO_TERRITORY_MESSAGE,
  permittedDoctors,
  readTerritory,
  territoryDestinationOptions,
} from "../../services/territory";
import { manilaToday, validateRequestedDate } from "../../services/requestedDate";
import { formatCentavos, readPriceCentavos } from "../../services/money";

/**
 * A server error code turned into something a rep can act on.
 *
 * The server already writes a user-facing sentence; this only adds the extra
 * step where the right next action is not obvious from the message alone.
 */
function messageForCallableError(error) {
  switch (error?.code) {
    case "insufficient-stock": {
      const info = error.info;
      return info
        ? `Only ${info.available} left in batch ${info.batchId ?? info.inventoryId}. Adjust the quantity and try again.`
        : error.message;
    }
    case "batch-expired":
      return "One of these batches has expired and can no longer be ordered. Remove it and pick another.";
    case "price-changed": {
      // The whole point of the check is that a rep sees the real numbers and
      // decides, so both figures are named rather than summarised as "changed".
      const info = error.info;
      if (!info) return error.message;
      const batch = info.batchId ?? info.inventoryId;
      return `The price of batch ${batch} changed from ${formatCentavos(
        info.expectedUnitPriceCentavos
      )} to ${formatCentavos(
        info.currentUnitPriceCentavos
      )} while you were ordering. Nothing was placed. Rebuild the cart from the catalog to order at the new price.`;
    }
    case "batch-unpriced":
      return "One of these batches has no selling price yet. An admin needs to price it before it can be ordered.";
    case "price-not-confirmed":
      return "This cart was built before batch pricing. Please rebuild it from the catalog so the prices can be confirmed.";
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
      return error?.message || "Choose a valid delivery date, today or later.";
    default:
      return error?.message || "Unable to create order. Please try again.";
  }
}

// One shared empty list, so "no addresses yet" keeps a stable identity and the
// destination options are not rebuilt on every render.
const EMPTY_ADDRESSES = Object.freeze([]);

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
        stockText: item.stock
          ? `Available: ${Number(item.stock).toLocaleString()} ${Number(item.stock) === 1 ? "vial" : "vials"}`
          : "",
      }));
    }
  } catch (error) {
    console.warn("Unable to load Med Rep cart:", error);
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
  // The last address snapshot, tagged with the doctor it belongs to. Written
  // only by the subscription's callbacks; what the page shows is derived from
  // it below, so a doctor change never needs a synchronous reset in an effect
  // and another doctor's addresses can never be shown for this one.
  const [addressBook, setAddressBook] = useState({ doctorId: null, docs: [] });
  // Every active doctor's addresses, keyed by doctor id — used only to decide
  // which doctors this Med Rep's territory reaches.
  const [addressesByDoctor, setAddressesByDoctor] = useState({});
  const [selectedDestinationId, setSelectedDestinationId] = useState("");
  const [clinics, setClinics] = useState([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  const [destinationLoadError, setDestinationLoadError] = useState("");
  const [instructions, setInstructions] = useState(restored?.deliveryInstructions ?? "");
  // Exact 'YYYY-MM-DD' text, never parsed into a Date, so it cannot shift.
  const [requestedDate, setRequestedDate] = useState(initialCheckout.requestedDeliveryDate);
  const [urgent, setUrgent] = useState(restored?.priority === "Urgent");
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
      },
      () => {
        setClinicsLoading(false);
        setDestinationLoadError("Clinic destinations could not be loaded.");
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeDoctors(
      (docs) => {
        setDoctors(docs);
        setDoctorsLoading(false);
      },
      () => {
        setDoctorsLoading(false);
        setDestinationLoadError("Doctors could not be loaded.");
      }
    );

    return unsubscribe;
  }, []);

  // Subscribe to the selected doctor's addresses. The effect only subscribes;
  // clearing the previous doctor's addresses and destination happens in
  // handleDoctorChange, the event that changes the doctor.
  useEffect(() => {
    if (!selectedDoctorId) return undefined;

    const unsubscribe = subscribeDoctorAddresses(
      selectedDoctorId,
      (docs) => {
        // A restored destination is NOT applied here: it is verified against
        // this doctor's options once they (and the clinics they reference)
        // have loaded — see resolveRestoredDestination below.
        setAddressBook({ doctorId: selectedDoctorId, docs });
      },
      () => {
        // Loaded, with nothing usable — ends the loading state.
        setAddressBook({ doctorId: selectedDoctorId, docs: [] });
        setDestinationLoadError("That doctor's delivery addresses could not be loaded.");
      }
    );

    return unsubscribe;
  }, [selectedDoctorId]);

  // The Med Rep's own territory (Admin-assigned, read-only to them).
  const { profile: ownProfile, loading: profileLoading } = useOwnProfile();
  const territory = useMemo(() => readTerritory(ownProfile), [ownProfile]);

  // Subscribe to every active doctor's addresses. The effect only subscribes;
  // state changes come from the snapshot callbacks.
  const activeDoctorKey = doctors
    .filter((doctor) => doctor.active === true)
    .map((doctor) => doctor.id)
    .sort()
    .join("|");
  useEffect(() => {
    if (!activeDoctorKey) return undefined;
    const unsubscribes = activeDoctorKey.split("|").map((doctorId) =>
      subscribeDoctorAddresses(
        doctorId,
        (docs) => setAddressesByDoctor((current) => ({ ...current, [doctorId]: docs })),
        () => setAddressesByDoctor((current) => ({ ...current, [doctorId]: [] }))
      )
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [activeDoctorKey]);
  const territoryAddressesReady = activeDoctorKey
    .split("|")
    .every((doctorId) => !doctorId || doctorId in addressesByDoctor);
  // Doctors, clinics, the territory and (when one is assigned) every doctor's
  // addresses must all be loaded before the list can be trusted.
  const doctorListLoading =
    doctorsLoading ||
    clinicsLoading ||
    profileLoading ||
    (territory.assigned && !territoryAddressesReady);

  // Derived, never stored: this doctor's addresses once their snapshot has
  // arrived, and "loading" until it has.
  const addressesReady = !!selectedDoctorId && addressBook.doctorId === selectedDoctorId;
  const doctorAddresses = addressesReady ? addressBook.docs : EMPTY_ADDRESSES;
  const addressesLoading = !!selectedDoctorId && !addressesReady;

  // A USER changing (or clearing) the doctor: the new doctor starts with no
  // addresses and no destination, and any destination still waiting to be
  // restored is dropped — the previous doctor's choice must never carry over.
  // Initial restoration after a refresh does not pass through here.
  const handleDoctorChange = (doctorId) => {
    setSelectedDoctorId(doctorId);
    setAddressBook({ doctorId: null, docs: [] });
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
    });
  }, [uid, doctorSelectValue, draftDestinationId, requestedDate]);

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.sku.toLowerCase().includes(query) ||
        item.chain.toLowerCase().includes(query)
    );
  }, [items, searchTerm]);

  const totalQuantity = items.reduce((total, item) => total + item.quantity, 0);

  /**
   * The cart's VAT-exclusive subtotal, in centavos — an ESTIMATE, and labelled
   * as one on screen.
   *
   * The authoritative subtotal is the one the server computes from the batches
   * inside the reservation transaction and writes onto the order. This figure
   * exists so the rep can see what they are about to commit to; if it disagrees
   * with the server the checkout is refused with `price-changed` rather than
   * quietly reconciled. Null when any line has no readable price, because a
   * partial total is a wrong total.
   */
  const subtotalCentavos = items.some((item) => item.expectedUnitPriceCentavos === null)
    ? null
    : items.reduce(
        (total, item) => total + item.expectedUnitPriceCentavos * item.quantity,
        0
      );

  const handleQuantityChange = (sku, action) => {
    setItems((current) =>
      current.map((item) => {
        if (item.sku !== sku) return item;
        const nextQuantity =
          action === "increase" ? item.quantity + 1 : Math.max(item.quantity - 1, 1);
        return { ...item, quantity: nextQuantity };
      })
    );
  };

  const handleRemoveItem = (sku) => {
    setItems((current) => current.filter((item) => item.sku !== sku));
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

  const handleFinalizeOrder = async () => {
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

    // Optional booking date. Blank is fine; a present date must be valid and not
    // in the past. The server re-validates, but checking here tells the rep at
    // once rather than after a round trip.
    const requestedCheck = validateRequestedDate(requestedDate);
    if (!requestedCheck.ok) {
      submittingRef.current = false;
      setMessage(requestedCheck.message);
      return;
    }

    // The draft is scoped to the signed-in Med Rep, so there must be one.
    // Refused here, before any id is generated or anything is sent.
    if (!uid) {
      submittingRef.current = false;
      setMessage(UNAUTHENTICATED_MESSAGE);
      return;
    }

    // Everything the rep is submitting — including priority, instructions and
    // the requested date, which the server fingerprint ignores. It is saved
    // with the request id before the call, and a retry must match it.
    const submission = {
      doctorId: selectedDoctor.id,
      doctorAddressId: selectedDestination.id,
      priority: urgent ? "Urgent" : "Standard",
      deliveryInstructions: instructions.trim(),
      requestedDeliveryDate: requestedCheck.value,
      items: items.map((item) => ({
        inventoryId: item.inventoryId,
        quantity: Number(item.quantity),
        expectedUnitPriceCentavos: item.expectedUnitPriceCentavos,
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
            items: submission.items,
          });
          if (typeof created?.orderId !== "string" || created.orderId === "") {
            // Thrown INSIDE submit so the draft survives: finalizing again
            // replays the saved order under the same id.
            throw new Error(
              "The order may have been saved, but the server's reply was incomplete. Finalize again to recover it."
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
              onClick={() => navigate("/sales-rep/request-order")}
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
                      key={item.sku}
                      item={item}
                      onDecrease={() => handleQuantityChange(item.sku, "decrease")}
                      onIncrease={() => handleQuantityChange(item.sku, "increase")}
                      onRemove={() => handleRemoveItem(item.sku)}
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
              placeholder="Add special handling notes, gate codes, or delivery window preferences..."
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

            {/* Named "estimated" and "excl. VAT" on purpose. The server writes
                the binding figure, and the invoice adds 12% on top of it —
                a number labelled just "Total" would be read as neither. */}
            <p>
              Estimated subtotal
              <strong className="tnum">
                {subtotalCentavos === null ? "—" : formatCentavos(subtotalCentavos)}
              </strong>
            </p>
            <p className="place-v2-price-note">
              Excludes 12% VAT, added at invoicing. Prices are confirmed against
              the batch when the order is placed.
            </p>

            <button
              type="button"
              onClick={handleFinalizeOrder}
              disabled={
                saving ||
                items.length === 0 ||
                doctorListLoading ||
                !territory.assigned ||
                addressesLoading ||
                !selectedDoctor ||
                !selectedDestination
              }
            >
              {saving ? "Saving Order..." : "Finalize Order →"}
            </button>

            <small>
              By clicking finalize, you confirm this order complies with medical distribution regulations.
            </small>
          </div>
        </aside>
      </section>
    </>
  );
}

function OrderRow({ item, onDecrease, onIncrease, onRemove }) {
  return (
    <tr>
      <td>
        <strong>{item.name}</strong>
        {item.stockText && <small>{item.stockText}</small>}
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

      {/* Both figures come from the catalog snapshot, and the server will
          confirm the unit price against the live batch before anything is
          placed. A line whose price could not be read shows a dash rather than
          a zero — zero is a price, and this is the absence of one. */}
      <td className="tnum">{formatCentavos(item.expectedUnitPriceCentavos)}</td>

      <td className="tnum">
        {item.expectedUnitPriceCentavos === null
          ? "—"
          : formatCentavos(item.expectedUnitPriceCentavos * item.quantity)}
      </td>

      <td>
        <button type="button" className="place-v2-remove-btn" onClick={onRemove}>
          <Trash2 size={15} />
        </button>
      </td>
    </tr>
  );
}

export default SalesRepPlaceOrder;
