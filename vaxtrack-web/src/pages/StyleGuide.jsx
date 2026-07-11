// ============================================================
// VaxTrack "Meridian" UI style guide — isolated visual preview.
// No Firestore, no services, no shared page CSS. Static demo data
// only. Safe to delete once the design system ships to real pages.
// ============================================================
import { useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  FileText,
  Inbox,
  Info,
  LayoutDashboard,
  LogOut,
  Package,
  Search,
  Settings as SettingsIcon,
  ShieldPlus,
  Truck,
  Users,
  XCircle,
} from "lucide-react";
import "../styles/tokens.css";
import "./StyleGuide.css";

const NAV_ITEMS = [
  { label: "Dashboard", icon: LayoutDashboard, active: true },
  { label: "Deliveries", icon: Truck },
  { label: "Inventory", icon: Package },
  { label: "Riders", icon: Users },
  { label: "Invoices", icon: FileText },
  { label: "Settings", icon: SettingsIcon },
];

const BADGES = [
  { key: "pending", label: "Pending Dispatch" },
  { key: "assigned", label: "Assigned" },
  { key: "loading", label: "Loading" },
  { key: "transit", label: "In Transit" },
  { key: "delayed", label: "Delayed" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
];

const TABLE_ROWS = [
  {
    order: "VT-ORD-2201",
    clinic: "St. Luke's Medical Center",
    address: "Quezon City",
    vaccine: "Comirnaty",
    qty: 120,
    rider: "M. Santos",
    badge: "transit",
    badgeLabel: "In Transit",
    updated: "12m ago",
  },
  {
    order: "VT-ORD-2198",
    clinic: "PGH Manila",
    address: "Taft Ave, Manila",
    vaccine: "Spikevax",
    qty: 60,
    rider: "J. Ramirez",
    badge: "delayed",
    badgeLabel: "Delayed",
    updated: "38m ago",
    delayed: true,
  },
  {
    order: "VT-ORD-2195",
    clinic: "Makati Medical Center",
    address: "Amorsolo St, Makati",
    vaccine: "BCG",
    qty: 200,
    rider: "A. dela Cruz",
    badge: "loading",
    badgeLabel: "Loading",
    updated: "1h ago",
  },
  {
    order: "VT-ORD-2190",
    clinic: "Cardinal Santos",
    address: "San Juan",
    vaccine: "Hepatitis B",
    qty: 80,
    rider: "M. Santos",
    badge: "delivered",
    badgeLabel: "Delivered",
    updated: "2h ago",
  },
  {
    order: "VT-ORD-2188",
    clinic: "QC General Hospital",
    address: "Quezon City",
    vaccine: "Comirnaty",
    qty: 45,
    rider: "—",
    badge: "pending",
    badgeLabel: "Pending Dispatch",
    updated: "3h ago",
  },
];

function Badge({ variant, children }) {
  return (
    <span className={`sg-badge ${variant}`}>
      <span className="sg-dot" />
      {children}
    </span>
  );
}

function Swatch({ name, hex, style }) {
  return (
    <div className="sg-swatch">
      <div className="sg-swatch-chip" style={{ background: hex, ...style }} />
      <div className="sg-swatch-name">{name}</div>
      <div className="sg-swatch-hex">{hex}</div>
    </div>
  );
}

function Section({ title, desc, children }) {
  return (
    <section className="sg-section">
      <h2 className="sg-section-title">{title}</h2>
      {desc && <p className="sg-section-desc">{desc}</p>}
      {children}
    </section>
  );
}

function StyleGuide() {
  const [segment, setSegment] = useState("all");

  return (
    <div className="sg-root">
      {/* ---------- 3. Sidebar (live) ---------- */}
      <aside className="sg-sidebar">
        <div className="sg-logo">
          <span className="sg-logo-mark">
            <ShieldPlus size={16} />
          </span>
          <span className="sg-logo-word">VaxTrack</span>
        </div>

        <span className="sg-role-chip">
          <span className="sg-role-dot" />
          Admin Console
        </span>

        <nav className="sg-nav">
          {NAV_ITEMS.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className={`sg-nav-item ${active ? "active" : ""}`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sg-nav-footer">
          <button type="button" className="sg-nav-item">
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </aside>

      <div className="sg-main">
        {/* ---------- 4. Topbar (live) ---------- */}
        <header className="sg-topbar">
          <h1 className="sg-page-title">Meridian style guide</h1>

          <div className="sg-topbar-right">
            <label className="sg-search">
              <Search size={15} />
              <input placeholder="Search orders, clinics..." />
            </label>

            <button type="button" className="sg-icon-btn" title="Notifications">
              <Bell size={16} />
            </button>

            <span className="sg-avatar">JR</span>
          </div>
        </header>

        <main className="sg-content">
          <p className="sg-intro">
            VaxTrack visual system preview — dark pine navigation, light
            operational content, green as the safety/success signal, red
            reserved for things that need action. Nothing on this page touches
            Firestore or the real app flows.
          </p>

          {/* ---------- 1. Color tokens ---------- */}
          <Section
            title="1 · Color tokens"
            desc="Brand greens for chrome and CTAs, true grays for structure, four semantic families for state."
          >
            <div className="sg-swatch-row">
              <Swatch name="--green-950" hex="#0B211A" />
              <Swatch name="--green-900" hex="#123126" />
              <Swatch name="--green-800" hex="#1A4534" />
              <Swatch name="--green-700" hex="#1F5C41" />
              <Swatch name="--green-600" hex="#27714F" />
              <Swatch name="--green-100" hex="#DBEEE3" />
              <Swatch name="--green-50" hex="#F1F8F4" />
            </div>
            <div className="sg-swatch-row">
              <Swatch name="--gray-900" hex="#111827" />
              <Swatch name="--gray-600" hex="#4B5563" />
              <Swatch name="--gray-500" hex="#6B7280" />
              <Swatch name="--gray-300" hex="#D1D5DB" />
              <Swatch name="--gray-200" hex="#E5E7EB" />
              <Swatch name="--gray-100" hex="#F3F4F6" />
              <Swatch name="--gray-50" hex="#F9FAFB" />
            </div>
            <div className="sg-semantic-grid">
              <div
                className="sg-semantic"
                style={{
                  background: "var(--success-bg)",
                  borderColor: "var(--success-border)",
                  color: "var(--success-text)",
                }}
              >
                <strong>Success</strong>
                <span>Delivered · approved · active</span>
              </div>
              <div
                className="sg-semantic"
                style={{
                  background: "var(--danger-bg)",
                  borderColor: "var(--danger-border)",
                  color: "var(--danger-text)",
                }}
              >
                <strong>Danger</strong>
                <span>Delayed · cancelled · urgent</span>
              </div>
              <div
                className="sg-semantic"
                style={{
                  background: "var(--warning-bg)",
                  borderColor: "var(--warning-border)",
                  color: "var(--warning-text)",
                }}
              >
                <strong>Warning</strong>
                <span>Loading · expiring soon</span>
              </div>
              <div
                className="sg-semantic"
                style={{
                  background: "var(--info-bg)",
                  borderColor: "var(--info-border)",
                  color: "var(--info-text)",
                }}
              >
                <strong>Info (teal)</strong>
                <span>In transit · assigned</span>
              </div>
            </div>
          </Section>

          {/* ---------- 2. Typography ---------- */}
          <Section
            title="2 · Typography"
            desc="Inter, one family. Tabular numerals on every number. Sentence case everywhere — no uppercase microlabels."
          >
            <div className="sg-card">
              <div className="sg-type-row">
                <span className="sg-type-label">Page title · 22 / 600</span>
                <span className="sg-t-page">Delivery management</span>
              </div>
              <div className="sg-type-row">
                <span className="sg-type-label">Section title · 16 / 600</span>
                <span className="sg-t-section">Active shipments</span>
              </div>
              <div className="sg-type-row">
                <span className="sg-type-label">Body & table · 14 / 400</span>
                <span className="sg-t-body">
                  120 vials of Comirnaty for St. Luke's Medical Center.
                </span>
              </div>
              <div className="sg-type-row">
                <span className="sg-type-label">Secondary · 13 / 400</span>
                <span className="sg-t-meta">
                  Updated 12 minutes ago by dispatcher@vaxtrack.com
                </span>
              </div>
              <div className="sg-type-row">
                <span className="sg-type-label">Label / badge · 12 / 600</span>
                <span className="sg-t-label">Order number</span>
              </div>
              <div className="sg-type-row">
                <span className="sg-type-label">KPI · 28 / 700 tabular</span>
                <span className="sg-t-kpi">
                  1,248 <span style={{ color: "var(--gray-300)" }}>·</span>{" "}
                  1,111
                </span>
              </div>
            </div>
          </Section>

          {/* ---------- 5. KPI cards ---------- */}
          <Section
            title="5 · KPI cards"
            desc="Quiet by default — label, tabular number, one context line. No icon tiles. At most one red 'attention' accent per page."
          >
            <div className="sg-kpi-grid">
              <div className="sg-kpi">
                <span className="sg-kpi-label">Active deliveries</span>
                <span className="sg-kpi-value">24</span>
                <span className="sg-kpi-context">
                  <span
                    className="sg-dot"
                    style={{ background: "var(--gray-300)" }}
                  />
                  5 pending dispatch
                </span>
              </div>

              <div className="sg-kpi">
                <span className="sg-kpi-label">In transit</span>
                <span className="sg-kpi-value">9</span>
                <span className="sg-kpi-context">
                  <span
                    className="sg-dot"
                    style={{ background: "var(--info-text)" }}
                  />
                  2 arriving within the hour
                </span>
              </div>

              <div className="sg-kpi attention">
                <span className="sg-kpi-label">Delayed</span>
                <span
                  className="sg-kpi-value"
                  style={{ color: "var(--danger-text)" }}
                >
                  3
                </span>
                <span className="sg-kpi-context">
                  <span
                    className="sg-dot"
                    style={{ background: "var(--danger-text)" }}
                  />
                  Needs dispatcher action
                </span>
              </div>

              <div className="sg-kpi">
                <span className="sg-kpi-label">Delivered today</span>
                <span className="sg-kpi-value">12</span>
                <span className="sg-kpi-context">
                  <span
                    className="sg-dot"
                    style={{ background: "var(--success-text)" }}
                  />
                  All cold-chain checks passed
                </span>
              </div>
            </div>
          </Section>

          {/* ---------- 6. Status badges ---------- */}
          <Section
            title="6 · Status badges"
            desc="One anatomy for every screen and role: dot + 12px label, pill radius, tinted background with matching border."
          >
            <div className="sg-card">
              <div className="sg-badge-row">
                {BADGES.map((b) => (
                  <Badge key={b.key} variant={b.key}>
                    {b.label}
                  </Badge>
                ))}
              </div>
            </div>
          </Section>

          {/* ---------- 8. Filter bar ---------- */}
          <Section
            title="8 · Filter bar"
            desc="Segmented status control with counts, secondary selects, search on the right. One pattern for every list page."
          >
            <div className="sg-filterbar">
              <div className="sg-segmented">
                {[
                  { id: "all", label: "All · 24" },
                  { id: "transit", label: "In transit · 9" },
                  { id: "delayed", label: "Delayed · 3" },
                  { id: "delivered", label: "Delivered · 12" },
                ].map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`sg-segment ${segment === s.id ? "active" : ""}`}
                    onClick={() => setSegment(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              <select className="sg-select" defaultValue="all">
                <option value="all">All regions</option>
                <option>Metro Manila</option>
                <option>Laguna</option>
              </select>

              <button type="button" className="sg-btn secondary sm">
                More filters
              </button>

              <label className="sg-search" style={{ marginLeft: "auto" }}>
                <Search size={15} />
                <input placeholder="Search orders..." />
              </label>
            </div>
          </Section>

          {/* ---------- 7. Table ---------- */}
          <Section
            title="7 · Table"
            desc="48px rows, divider lines instead of zebra, green-tinted hover, red left rule on rows needing attention, tabular numerals right-aligned."
          >
            <div className="sg-table-wrap">
              <table className="sg-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Destination</th>
                    <th>Vaccine</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th>Rider</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {TABLE_ROWS.map((r) => (
                    <tr key={r.order} className={r.delayed ? "row-delayed" : ""}>
                      <td className="sg-td-strong tnum">{r.order}</td>
                      <td>
                        {r.clinic}
                        <span className="sg-td-sub">{r.address}</span>
                      </td>
                      <td>{r.vaccine}</td>
                      <td className="sg-td-num">{r.qty}</td>
                      <td>{r.rider}</td>
                      <td>
                        <Badge variant={r.badge}>{r.badgeLabel}</Badge>
                      </td>
                      <td className="sg-td-meta">{r.updated}</td>
                      <td style={{ textAlign: "right" }}>
                        <button type="button" className="sg-btn ghost sm">
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* ---------- 9. Buttons ---------- */}
          <Section
            title="9 · Buttons"
            desc="Three variants, three sizes (32 / 36 / 40). Solid red only on confirmation steps."
          >
            <div className="sg-card">
              <div className="sg-btn-row" style={{ marginBottom: 14 }}>
                <button type="button" className="sg-btn primary">
                  Assign rider
                </button>
                <button type="button" className="sg-btn secondary">
                  Export
                </button>
                <button type="button" className="sg-btn ghost">
                  View details
                </button>
                <button type="button" className="sg-btn destructive">
                  Cancel order
                </button>
                <button type="button" className="sg-btn destructive-solid">
                  Confirm cancellation
                </button>
                <button type="button" className="sg-btn primary" disabled>
                  Disabled
                </button>
                <button type="button" className="sg-btn primary">
                  <span className="sg-spinner" />
                  Saving...
                </button>
              </div>
              <div className="sg-btn-row">
                <button type="button" className="sg-btn primary sm">
                  Small · 32
                </button>
                <button type="button" className="sg-btn primary">
                  Medium · 36
                </button>
                <button type="button" className="sg-btn primary lg">
                  Large · 40
                </button>
              </div>
            </div>
          </Section>

          {/* ---------- 10. Alerts ---------- */}
          <Section
            title="10 · Alerts & banners"
            desc="One anatomy, four semantic variants. Tinted background + matching border, 16px icon, no heavy shadows."
          >
            <div className="sg-alert-stack">
              <div className="sg-alert success">
                <CheckCircle2 size={16} />
                <div>
                  <strong>Order delivered</strong>
                  <p>
                    VT-ORD-2190 was delivered to Cardinal Santos at 2:14 PM.
                  </p>
                </div>
              </div>
              <div className="sg-alert warning">
                <AlertTriangle size={16} />
                <div>
                  <strong>Stock expiring soon</strong>
                  <p>3 Comirnaty batches expire within 30 days.</p>
                </div>
              </div>
              <div className="sg-alert danger">
                <XCircle size={16} />
                <div>
                  <strong>Delivery delayed</strong>
                  <p>
                    VT-ORD-2198 reported a delay: heavy traffic on Taft Ave.
                  </p>
                </div>
              </div>
              <div className="sg-alert info">
                <Info size={16} />
                <div>
                  <strong>Live tracking not yet active</strong>
                  <p>
                    Map view activates once the Rider app sends location
                    updates.
                  </p>
                </div>
              </div>
            </div>
          </Section>

          {/* ---------- 11. Empty state ---------- */}
          <Section
            title="11 · Empty state"
            desc="Compact and useful — never a giant blank card."
          >
            <div className="sg-card" style={{ maxWidth: 480 }}>
              <div className="sg-empty">
                <span className="sg-empty-icon">
                  <Inbox size={20} />
                </span>
                <strong>No assigned deliveries yet</strong>
                <p>Orders assigned by a dispatcher will appear here.</p>
                <button type="button" className="sg-btn secondary sm">
                  Refresh
                </button>
              </div>
            </div>
          </Section>

          {/* ---------- 12. Skeletons ---------- */}
          <Section
            title="12 · Loading skeletons"
            desc="Skeletons for tables and cards; spinners only inside buttons."
          >
            <div className="sg-skeleton-grid">
              <div className="sg-card">
                <div className="sg-skel-stack">
                  <div className="sg-skel" style={{ width: "40%", height: 12 }} />
                  <div className="sg-skel" style={{ width: "55%", height: 26 }} />
                  <div className="sg-skel" style={{ width: "70%", height: 10 }} />
                </div>
              </div>
              <div className="sg-card">
                <div className="sg-skel-stack">
                  <div className="sg-skel" style={{ width: "100%", height: 14 }} />
                  <div className="sg-skel" style={{ width: "100%", height: 12 }} />
                  <div className="sg-skel" style={{ width: "100%", height: 12 }} />
                  <div className="sg-skel" style={{ width: "62%", height: 12 }} />
                </div>
              </div>
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}

export default StyleGuide;
