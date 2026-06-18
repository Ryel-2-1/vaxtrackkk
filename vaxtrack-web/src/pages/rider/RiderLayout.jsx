import { Bell, Compass, Home, Menu, Truck, UserRound } from "lucide-react";
import { NavLink } from "react-router-dom";
import "./Rider.css";

function RiderLayout({ active = "home", children }) {
  return (
    <main className="rider-mobile-page">
      <section className="rider-phone-shell">
        <header className="rider-app-header">
          <button type="button" className="rider-header-btn">
            <Menu size={18} />
          </button>

          <h1>VaxTrack Mobile</h1>

          <button type="button" className="rider-header-btn">
            <Bell size={17} />
          </button>
        </header>

        <div className="rider-app-content">{children}</div>

        <nav className="rider-bottom-nav">
          <NavLink
            to="/rider"
            end
            className={active === "home" ? "active" : ""}
          >
            <Home size={17} />
            <span>Home</span>
          </NavLink>

          <NavLink
            to="/rider/deliveries"
            className={active === "deliveries" ? "active" : ""}
          >
            <Truck size={17} />
            <span>Deliveries</span>
          </NavLink>

          <NavLink
            to="/rider/navigation"
            className={active === "navigation" ? "active" : ""}
          >
            <Compass size={17} />
            <span>Navigation</span>
          </NavLink>

          <NavLink
            to="/rider/profile"
            className={active === "profile" ? "active" : ""}
          >
            <UserRound size={17} />
            <span>Profile</span>
          </NavLink>
        </nav>
      </section>
    </main>
  );
}

export default RiderLayout;