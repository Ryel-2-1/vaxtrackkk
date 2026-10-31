import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ALLOCATION_FILTER_OPTIONS,
  HISTORY_PAGE_SIZE,
  STAGE_OPTIONS,
  formatDateTime,
  historyRow,
  loadedFilterNotice,
  matchesHistoryFilters,
} from "../../services/orderHistory.js";
import {
  fetchOrdersByIds,
  fetchReceiptsForOrders,
  findOrderIdsByBatchId,
  findOrderIdsBySku,
  findOrdersByReference,
  subscribeMedReps,
  subscribeOrderHistoryWindow,
} from "../../services/orderHistoryService";
import OrderHistoryDetail from "./OrderHistoryDetail";
import RequestedArrivalNote from "../schedule/RequestedArrivalNote";
import "../ui/PageNav.css";
import "./OrderHistory.css";
import { liveErrorMessage } from "../../services/liveDataErrors";

/**
 * Order Receipt History + Stock Allocation History, shared by the Med Rep and
 * Admin pages.
 *
 *   mode "salesrep"  only the signed-in Med Rep's orders (medRepUid required);
 *                    every query is scoped to that uid, as the rules require.
 *   mode "admin"     every Med Rep's orders, with a Med Rep filter and exact
 *                    SKU / Batch ID lookups.
 *
 * Loading is bounded: a LIVE window of the newest orders, one page at first,
 * grown a page at a time by Med Rep Next or Admin's Load older action — every loaded row stays
 * current without a reload. The date range narrows the query itself; status, allocation,
 * priority and the text search filter the orders already loaded, and the page
 * says so. Exact reference / SKU / Batch ID lookups search the whole history.
 */

const EMPTY_FILTERS = { search: "", dateFrom: "", dateTo: "", stage: "", allocationState: "", priority: "" };

// One mapping for every failure: permission, offline, signed-out and a
// missing index each read differently, and none is shown as "no orders".
// A complete order reference, as printed on the receipt (VT-ORD-<digits>-<code>,
// or the older VT-ORD-<digits>): Enter on one searches the whole history.
const FULL_ORDER_REFERENCE = /^VT-ORD-\d{6,}(-[A-Z0-9]{3,8})?$/i;

function errorMessage(err, what) {
  return liveErrorMessage(err, what);
}

