import { useEffect, useMemo, useState } from "react";
import AdminLayout from "../../components/admin/AdminLayout";
import KpiCard from "../../components/ui/KpiCard";
import {
  subscribeAnalyticsConfigs,
  subscribeInventoryForecasts,
  subscribeLatestAnalyticsRun,
  saveAnalyticsConfig,
} from "../../services/inventoryAnalyticsService";
import {
  ANALYTICS_DISCLAIMER,
  BASELINE_LABEL,
  CONFIDENCE_LABELS,
  HORIZONS,
  NO_FORECAST_MESSAGE,
  PRIMARY_HORIZON,
  REORDER_CONFIGURATION_REQUIRED,
  RISK_META,
  STALE_AFTER_DAYS,
  configChangedSinceForecast,
  configFormFrom,
  environmentNotice,
  forecastRow,
  forecastsByVaccine,
  formatGeneratedAt,
  formatQuantity,
  isStale,
  sortRows,
  summarize,
} from "../../services/inventoryAnalytics";
import "./AiInventoryAnalytics.css";

/**
 * Admin › AI Inventory Analytics (Phase 1 — baseline forecasting).
 *
 * Read-only view of the forecasts the server generator stored. It never
 * computes or fills in a forecast: with no run there is an empty state, and a
 * missing figure shows as "—" or as the reason it is missing. The only thing an
 * Admin can change here is a vaccine's reorder configuration, which takes
 * effect at the next analytics run. Nothing here changes inventory.
 */

const CALCULATION_ROWS = [
  ["predictedDemandQuantity", "Forecast demand in the horizon"],
  ["backorderedQuantity", "Active backorders"],
  ["availableQuantity", "Available stock"],
  ["confirmedIncomingUsed", "Confirmed incoming (not tracked — 0)"],
  ["projectedShortageQuantity", "Projected shortage"],
  ["remainingAfterHorizonQuantity", "Remaining after the horizon"],
  ["leadTimeDays", "Lead time (days)"],
  ["leadTimeDemandQuantity", "Forecast demand during lead time"],
  ["leadTimeShortageQuantity", "Shortage within lead time"],
  ["safetyStockQuantity", "Safety stock (vials)"],
  ["recommendedReorderQuantity", "Recommended reorder"],
];

function signedQuantity(value) {
  // Remaining stock may legitimately be negative (a shortfall); everything
  // else is a whole number ≥ 0 or absent.
  if (Number.isSafeInteger(value) && value < 0) return `−${Math.abs(value).toLocaleString("en-PH")}`;
  return formatQuantity(value);
}

function RiskBadge({ level }) {
  const meta = RISK_META[level] ?? RISK_META.unknown;
  return <span className={`aia-risk aia-risk--${meta.tone}`}>{meta.label}</span>;
}

function ConfigEditor({ vaccineId, config, onSaved }) {
  const [form, setForm] = useState(() => configFormFrom(config));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: key === "enabled" ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await saveAnalyticsConfig(vaccineId, form);
      onSaved();
    } catch (err) {
      setError(err?.code === "permission-denied" ? "Only an Admin can change this configuration." : err?.message || "The configuration could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="aia-config" onSubmit={submit}>
      <div className="aia-config-grid">
        <label>
          Supplier lead time (days)
          <input inputMode="numeric" value={form.leadTimeDays} onChange={set("leadTimeDays")} placeholder="e.g. 14" />
        </label>
        <label>
          Safety stock as
          <select value={form.safetyMode} onChange={set("safetyMode")}>
            <option value="quantity">Vials</option>
            <option value="days">Days of demand</option>
          </select>
        </label>
        <label>
          {form.safetyMode === "days" ? "Safety stock (days)" : "Safety stock (vials)"}
          <input inputMode="numeric" value={form.safetyValue} onChange={set("safetyValue")} placeholder="e.g. 20" />
        </label>
        <label className="aia-config-check">
          <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
          Reorder analysis enabled
        </label>
      </div>
      {error && <p className="aia-error" role="alert">{error}</p>}
      <div className="aia-config-actions">
        <button type="submit" className="aia-btn" disabled={saving}>
          {saving ? "Saving…" : "Save configuration"}
        </button>
        <span className="aia-muted">Applies from the next analytics run. Lead times are never assumed.</span>
      </div>
    </form>
  );
}

