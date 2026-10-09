import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALLOCATION_FILTER_OPTIONS,
  HISTORY_PAGE_SIZE,
  STAGE_OPTIONS,
  formatDateTime,
  historyRow,
  loadedFilterNotice,
  matchesHistoryFilters,
  mergeHistoryPage,
} from "../../services/orderHistory.js";
import {
  fetchMedReps,
  fetchOrderHistoryPage,
  fetchOrdersByIds,
  fetchReceiptsForOrders,
  findOrderIdsByBatchId,
  findOrderIdsBySku,
  findOrdersByReference,
} from "../../services/orderHistoryService";
import OrderHistoryDetail from "./OrderHistoryDetail";
import "./OrderHistory.css";

/**
 * Order Receipt History + Stock Allocation History, shared by the Med Rep and
 * Admin pages.
 *
 *   mode "salesrep"  only the signed-in Med Rep's orders (medRepUid required);
 *                    every query is scoped to that uid, as the rules require.
 *   mode "admin"     every Med Rep's orders, with a Med Rep filter and exact
 *                    SKU / Batch ID lookups.
 *
 * Loading is bounded: one page of orders at a time, newest first, with "Load
 * older orders". The date range narrows the query itself; status, allocation,
 * priority and the text search filter the orders already loaded, and the page
 * says so. Exact reference / SKU / Batch ID lookups search the whole history.
 */

const EMPTY_FILTERS = { search: "", dateFrom: "", dateTo: "", stage: "", allocationState: "", priority: "" };

function errorMessage(err, what) {
  if (err?.code === "permission-denied") return `You do not have permission to view ${what}.`;
  return `${what[0].toUpperCase()}${what.slice(1)} could not be loaded. Please try again.`;
}