export default function OrderHistoryView({ mode, medRepUid = null }) {
  const isAdmin = mode === "admin";
  const scopeUid = isAdmin ? null : medRepUid;

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  // The date range in effect for the live window (debounced for Med Rep,
  // applied on submit for Admin).
  const [range, setRange] = useState({ dateFrom: "", dateTo: "" });
  const [repFilter, setRepFilter] = useState("");
  const [medReps, setMedReps] = useState([]);
  const [medRepsError, setMedRepsError] = useState(false);

  // A Med Rep view needs the signed-in uid; decided during render, not in an
  // effect (react-hooks/set-state-in-effect).
  const signedOut = !isAdmin && !scopeUid;
  const [rows, setRows] = useState([]);
  // How many of the newest orders the live window holds.
  const [windowSize, setWindowSize] = useState(HISTORY_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(!signedOut);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  // Exact lookups across the whole history (not limited to loaded pages).
  const [lookupResult, setLookupResult] = useState(null); // { label, rows } | null
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState("");

  const [selectedId, setSelectedId] = useState(null);
  const requestSeq = useRef(0);

  // Text and date controls settle before changing the live query; selectors
  // apply immediately. The same for Admin and Med Rep.
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedFilters((current) => ({
        ...current,
        search: filters.search,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      }));
      setPage(1);
      if (range.dateFrom !== filters.dateFrom || range.dateTo !== filters.dateTo) {
        setLookupResult(null);
        setLoading(true);
        setWindowSize(HISTORY_PAGE_SIZE);
        setRange({ dateFrom: filters.dateFrom, dateTo: filters.dateTo });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [filters.search, filters.dateFrom, filters.dateTo, range]);

  // Receipts are written once, in the order's own creation transaction, so
  // each is read once per order and cached (a legacy order's absence too).
  const receiptCache = useRef(new Map());
  const toRows = useCallback(
    async (orders) => {
      const cache = receiptCache.current;
      const keyOf = (id) => `${scopeUid ?? "*"}:${id}`;
      const missing = orders.map((o) => o.id).filter((id) => !cache.has(keyOf(id)));
      if (missing.length) {
        const receipts = await fetchReceiptsForOrders(missing, scopeUid);
        for (const id of missing) cache.set(keyOf(id), receipts.get(id) ?? null);
      }
      return orders.map((o) => historyRow(o, cache.get(keyOf(o.id)) ?? null));
    },
    [scopeUid]
  );

  // The live window for the current scope, date range and size. State is set
  // only in the listener's callbacks; the handlers that change scope or range
  // set `loading`. Changing any of them replaces the listener (the cleanup
  // closes the old one), and a sequence number drops a result from a replaced
  // listener — or an older snapshot of this one — that resolves late.
  useEffect(() => {
    if (signedOut) return undefined;
    const seq = ++requestSeq.current;
    let snapshotSeq = 0;
    const fail = (err) => {
      if (seq !== requestSeq.current) return;
      setError(errorMessage(err, "order history"));
      setLoading(false);
      setLoadingMore(false);
    };
    const unsubscribe = subscribeOrderHistoryWindow(
      {
        medRepUid: isAdmin ? repFilter || null : scopeUid,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        size: windowSize,
      },
      ({ orders, hasMore: more }) => {
        const mine = ++snapshotSeq;
        toRows(orders)
          .then((next) => {
            if (seq !== requestSeq.current || mine !== snapshotSeq) return;
            setRows(next);
            setHasMore(more);
            setError("");
            setLoading(false);
            setLoadingMore(false);
          })
          .catch(fail);
      },
      fail
    );
    return () => unsubscribe();
  }, [signedOut, isAdmin, scopeUid, repFilter, range, windowSize, toRows]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    return subscribeMedReps(
      (reps) => {
        setMedReps(reps);
        setMedRepsError(false);
      },
      () => setMedRepsError(true)
    );
  }, [isAdmin]);

  // uid → name from the Med Rep directory the filter already loads, for orders
  // that carry no name snapshot (every order placed before receipts existed).
  const medRepLabel = useMemo(() => new Map(medReps.map((m) => [m.uid, m.label])), [medReps]);

  // Grows the live window by a page; the rows already shown stay on screen
  // until the larger window arrives.
  const loadMore = () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setPage((current) => current + 1);
    setWindowSize((n) => n + HISTORY_PAGE_SIZE);
  };
  const changeHistoryPage = (next) => {
    if (next > Math.ceil(visible.length / HISTORY_PAGE_SIZE) && hasMore && !lookupResult) {
      loadMore();
    } else {
      setPage(next);
    }
  };

  // One search row for both roles: typing filters the loaded orders; Enter on
  // a full order reference (VT-ORD-…) searches the whole history. For Admin,
  // Enter on any other value runs the exact SKU and Batch ID lookups (they
  // replaced the separate "Search all history by" bar, removed 2026-10-31).
  const submitSearch = (event) => {
    event.preventDefault();
    const value = filters.search.trim();
    if (!value) return;
    if (FULL_ORDER_REFERENCE.test(value)) searchWholeHistory("reference", value);
    else if (isAdmin) searchWholeHistory("sku-or-batch", value);
  };

  const searchWholeHistory = async (kind, raw) => {
    const value = raw.trim();
    if (!value) return;
    setLookupBusy(true);
    setLookupError("");
    try {
      let orders = [];
      if (kind === "reference") orders = await findOrdersByReference(value, scopeUid);
      else if (isAdmin && kind === "sku-or-batch") {
        const [bySku, byBatch] = await Promise.all([findOrderIdsBySku(value), findOrderIdsByBatchId(value)]);
        orders = await fetchOrdersByIds([...new Set([...bySku, ...byBatch])]);
      }
      const label =
        kind === "reference" ? `order reference ${value.toUpperCase()}`
          : `SKU or Batch ID ${value}`;
      setLookupResult({ label, rows: await toRows(orders) });
    } catch (err) {
      setLookupError(errorMessage(err, "search results"));
      setLookupResult(null);
    } finally {
      setLookupBusy(false);
    }
  };

  const effectiveFilters = isAdmin ? filters : appliedFilters;
  const source = lookupResult ? lookupResult.rows : rows;
  const visible = source.filter((r) => matchesHistoryFilters(r, { ...effectiveFilters, dateFrom: "", dateTo: "" }));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visible.length / HISTORY_PAGE_SIZE)));
  const visiblePage = visible.slice((currentPage - 1) * HISTORY_PAGE_SIZE, currentPage * HISTORY_PAGE_SIZE);

  const selected = useMemo(() => {
    const all = [...(lookupResult?.rows ?? []), ...rows];
    return all.find((r) => r.id === selectedId) ?? null;
  }, [rows, lookupResult, selectedId]);

  const setFilter = (key) => (e) => {
    const value = e.target.value;
    setFilters((f) => ({ ...f, [key]: value }));
    if (isAdmin || !["search", "dateFrom", "dateTo"].includes(key)) {
      if (!isAdmin) setAppliedFilters((f) => ({ ...f, [key]: value }));
      setPage(1);
    }
  };
  const changeRep = (e) => {
    if (e.target.value === repFilter) return;
    setLookupResult(null);
    setLoading(true);
    setWindowSize(HISTORY_PAGE_SIZE);
    setPage(1);
    setRepFilter(e.target.value);
  };
  const shownError = signedOut ? "You must be signed in to view your order history." : error;
  const clientFiltered = Boolean(effectiveFilters.search || effectiveFilters.stage || effectiveFilters.allocationState || effectiveFilters.priority);
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
      <div className="ohx-filter-dock">
        {lookupError && <p className="ohx-error" role="alert">{lookupError}</p>}

        <form className="ohx-filters" onSubmit={submitSearch} aria-label="Filter order history">
          <label className="ohx-filter-search">
            <span>Filter loaded orders</span>
            <input
              type="search"
              value={filters.search}
              onChange={setFilter("search")}
              placeholder={isAdmin ? "Reference, Med Rep, doctor, clinic or SKU" : "Reference, doctor or clinic"}
              title={isAdmin
                ? "Type to filter loaded orders. Press Enter on a full order reference (VT-ORD-…), SKU or Batch ID to search all history."
                : "Type to filter loaded orders. Enter a full order reference (VT-ORD-…) and press Enter to search all your history."}
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
                {medRepsError && (
                  <option value="" disabled>
                    Med Rep list could not be loaded
                  </option>
                )}
                {medReps.map((m) => (
                  <option key={m.uid} value={m.uid}>{m.label}</option>
                ))}
              </select>
            </label>
          )}
          {(lookupBusy || lookupResult) && (
            <button type="button" className="ohx-btn ohx-filters-back" onClick={() => setLookupResult(null)} disabled={lookupBusy}>
              {lookupBusy ? "Searching…" : "Back to all orders"}
            </button>
          )}
        </form>
      </div>

      {lookupResult ? (
        <p className="ohx-muted" role="status">
          {lookupResult.rows.length} order{lookupResult.rows.length === 1 ? "" : "s"} found for {lookupResult.label}.
        </p>
      ) : (
        !loading && !shownError && (
          <>
            <p className="ohx-muted" role="status">
              Showing {visiblePage.length ? (currentPage - 1) * HISTORY_PAGE_SIZE + 1 : 0}–{Math.min(currentPage * HISTORY_PAGE_SIZE, visible.length)} of {visible.length} matching loaded order{visible.length === 1 ? "" : "s"}, newest first
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
        <div className="ohx-table-wrap ohx-list-table-wrap">
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
              {visiblePage.map((row) => (
                <tr key={row.id}>
                  <td>
                    <button type="button" className="ohx-link ohx-ref" onClick={() => setSelectedId(row.id)}>
                      {row.reference}
                    </button>
                    {row.priority === "Urgent" && <span className="ohx-chip ohx-chip-danger">Urgent</span>}
                    <RequestedArrivalNote order={row.order} />
                  </td>
                  <td className="tnum">{formatDateTime(row.createdAtMs)}</td>
                  {isAdmin && (
                    <td>
                      {row.medRep || medRepLabel.get(row.medRepUid) || (
                        <span className="ohx-muted">{medRepsError ? "Couldn't load name" : "Not recorded"}</span>
                      )}
                    </td>
                  )}
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

      {!loading && !shownError && !lookupResult && (visible.length > 0 || hasMore) && (
        <nav className="page-nav ohx-history-pager" aria-label="Order history pages">
          <span>Showing {visiblePage.length ? (currentPage - 1) * HISTORY_PAGE_SIZE + 1 : 0}–{Math.min(currentPage * HISTORY_PAGE_SIZE, visible.length)} of {visible.length} loaded</span>
          <div className="page-nav-actions">
            <button type="button" disabled={currentPage === 1 || loadingMore} onClick={() => changeHistoryPage(currentPage - 1)}>Previous</button>
            <span>Page {currentPage} of {Math.max(1, Math.ceil(visible.length / HISTORY_PAGE_SIZE)) + (hasMore ? 1 : 0)}{hasMore ? "+" : ""}</span>
            <button type="button" disabled={loadingMore || (!hasMore && currentPage >= Math.ceil(visible.length / HISTORY_PAGE_SIZE))} onClick={() => changeHistoryPage(currentPage + 1)}>{loadingMore ? "Loading…" : "Next"}</button>
          </div>
        </nav>
      )}
    </div>
  );
}
