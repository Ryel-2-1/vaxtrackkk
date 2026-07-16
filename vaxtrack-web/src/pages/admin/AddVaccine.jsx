import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  FlaskConical,
  Package,
  Plus,
  Syringe,
  X,
} from "lucide-react";
import { AdminSidebar } from "./Inventory";
import {
  getVaccineTypes,
  addVaccineType,
  skuExists,
  addVaccine,
} from "../../services/vaccineService";
import "./AdminForms.css";

function AddVaccine() {
  const navigate = useNavigate();

  const [vaccineName, setVaccineName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [vaccineType, setVaccineType] = useState("");
  const [internalSku, setInternalSku] = useState("");

  const [vaccineTypes, setVaccineTypes] = useState([]);
  const [newTypeName, setNewTypeName] = useState("");
  const [showAddType, setShowAddType] = useState(false);

  const [saving, setSaving] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("error");

  const showMessage = (text, type = "error") => {
    setMessage(text);
    setMessageType(type);
  };

  const loadVaccineTypes = async () => {
    try {
      setVaccineTypes(await getVaccineTypes());
    } catch (error) {
      console.error("Load vaccine types error:", error);
      showMessage("Unable to load vaccine types.");
    }
  };

  useEffect(() => {
    loadVaccineTypes();
  }, []);

  const validateForm = async () => {
    const skuRegex = /^VXT-\d{3}-[A-Z0-9]{5}$/;

    if (!vaccineName.trim()) {
      showMessage("Vaccine name is required.");
      return false;
    }

    if (vaccineName.trim().length < 3) {
      showMessage("Vaccine name must be at least 3 characters.");
      return false;
    }

    if (!manufacturer.trim()) {
      showMessage("Manufacturer or pharma company is required.");
      return false;
    }

    if (manufacturer.trim().length < 2) {
      showMessage("Manufacturer name is too short.");
      return false;
    }

    if (!vaccineType.trim()) {
      showMessage("Please select a vaccine type.");
      return false;
    }

    if (!internalSku.trim()) {
      showMessage("Internal inventory SKU is required.");
      return false;
    }

    if (!skuRegex.test(internalSku.trim().toUpperCase())) {
      showMessage("SKU format must be like VXT-992-ABCDE.");
      return false;
    }

    if (await skuExists(internalSku.trim().toUpperCase())) {
      showMessage("This internal inventory SKU already exists.");
      return false;
    }

    return true;
  };

  const handleAddType = async () => {
    setMessage("");

    const typeName = newTypeName.trim();

    if (!typeName) {
      showMessage("Vaccine type name is required.");
      return;
    }

    if (typeName.length < 3) {
      showMessage("Vaccine type name must be at least 3 characters.");
      return;
    }

    const alreadyExists = vaccineTypes.some(
      (type) => type.name.toLowerCase() === typeName.toLowerCase()
    );

    if (alreadyExists) {
      showMessage("This vaccine type already exists.");
      return;
    }

    setTypeSaving(true);

    try {
      await addVaccineType(typeName);
      setNewTypeName("");
      setShowAddType(false);
      showMessage("Vaccine type added successfully.", "success");
      await loadVaccineTypes();
      setVaccineType(typeName);
    } catch (error) {
      console.error("Add vaccine type error:", error);
      showMessage("Failed to add vaccine type.");
    } finally {
      setTypeSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");
    setMessageType("error");

    const isValid = await validateForm();
    if (!isValid) return;

    setSaving(true);

    try {
      await addVaccine({
        vaccineName: vaccineName.trim(),
        manufacturer: manufacturer.trim(),
        vaccineType,
        internalSku: internalSku.trim().toUpperCase(),
      });

      showMessage("Vaccine registered successfully.", "success");

      setTimeout(() => {
        navigate("/admin/inventory");
      }, 800);
    } catch (error) {
      console.error(error);
      showMessage("Failed to register vaccine.");
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
              Inventory / <span>Register New Vaccine</span>
            </p>
            <h1>Register New Vaccine</h1>
            <small>
              Onboard new pharmaceutical assets into the national tracking
              system.
            </small>
          </div>

          <div className="form-header-actions">
            <button
              type="button"
              className="outline-btn"
              onClick={() => navigate("/admin/inventory")}
            >
              Cancel
            </button>

            <button
              type="button"
              className="blue-btn"
              onClick={handleSubmit}
              disabled={saving}
            >
              {saving ? "Saving..." : "Register Vaccine"}
            </button>
          </div>
        </header>

        <form className="vaccine-form-card" onSubmit={handleSubmit}>
          <h2>
            <span>
              <Syringe size={18} />
            </span>
            Basic Information
          </h2>

          <label>Vaccine Name</label>
          <input
            placeholder="e.g. Comirnaty BNT162b2"
            value={vaccineName}
            onChange={(e) => setVaccineName(e.target.value)}
          />

          <div className="two-col-form">
            <div>
              <label>Manufacturer / Pharma Company</label>
              <div className="field-with-icon">
                <Building2 size={16} />
                <input
                  placeholder="e.g. Pfizer-BioNTech"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                />
              </div>
            </div>

            <div>
              <div className="label-with-action">
                <label>Vaccine Type</label>
                <button
                  type="button"
                  className="mini-link-btn"
                  onClick={() => setShowAddType(true)}
                >
                  <Plus size={13} />
                  Add Type
                </button>
              </div>

              <div className="field-with-icon">
                <FlaskConical size={16} />
                <select
                  value={vaccineType}
                  onChange={(e) => setVaccineType(e.target.value)}
                >
                  <option value="">Select Type</option>

                  {vaccineTypes.map((type) => (
                    <option key={type.id} value={type.name}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {showAddType && (
            <div className="add-type-box">
              <div className="add-type-header">
                <h3>Add Vaccine Type</h3>
                <button type="button" onClick={() => setShowAddType(false)}>
                  <X size={16} />
                </button>
              </div>

              <div className="add-type-row">
                <input
                  placeholder="e.g. mRNA, Inactivated, Viral Vector"
                  value={newTypeName}
                  onChange={(e) => setNewTypeName(e.target.value)}
                />

                <button
                  type="button"
                  className="blue-btn"
                  onClick={handleAddType}
                  disabled={typeSaving}
                >
                  {typeSaving ? "Adding..." : "Add"}
                </button>
              </div>
            </div>
          )}

          <label>Internal Inventory SKU</label>
          <div className="field-with-icon">
            <Package size={16} />
            <input
              placeholder="VXT-992-XXXXX"
              value={internalSku}
              onChange={(e) => setInternalSku(e.target.value.toUpperCase())}
            />
          </div>

          <small className="input-helper">
            Format: VXT-123-ABCDE. This is used as the internal inventory
            identifier.
          </small>

          {message && (
            <p className={`form-response ${messageType}`}>{message}</p>
          )}
        </form>
      </main>
    </div>
  );
}

export default AddVaccine;