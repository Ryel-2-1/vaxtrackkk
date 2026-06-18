import {
  Compass,
  Home,
  LocateFixed,
  Minus,
  Plus,
  ShieldCheck,
  Thermometer,
} from "lucide-react";
import RiderLayout from "./RiderLayout";

function RiderNavigation() {
  return (
    <RiderLayout active="navigation">
      <section className="nav-status-top">
        <div>
          <span>IN TRANSIT TO</span>
          <h2>Makati Medical Center</h2>
        </div>

        <div>
          <strong>14 min</strong>
          <p>3.4 km</p>
        </div>
      </section>

      <div className="nav-progress">
        <span></span>
      </div>

      <section className="navigation-map">
        <button className="nav-map-control plus" type="button">
          <Plus size={18} />
        </button>

        <button className="nav-map-control minus" type="button">
          <Minus size={18} />
        </button>

        <button className="nav-map-control locate" type="button">
          <LocateFixed size={19} />
        </button>

        <div className="nav-instruction-card">
          <div className="nav-badges">
            <span>
              <ShieldCheck size={12} />
              Safest Route
            </span>

            <span>
              <Thermometer size={12} />
              Stable 4°C
            </span>
          </div>

          <div className="nav-turn-row">
            <div className="turn-icon">
              <Compass size={24} />
            </div>

            <div>
              <h2>Right</h2>
              <p>on Ayala Ave</p>
              <small>Distance: 1.2km</small>
            </div>
          </div>
        </div>
      </section>
    </RiderLayout>
  );
}

export default RiderNavigation;