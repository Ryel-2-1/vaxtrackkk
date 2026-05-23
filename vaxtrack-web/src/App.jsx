import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Register from "./pages/Register";
import AdminDashboard from "./pages/AdminDashboard";
import SalesRepRegister from "./pages/SalesRepRegister";
import PendingApproval from "./pages/PendingApproval";
import SalesRepDashboard from "./pages/SalesRepDashboard";
import Inventory from "./pages/Inventory";
import AddStock from "./pages/AddStock";
import AddVaccine from "./pages/AddVaccine";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/sales-register" element={<SalesRepRegister />} />
        <Route path="/pending" element={<PendingApproval />} />

        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/sales" element={<SalesRepDashboard />} />

        <Route path="/inventory" element={<Inventory />} />
        <Route path="/add-stock" element={<AddStock />} />
        <Route path="/add-vaccine" element={<AddVaccine />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;