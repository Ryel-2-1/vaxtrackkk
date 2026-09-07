import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileDown, Package, Plus, Search, X } from "lucide-react";
import AdminLayout from "../../components/admin/AdminLayout";
import { subscribeInventory } from "../../services/inventoryService";
import { updateStockPrice } from "../../services/vaccineService";
import {
  centavosToInputValue,
  formatCentavos,
  parsePesosToCentavos,
  readPriceCentavos,
} from "../../services/money";
import KpiCard from "../../components/ui/KpiCard";
import "./Inventory.css";

function getDaysUntilExpiry(rawDateStr) {
  if (!rawDateStr) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(rawDateStr + "T00:00:00");
  return Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

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
 * Available is DERIVED (`quantity - reservedQuantity`), never stored — a third
 * persisted total would be a number nothing could keep honest. Data problems
 * are surfaced as flags rather than smoothed over: a quantity stored as text
 * reads "—", not "0", because those mean very different things to whoever has
 * to act on the row.
 */
function normalizeInventoryItem(raw) {
  const status = raw.status || "Stable";
  const onHandOk = typeof raw.quantity === "number" && Number.isInteger(raw.quantity);
  const reservedRaw = raw.reservedQuantity;
  const reservedOk =
    reservedRaw === undefined ||
    reservedRaw === null ||
    (typeof reservedRaw === "number" && Number.isInteger(reservedRaw) && reservedRaw >= 0);
  const reserved = typeof reservedRaw === "number" ? reservedRaw : 0;
  const available = onHandOk && reservedOk ? raw.quantity - reserved : null;

  const flags = [];
  if (!onHandOk) {
    flags.push(
      typeof raw.quantity === "string"
        ? "Quantity stored as text — needs migration"
        : "Quantity is not a whole number"
    );
  }
  if (!reservedOk) flags.push("Reserved figure is invalid");
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
  if (reservedRaw === undefined || reservedRaw === null) flags.push("No reserved field yet");
  if (available !== null && available < 0) flags.push("Reserved exceeds stock on hand");
  if (raw.expiryDate && /^\d{4}-\d{2}-\d{2}$/.test(raw.expiryDate)) {
    const todayManila = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (raw.expiryDate < todayManila) flags.push("Expired");
  }

  return {
    id: raw.id,
    name: raw.vaccineName || "—",
    type: raw.vaccineType || "—",
    batch: raw.batchId || "—",
    expiry: formatExpiry(raw.expiryDate),
    expiryRaw: raw.expiryDate || "",
    onHand: onHandOk ? raw.quantity.toLocaleString() : "—",
    reserved: reservedOk ? reserved.toLocaleString() : "—",
    available: available === null ? "—" : available.toLocaleString(),
    priceCentavos,
    price: formatCentavos(priceCentavos),
    flags,
    qty: raw.quantity != null ? Number(raw.quantity).toLocaleString() : "—",
    qtyRaw: raw.quantity != null ? Number(raw.quantity) : 0,
    temp: raw.storageTempDisplay || (raw.storageTemp != null ? `${raw.storageTemp}°C` : "—"),
    status,
    level: status.toLowerCase(),
    location: raw.location || "—",
    manufacturer: raw.manufacturer || "—",
  };
}

function Inventory() {
  const navigate = useNavigate();

  const [inventory, setInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expiryFilter, setExpiryFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedBatches, setSelectedBatches] = useState([]);
  const [selectedVaccine, setSelectedVaccine] = useState(null);
  const [toast, setToast] = useState("");

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

  useEffect(() => {
    const unsubscribe = subscribeInventory((raw) => {
      setInventory(raw.map(normalizeInventoryItem));
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const pageSize = 3;

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(""), 2200);
  };

  const openPriceDialog = (item) => {
    setPricing(item);
    setPriceInput(centavosToInputValue(item.priceCentavos));
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
    if (savingPrice || !pricing) return;

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
      showToast(`Price updated for batch ${pricing.batch}.`);
    } catch (error) {
      console.error("Update price error:", error);
      setPriceError("Could not save the price. Please try again.");
    } finally {
      setSavingPrice(false);
    }
  };

  const filteredVaccines = useMemo(() => {
    return inventory.filter((item) => {
      const searchValue =
        `${item.name} ${item.type} ${item.batch} ${item.status}`.toLowerCase();

      const matchesSearch = searchValue.includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === "all" || item.level === statusFilter;

      const daysUntilExpiry = getDaysUntilExpiry(item.expiryRaw);
      const matchesExpiry =
        expiryFilter === "all" ||
        (daysUntilExpiry >= 0 && daysUntilExpiry <= Number(expiryFilter));

      return matchesSearch && matchesStatus && matchesExpiry;
    });
  }, [inventory, searchTerm, statusFilter, expiryFilter]);

  const stockByType = useMemo(() => {
    if (inventory.length === 0) return [];
    const totals = {};
    inventory.forEach((item) => {
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
  }, [inventory]);

  const criticalAndExpiring = useMemo(() => {
    return inventory
      .filter((i) => {
        const days = getDaysUntilExpiry(i.expiryRaw);
        return i.level === "critical" || (days >= 0 && days <= 30);
      })
      .sort((a, b) => getDaysUntilExpiry(a.expiryRaw) - getDaysUntilExpiry(b.expiryRaw))
      .slice(0, 4);
  }, [inventory]);

  const criticalCount = useMemo(
    () => inventory.filter((i) => i.level === "critical").length,
    [inventory]
  );
  const expiringSoonCount = useMemo(
    () =>
      inventory.filter((i) => {
        const days = getDaysUntilExpiry(i.expiryRaw);
        return days >= 0 && days <= 90;
      }).length,
    [inventory]
  );
  const stableCount = useMemo(
    () => inventory.filter((i) => i.level === "stable").length,
    [inventory]
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

  const startItem =
    filteredVaccines.length === 0 ? 0 : (safePage - 1) * pageSize + 1;

  const endItem = Math.min(safePage * pageSize, filteredVaccines.length);

  const isAllSelected =
    paginatedVaccines.length > 0 &&
    paginatedVaccines.every((item) => selectedBatches.includes(item.batch));

  const toggleAll = () => {
    const visibleBatchIds = paginatedVaccines.map((item) => item.batch);

    if (isAllSelected) {
      setSelectedBatches((prev) =>
        prev.filter((batch) => !visibleBatchIds.includes(batch))
      );
      return;
    }

    setSelectedBatches((prev) => Array.from(new Set([...prev, ...visibleBatchIds])));
  };

  const toggleBatch = (batch) => {
    setSelectedBatches((prev) =>
      prev.includes(batch)
        ? prev.filter((item) => item !== batch)
        : [...prev, batch]
    );
  };

  return (
    <AdminLayout
      active="inventory"
      title="Inventory"
      description="Real-time vaccine stock, batch status, and cold-chain visibility."
      actions={
        <>
          <button
            type="button"
            className="v2-light-action"
            onClick={() => showToast("Inventory report exported.")}
          >
            <FileDown size={16} aria-hidden="true" />
            Export
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
      {toast && <div className="v2-inventory-toast">{toast}</div>}

        <section className="v2-inventory-summary-grid">
          <KpiCard
            label="Total batches"
            value={loading ? "—" : inventory.length}
            context="Across all vaccine types"
            tone="neutral"
            onClick={() => setStatusFilter("all")}
          />

          <KpiCard
            label="Critical stock"
            value={loading ? "—" : inventory.filter((i) => i.level === "critical").length}
            context="Needs immediate review"
            tone="danger"
            attention
            onClick={() => setStatusFilter("critical")}
          />

          <KpiCard
            label="Warning batches"
            value={loading ? "—" : inventory.filter((i) => i.level === "warning").length}
            context="Temperature exceptions"
            tone="warning"
            onClick={() => setStatusFilter("warning")}
          />

          <KpiCard
            label="Stable batches"
            value={loading ? "—" : inventory.filter((i) => i.level === "stable").length}
            context="No action required"
            tone="success"
            onClick={() => setStatusFilter("stable")}
          />
        </section>

        <section className="v2-hub-grid">
          <StockOverviewCard groups={stockByType} loading={loading} />

          <CriticalExpiringCard batches={criticalAndExpiring} loading={loading} />

          <InventoryAlertCard
            critical={criticalCount}
            expiringSoon={expiringSoonCount}
            stable={stableCount}
            loading={loading}
          />
        </section>

        <section className="v2-inventory-table-card">
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

              <button
                type="button"
                className={statusFilter === "critical" ? "active" : ""}
                onClick={() => setStatusFilter("critical")}
              >
                Critical
              </button>

              <button
                type="button"
                className={statusFilter === "warning" ? "active" : ""}
                onClick={() => setStatusFilter("warning")}
              >
                Warning
              </button>

              <button
                type="button"
                className={statusFilter === "stable" ? "active" : ""}
                onClick={() => setStatusFilter("stable")}
              >
                Stable
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

          {selectedBatches.length > 0 && (
            <div className="v2-bulk-bar">
              <strong>{selectedBatches.length} batch selected</strong>

              <div>
                <button
                  type="button"
                  onClick={() => showToast("Selected batches marked as checked.")}
                >
                  Mark as Checked
                </button>

                <button
                  type="button"
                  onClick={() => showToast("Batch report generated.")}
                >
                  Generate Report
                </button>

                <button type="button" onClick={() => setSelectedBatches([])}>
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="v2-table-scroll">
            <table className="v2-vaccine-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Vaccine name</th>
                  <th>Batch ID</th>
                  <th>Expiry date</th>
                  <th>On hand</th>
                <th>Reserved</th>
                <th>Available</th>
                  <th>Unit price</th>
                  <th>Temp</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {paginatedVaccines.map((item) => (
                  <tr
                    key={item.batch}
                    className={`v2-row-${item.level}`}
                    onClick={() => setSelectedVaccine(item)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedBatches.includes(item.batch)}
                        onChange={() => toggleBatch(item.batch)}
                      />
                    </td>

                    <td>
                      <div className="v2-vaccine-cell">
                        <span>
                          <Package size={15} />
                        </span>

                        <div>
                          <strong>{item.name}</strong>
                          <small>{item.type}</small>
                        </div>
                      </div>
                    </td>

                    <td>{item.batch}</td>
                    <td>{item.expiry}</td>
                    <td>{item.onHand}</td>
                    <td>{item.reserved}</td>
                    <td>
                      {item.available}
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
                    </td>

                    <td>
                      <span className="v2-temp-pill">{item.temp}</span>
                    </td>

                    <td>
                      <span className={`v2-stock-status ${item.level}`}>
                        {item.status}
                      </span>
                    </td>

                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="inv-price-btn"
                        onClick={() => openPriceDialog(item)}
                      >
                        {item.priceCentavos === null ? "Set price" : "Edit price"}
                      </button>
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

          {!loading && filteredVaccines.length === 0 && (
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

      {selectedVaccine && (
        <div className="v2-inventory-modal-backdrop">
          <div className="v2-inventory-modal">
            <button
              type="button"
              className="v2-inventory-modal-close"
              onClick={() => setSelectedVaccine(null)}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div className={`v2-modal-badge ${selectedVaccine.level}`}>
              {selectedVaccine.status}
            </div>

            <h2>{selectedVaccine.name}</h2>
            <p>{selectedVaccine.type} vaccine batch details and cold-chain status.</p>

            <div className="v2-modal-detail-grid">
              <div>
                <span>Batch ID</span>
                <strong>{selectedVaccine.batch}</strong>
              </div>

              <div>
                <span>On hand / Reserved / Available</span>
                <strong>
                  {selectedVaccine.onHand} / {selectedVaccine.reserved} /{" "}
                  {selectedVaccine.available}
                </strong>
                {selectedVaccine.flags.length > 0 && (
                  <small className="inv-flag-list">
                    {selectedVaccine.flags.join(" · ")}
                  </small>
                )}
              </div>

              <div>
                <span>Expiry Date</span>
                <strong>{selectedVaccine.expiry}</strong>
              </div>

              <div>
                <span>Storage Temp</span>
                <strong>{selectedVaccine.temp}</strong>
              </div>

              <div>
                <span>Location</span>
                <strong>{selectedVaccine.location}</strong>
              </div>

              <div>
                <span>Manufacturer</span>
                <strong>{selectedVaccine.manufacturer}</strong>
              </div>
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
                className="v2-light-action"
                onClick={() => showToast("Batch history opened.")}
              >
                View Batch History
              </button>

              <button
                type="button"
                className="v2-danger-action"
                onClick={() => showToast("Batch flagged for review.")}
              >
                Flag for Review
              </button>
            </div>
          </div>
        </div>
      )}

      {pricing && (
        <div className="v2-inventory-modal-backdrop" onClick={closePriceDialog}>
          <div
            className="v2-inventory-modal inv-price-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inv-price-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="v2-inventory-modal-close"
              onClick={closePriceDialog}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <h2 id="inv-price-title">Set selling price</h2>

            <p className="inv-price-batch">
              <strong>{pricing.name}</strong>
              <span>Batch {pricing.batch}</span>
            </p>

            <label htmlFor="inv-price-input">Unit selling price (₱)</label>
            <input
              id="inv-price-input"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 1250.00"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              aria-describedby="inv-price-help"
            />
            <small id="inv-price-help">
              Price per vial charged to the clinic, excluding VAT. Applies to
              this batch only, and only to orders placed from now on — orders
              already placed keep the price they were quoted.
            </small>

            {/* assertive: it reports the outcome of an action just taken. */}
            <div aria-live="assertive">
              {priceError && <p className="inv-price-error">{priceError}</p>}
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
                disabled={savingPrice}
              >
                {savingPrice ? "Saving…" : "Save price"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function StockOverviewCard({ groups, loading }) {
  return (
    <div className="v2-hub-card">
      <div className="v2-card-head">
        <h2>Current Stock Overview</h2>
        <p>Total doses available by vaccine type</p>
      </div>

      {loading ? (
        <p className="v2-stock-empty">Loading...</p>
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

function CriticalExpiringCard({ batches, loading }) {
  return (
    <div className="v2-hub-card v2-cold-card">
      <div className="v2-card-head">
        <h2>Critical &amp; Expiring</h2>
        <p>Critical stock and batches expiring within 30 days</p>
      </div>

      <div className="v2-cold-list">
        {loading ? (
          <div><span>Loading...</span></div>
        ) : batches.length === 0 ? (
          <div><span>No critical or near-expiry batches</span></div>
        ) : (
          batches.map((item) => {
            const days = getDaysUntilExpiry(item.expiryRaw);
            return (
              <div key={item.batch}>
                <span>{item.name}</span>
                <strong>{item.expiry}</strong>
                <small className={item.level}>
                  {item.level === "critical"
                    ? `Critical — ${days >= 0 ? `${days}d left` : "expired"}`
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