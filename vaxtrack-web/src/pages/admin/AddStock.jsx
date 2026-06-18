import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { ClipboardList, Truck } from "lucide-react";
import { db } from "../../firebase";
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
  const [storageTemp, setStorageTemp] = useState("-80");

  const [loadingVaccines, setLoadingVaccines] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("error");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  useEffect(() => {
    const loadVaccines = async () => {
      try {
        setLoadingVaccines(true);

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
      } catch (error) {
        console.error("Load vaccines error:", error);
        showMessage("Unable to load registered vaccines.");
      } finally {
        setLoadingVaccines(false);
      }
    };

    loadVaccines();
  }, []);

  const selectedVaccine = vaccines.find(
    (item) => item.id === selectedVaccineId
  );

  const handleVaccineChange = (value) => {
    setSelectedVaccineId(value);
    setMessage("");

    const vaccine = vaccines.find((item) => item.id === value);

    if (vaccine) {
      setManufacturer(vaccine.manufacturer || "");
    } else {
      setManufacturer("");
    }
  };

  const validateForm = async () => {
    const cleanedBatchId = batchId.trim().toUpperCase();
    const quantityNumber = Number(quantity);
    const cleanedTemp = String(storageTemp).trim();

    if (!selectedVaccine) {
      showMessage("Please select a registered vaccine.");
      return false;
    }

    if (!selectedVaccine.vaccineName || !selectedVaccine.vaccineType) {
      showMessage(
        "Selected vaccine is missing required details. Please check the vaccine record."
      );
      return false;
    }

    if (!manufacturer.trim()) {
      showMessage("Manufacturer is required.");
      return false;
    }

    if (!cleanedBatchId) {
      showMessage("Batch ID is required.");
      return false;
    }

    if (cleanedBatchId.length < 3) {
      showMessage("Batch ID must be at least 3 characters.");
      return false;
    }

    if (!arrivalDate) {
      showMessage("Arrival date is required.");
      return false;
    }

    if (!expiryDate) {
      showMessage("Expiry date is required.");
      return false;
    }

    const today = normalizeDate(new Date());
    const arrival = normalizeDate(new Date(arrivalDate));
    const expiry = normalizeDate(new Date(expiryDate));

    if (Number.isNaN(arrival.getTime())) {
      showMessage("Arrival date is invalid.");
      return false;
    }

    if (Number.isNaN(expiry.getTime())) {
      showMessage("Expiry date is invalid.");
      return false;
    }

    const maxFutureArrivalDate = new Date(today);
    maxFutureArrivalDate.setDate(maxFutureArrivalDate.getDate() + 30);

    if (arrival > maxFutureArrivalDate) {
      showMessage("Arrival date cannot be more than 30 days in the future.");
      return false;
    }

    if (expiry <= arrival) {
      showMessage("Expiry date must be after the arrival date.");
      return false;
    }

    if (expiry <= today) {
      showMessage("Expired stock cannot be added to inventory.");
      return false;
    }

    if (!Number.isInteger(quantityNumber)) {
      showMessage("Quantity must be a whole number.");
      return false;
    }

    if (quantityNumber <= 0) {
      showMessage("Quantity must be greater than zero.");
      return false;
    }

    if (quantityNumber > 1000000) {
      showMessage("Quantity is too large. Please check the encoded amount.");
      return false;
    }

    if (!cleanedTemp) {
      showMessage("Storage temperature is required.");
      return false;
    }

    if (!isValidTemperature(cleanedTemp)) {
      showMessage("Storage temperature must be a valid number.");
      return false;
    }

    const batchQuery = query(
      collection(db, "inventory"),
      where("batchId", "==", cleanedBatchId)
    );

    const batchSnap = await getDocs(batchQuery);

    if (!batchSnap.empty) {
      showMessage("This Batch ID already exists in inventory.");
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setMessageType("error");

    const isValid = await validateForm();
    if (!isValid) return;

    setSaving(true);

    try {
      const cleanedBatchId = batchId.trim().toUpperCase();
      const cleanedStorageTemp = String(storageTemp).trim();
      const cleanedManufacturer = manufacturer.trim();
      const status = getBatchStatus(expiryDate);

      await addDoc(collection(db, "inventory"), {
        vaccineId: selectedVaccine.id,
        vaccineName: selectedVaccine.vaccineName,
        vaccineType: selectedVaccine.vaccineType,
        manufacturer: cleanedManufacturer,
        internalSku: selectedVaccine.internalSku || "",
        batchId: cleanedBatchId,
        arrivalDate,
        expiryDate,
        quantity: Number(quantity),
        storageTemp: Number(cleanedStorageTemp),
        storageTempDisplay: `${cleanedStorageTemp}°C`,
        status,
        createdAt: serverTimestamp(),
      });

      showMessage("Stock added successfully.", "success");

      setTimeout(() => {
        navigate("/inventory");
      }, 700);
    } catch (error) {
      console.error("Add stock error:", error);
      showMessage("Failed to add stock. Please try again.");
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
            <p>
              Inventory / <span>Add New Stock</span>
            </p>
            <h1>Register Vaccine Batch</h1>
            <small>
              Enter vaccine batch details accurately to maintain supply chain
              integrity.
            </small>
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
                <label>Vaccine</label>
                <select
                  value={selectedVaccineId}
                  onChange={(e) => handleVaccineChange(e.target.value)}
                  disabled={loadingVaccines}
                >
                  <option value="">
                    {loadingVaccines
                      ? "Loading vaccines..."
                      : "Select registered vaccine..."}
                  </option>

                  {vaccines.map((vaccine) => (
                    <option key={vaccine.id} value={vaccine.id}>
                      {vaccine.vaccineName}{" "}
                      {vaccine.vaccineType ? `(${vaccine.vaccineType})` : ""}
                    </option>
                  ))}
                </select>

                {!loadingVaccines && vaccines.length === 0 && (
                  <small className="input-helper">
                    No vaccines registered yet. Please add a vaccine first.
                  </small>
                )}
              </div>

              <div>
                <label>Manufacturer</label>
                <input
                  placeholder="e.g. Pfizer-BioNTech"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                />
              </div>
            </div>

            {selectedVaccine && (
              <small className="input-helper">
                Type: {selectedVaccine.vaccineType || "N/A"} | SKU:{" "}
                {selectedVaccine.internalSku || "N/A"}
              </small>
            )}
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
                  placeholder="BT-2026-X90"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value.toUpperCase())}
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

                {arrivalDate &&
                  expiryDate &&
                  isExpiryAfterArrival(arrivalDate, expiryDate) && (
                    <small className="valid-note">
                      Valid lifecycle detected
                    </small>
                  )}
              </div>
            </div>

            <div className="two-col-form stock-controls">
              <div>
                <label>Unit Quantity (Doses)</label>

                <div className="number-stepper">
                  <button
                    type="button"
                    onClick={() =>
                      setQuantity(Math.max(1, Number(quantity || 0) - 100))
                    }
                  >
                    −
                  </button>

                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />

                  <button
                    type="button"
                    onClick={() => setQuantity(Number(quantity || 0) + 100)}
                  >
                    +
                  </button>
                </div>
              </div>

              <div>
                <label>Storage Temperature Requirements</label>

                <input
                  type="text"
                    placeholder="e.g. -80"
                   value={storageTemp}
                  onChange={(e) => {
                   const value = e.target.value;

                   if (/^-?\d*\.?\d*$/.test(value)) {
                    setStorageTemp(value);
                     }
            }}
          />

<small className="input-helper">
  Enter numbers only. The system will automatically display °C.
  {storageTemp && ` Current value: ${storageTemp}°C`}
</small>

                <small className="input-helper">
                  Enter numbers only. The system will automatically add °C.
                </small>
              </div>
            </div>
          </section>

          {message && (
            <p
              className={
                messageType === "success"
                  ? "form-response success"
                  : "form-error"
              }
            >
              {message}
            </p>
          )}

          <div className="stock-form-footer">
            <button
              type="button"
              className="outline-btn"
              onClick={() => navigate("/inventory")}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="blue-btn"
              disabled={saving || loadingVaccines || vaccines.length === 0}
            >
              {saving ? "Adding..." : "+ Add Stock"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function normalizeDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isExpiryAfterArrival(arrivalDate, expiryDate) {
  const arrival = normalizeDate(new Date(arrivalDate));
  const expiry = normalizeDate(new Date(expiryDate));

  if (Number.isNaN(arrival.getTime()) || Number.isNaN(expiry.getTime())) {
    return false;
  }

  return expiry > arrival;
}

function getBatchStatus(expiryDate) {
  const today = normalizeDate(new Date());
  const expiry = normalizeDate(new Date(expiryDate));

  const diffTime = expiry.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 30) return "Critical";
  if (diffDays <= 90) return "Warning";
  return "Stable";
}
function isValidTemperature(value) {
  return /^-?\d+(\.\d+)?$/.test(value);
}

export default AddStock;