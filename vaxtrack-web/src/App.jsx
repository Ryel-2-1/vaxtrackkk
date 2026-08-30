import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Login is the landing page — keep it eager so there's no first-paint flash.
import Login from "./pages/Login";
// Route guards gate rendering and are tiny — eager so protected routes resolve
// synchronously (only the page inside the Outlet is code-split).
import AdminRoute from "./components/AdminRoute";
import DispatcherRoute from "./components/DispatcherRoute";
import SalesRepRoute from "./components/SalesRepRoute";
import RouteFallback from "./components/RouteFallback";

import "./styles.css";

// Everything else is lazy-loaded per route, so the initial download is just the
// shell + login instead of every Admin/Sales-Rep/Dispatcher page (and Leaflet)
// at once. Each page becomes its own chunk, fetched on navigation.
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const PendingApproval = lazy(() => import("./pages/PendingApproval"));
const StyleGuide = lazy(() => import("./pages/StyleGuide"));
const GoogleMapsFeasibility = lazy(() => import("./pages/dev/GoogleMapsFeasibility"));

const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const Inventory = lazy(() => import("./pages/admin/Inventory"));
const AddStock = lazy(() => import("./pages/admin/AddStock"));
const AddVaccine = lazy(() => import("./pages/admin/AddVaccine"));
const Deliveries = lazy(() => import("./pages/admin/Deliveries"));
const Riders = lazy(() => import("./pages/admin/Riders"));
const Alerts = lazy(() => import("./pages/admin/Alerts"));
const Analytics = lazy(() => import("./pages/admin/Analytics"));
const Settings = lazy(() => import("./pages/admin/Settings"));
const Clinics = lazy(() => import("./pages/admin/Clinics"));
const Invoices = lazy(() => import("./pages/admin/Invoices"));
const InvoiceEditor = lazy(() => import("./pages/admin/InvoiceEditor"));
const RegisterClinic = lazy(() => import("./pages/admin/RegisterClinic"));
const ClinicSuccess = lazy(() => import("./pages/admin/ClinicSuccess"));

const SalesRepDashboard = lazy(() => import("./pages/salesRep/SalesRepDashboard"));
const SalesRepInventory = lazy(() => import("./pages/salesRep/SalesRepInventory"));
const SalesRepRequestOrder = lazy(() => import("./pages/salesRep/SalesRepRequestOrder"));
const SalesRepPlaceOrder = lazy(() => import("./pages/salesRep/SalesRepPlaceOrder"));
const SalesRepOrderConfirmation = lazy(() => import("./pages/salesRep/SalesRepOrderConfirmation"));
const SalesRepOrderTracking = lazy(() => import("./pages/salesRep/SalesRepOrderTracking"));
const SalesRepAlerts = lazy(() => import("./pages/salesRep/SalesRepAlerts"));
const SalesRepSettings = lazy(() => import("./pages/salesRep/SalesRepSettings"));

const DispatcherDashboard = lazy(() => import("./pages/dispatcher/DispatcherDashboard"));
const DispatcherAssignRider = lazy(() => import("./pages/dispatcher/DispatcherAssignRider"));
const DispatcherShipments = lazy(() => import("./pages/dispatcher/DispatcherShipments"));
const DispatcherCargoLoading = lazy(() => import("./pages/dispatcher/DispatcherCargoLoading"));
const DispatcherGeofence = lazy(() => import("./pages/dispatcher/DispatcherGeofence"));
const DispatcherSettings = lazy(() => import("./pages/dispatcher/DispatcherSettings"));

function App() {
  return (
    <BrowserRouter>
      {/* One Suspense boundary for all code-split routes. The fallback is a
          fixed, layout-stable loader so navigation never shifts content. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />

          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/pending" element={<PendingApproval />} />
          <Route path="/pending-approval" element={<Navigate to="/pending" replace />} />

          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/inventory" element={<Inventory />} />
            <Route path="/admin/add-stock" element={<AddStock />} />
            <Route path="/admin/add-vaccine" element={<AddVaccine />} />
            <Route path="/admin/deliveries" element={<Deliveries />} />
            <Route path="/admin/riders" element={<Riders />} />
            <Route path="/admin/alerts" element={<Alerts />} />
            <Route path="/admin/analytics" element={<Analytics />} />
            <Route path="/admin/settings" element={<Settings />} />
            <Route path="/admin/clinics" element={<Clinics />} />
            <Route path="/admin/invoices" element={<Invoices />} />
            <Route path="/admin/invoices/:orderId" element={<InvoiceEditor />} />
            <Route path="/admin/register-clinic" element={<RegisterClinic />} />
            <Route path="/admin/clinic-success" element={<ClinicSuccess />} />
          </Route>

          <Route path="/inventory" element={<Navigate to="/admin/inventory" replace />} />
          <Route path="/add-stock" element={<Navigate to="/admin/add-stock" replace />} />
          <Route path="/add-vaccine" element={<Navigate to="/admin/add-vaccine" replace />} />
          <Route path="/deliveries" element={<Navigate to="/admin/deliveries" replace />} />
          <Route path="/riders" element={<Navigate to="/admin/riders" replace />} />
          <Route path="/alerts" element={<Navigate to="/admin/alerts" replace />} />
          <Route path="/analytics" element={<Navigate to="/admin/analytics" replace />} />
          <Route path="/settings" element={<Navigate to="/admin/settings" replace />} />
          <Route path="/clinics" element={<Navigate to="/admin/clinics" replace />} />
          <Route path="/register-clinic" element={<Navigate to="/admin/register-clinic" replace />} />
          <Route path="/clinic-success" element={<Navigate to="/admin/clinic-success" replace />} />

          <Route element={<SalesRepRoute />}>
            <Route path="/sales-rep" element={<SalesRepDashboard />} />
            <Route path="/sales-rep/inventory" element={<SalesRepInventory />} />
            <Route path="/sales-rep/request-order" element={<SalesRepRequestOrder />} />
            <Route path="/sales-rep/place-order" element={<SalesRepPlaceOrder />} />
            <Route path="/sales-rep/order-confirmation" element={<SalesRepOrderConfirmation />} />
            <Route path="/sales-rep/order-tracking" element={<SalesRepOrderTracking />} />
            <Route path="/sales-rep/alerts" element={<SalesRepAlerts />} />
            <Route path="/sales-rep/settings" element={<SalesRepSettings />} />
          </Route>

          <Route element={<DispatcherRoute />}>
            <Route path="/dispatcher" element={<DispatcherDashboard />} />
            <Route path="/dispatcher/assign-rider" element={<DispatcherAssignRider />} />
            <Route path="/dispatcher/shipments" element={<DispatcherShipments />} />
            <Route path="/dispatcher/cargo-loading" element={<DispatcherCargoLoading />} />
            <Route path="/dispatcher/geofence" element={<DispatcherGeofence />} />
            <Route path="/dispatcher/settings" element={<DispatcherSettings />} />
          </Route>

          {/* Meridian design-system preview — isolated, no Firestore. */}
          <Route path="/style-guide" element={<StyleGuide />} />

          {/* TEMPORARY Google Maps feasibility spike — only mounted behind an
              explicit env flag. Absent/false => normal app is unchanged. */}
          {import.meta.env.VITE_GOOGLE_MAPS_FEASIBILITY === "true" && (
            <Route path="/gmaps-feasibility" element={<GoogleMapsFeasibility />} />
          )}

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