function ForecastDetail({ horizons, config, onClose }) {
  const [savedNote, setSavedNote] = useState("");
  const primary = horizons[PRIMARY_HORIZON] ?? horizons[HORIZONS.find((h) => horizons[h])];
  const row = forecastRow(primary);
  const history = Array.isArray(primary.weeklyHistory) ? primary.weeklyHistory : [];
  const peak = history.reduce((m, w) => Math.max(m, Number.isSafeInteger(w.quantity) ? w.quantity : 0), 0);
  const calc = primary.calculation ?? {};

  return (
    <section className="aia-card aia-detail" aria-labelledby="aia-detail-title">
      <header className="aia-detail-head">
        <div>
          <h2 id="aia-detail-title">{row.name}</h2>
          <p className="aia-muted">
            SKU <strong className={row.skuMissing ? "aia-missing" : ""}>{row.sku}</strong> · {BASELINE_LABEL} · not a trained
            machine-learning model
          </p>
        </div>
        <button type="button" className="aia-btn aia-btn--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <p className={`aia-reason aia-reason--${row.riskTone}`}>
        <RiskBadge level={row.risk} /> {row.riskReason}
      </p>

      {row.insufficient && (
        <p className="aia-note aia-note--unknown">
          Insufficient history: {primary.usableWeekCount ?? 0} usable week(s). At least 4 complete weeks are needed before a
          baseline forecast is made.
        </p>
      )}
      {configChangedSinceForecast(config, primary) && (
        <p className="aia-note aia-note--medium">
          The reorder configuration changed after this forecast was generated. The figures below still use the earlier
          configuration until the next analytics run.
        </p>
      )}

      <h3>Forecasts by horizon</h3>
      <div className="aia-table-wrap">
        <table className="aia-table">
          <thead>
            <tr>
              <th>Horizon</th>
              <th>Predicted demand</th>
              <th>Projected shortage</th>
              <th>Recommended reorder</th>
              <th>Risk</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {HORIZONS.map((h) => {
              const doc = horizons[h];
              if (!doc) {
                return (
                  <tr key={h}>
                    <td>{h} days</td>
                    <td colSpan={5} className="aia-muted">No forecast stored for this horizon.</td>
                  </tr>
                );
              }
              const r = forecastRow(doc);
              return (
                <tr key={h}>
                  <td>{h} days</td>
                  <td className="tnum">{r.predicted}</td>
                  <td className="tnum">{r.shortage}</td>
                  <td className={r.needsConfiguration ? "aia-config-required" : "tnum"}>{r.reorder}</td>
                  <td><RiskBadge level={r.risk} /></td>
                  <td>{r.confidence}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Historical weekly demand (requested vials)</h3>
      {history.length === 0 ? (
        <p className="aia-muted">No weekly history inside the training window.</p>
      ) : (
        <ol className="aia-history">
          {history.map((w) => (
            <li key={w.weekStart}>
              <span className="aia-history-week tnum">{w.weekStart}</span>
              <span className="aia-history-bar" aria-hidden="true">
                <span style={{ width: peak > 0 ? `${(w.quantity / peak) * 100}%` : "0%" }} />
              </span>
              <span className="aia-history-qty tnum">{formatQuantity(w.quantity)}</span>
            </li>
          ))}
        </ol>
      )}

      <h3>Calculation breakdown ({primary.horizonDays} days)</h3>
      <dl className="aia-calc">
        {CALCULATION_ROWS.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd className="tnum">
              {key === "recommendedReorderQuantity" && primary.reorderConfigurationComplete !== true
                ? REORDER_CONFIGURATION_REQUIRED
                : signedQuantity(calc[key])}
            </dd>
          </div>
        ))}
      </dl>

      <h3>Explanation</h3>
      <ul className="aia-factors">
        {(primary.explanationFactors ?? []).map((f) => (
          <li key={f.key}>
            <strong>{f.label}:</strong> {f.value}
          </li>
        ))}
      </ul>

      <h3>Data quality</h3>
      {(primary.dataQualityWarnings ?? []).length === 0 ? (
        <p className="aia-muted">No data-quality warnings for this vaccine.</p>
      ) : (
        <ul className="aia-warnings">
          {primary.dataQualityWarnings.map((w) => (
            <li key={w.code}>{w.message}</li>
          ))}
        </ul>
      )}

      <dl className="aia-meta">
        <div><dt>Engine</dt><dd>{primary.engineLabel ?? primary.engineType}</dd></div>
        <div><dt>Model version</dt><dd>{primary.modelVersion}</dd></div>
        <div>
          <dt>Training period</dt>
          <dd>{primary.trainingWindowStart ? `${primary.trainingWindowStart} – ${primary.trainingWindowEnd}` : "No usable history"}</dd>
        </div>
        <div><dt>Usable weeks</dt><dd className="tnum">{formatQuantity(primary.usableWeekCount)}</dd></div>
        <div><dt>Orders in sample</dt><dd className="tnum">{formatQuantity(primary.sampleOrderCount)}</dd></div>
        <div><dt>Confidence</dt><dd>{CONFIDENCE_LABELS[primary.confidenceLevel] ?? "Unknown"} (data coverage, not probability)</dd></div>
        <div><dt>Generated</dt><dd>{formatGeneratedAt(primary.generatedAt)}</dd></div>
      </dl>

      <h3>Reorder configuration</h3>
      {savedNote && <p className="aia-note aia-note--low" role="status">{savedNote}</p>}
      <ConfigEditor
        key={primary.vaccineId}
        vaccineId={primary.vaccineId}
        config={config}
        onSaved={() => setSavedNote("Configuration saved. It will be used at the next analytics run.")}
      />
    </section>
  );
}

function AiInventoryAnalytics() {
  const [run, setRun] = useState(undefined); // undefined = loading, null = none
  const [forecasts, setForecasts] = useState(null);
  const [configs, setConfigs] = useState(new Map());
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const fail = (err) => setError(err?.code === "permission-denied" ? "permission" : "error");
    const stops = [
      subscribeLatestAnalyticsRun(setRun, fail),
      subscribeInventoryForecasts(setForecasts, fail),
      subscribeAnalyticsConfigs(setConfigs, fail),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  const byVaccine = useMemo(() => forecastsByVaccine(forecasts ?? [], run?.runId), [forecasts, run]);
  const rows = useMemo(
    () => sortRows([...byVaccine.values()].filter((h) => h[PRIMARY_HORIZON]).map((h) => forecastRow(h[PRIMARY_HORIZON]))),
    [byVaccine]
  );
  const totals = summarize(rows);

  let body;
  if (error === "permission") {
    body = <p className="aia-state aia-error" role="alert">You do not have permission to view inventory analytics. It is available to Admins only.</p>;
  } else if (error) {
    body = <p className="aia-state aia-error" role="alert">Inventory analytics could not be loaded. Please try again.</p>;
  } else if (run === undefined || forecasts === null) {
    body = <p className="aia-state aia-muted">Loading inventory analytics…</p>;
  } else if (run === null || rows.length === 0) {
    body = (
      <div className="aia-state aia-empty">
        <strong>{NO_FORECAST_MESSAGE}</strong>
        <p className="aia-muted">
          Forecasts are produced by the server-side analytics generator. Until it has run for this project, there is
          nothing to show — no sample figures are displayed.
        </p>
      </div>
    );
  } else {
    const selectedHorizons = selected ? byVaccine.get(selected) : null;
    body = (
      <>
        {isStale(run.generatedAt, now) && (
          <p className="aia-note aia-note--medium" role="status">
            Stale forecast: this run was generated {formatGeneratedAt(run.generatedAt)}, more than {STALE_AFTER_DAYS} days
            ago. Stock and orders have changed since; generate a new run before relying on it.
          </p>
        )}

        <section className="aia-kpis" aria-label="Forecast summary (30 days)">
          <KpiCard label="Vaccines analyzed" value={totals.vaccinesAnalyzed} context="in the latest run" />
          <KpiCard
            label="High stockout risk"
            value={totals.highRisk}
            context="projected shortage"
            tone={totals.highRisk ? "danger" : "neutral"}
            attention={totals.highRisk > 0}
          />
          <KpiCard
            label="Reorder configuration required"
            value={totals.configurationRequired}
            context="no lead time / safety stock"
            tone={totals.configurationRequired ? "warning" : "neutral"}
          />
          <KpiCard label="Low-confidence forecasts" value={totals.lowConfidence} context="low or insufficient history" />
        </section>

        <p className="aia-run-meta aia-muted">
          Run {run.runId} · {run.engineLabel ?? BASELINE_LABEL} ({run.modelVersion}) · as of {run.asOfDate} · training weeks up to{" "}
          {run.trainingWindowEnd} · generated {formatGeneratedAt(run.generatedAt)}
        </p>

        <section className="aia-card" aria-labelledby="aia-table-title">
          <header>
            <h2 id="aia-table-title">30-day forecast</h2>
            <p className="aia-muted">Requested demand from orders (backorders included, cancellations excluded). Select a vaccine for its details.</p>
          </header>
          <div className="aia-table-wrap">
            <table className="aia-table aia-main-table">
              <thead>
                <tr>
                  <th>Vaccine</th>
                  <th>SKU</th>
                  <th>Available</th>
                  <th>Reserved</th>
                  <th>Backordered</th>
                  <th>Predicted 30-day demand</th>
                  <th>Projected shortage</th>
                  <th>Recommended reorder</th>
                  <th>Risk</th>
                  <th>Confidence</th>
                  <th>Generated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.vaccineId} className={selected === r.vaccineId ? "aia-selected" : ""}>
                    <td className="aia-name">
                      <button type="button" className="aia-link" onClick={() => setSelected(r.vaccineId)}>
                        <span className={r.nameMissing ? "aia-missing" : ""}>{r.name}</span>
                      </button>
                    </td>
                    <td className={`aia-sku${r.skuMissing ? " aia-missing" : ""}`}>{r.sku}</td>
                    <td className="tnum">{r.available}</td>
                    <td className="tnum">{r.reserved}</td>
                    <td className="tnum">{r.backordered}</td>
                    <td className="tnum">{r.insufficient ? <span className="aia-muted">Insufficient history</span> : r.predicted}</td>
                    <td className="tnum">{r.shortage}</td>
                    <td className={r.needsConfiguration ? "aia-config-required" : "tnum"}>{r.reorder}</td>
                    <td><RiskBadge level={r.risk} /></td>
                    <td>{r.confidence}</td>
                    <td className="tnum">{r.generatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
          <section className="aia-card" aria-labelledby="aia-quality-title">
            <header>
              <h2 id="aia-quality-title">Data quality (whole run)</h2>
              <p className="aia-muted">Counts only; sample references are opaque document ids.</p>
            </header>
            <ul className="aia-warnings">
              {run.dataQualityWarnings.map((w) => (
                <li key={w.code}>
                  <strong className="tnum">{formatQuantity(w.count)}×</strong> {w.message}
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  // The project this page reads from (build config), or else the one the run
  // recorded. Staging data may include seed/test orders.
  const environment = environmentNotice(import.meta.env.VITE_FIREBASE_PROJECT_ID || run?.projectId);

  return (
    <AdminLayout description={`${BASELINE_LABEL} of vaccine demand and stockout risk from VaxTrack's own orders and stock.`}>
      <p className="aia-disclaimer" role="note">
        <strong>{ANALYTICS_DISCLAIMER}</strong> Recommendations are informational and need a human decision; nothing is
        reordered, reserved or allocated from this page.
      </p>
      {environment && (
        <p className={`aia-environment${environment.warning ? " aia-environment--staging" : ""}`} role="note">
          Environment: <strong>{environment.label}</strong> ({environment.projectId})
          {environment.warning && <> — {environment.warning}</>}
        </p>
      )}
      {body}
    </AdminLayout>
  );
}

export default AiInventoryAnalytics;
