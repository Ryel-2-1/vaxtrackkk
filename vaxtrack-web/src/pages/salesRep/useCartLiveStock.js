import { useEffect, useMemo, useState } from "react";
import { cartBatchIds, liveCartLines } from "../../services/cartLiveStock";
import { subscribeInventoryBatches } from "../../services/inventoryService";
import { subscribeVaccinesByIds } from "../../services/vaccineCatalogService";
import { manilaToday } from "../../services/requestedDate";

/**
 * The checkout cart's OWN batches and products as they are now.
 *
 * A listener on just the cart's batch document ids, replaced when the cart's
 * set of batches changes — never the whole inventory collection — and one on
 * just those batches' vaccine products, never the whole catalog. See
 * cartLiveStock.js: changes are shown and gate the checkout, but only the
 * rep's explicit acceptance edits the cart. This hook never edits [items].
 *
 * Returns the cart lines as shown (`displayItems`), the listener state
 * (`liveStatus`: "live" | "loading" | "failed"), and the raw `batches` and
 * `vaccinesById` the price review reads.
 */
export default function useCartLiveStock(items) {
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

  return { displayItems, liveStatus, batches: liveStock.batches, vaccinesById: catalog.byId };
}
