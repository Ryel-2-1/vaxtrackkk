import { useEffect, useMemo, useRef, useState } from "react";
import AdminLayout from "../../components/admin/AdminLayout";
import PageNav, { PAGE_SIZE } from "../../components/ui/PageNav";
import StaleEditNotice from "../../components/ui/StaleEditNotice";
import { useLiveDraft } from "../../components/useLiveDraft";
import {
  subscribeAnalyticsConfigs,
  subscribeInventoryForecasts,
  subscribeLatestAnalyticsRun,
  saveAnalyticsConfig,
} from "../../services/inventoryAnalyticsService";
import {
  ANALYTICS_DISCLAIMER,
  BASELINE_LABEL,
  FORECAST_VIEWS,
  HORIZONS,
  NO_FORECAST_MESSAGE,
  PRIMARY_HORIZON,
  STALE_AFTER_DAYS,
  configChangedSinceForecast,
  configFormFrom,
  environmentNotice,
  forecastAdvice,
  PLAIN_CONFIDENCE,
  periodLabel,
  plainDataNote,
  plainFigures,
  plainForecastStory,
  FORECAST_STATUS_HELP,
  MAX_BUSY_INCREASE_PERCENT,
  MONTH_NAMES,
  seasonSummary,
  forecastRow,
  forecastViewCounts,
  forecastsByVaccine,
  formatGeneratedAt,
  formatQuantity,
  isStale,
  shortDay,
  sortRows,
} from "../../services/inventoryAnalytics";
import { analyticsConfigPayload } from "../../services/inventoryAnalytics";
import { friendlyErrorMessage, liveErrorKind, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import ForecastList from "./ForecastList";
import "./AiInventoryAnalytics.css";

/**
 * Admin › AI Inventory Analytics (Phase 1 — baseline forecasting).
 *
 * Read-only view of the forecasts the server generator stored. It never
 * computes or fills in a forecast: with no run there is an empty state, and a
 * missing figure shows as "—" or as the reason it is missing. The only thing an
 * Admin can change here is a vaccine's busy season (which months, and how much
 * more), used from the next forecast update. Nothing here changes inventory.
 */

const CONFIG_FIELD_LABELS = {
  busyMonths: "Busy months",
  busyIncreasePercent: "How much more",
};

/** How many recent weeks the weekly-orders chart shows. */
const RECENT_WEEKS_SHOWN = 8;

function SeasonEditor({ vaccineId, config, onSaved }) {
  // Follows the live settings while untouched; once edited, a change saved by
  // another Admin is flagged and blocks saving until reviewed.
  const liveForm = useLiveDraft(configFormFrom(config));
  const form = liveForm.draft;
  const setForm = liveForm.setDraft;
  const staleLabels = liveForm.stale.map((f) => CONFIG_FIELD_LABELS[f] ?? f);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const months = form.busyMonths.split(",").filter(Boolean).map(Number);
  const percentId = `aia-busy-pct-${vaccineId}`;
  const errorId = `aia-config-error-${vaccineId}`;

  const toggleMonth = (m) => {
    // From the latest draft, so two quick taps both count.
    setForm((f) => {
      const current = f.busyMonths.split(",").filter(Boolean).map(Number);
      const next = current.includes(m) ? current.filter((x) => x !== m) : [...current, m].sort((a, b) => a - b);
      return { ...f, busyMonths: next.join(",") };
    });
    setFieldError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (savingRef.current || staleLabels.length > 0) return;
    setError("");
    const checked = analyticsConfigPayload(vaccineId, form);
    if (!checked.ok) {
      setFieldError({ field: checked.field ?? null, text: checked.error });
      if (checked.field === "busyIncreasePercent") document.getElementById(percentId)?.focus();
      return;
    }
    setFieldError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      await saveAnalyticsConfig(vaccineId, form);
      liveForm.markSaved(form);
      onSaved();
    } catch (err) {
      logSafeError("Save busy season", err);
      setError(friendlyErrorMessage(err, "The busy season could not be saved. Nothing was changed — please try again."));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <form className="aia-config" onSubmit={submit} noValidate>
      <fieldset className="aia-months">
        <legend>Busy months</legend>
        {MONTH_NAMES.map((name, i) => (
          <button
            key={name}
            type="button"
            className={`aia-month${months.includes(i + 1) ? " is-on" : ""}`}
            aria-pressed={months.includes(i + 1)}
            onClick={() => toggleMonth(i + 1)}
          >
            {name}
          </button>
        ))}
      </fieldset>
      {months.length > 0 && (
        <label className="aia-busy-pct" htmlFor={percentId}>
          About how much more is ordered in those months? (%)
          <input
            id={percentId}
            inputMode="numeric"
            value={form.busyIncreasePercent}
            onChange={(e) => {
              setForm((f) => ({ ...f, busyIncreasePercent: e.target.value }));
              setFieldError(null);
            }}
            placeholder="e.g. 50"
            aria-invalid={fieldError?.field === "busyIncreasePercent" ? "true" : undefined}
            aria-describedby={fieldError ? errorId : undefined}
          />
          <small className="aia-muted">1 to {MAX_BUSY_INCREASE_PERCENT}. Once there is a full year of orders, VaxTrack also learns this from last year.</small>
        </label>
      )}
      {fieldError && <p id={errorId} className="aia-error" role="alert">{fieldError.text}</p>}
      {error && <p className="aia-error" role="alert">{error}</p>}
      <StaleEditNotice
        labels={staleLabels}
        what="this busy season"
        disabled={saving}
        onLoadLatest={liveForm.loadLatest}
        onKeepMine={liveForm.keepMine}
      />
      <div className="aia-config-actions">
        <button type="submit" className="aia-btn" disabled={saving || staleLabels.length > 0}>
          {saving ? "Saving…" : "Save busy season"}
        </button>
        <span className="aia-muted">Used from the next forecast update.</span>
      </div>
    </form>
  );
}

function ForecastDetail({ horizons, config, onClose }) {
  const [savedNote, setSavedNote] = useState("");
  const primary = horizons[PRIMARY_HORIZON] ?? horizons[HORIZONS.find((h) => horizons[h])];
  const row = forecastRow(primary);
  // The recent weeks are what the estimate leans on; months of empty weeks
  // before a vaccine was first ordered only push them off the screen.
  const history = (Array.isArray(primary.weeklyHistory) ? primary.weeklyHistory : []).slice(-RECENT_WEEKS_SHOWN);
  const peak = history.reduce((m, w) => Math.max(m, Number.isSafeInteger(w.quantity) ? w.quantity : 0), 0);
  const advice = forecastAdvice(row);

  return (
    <section className="aia-card aia-detail" aria-labelledby="aia-detail-title">
      <header className="aia-detail-head">
        <div>
          <h2 id="aia-detail-title">{row.name}</h2>
          <p className="aia-muted">
            SKU <strong className={row.skuMissing ? "aia-missing" : ""}>{row.sku}</strong>
          </p>
        </div>
        <button type="button" className="aia-btn aia-btn--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="aia-answer">
        <span className={`aia-risk aia-risk--${advice.tone}`}>{advice.status}</span>
        <strong>{advice.action}</strong>
        {advice.why && <p>{advice.why}</p>}
      </div>
      <dl className="aia-facts">
        <div><dt>In stock</dt><dd className="tnum">{row.available}</dd></div>
        <div><dt>Expected need, 30 days</dt><dd className="tnum">{row.insufficient ? "—" : row.predicted}</dd></div>
        {row.hasBackorders && (
          <div><dt>Already ordered, waiting for stock</dt><dd className="tnum">{row.backordered}</dd></div>
        )}
      </dl>
      {row.hasCurrentShortage && (
        <p className="aia-note aia-note--high">
          Short now: orders already placed need {row.currentShortage} more vials than you have. This is not an
          estimate; these orders are waiting.
        </p>
      )}

      {row.insufficient && (
        <p className="aia-note aia-note--unknown">
          Only {primary.usableWeekCount ?? 0} week(s) of orders so far. VaxTrack needs at least 4 full weeks before it
          can estimate future orders or suggest an amount to order.
        </p>
      )}
      {configChangedSinceForecast(config, primary) && (
        <p className="aia-note aia-note--medium">
          The busy season was changed after this forecast was made. The numbers below use the old setting until
          the next update.
        </p>
      )}

      {savedNote && <p className="aia-note aia-note--low" role="status">{savedNote}</p>}
      {/* Set once per vaccine (e.g. flu vaccine before Christmas), not read every visit. */}
      <details className="aia-workings aia-settings">
        <summary>
          Busy season
          <span className="aia-settings-summary">{seasonSummary(config) ?? "None set"}</span>
        </summary>
        <p className="aia-muted">
          Mark the months this vaccine is ordered more, and VaxTrack raises its estimate for them.
        </p>
        <SeasonEditor
          key={primary.vaccineId}
          vaccineId={primary.vaccineId}
          config={config}
          onSaved={() => setSavedNote("Saved. It will be used at the next forecast update.")}
        />
      </details>

      <details className="aia-workings">
        <summary>How this was worked out (for checking the numbers)</summary>
        <div className="aia-story">
          {plainForecastStory(primary).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>

        <h3>Vials ordered each week (last {RECENT_WEEKS_SHOWN} weeks)</h3>
        {history.length === 0 ? (
          <p className="aia-muted">No orders in the weeks VaxTrack looked at.</p>
        ) : (
          <ol className="aia-history">
            {history.map((w, i) => (
              <li key={w.weekStart} style={{ "--aia-i": i }}>
                <span className="aia-history-week">Week of {shortDay(w.weekStart)}</span>
                <span className="aia-history-bar" aria-hidden="true">
                  <span style={{ width: peak > 0 ? `${(w.quantity / peak) * 100}%` : "0%" }} />
                </span>
                <span className="aia-history-qty tnum">{formatQuantity(w.quantity)}</span>
              </li>
            ))}
          </ol>
        )}

        <h3>The numbers, next {primary.horizonDays} days</h3>
        <dl className="aia-calc">
          {plainFigures(primary).map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd className="tnum">{f.value}</dd>
            </div>
          ))}
        </dl>

        <h3>Looking further ahead</h3>
        <div className="aia-table-wrap">
          <table className="aia-table">
            <thead>
              <tr>
                <th>Period</th>
                <th className="aia-num">Expected orders</th>
                <th className="aia-num">Short if orders come as expected</th>
                <th className="aia-num">Suggested order</th>
                <th>Status</th>
                <th>How sure</th>
              </tr>
            </thead>
            <tbody>
              {HORIZONS.map((h) => {
                const doc = horizons[h];
                if (!doc) {
                  return (
                    <tr key={h}>
                      <td>{periodLabel(h)}</td>
                      <td colSpan={5} className="aia-muted">Not worked out for this period.</td>
                    </tr>
                  );
                }
                const r = forecastRow(doc);
                const c = doc.calculation ?? {};
                return (
                  <tr key={h}>
                    <td>{periodLabel(h)}</td>
                    <td className="aia-num">{r.predicted}</td>
                    <td className="aia-num">{r.insufficient ? "—" : formatQuantity(c.forecastShortageQuantity)}</td>
                    <td className="aia-num">{r.reorder}</td>
                    <td>{forecastAdvice(r).status}</td>
                    <td>{PLAIN_CONFIDENCE[doc.confidenceLevel] ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(primary.dataQualityWarnings ?? []).length > 0 && (
          <>
            <h3>Good to know</h3>
            <ul className="aia-warnings">
              {primary.dataQualityWarnings.map((w) => (
                <li key={w.code}>{plainDataNote(w)}</li>
              ))}
            </ul>
          </>
        )}

        <p
          className="aia-muted aia-basis"
          title={`${primary.engineLabel ?? primary.engineType} · ${primary.modelVersion}`}
        >
          Based on {formatQuantity(primary.sampleOrderCount)} orders
          {primary.trainingWindowStart ? ` from ${shortDay(primary.trainingWindowStart)} to ${shortDay(primary.trainingWindowEnd)}` : ""}.
          Updated {formatGeneratedAt(primary.generatedAt)}. This is an average of past orders, not artificial
          intelligence, so treat it as a guide.
        </p>
      </details>

    </section>
  );
}

function AiInventoryAnalytics() {
  const [run, setRun] = useState(undefined); // undefined = loading, null = none
  const [forecasts, setForecasts] = useState(null);
  const [configs, setConfigs] = useState(new Map());
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const [now] = useState(() => Date.now());
  const [view, setView] = useState(null); // null = needs attention, or all when nothing does
  const [search, setSearch] = useState("");

  // The details open below the table: bring them into view, wherever the row was.
  useEffect(() => {
    if (selected) document.getElementById("aia-detail-title")?.scrollIntoView({ block: "start" });
  }, [selected]);

  useEffect(() => {
    // Data arriving after a failure (automatic reconnect or the shell's
    // "Try again") clears the error.
    const recovered = (setter) => (value) => {
      setter(value);
      setError(null);
    };
    const fail = (err) => setError(liveErrorKind(err) === "permission" ? "permission" : liveErrorMessage(err, "inventory analytics"));
    const stops = [
      subscribeLatestAnalyticsRun(recovered(setRun), fail),
      subscribeInventoryForecasts(recovered(setForecasts), fail),
      subscribeAnalyticsConfigs(recovered(setConfigs), fail),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const byVaccine = useMemo(() => forecastsByVaccine(forecasts ?? [], run?.runId), [forecasts, run]);
  const rows = useMemo(
    () => sortRows([...byVaccine.values()].filter((h) => h[PRIMARY_HORIZON]).map((h) => forecastRow(h[PRIMARY_HORIZON]))),
    [byVaccine]
  );
  const counts = forecastViewCounts(rows);
  const needle = search.trim().toLowerCase();
  const activeView = view ?? (counts.attention > 0 ? "attention" : "all");
  // A search looks through every vaccine, whichever view is open.
  const shownRows = rows.filter((r) =>
    needle
      ? `${r.name} ${r.sku}`.toLowerCase().includes(needle)
      : activeView === "all" || forecastAdvice(r).view === activeView
  );
  const currentPage = Math.min(page, Math.max(1, Math.ceil(shownRows.length / PAGE_SIZE)));
  const pageRows = shownRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  let body;
  if (error === "permission") {
    body = <p className="aia-state aia-error" role="alert">You do not have permission to view inventory analytics. It is available to Admins only.</p>;
  } else if (error) {
    body = <p className="aia-state aia-error" role="alert">{error}</p>;
  } else if (run === undefined || forecasts === null) {
    body = <p className="aia-state aia-muted">Loading inventory analytics…</p>;
  } else if (run === null || rows.length === 0) {
    body = (
      <div className="aia-state aia-empty">
        <strong>{NO_FORECAST_MESSAGE}</strong>
        <p className="aia-muted">
          VaxTrack works out forecasts on its own every so often. Until the first one is ready there is nothing to
          show here, and no example numbers are made up.
        </p>
      </div>
    );
  } else {
    const selectedHorizons = selected ? byVaccine.get(selected) : null;
    body = (
      <>
        {isStale(run.generatedAt, now) && (
          <p className="aia-note aia-note--medium" role="status">
            This forecast is out of date: it was made {formatGeneratedAt(run.generatedAt)}, more than {STALE_AFTER_DAYS} days
            ago. Stock and orders have changed since, so check with the latest numbers before ordering.
          </p>
        )}

        <section className="aia-card" aria-labelledby="aia-table-title">
          <header className="aia-list-head">
            <h2 id="aia-table-title">
              {counts.attention === 0
                ? "No vaccines need attention"
                : `${counts.attention} vaccine${counts.attention === 1 ? " needs" : "s need"} attention`}
            </h2>
            <p className="aia-muted" title={`Run ${run.runId} · ${run.engineLabel ?? BASELINE_LABEL} (${run.modelVersion})`}>
              Stock compared with expected orders for the next 30 days. Updated {formatGeneratedAt(run.generatedAt)}, using orders up to {shortDay(run.trainingWindowEnd)}.
            </p>
          </header>

          <details className="aia-workings aia-help">
            <summary>What do these mean?</summary>
            <dl className="aia-help-list">
              {FORECAST_STATUS_HELP.map((h) => (
                <div key={h.status}>
                  <dt>{h.status}</dt>
                  <dd>{h.meaning}</dd>
                </div>
              ))}
            </dl>
            <p className="aia-muted">
              Nothing is ordered automatically. Open a vaccine to see why, and to mark the months it is ordered more
              (for example, flu vaccine before Christmas).
            </p>
          </details>

          <div className="aia-toolbar">
            <div className="aia-filters" role="group" aria-label="Show">
              {FORECAST_VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`aia-filter${!needle && activeView === v.key ? " is-active" : ""}`}
                  aria-pressed={!needle && activeView === v.key}
                  onClick={() => {
                    setView(v.key);
                    setSearch("");
                    setPage(1);
                  }}
                >
                  {v.label} <span className="tnum">{counts[v.key]}</span>
                </button>
              ))}
            </div>
            <input
              id="aia-search"
              className="aia-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search vaccine or SKU"
              aria-label="Search vaccine or SKU"
            />
          </div>

          <ForecastList
            rows={pageRows}
            selectedId={selected}
            onSelect={setSelected}
            emptyText={needle ? "No vaccine matches that search." : "Nothing here right now."}
          />
          <PageNav page={currentPage} total={shownRows.length} onPageChange={setPage} label="Forecast pages" />
        </section>

        {selectedHorizons && (
          <ForecastDetail
            key={selected}
            horizons={selectedHorizons}
            config={configs.get(selected) ?? null}
            onClose={() => setSelected(null)}
          />
        )}

        {(run.dataQualityWarnings ?? []).length > 0 && (
          <details className="aia-workings aia-card">
            <summary>About the data ({run.dataQualityWarnings.length})</summary>
            <ul className="aia-warnings">
              {run.dataQualityWarnings.map((w) => (
                <li key={w.code}>{plainDataNote(w)}</li>
              ))}
            </ul>
          </details>
        )}
      </>
    );
  }

  // The project this page reads from (build config), or else the one the run
  // recorded. Staging data may include seed/test orders.
  const environment = environmentNotice(import.meta.env.VITE_FIREBASE_PROJECT_ID || run?.projectId);

  return (
    <AdminLayout description="Which vaccines may run out soon, based on VaxTrack's own orders and stock.">
      {body}
      <p className="aia-disclaimer" role="note">
        <strong>{ANALYTICS_DISCLAIMER}</strong> They are suggestions for a person to decide on; nothing is ordered or set
        aside from this page.
      </p>
      {environment && (
        <p className={`aia-environment${environment.warning ? " aia-environment--staging" : ""}`} role="note">
          Environment: <strong>{environment.label}</strong> ({environment.projectId})
          {environment.warning && <> — {environment.warning}</>}
        </p>
      )}
    </AdminLayout>
  );
}

export default AiInventoryAnalytics;
