import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowRight, Box, Circle, Database, Gauge, GitBranch, LocateFixed, MapPin, Monitor,
  Radio, Route, ShieldCheck, Smartphone, Snowflake, Terminal, Truck, Wifi, WifiOff, Zap,
} from "lucide-react";
import { NODES } from "./explorerArchitecture.js";
import { EXPLORER_ENDPOINT, HUB, RIDERS, SCENARIOS, SIM_PROJECT, STOPS } from "./explorerFixtures.js";
import "./systemExplorer.css";

const ICONS = { web: Monitor, rider: Smartphone, auth: ShieldCheck, firestore: Database, functions: Zap, routing: Route, tracking: LocateFixed, push: Radio };
const ROLES = [
  { id: "admin", label: "Admin", icon: ShieldCheck },
  { id: "dispatcher", label: "Distributor / Dispatcher", icon: Truck },
  { id: "rider", label: "Mobile Rider", icon: Smartphone },
];
const CHANNELS = { all: "All", firestore: "Firestore", http: "HTTP / GPS", vrp: "Routing", lab: "Simulator" };
const clock = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", second: "2-digit" });
const showTime = (date) => date ? clock.format(new Date(date)) : "—";
const humanize = (text) => String(text ?? "idle").replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());

function Architecture({ active, select, health, listeners }) {
  const node = NODES.find(({ id }) => id === active);
  return (
    <section className="vte-panel vte-architecture" aria-labelledby="vte-architecture-title">
      <div className="vte-panel-head">
        <div><h2 id="vte-architecture-title"><GitBranch /> Architecture</h2><small>Select a node to inspect its wiring</small></div>
        <span className="vte-tag">{NODES.length} components</span>
      </div>
      <div className="vte-graph">
        <svg viewBox="0 0 360 284" preserveAspectRatio="none" aria-hidden="true">
          <path d="M176 28h9m-96 28v18m182-18v18m-95 27h9m-96 29v17m182-17v17m-95 27h9m-96 29v17m182-17v17m-95 27h9" />
        </svg>
        {NODES.map(({ id, label, detail }) => {
          const Icon = ICONS[id];
          return (
            <button type="button" key={id} className="vte-node" onClick={() => select(id)} aria-pressed={id === active}>
              <Icon />
              <span><strong>{label}</strong><small>{detail}</small></span>
            </button>
          );
        })}
      </div>
      <div className="vte-inspector">
        <h3>{node.label}</h3>
        <p>{node.description}</p>
        <details open>
          <summary>Runtime &amp; configuration</summary>
          <ul><li>Local emulator {health?.connected ? "connected" : "offline"}{health?.emulator ? ` · ${health.emulator}` : ""}</li>
            {node.config.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
        <details>
          <summary>Listeners {active === "firestore" && listeners.length > 0 && `(${listeners.length} active)`}</summary>
          <ul>{(active === "firestore" && listeners.length ? listeners : node.listeners).map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
        <details>
          <summary>Repository files</summary>
          <ul>{node.files.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </details>
      </div>
    </section>
  );
}

function mapPoint([lat, lng]) {
  return [Math.max(24, Math.min(644, (lng - 120.936) / 0.15 * 668)), Math.max(22, Math.min(358, (14.675 - lat) / 0.15 * 380))];
}

function markerPoint(rider) {
  const { latitude, longitude } = rider.location ?? {};
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null;
}

function FleetMap({ state, activeRider }) {
  const [hx, hy] = mapPoint(HUB.point);
  const center = state?.center ? mapPoint(state.center.point) : null;
  const delivered = new Set((state?.orders ?? []).filter((order) => order.status === "delivered").map((order) => order.destinationDocId ?? order.clinicDocId));
  return (
    <div className="vte-map">
      <div className="vte-map-label"><MapPin /> Demo territory <span>Synthetic coordinates</span></div>
      <svg viewBox="0 0 668 380" role="img" aria-label="Demo hub, ten clinic stops, planned rider lines and latest Firestore GPS locations">
        <defs>
          <pattern id="vte-grid" width="27" height="27" patternUnits="userSpaceOnUse"><path d="M27 0H0v27" fill="none" stroke="#25323d" strokeWidth="1" /></pattern>
        </defs>
        <rect width="668" height="380" fill="url(#vte-grid)" />
        <path className="vte-map-river" d="M161 -20Q233 61 186 112t-17 102q87 53 40 95t21 90" />
        <path className="vte-map-contours" d="M0 80h112l24 31h207l38-22h287M0 293h80l52-32h282l63 25h191M313 0v59l-24 45v123l46 49v104M550 0v102l-25 41v148l36 29v60" />
        {RIDERS.map((rider) => {
          const route = state?.routes?.[rider.key];
          return route?.points?.length > 1 ? (
            <polyline key={rider.key} points={route.points.map(mapPoint).map((point) => point.join(",")).join(" ")}
              fill="none" stroke={rider.color} strokeWidth={rider.key === activeRider ? 3.5 : 2}
              strokeLinecap="round" strokeLinejoin="round" strokeDasharray={route.saved ? undefined : "7 5"} opacity={rider.key === activeRider ? 1 : 0.7} />
          ) : null;
        })}
        {STOPS.map((stop, index) => {
          const [x, y] = mapPoint(stop.point);
          const checked = [...delivered].some((id) => id?.endsWith(`-${stop.key}`));
          return <g key={stop.key}><title>{stop.name}</title><circle cx={x} cy={y} r="11" className={checked ? "vte-map-delivered" : "vte-map-stop"} />
            <text className="vte-map-index" x={x} y={y + 4}>{index + 1}</text></g>;
        })}
        {center && (
          <g className="vte-map-center" transform={`translate(${center[0]} ${center[1]})`}><title>Load center · weighted by vials</title>
            <circle r="12" /><path d="M-16 0h32M0-16v32" /></g>
        )}
        <g transform={`translate(${hx} ${hy})`}><title>{HUB.name}</title><rect x={-11} y={-11} width={22} height={22} rx="4" className="vte-map-hub" />
          <text className="vte-map-index" y={4}>H</text><text x={16} y={5} className="vte-map-name">Hub</text></g>
        {state?.riders?.map((rider) => {
          const point = markerPoint(rider);
          if (!point) return null;
          const [x, y] = mapPoint(point);
          return <g key={rider.key} transform={`translate(${x} ${y})`}>
            <title>{rider.name}{rider.offline ? " · last synced position" : ""}</title>
            <circle r="14" fill={rider.color} className="vte-map-rider-halo" />
            <circle r="8" fill={rider.offline ? "#67778b" : rider.color} className="vte-map-rider" />
            <text x={15} y={5} className="vte-map-name">{rider.name}</text>
          </g>;
        })}
      </svg>
      <div className="vte-map-legend"><span><b className="vte-legend-hub" /> Hub</span><span><b /> Clinic stop</span><span><b className="vte-legend-center" /> Load center</span><span><b className="vte-legend-rider" /> Rider GPS</span></div>
    </div>
  );
}

function OrderRows({ orders, riders }) {
  if (!orders.length) return <p className="vte-empty">Place a sample order or seed ten stops to see the reservation queue.</p>;
  return (
    <div className="vte-table-wrap">
      <table><thead><tr><th>Order / destination</th><th>Vials</th><th>Allocation</th><th>Custody</th></tr></thead>
        <tbody>{orders.map((order) => (
          <tr key={order.id}>
            <td><strong>{order.destinationName || order.clinicName}</strong><small>{order.orderNumber} · {order.priority}</small></td>
            <td>{order.quantity}</td>
            <td><span className={order.allocationState === "fully_reserved" ? "vte-good" : "vte-warn"}>{humanize(order.allocationState)}</span></td>
            <td>{humanize(order.status)}<small>{riders.find((rider) => rider.uid === order.assignedRiderId)?.name || "Unassigned"}</small></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function AdminControls({ state, rider, disabled, run }) {
  const [units, setUnits] = useState("3");
  return (
    <div className="vte-controls-card">
      <h3><Box /> Inventory &amp; fleet alerts</h3>
      <div className="vte-actions">
        <label>Vials to add<input type="number" min={1} max={100} value={units} onChange={(e) => setUnits(e.target.value)} /></label>
        <button type="button" onClick={() => run("stock", { quantity: Number(units) })} disabled={disabled || !(Number(units) > 0)}>Add stock</button>
        <button type="button" onClick={() => run("temperature", { rider: rider.key })} disabled={disabled}><Snowflake /> {rider.temperature > 8 ? "Restore temperature" : "Simulate temperature spike"}</button>
      </div>
      <p className="vte-subtle">{rider.name} cargo · {rider.temperature ?? 5} °C · thermal simulation</p>
      {state && (
        <ul className="vte-loads" aria-label="Assigned vials by rider">
          {state.riders.map((item) => {
            const vials = state.orders.filter((order) =>
              order.assignedRiderId === item.uid && ["assigned", "loading", "in_transit", "delayed"].includes(order.status)
            ).reduce((sum, order) => sum + order.quantity, 0);
            return <li key={item.key}><strong>{item.name}</strong>
              <progress aria-label={`${item.name} vial capacity`} value={vials} max={item.capacity} />
              <span>{vials}/{item.capacity} vials · {humanize(item.custody)}</span></li>;
          })}
        </ul>
      )}
      {!!state?.alerts?.length && (
        <ul className="vte-alerts">{state.alerts.map((alert) => (
          <li key={alert.id} className={alert.status === "active" ? "vte-warn" : "vte-good"}>
            <strong>{alert.title}</strong><span>{humanize(alert.status)} · {alert.message}</span>
          </li>
        ))}</ul>
      )}
    </div>
  );
}

function DispatchControls({ rider, disabled, run, route }) {
  const [stopKey, setStopKey] = useState(STOPS[0].key);
  const [quantity, setQuantity] = useState("2");
  const [urgent, setUrgent] = useState(false);
  return (
    <div className="vte-controls-card">
      <h3><Truck /> Order &amp; dispatch</h3>
      <div className="vte-actions">
        <label>Destination<select value={stopKey} onChange={(e) => setStopKey(e.target.value)}>
          {STOPS.map((stop) => <option key={stop.key} value={stop.key}>{stop.name}</option>)}
        </select></label>
        <label>Vials<input type="number" min={1} max={100} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label className="vte-check"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent</label>
        <button type="button" className="vte-primary" onClick={() => run("place", { stopKey, quantity: Number(quantity), urgent })} disabled={disabled || !(Number(quantity) > 0)}>Place sample order <ArrowRight /></button>
        <button type="button" onClick={() => run("seed")} disabled={disabled}>Seed 10 stops</button>
      </div>
      <div className="vte-actions vte-routing-actions">
        <button type="button" onClick={() => run("optimize", { rider: "fleet" })} disabled={disabled}><Route /> Balance fleet &amp; plan</button>
        <button type="button" onClick={() => run("optimize", { rider: rider.key })} disabled={disabled}>Plan for {rider.name}</button>
        {route && !route.saved && (
          <button type="button" onClick={() => run("optimize", { rider: rider.key, acceptConflicts: true })} disabled={disabled}>Use plan with conflicts</button>
        )}
        <button type="button" onClick={() => run("depart", { rider: rider.key })} disabled={disabled || !route?.saved || !rider.canDepart}>Load &amp; dispatch {rider.name}</button>
      </div>
      {route && (
        <p className="vte-subtle">
          {route.orderIds.length} stops · {Math.round(route.durationSeconds / 60)} min riding · {route.exact ? "Exhaustive sequence search" : "Best-effort sequence search"}
          {route.saved ? "" : " · Awaiting approval for missed arrival"}
        </p>
      )}
    </div>
  );
}

function RiderControls({ state, rider, route, disabled, run, playing, setPlaying }) {
  const rows = (route?.orderIds ?? []).map((id) => state?.orders.find((order) => order.id === id)).filter(Boolean);
  const active = rows.find(({ id }) => id === rider.activeOrderId);
  const position = markerPoint(rider);
  const deviation = rider.deviation?.phase === "deviating" ? "Off route"
    : rider.deviation?.pendingOffSinceMs != null ? "Off route · confirming"
      : rider.deviation?.sessionState === "navigating" ? "Monitoring" : "Awaiting dispatch";
  return (
    <div className="vte-controls-card vte-rider-screen">
      <div className="vte-rider-head"><h3><Smartphone /> {rider.name}</h3><span className={rider.offline ? "vte-warn" : "vte-good"}>{rider.offline ? <WifiOff /> : <Wifi />} {rider.offline ? "Offline" : "Online"}</span></div>
      <div className="vte-rider-state"><strong>{active?.destinationName || active?.clinicName || "No active stop"}</strong>
        <span>{deviation}{rider.cached ? " · 1 queued GPS fix" : ""}</span>
        {position && <code>{position.map((n) => n.toFixed(5)).join(", ")} · ±{rider.location.accuracyMeters} m</code>}
      </div>
      <div className="vte-actions">
        <button type="button" className="vte-primary" onClick={() => run("tick", { rider: rider.key })} disabled={disabled || !active}><LocateFixed /> GPS tick · +30 s</button>
        <button type="button" onClick={() => setPlaying(!playing)} disabled={!active}>{playing ? "Pause GPS" : "Auto GPS"}</button>
        <button type="button" onClick={() => run("offline", { rider: rider.key })} disabled={disabled}>{rider.offline ? "Reconnect & sync" : "Drop connection"}</button>
        <button type="button" onClick={() => run("detour", { rider: rider.key })} disabled={disabled}>{rider.detour ? "Return to route" : "Take detour"}</button>
        <button type="button" onClick={() => run("accuracy", { rider: rider.key })} disabled={disabled}>{rider.accuracy > 100 ? "Restore GPS accuracy" : "Weaken GPS"}</button>
        <button type="button" onClick={() => run("checkIn", { rider: rider.key })} disabled={disabled || !active}>Check delivery area</button>
        <button type="button" onClick={() => run("complete", { rider: rider.key })} disabled={disabled || !active}>Complete with sample proof</button>
      </div>
      {!!rows.length && (
        <ol className="vte-stop-list">{rows.map((order) => (
          <li key={order.id} className={order.id === rider.activeOrderId ? "vte-current-stop" : ""}>
            <span>{order.destinationName || order.clinicName}</span><small>{humanize(order.status)}</small>
          </li>
        ))}</ol>
      )}
    </div>
  );
}

function StreamLog({ entries, connection }) {
  const [channel, setChannel] = useState("all");
  const [selectedId, select] = useState("");
  const visible = entries.filter((entry) => channel === "all" || entry.channel === channel);
  const selected = visible.find((entry) => entry.id === selectedId) ?? visible.at(-1);
  return (
    <details className="vte-panel vte-terminal" open>
      <summary><Terminal /> Payload stream <span className="vte-tag">{connection}</span></summary>
      <div className="vte-channel-bar" aria-label="Filter payloads">
        {Object.entries(CHANNELS).map(([id, label]) => (
          <button type="button" aria-pressed={channel === id} key={id} onClick={() => { setChannel(id); select(""); }}>{label}</button>
        ))}
      </div>
      <div className="vte-log-body">
        <div className="vte-log-events" aria-label="Payload events">
          {visible.slice().reverse().map((entry) => (
            <button type="button" key={entry.id} aria-pressed={selected?.id === entry.id} onClick={() => select(entry.id)}>
              <time>{showTime(entry.at)}</time><span>{entry.title}</span>
            </button>
          ))}
          {!visible.length && <p>Waiting for events.</p>}
        </div>
        <pre aria-label="Selected JSON payload">{selected ? JSON.stringify(selected.payload, null, 2) : "{}"}</pre>
      </div>
    </details>
  );
}

export default function VaxTrackSystemExplorer() {
  const [role, setRole] = useState("dispatcher");
  const [node, setNode] = useState("firestore");
  const [scenario, setScenario] = useState("fleet");
  const [riderKey, setRiderKey] = useState("r1");
  const [runId, setRunId] = useState("");
  const [state, setState] = useState(null);
  const [health, setHealth] = useState(null);
  const [events, setEvents] = useState([]);
  const [connection, setConnection] = useState("Idle");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const inFlight = useRef(false);
  const rider = (state?.riders ?? RIDERS).find((item) => item.key === riderKey);

  useEffect(() => {
    const abort = new AbortController();
    const refresh = async () => {
      try {
        const r = await fetch(`${EXPLORER_ENDPOINT}/health`, { signal: abort.signal });
        if (!r.ok) throw new Error("Health check failed.");
        setHealth(await r.json());
      } catch {
        if (!abort.signal.aborted) setHealth({ connected: false });
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!runId) return;
    const stream = new EventSource(`${EXPLORER_ENDPOINT}/events?runId=${encodeURIComponent(runId)}`);
    stream.onopen = () => setConnection("Streaming");
    stream.onerror = () => setConnection("Reconnecting");
    stream.addEventListener("state", (event) => setState(JSON.parse(event.data)));
    stream.addEventListener("history", (event) => setEvents(JSON.parse(event.data)));
    stream.addEventListener("trace", (event) => setEvents((previous) => [...previous.slice(-99), JSON.parse(event.data)]));
    return () => stream.close();
  }, [runId]);

  const run = useCallback(async (action, parameters = {}, id = runId) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(action);
    setError("");
    try {
      const response = await fetch(EXPLORER_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, role, runId: id, ...parameters }),
      });
      const output = await response.json();
      if (!response.ok) {
        setError(output.message || "The simulator command failed.");
        setPlaying(false);
        return false;
      }
      if (action === "init") {
        setEvents([]);
        setRunId(id);
        setPlaying(false);
      }
      setState(output);
      return true;
    } catch {
      setError("The local simulator could not be reached. Check that the explorer is running.");
      setPlaying(false);
      return false;
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }, [role, runId]);

  useEffect(() => {
    if (!playing || role !== "rider" || !rider.activeOrderId) return;
    const timer = window.setInterval(() => run("tick", { rider: riderKey }), 1400);
    return () => clearInterval(timer);
  }, [playing, role, rider.activeOrderId, riderKey, run]);

  const disabled = !runId || Boolean(busy) || !health?.connected;
  const route = state?.routes?.[riderKey];
  const count = state?.orders.length ?? 0;
  const activeAlerts = state?.alerts.filter((alert) => alert.status === "active").length ?? 0;
  return (
    <main className="vte">
      <header className="vte-top">
        <div className="vte-brand"><span><Activity /></span><div><small>VaxTrack / Development</small><h1>System Explorer</h1></div></div>
        <div className="vte-top-meta">
          <span className={health?.connected ? "vte-good" : "vte-warn"}><Circle size={9} fill="currentColor" /> {health?.connected ? "Firestore emulator ready" : "Firestore emulator offline"}</span>
          <span>Simulated clock <strong>{showTime(state?.nowMs)}</strong> PHT</span>
        </div>
      </header>
      <div className="vte-toolbar">
        <nav aria-label="Simulator role">
          {ROLES.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} aria-pressed={role === id} onClick={() => { setRole(id); setPlaying(false); }}><Icon />{label}</button>
          ))}
        </nav>
        <div className="vte-run-controls">
          <label className="vte-sr-only" htmlFor="vte-scenario">Scenario</label>
          <select id="vte-scenario" value={scenario} onChange={(event) => setScenario(event.target.value)}>
            {Object.entries(SCENARIOS).map(([id, fixture]) => <option key={id} value={id}>{fixture.label}</option>)}
          </select>
          <button type="button" className="vte-primary" disabled={Boolean(busy)} onClick={() => run("init", { scenario }, crypto.randomUUID())}>{busy === "init" ? "Starting…" : runId ? "New run" : "Start lab"}</button>
        </div>
      </div>
      {health && !health.connected && <p className="vte-notice">Start <code>npm run emulators:system-explorer</code> to run a scenario. You can inspect the architecture while it starts.</p>}
      {error && <p className="vte-notice vte-error" role="alert">{error}</p>}
      <div className="vte-grid">
        <Architecture active={node} select={setNode} health={health} listeners={state?.listeners ?? []} />
        <section className="vte-panel vte-logistics" aria-labelledby="vte-logistics-title">
          <div className="vte-panel-head">
            <div><h2 id="vte-logistics-title"><Gauge /> Logistics simulator</h2><small>{state ? SCENARIOS[state.scenario].label : "Isolated demo workspace"}</small></div>
            <label className="vte-rider-select">Rider<select value={riderKey} onChange={(e) => { setRiderKey(e.target.value); setPlaying(false); }}>{RIDERS.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
          </div>
          <div className="vte-metrics" aria-label="Inventory totals">
            <div><span>On hand</span><strong>{state?.stock.onHand ?? "—"}</strong></div>
            <div><span>Reserved</span><strong>{state?.stock.reserved ?? "—"}</strong></div>
            <div><span>Available</span><strong>{state?.stock.available ?? "—"}</strong></div>
            <div><span>Orders</span><strong>{count}</strong></div>
            <div><span>Active alerts</span><strong className={activeAlerts > 0 ? "vte-warn" : ""}>{activeAlerts}</strong></div>
          </div>
          <FleetMap state={state} activeRider={riderKey} />
          {role === "admin" && <AdminControls state={state} rider={rider} disabled={disabled} run={run} />}
          {role === "dispatcher" && <DispatchControls rider={rider} disabled={disabled} run={run} route={route} />}
          {role === "rider" && <RiderControls state={state} rider={rider} route={route} disabled={disabled} run={run} playing={playing} setPlaying={setPlaying} />}
          {busy && <p className="vte-subtle" role="status">Running {humanize(busy).toLowerCase()}…</p>}
          <OrderRows orders={state?.orders ?? []} riders={state?.riders ?? []} />
        </section>
      </div>
      <StreamLog entries={events} connection={connection} />
      <footer>{SIM_PROJECT} · Local Firestore · Synthetic users, coordinates and cargo readings</footer>
    </main>
  );
}