export default function OrderHistoryView({ mode, medRepUid = null }) {
  const isAdmin = mode === "admin";
  const scopeUid = isAdmin ? null : medRepUid;

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // The date range in effect for the loaded pages (applied on submit).
  const [range, setRange] = useState({ dateFrom: "", dateTo: "" });
  const [repFilter, setRepFilter] = useState("");
  const [medReps, setMedReps] = useState([]);

  // A Med Rep view needs the signed-in uid; decided during render, not in an
  // effect (react-hooks/set-state-in-effect).
  const signedOut = !isAdmin && !scopeUid;
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(!signedOut);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  // Exact lookups across the whole history (not limited to loaded pages).
  const [lookup, setLookup] = useState({ kind: "reference", value: "" });
  const [lookupResult, setLookupResult] = useState(null); // { label, rows } | null
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");

  const [selectedId, setSelectedId] = useState(null);
  const requestSeq = useRef(0);

  const toRows = useCallback(
    async (orders) => {
      const receipts = await fetchReceiptsForOrders(orders.map((o) => o.id), scopeUid);
      return orders.map((o) => historyRow(o, receipts.get(o.id) ?? null));
    },
    [scopeUid]
  );

  // First page for the current scope and date range. State is set only in the
  // async callbacks; the handlers that change scope or range set `loading`.
  // A sequence number drops a stale response that arrives after a newer one.
  useEffect(() => {
    if (signedOut) return undefined;
    const seq = ++requestSeq.current;
    fetchOrderHistoryPage({
      medRepUid: isAdmin ? repFilter || null : scopeUid,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    })
      .then(async (page) => ({ page, next: await toRows(page.orders) }))
      .then(({ page, next }) => {
        if (seq !== requestSeq.current) return;
        setRows(next);
        setCursor(page.cursor);
        setHasMore(page.hasMore);
        setError("");
        setLoading(false);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        setRows([]);
        setHasMore(false);
        setError(errorMessage(err, "order history"));
        setLoading(false);
      });
    return undefined;
  }, [signedOut, isAdmin, scopeUid, repFilter, range, toRows]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchMedReps().then(setMedReps).catch(() => setMedReps([]));
  }, [isAdmin]);

  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    // The page belongs to the scope and range in effect now; if they change
    // before it arrives (a new first page started), it is dropped.
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await fetchOrderHistoryPage({
        medRepUid: isAdmin ? repFilter || null : scopeUid,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        cursor,
      });
      const next = await toRows(page.orders);
      if (seq !== requestSeq.current) return;
      setRows((prev) => mergeHistoryPage(prev, next));
      setCursor(page.cursor);
      setHasMore(page.hasMore);
    } catch (err) {
      if (seq === requestSeq.current) setError(errorMessage(err, "older orders"));
    } finally {
      setLoadingMore(false);
    }
  };

  const runLookup = async (event) => {
    event.preventDefault();
    const value = lookup.value.trim();
    if (!value) return;
    setLookupBusy(true);
    setLookupError("");
    try {
      let orders = [];
      if (lookup.kind === "reference") orders = await findOrdersByReference(value, scopeUid);
      else if (isAdmin && lookup.kind === "sku") orders = await fetchOrdersByIds(await findOrderIdsBySku(value));
      else if (isAdmin && lookup.kind === "batch") orders = await fetchOrdersByIds(await findOrderIdsByBatchId(value));
      const label =
        lookup.kind === "reference" ? `order reference ${value.toUpperCase()}`
          : lookup.kind === "sku" ? `SKU ${value}`
            : `Batch ID ${value.toUpperCase()}`;
      setLookupResult({ label, rows: await toRows(orders) });
    } catch (err) {
      setLookupError(errorMessage(err, "search results"));
      setLookupResult(null);
    } finally {
      setLookupBusy(false);
    }
  };

  const visible = useMemo(() => {
    const source = lookupResult ? lookupResult.rows : rows;
    return source.filter((r) => matchesHistoryFilters(r, { ...filters, dateFrom: "", dateTo: "" }));
  }, [rows, lookupResult, filters]);

  const selected = useMemo(() => {
    const all = [...(lookupResult?.rows ?? []), ...rows];
    return all.find((r) => r.id === selectedId) ?? null;
  }, [rows, lookupResult, selectedId]);

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const applyRange = (e) => {
    e.preventDefault();
    if (range.dateFrom === filters.dateFrom && range.dateTo === filters.dateTo) return;
    setLookupResult(null);
    setLoading(true);
    setRange({ dateFrom: filters.dateFrom, dateTo: filters.dateTo });
  };
  const changeRep = (e) => {
    if (e.target.value === repFilter) return;
    setLookupResult(null);
    setLoading(true);
    setRepFilter(e.target.value);
  };
  const shownError = signedOut ? "You must be signed in to view your order history." : error;
  const clientFiltered = Boolean(filters.search || filters.stage || filters.allocationState || filters.priority);
  // Shown whenever a filter acts on loaded records only. The exact-reference
  // lookup above is not one: it queries the whole authorized history.
  const loadedNotice = loadedFilterNotice({ filtersActive: clientFiltered, hasMore, loadedCount: rows.length });

  if (selected) {
    return (
      <div className="ohx">
        <OrderHistoryDetail key={selected.id} row={selected} mode={mode} medRepUid={scopeUid} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div className="ohx">
      <p className="ohx-scope-note">
        <strong>History</strong> lists every accepted order — delivered, cancelled and failed included — with its
        original Order Confirmation Receipt and Stock Allocation History. For orders still waiting for stock right
        now, {isAdmin ? "see the Stock Allocation backlog." : "see Order Tracking."}
      </p>

      <form className="ohx-lookup" onSubmit={runLookup} role="search" aria-label="Search all history">
        <label>
          <span>Search all history by</span>
          <select value={lookup.kind} onChange={(e) => setLookup((l) => ({ ...l, kind: e.target.value }))}>
            <option value="reference">Full order reference</option>
            {isAdmin && <option value="sku">SKU</option>}
            {isAdmin && <option value="batch">Batch ID</option>}
          </select>
        </label>
        <input
          type="search"
          value={lookup.value}
          onChange={(e) => setLookup((l) => ({ ...l, value: e.target.value }))}
          placeholder={lookup.kind === "reference" ? "VT-ORD-…" : lookup.kind === "sku" ? "e.g. ATV-001" : "e.g. BT-3131-3131"}
          aria-label="Exact value"
        />
        <button type="submit" className="ohx-btn ohx-btn-primary" disabled={lookupBusy || !lookup.value.trim()}>
          {lookupBusy ? "Searching…" : "Search"}
        </button>
        {lookupResult && (
          <button type="button" className="ohx-btn" onClick={() => setLookupResult(null)}>
            Back to all orders
          </button>
        )}
      </form>
      {lookupError && <p className="ohx-error" role="alert">{lookupError}</p>}

      <form className="ohx-filters" onSubmit={applyRange} aria-label="Filter order history">
        <label className="ohx-filter-search">
          <span>Filter loaded orders</span>
          <input
            type="search"
            value={filters.search}
            onChange={setFilter("search")}
            placeholder={isAdmin ? "Reference, Med Rep, doctor, clinic or SKU" : "Reference, doctor or clinic"}
          />
        </label>
        <label>
          <span>From</span>
          <input type="date" value={filters.dateFrom} onChange={setFilter("dateFrom")} />
        </label>
        <label>
          <span>To</span>
          <input type="date" value={filters.dateTo} onChange={setFilter("dateTo")} />
        </label>
        <button type="submit" className="ohx-btn">Apply dates</button>
        <label>
          <span>Status</span>
          <select value={filters.stage} onChange={setFilter("stage")}>
            <option value="">All statuses</option>
            {STAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Allocation</span>
          <select value={filters.allocationState} onChange={setFilter("allocationState")}>
            <option value="">All allocation states</option>
            {ALLOCATION_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <label>
            <span>Priority</span>
            <select value={filters.priority} onChange={setFilter("priority")}>
              <option value="">All priorities</option>
              <option value="Urgent">Urgent</option>
              <option value="Standard">Standard</option>
            </select>
          </label>
        )}
        {isAdmin && (
          <label>
            <span>Med Rep</span>
            <select value={repFilter} onChange={changeRep}>
              <option value="">All Med Reps</option>
              {medReps.map((m) => (
                <option key={m.uid} value={m.uid}>{m.label}</option>
              ))}
            </select>
          </label>
        )}
      </form>

      {lookupResult ? (
        <p className="ohx-muted" role="status">
          {lookupResult.rows.length} order{lookupResult.rows.length === 1 ? "" : "s"} found for {lookupResult.label}.
        </p>
      ) : (
        !loading && !shownError && (
          <>
            <p className="ohx-muted" role="status">
              Showing {visible.length} of {rows.length} loaded order{rows.length === 1 ? "" : "s"}, newest first
              {range.dateFrom || range.dateTo ? ` (${range.dateFrom || "…"} to ${range.dateTo || "…"})` : ""}.
            </p>
            {loadedNotice && <p className="ohx-loaded-notice" role="note">{loadedNotice}</p>}
          </>
        )
      )}

      {loading ? (
        <div className="ohx-state" role="status"><span className="rv-spinner" aria-hidden="true" /> Loading order history…</div>
      ) : shownError ? (
        <p className="ohx-error" role="alert">{shownError}</p>
      ) : visible.length === 0 ? (
        <div className="ohx-state">
          {rows.length === 0 && !lookupResult
            ? isAdmin
              ? "No orders have been placed yet."
              : "You have not placed any orders yet."
            : "No orders match these filters."}
        </div>
      ) : (
        <div className="ohx-table-wrap">
          <table className="ohx-table">
            <thead>
              <tr>
                <th scope="col">Order reference</th>
                <th scope="col">Placed</th>
                {isAdmin && <th scope="col">Med Rep</th>}
                <th scope="col">Doctor / clinic</th>
                <th scope="col">Status</th>
                <th scope="col">Allocation</th>
                <th scope="col">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button type="button" className="ohx-link ohx-ref" onClick={() => setSelectedId(row.id)}>
                      {row.reference}
                    </button>
                    {row.priority === "Urgent" && <span className="ohx-chip ohx-chip-danger">Urgent</span>}
                  </td>
                  <td className="tnum">{formatDateTime(row.createdAtMs)}</td>
                  {isAdmin && <td>{row.medRep || <span className="ohx-muted">{row.medRepUid || "—"}</span>}</td>}
                  <td>
                    <span>{row.doctor || "—"}</span>
                    <small className="ohx-muted">{row.clinic}</small>
                  </td>
                  <td><span className={`ohx-stage ohx-stage-${row.stage.value}`}>{row.stage.label}</span></td>
                  <td className="tnum">
                    {row.allocationLabel}
                    {row.allocationState !== "untracked" && (
                      <small className="ohx-muted">{row.reserved} of {row.requested} reserved</small>
                    )}
                  </td>
                  <td>
                    {row.receiptStatus === "original" ? "Original"
                      : row.receiptStatus === "reconstructed" ? "Reconstructed"
                        : <span className="ohx-muted">Legacy — none</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!lookupResult && hasMore && !loading && !shownError && (
        <button type="button" className="ohx-btn ohx-more" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading…" : `Load ${HISTORY_PAGE_SIZE} older orders`}
        </button>
      )}
    </div>
  );
}
