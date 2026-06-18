import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import Login from "./pages/Login";
import Register from "./pages/Register";
import ForgotPassword from "./pages/ForgotPassword";
import PendingApproval from "./pages/PendingApproval";

import AdminDashboard from "./pages/admin/AdminDashboard";
import Inventory from "./pages/admin/Inventory";
import AddStock from "./pages/admin/AddStock";
import AddVaccine from "./pages/admin/AddVaccine";
import Deliveries from "./pages/admin/Deliveries";
import Riders from "./pages/admin/Riders";
import Alerts from "./pages/admin/Alerts";
import Analytics from "./pages/admin/Analytics";
import Settings from "./pages/admin/Settings";
import Clinics from "./pages/admin/Clinics";
import RegisterClinic from "./pages/admin/RegisterClinic";
import ClinicSuccess from "./pages/admin/ClinicSuccess";

import SalesRepDashboard from "./pages/salesRep/SalesRepDashboard";
import SalesRepInventory from "./pages/salesRep/SalesRepInventory";
import SalesRepRequestOrder from "./pages/salesRep/SalesRepRequestOrder";
import SalesRepPlaceOrder from "./pages/salesRep/SalesRepPlaceOrder";
import SalesRepOrderConfirmation from "./pages/salesRep/SalesRepOrderConfirmation";
import SalesRepOrderTracking from "./pages/salesRep/SalesRepOrderTracking";
import SalesRepAlerts from "./pages/salesRep/SalesRepAlerts";
import SalesRepSettings from "./pages/salesRep/SalesRepSettings";

import DispatcherDashboard from "./pages/dispatcher/DispatcherDashboard";
import DispatcherAssignRider from "./pages/dispatcher/DispatcherAssignRider";
import DispatcherShipments from "./pages/dispatcher/DispatcherShipments";
import DispatcherGeofence from "./pages/dispatcher/DispatcherGeofence";
import DispatcherSettings from "./pages/dispatcher/DispatcherSettings";

import RiderLogin from "./pages/rider/RiderLogin";
import RiderRegister from "./pages/rider/RiderRegister";
import RiderSuccess from "./pages/rider/RiderSuccess";
import RiderDashboard from "./pages/rider/RiderDashboard";
import RiderDeliveries from "./pages/rider/RiderDeliveries";
import RiderGeofence from "./pages/rider/RiderGeofence";
import RiderDeviationAlert from "./pages/rider/RiderDeviationAlert";
import RiderNavigation from "./pages/rider/RiderNavigation";
import RiderProfile from "./pages/rider/RiderProfile";
import RiderForgotPassword from "./pages/rider/RiderForgotPassword";
import RiderVerifyEmail from "./pages/rider/RiderVerifyEmail";
import RiderResetPassword from "./pages/rider/RiderResetPassword";
import RiderResetSuccess from "./pages/rider/RiderResetSuccess";



import "./styles.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Auth Routes */}
        <Route path="/" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/pending" element={<PendingApproval />} />

        {/* Admin Routes */}
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/add-stock" element={<AddStock />} />
        <Route path="/add-vaccine" element={<AddVaccine />} />
        <Route path="/deliveries" element={<Deliveries />} />
        <Route path="/riders" element={<Riders />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/clinics" element={<Clinics />} />
        <Route path="/register-clinic" element={<RegisterClinic />} />
        <Route path="/clinic-success" element={<ClinicSuccess />} />

        {/* Sales Representative Routes */}
        <Route path="/sales-rep" element={<SalesRepDashboard />} />
        <Route path="/sales-rep/inventory" element={<SalesRepInventory />} />
        <Route path="/sales-rep/request-order" element={<SalesRepRequestOrder />} />
        <Route path="/sales-rep/place-order" element={<SalesRepPlaceOrder />} />
        <Route path="/sales-rep/order-confirmation" element={<SalesRepOrderConfirmation />} />
        <Route path="/sales-rep/order-tracking" element={<SalesRepOrderTracking />} />
        <Route path="/sales-rep/alerts" element={<SalesRepAlerts />} />
        <Route path="/sales-rep/settings" element={<SalesRepSettings />} />

        {/* Dispatcher Routes */}
        <Route path="/dispatcher" element={<DispatcherDashboard />} />
        <Route path="/dispatcher/assign-rider" element={<DispatcherAssignRider />} />
        <Route path="/dispatcher/shipments" element={<DispatcherShipments />} />
        <Route path="/dispatcher/geofence" element={<DispatcherGeofence />} />
        <Route path="/dispatcher/settings" element={<DispatcherSettings />} />

        {/* Rider Routes */}
        <Route path="/rider/login" element={<RiderLogin />} />
        <Route path="/rider/register" element={<RiderRegister />} />
        <Route path="/rider/success" element={<RiderSuccess />} />
        <Route path="/rider" element={<RiderDashboard />} />
        <Route path="/rider/deliveries" element={<RiderDeliveries />} />
        <Route path="/rider/geofence" element={<RiderGeofence />} />
        <Route path="/rider/deviation-alert" element={<RiderDeviationAlert />} />
        <Route path="/rider/navigation" element={<RiderNavigation />} />
        <Route path="/rider/profile" element={<RiderProfile />} />
        <Route path="/rider/forgot-password" element={<RiderForgotPassword />} />
        <Route path="/rider/verify-email" element={<RiderVerifyEmail />} />
        <Route path="/rider/reset-password" element={<RiderResetPassword />} />
        <Route path="/rider/reset-success" element={<RiderResetSuccess />} />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;