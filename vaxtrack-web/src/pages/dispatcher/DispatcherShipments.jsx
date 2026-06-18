import { Clock3, Filter, Truck } from "lucide-react";
import DispatcherLayout from "./DispatcherLayout";

function DispatcherShipments() {
  const pendingLoads = [
    {
      order: "#802",
      rider: "Marcus Chen",
      riderId: "VX-9902",
      cargo: "• -20°C Certified",
      tag: "Priority",
      wait: "14m",
    },
    {
      order: "#814",
      rider: "Elena Rodriguez",
      riderId: "VX-9941",
      cargo: "4x Vaccine Packs",
      tag: "Standard",
      wait: "08m",
    },
  ];

  return (
    <DispatcherLayout active="shipments" title="VaxTrack Logistics">
      <div className="dispatcher-v2-page">
        <div className="dispatcher-v2-header split">
          <div>
            <h1>Cargo Loading Queue</h1>
            <p>
              Monitor and manage the real-time loading process for assigned
              vaccine shipments. Ensure cold-chain integrity before dispatch.
            </p>
          </div>

          <div className="dispatcher-v2-top-cards">
            <div className="queue-status-card">
              <p>
                QUEUE STATUS<span>12 Total</span>
              </p>

              <div className="queue-bar">
                <span className="seg waiting"></span>
                <span className="seg loading"></span>
                <span className="seg done"></span>
              </div>

              <div className="queue-legend">
                <span>3 WAITING</span>
                <span>6 LOADING</span>
                <span>3 DONE</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dispatcher-shipments-grid">
          <div className="shipments-left">
            <div className="section-head-row">
              <h3>Pending Loads</h3>
              <button className="filter-link-btn">
                <Filter size={13} />
                Priority Order
              </button>
            </div>

            <div className="pending-loads-list">
              {pendingLoads.map((load) => (
                <div key={load.order} className="pending-load-card">
                  <div className="load-order-badge">
                    <small>ORDER</small>
                    <strong>{load.order}</strong>
                  </div>

                  <div className="load-rider-info">
                    <div className="load-avatar"></div>
                    <div>
                      <h4>{load.rider}</h4>
                      <p>Rider ID: {load.riderId}</p>
                      <span className="load-meta">
                        <Truck size={12} />
                        {load.cargo}
                      </span>
                      <span
                        className={`load-tag ${
                          load.tag === "Priority" ? "priority" : "standard"
                        }`}
                      >
                        {load.tag}
                      </span>
                    </div>
                  </div>

                  <div className="load-action-area">
                    <p>
                      Waiting: <strong>{load.wait}</strong>
                    </p>
                    <button className="start-load-btn">Start Loading →</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="in-progress-wrap">
              <h3>In Progress</h3>

              <div className="in-progress-grid">
                <div className="progress-card active">
                  <div className="progress-head">
                    <small>ACTIVE LOADING: #798</small>
                    <span>65% Done</span>
                  </div>

                  <h4>Rider: Sam J.</h4>

                  <div className="progress-line">
                    <span style={{ width: "65%" }}></span>
                  </div>

                  <p>Scan item 4 of 6 to complete...</p>
                </div>

                <div className="progress-card temp">
                  <div className="progress-head">
                    <small>ACTIVE LOADING: #792</small>
                    <span>Verify Temp</span>
                  </div>

                  <h4>Rider: Priya K.</h4>

                  <div className="progress-line dark">
                    <span style={{ width: "76%" }}></span>
                  </div>

                  <p>Finalizing documentation...</p>
                </div>
              </div>
            </div>
          </div>

          <aside className="shipments-right">
            <div className="logistics-efficiency-card">
              <div className="logistics-card-head">
                <Clock3 size={14} />
                <span>Logistics Efficiency</span>
              </div>

              <div className="efficiency-main">
                <h2>12.5</h2>
                <small>min</small>
              </div>

              <p className="efficiency-sub">Avg. Loading Time Today</p>

              <div className="efficiency-list">
                <div>
                  <span>Success Rate</span>
                  <strong>99.8%</strong>
                </div>
                <div>
                  <span>Rider Wait Time</span>
                  <strong>04:12</strong>
                </div>
                <div>
                  <span>Dispatch Goal</span>
                  <strong>45 / 50</strong>
                </div>
              </div>
            </div>
          </aside>
        </div>

        <footer className="dispatcher-v2-footer">
          <span>© 2026 VaxTrack Logistics. All rights reserved.</span>
          <div>
            <a href="/">Privacy Policy</a>
            <a href="/">Terms of Service</a>
            <a href="/">Help Center</a>
          </div>
        </footer>
      </div>
    </DispatcherLayout>
  );
}

export default DispatcherShipments;