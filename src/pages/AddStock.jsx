import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";
import { ClipboardList, Minus, Plus, Truck } from "lucide-react";
import { db } from "../firebase";
import { AdminSidebar } from "./Inventory";

function AddStock() {
  const navigate = useNavigate();

  const [vaccines, setVaccines] = useState([]);
  const [selectedVaccineId, setSelectedVaccineId] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [batchId, setBatchId] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [quantity, setQuantity] = useState(1000);
  const [storageTemp, setStorageTemp] = useState("-80°C");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const loadVaccines = async () => {
      const vaccineQuery = query(
        collection(db, "vaccines"),
        orderBy("createdAt", "desc")
      );

      const snap = await getDocs(vaccineQuery);

      setVaccines(
        snap.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }))
      );
    };

    loadVaccines();
  }, []);

  const selectedVaccine = vaccines.find((item) => item.id === selectedVaccineId);

  const handleVaccineChange = (value) => {
    setSelectedVaccineId(value);

    const vaccine = vaccines.find((item) => item.id === value);

    if (vaccine) {
      setManufacturer(vaccine.manufacturer || "");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");

    if (!selectedVaccine) {
      setMessage("Please select a vaccine type.");
      return;
    }

    if (!batchId.trim()) {
      setMessage("Batch ID is required.");
      return;
    }

    if (!arrivalDate) {
      setMessage("Arrival date is required.");
      return;
    }

    if (!expiryDate) {
      setMessage("Expiry date is required.");
      return;
    }

    if (Number(quantity) <= 0) {
      setMessage("Quantity must be greater than zero.");
      return;
    }

    if (!storageTemp.trim()) {
      setMessage("Storage temperature is required.");
      return;
    }

    setSaving(true);

    try {
      const status = getBatchStatus(expiryDate);

      await addDoc(collection(db, "inventory"), {
        vaccineId: selectedVaccine.id,
        vaccineName: selectedVaccine.vaccineName,
        vaccineType: selectedVaccine.vaccineType,
        manufacturer,
        batchId: batchId.trim(),
        arrivalDate,
        expiryDate,
        quantity: Number(quantity),
        storageTemp,
        status,
        createdAt: serverTimestamp(),
      });

      navigate("/inventory");
    } catch (error) {
      console.error(error);
      setMessage("Failed to add stock.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inventory-page">
      <AdminSidebar active="inventory" onLogout={() => navigate("/")} />

      <main className="inventory-main">
        <header className="form-page-header">
          <div>
            <p>Inventory / <span>Add New Stock</span></p>
            <h1>Register Vaccine Batch</h1>
            <small>Enter vaccine batch details accurately to maintain supply chain integrity.</small>
          </div>
        </header>

        <form className="stock-form" onSubmit={handleSubmit}>
          <div className="step-tabs">
            <span className="active">1. Product Information</span>
            <span>2. Batch Details</span>
          </div>

          <section className="form-section-card">
            <h2>
              <ClipboardList size={18} />
              Product Identification
            </h2>

            <div className="two-col-form">
              <div>
                <label>Vaccine Type</label>
                <select
                  value={selectedVaccineId}
                  onChange={(e) => handleVaccineChange(e.target.value)}
                >
                  <option value="">Select vaccine type...</option>
                  {vaccines.map((vaccine) => (
                    <option key={vaccine.id} value={vaccine.id}>
                      {vaccine.vaccineName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Manufacturer</label>
                <input
                  placeholder="e.g. BioTech Solutions"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="form-section-card">
            <h2>
              <Truck size={18} />
              Logistics & Quantity
            </h2>

            <div className="three-col-form">
              <div>
                <label>Batch ID</label>
                <input
                  placeholder="BT-2024-X90"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value)}
                />
              </div>

              <div>
                <label>Arrival Date</label>
                <input
                  type="date"
                  value={arrivalDate}
                  onChange={(e) => setArrivalDate(e.target.value)}
                />
              </div>

              <div>
                <label>Expiry Date</label>
                <input
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                />
                <small className="valid-note">Valid lifecycle detected</small>
              </div>
            </div>

            <div className="two-col-form stock-controls">
              <div>
                <label>Unit Quantity (Doses)</label>
                <div className="number-stepper">
                  <button
                    type="button"
                    onClick={() => setQuantity(Math.max(0, Number(quantity) - 100))}
                  >
                    <Minus size={15} />
                  </button>
                  <input
                    type="number"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setQuantity(Number(quantity) + 100)}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>

              <div>
                <label>Storage Temperature Requirements</label>
                <div className="number-stepper">
                  <button type="button">−</button>
                  <input
                    value={storageTemp}
                    onChange={(e) => setStorageTemp(e.target.value)}
                  />
                  <button type="button">+</button>
                </div>
              </div>
            </div>
          </section>

          {message && <p className="form-error">{message}</p>}

          <div className="stock-form-footer">
            <button
              type="button"
              className="outline-btn"
              onClick={() => navigate("/inventory")}
            >
              Cancel
            </button>

            <button type="submit" className="blue-btn" disabled={saving}>
              {saving ? "Adding..." : "+ Add Stock"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function getBatchStatus(expiryDate) {
  const today = new Date();
  const expiry = new Date(expiryDate);
  const diffTime = expiry.getTime() - today.getTime();
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  if (diffDays <= 30) return "Critical";
  if (diffDays <= 90) return "Warning";
  return "Stable";
}

export default AddStock;