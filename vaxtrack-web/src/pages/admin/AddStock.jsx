import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, Truck } from "lucide-react";
import { AdminSidebar } from "../../components/admin/AdminSidebar";
import {
  getVaccines,
  batchIdExists,
  addStockBatch,
} from "../../services/vaccineService";
import "./AdminForms.css";

function AddStock() {
  const navigate = useNavigate();

  const [vaccines, setVaccines] = useState([]);
  const [selectedVaccineId, setSelectedVaccineId] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [batchId, setBatchId] = useState("");
  const [arrivalDate, setArrivalDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  // Starts empty rather than a pre-filled figure: a default quantity is a
  // number nobody entered, and it could be submitted unchanged.
  const [quantity, setQuantity] = useState("");

  const [loadingVaccines, setLoadingVaccines] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("error");

  // Duplicate-submit guard. `saving` drives the disabled button, but it is set
  // AFTER an async validation that queries Firestore for the batch id — two
  // submits dispatched before that resolves would both pass and both write.
  // A ref flips synchronously, so only one write is ever in flight.
  const submittingRef = useRef(false);

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  useEffect(() => {
    const loadVaccines = async () => {
      try {
        setLoadingVaccines(true);
        setVaccines(await getVaccines());
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
    const quantityNumber = Number(String(quantity).trim());

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

    if (String(quantity).trim() === "" || Number.isNaN(quantityNumber)) {
      showMessage("Unit quantity is required.");
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

    if (await batchIdExists(cleanedBatchId)) {
      showMessage("This Batch ID already exists in inventory.");
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // One write at a time. Set before the await, because validateForm queries
    // Firestore and a second submit could otherwise slip through behind it.
    if (submittingRef.current) return;
    submittingRef.current = true;

    setMessage("");
    setMessageType("error");

    try {
      const isValid = await validateForm();
      if (!isValid) return;

      setSaving(true);

      const cleanedBatchId = batchId.trim().toUpperCase();
      const cleanedManufacturer = manufacturer.trim();
      const status = getBatchStatus(expiryDate);

      // Identity: `selectedVaccine.id` is the Firestore DOCUMENT id, kept
      // distinct from internalSku (the business SKU) and from the batch id.
      // No storage temperature is written — none was collected.
      await addStockBatch({
        vaccineId: selectedVaccine.id,
        vaccineName: selectedVaccine.vaccineName,
        vaccineType: selectedVaccine.vaccineType,
        manufacturer: cleanedManufacturer,
        internalSku: selectedVaccine.internalSku,
        batchId: cleanedBatchId,
        arrivalDate,
        expiryDate,
        quantity: Number(String(quantity).trim()),
        status,
      });

      showMessage("Stock added successfully.", "success");

      setTimeout(() => {
        navigate("/admin/inventory");
      }, 700);
    } catch (error) {
      console.error("Add stock error:", error);
      showMessage("Failed to add stock. Please try again.");
    } finally {
      submittingRef.current = false;
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
          {/* The decorative two-step strip at the top of this form is gone. It
              was not a real stepper — both entries were inert spans on a
              single-page form — and its second entry merely restated the
              batch/logistics section below. The real section headings are
              unchanged. */}
          <section className="form-section-card">
            <h2>
              <ClipboardList size={18} />
              Product Identification
            </h2>

            <div className="two-col-form">
              <div>
                <label htmlFor="stock-vaccine">Registered Vaccine</label>
                <select
                  id="stock-vaccine"
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

                {/* Empty state: stock can only be added against a registered
                    vaccine, so point the admin at the one action that unblocks
                    them. No vaccine is created automatically. */}
                {!loadingVaccines && vaccines.length === 0 && (
                  <small className="input-helper" role="status">
                    No vaccines are registered yet. Stock must be added against
                    a registered vaccine —{" "}
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => navigate("/admin/add-vaccine")}
                    >
                      Register New Vaccine
                    </button>{" "}
                    first.
                  </small>
                )}
              </div>

              <div>
                <label htmlFor="stock-manufacturer">Manufacturer</label>
                <input
                  id="stock-manufacturer"
                  placeholder="e.g. Pfizer-BioNTech"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  aria-describedby="stock-manufacturer-note"
                />
                <small id="stock-manufacturer-note" className="input-helper">
                  Filled in from the selected vaccine when it has one on record.
                </small>
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
                <label htmlFor="stock-batch-id">Batch ID</label>
                <input
                  id="stock-batch-id"
                  placeholder="BT-2026-X90"
                  value={batchId}
                  onChange={(e) => setBatchId(e.target.value.toUpperCase())}
                />
              </div>

              <div>
                <label htmlFor="stock-arrival-date">Arrival Date</label>
                <input
                  id="stock-arrival-date"
                  type="date"
                  value={arrivalDate}
                  onChange={(e) => setArrivalDate(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="stock-expiry-date">Expiry Date</label>
                <input
                  id="stock-expiry-date"
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
                <label htmlFor="stock-quantity">Unit Quantity (Doses)</label>

                <div className="number-stepper">
                  <button
                    type="button"
                    aria-label="Decrease quantity by 100"
                    onClick={() =>
                      setQuantity(Math.max(1, Number(quantity || 0) - 100))
                    }
                  >
                    −
                  </button>

                  <input
                    id="stock-quantity"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="e.g. 1000"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />

                  <button
                    type="button"
                    aria-label="Increase quantity by 100"
                    onClick={() => setQuantity(Number(quantity || 0) + 100)}
                  >
                    +
                  </button>
                </div>
              </div>

            </div>
          </section>

          {/* Announced, so a validation or write failure is not silent for
              screen-reader users. assertive because it reports the outcome of
              an action the admin just took. */}
          <div aria-live="assertive">
            {message && (
              <p
                role={messageType === "success" ? "status" : "alert"}
                className={
                  messageType === "success"
                    ? "form-response success"
                    : "form-error"
                }
              >
                {message}
              </p>
            )}
          </div>

          <div className="stock-form-footer">
            <button
              type="button"
              className="outline-btn"
              onClick={() => navigate("/admin/inventory")}
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
export default AddStock;