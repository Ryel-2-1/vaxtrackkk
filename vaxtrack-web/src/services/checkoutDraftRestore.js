import { loadCartDraft } from "./orderDraftRequest.js";
import { readPriceCentavos } from "./money.js";
import { readVatClassification } from "./vatClassification.js";
import { validateRequestedDate } from "./requestedDate.js";
import { logSafeError } from "./liveDataErrors.js";
/**
 * The signed-in Med Rep's own saved cart. Another account's cart on this
 * browser is never loaded; an old unscoped cart is migrated once, to the first
 * Med Rep who opens checkout without a cart of their own (see loadCartDraft).
 */
export function restoreCartItems(storage, uid) {
  if (!uid) return [];
  try {
    const savedDraft = loadCartDraft(storage, uid).draft;

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
        // storage value does not become a price, it becomes null, and the
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
export function takePlannedRequestedDate(storage) {
  try {
    const planned = storage.getItem("salesRepPlannedDate");
    if (!planned) return "";
    storage.removeItem("salesRepPlannedDate");
    const check = validateRequestedDate(planned);
    return check.ok && check.value ? check.value : "";
  } catch {
    return "";
  }
}

