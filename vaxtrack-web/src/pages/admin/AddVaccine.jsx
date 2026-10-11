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
import {
  subscribeVaccineTypes,
  addVaccineType,
  skuExists,
  addVaccine,
} from "../../services/vaccineService";
import { PRODUCT_VAT_CLASSIFICATIONS, PRODUCT_VAT_LABELS } from "../../services/vatClassification";
import { liveErrorMessage } from "../../services/liveDataErrors";
import "./AdminForms.css";

function AddVaccine() {
  const navigate = useNavigate();

  const [vaccineName, setVaccineName] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [vaccineType, setVaccineType] = useState("");
  const [internalSku, setInternalSku] = useState("");
  // No default: the Admin must choose. "" means not yet chosen.
  const [vatClassification, setVatClassification] = useState("");

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

  // Vaccine types are LIVE: the dropdown and the duplicate-type check follow
  // the collection, so a type added here or in another browser appears without
  // a reload. (The list used to be read once on open and re-read after each
  // add.) State is set only in the listener's callbacks, and the listener is
  // closed on unmount.
  useEffect(
    () =>
      subscribeVaccineTypes(
        (types) => setVaccineTypes(types),
        (error) => {
          setMessage(liveErrorMessage(error, "vaccine types"));
          setMessageType("error");
        }
      ),
    []
  );

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

    if (!PRODUCT_VAT_CLASSIFICATIONS.includes(vatClassification)) {
      showMessage("Select VAT, VAT Exempt or Zero-Rated for this vaccine.");
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
      // No re-read: the live list already holds the new type (the listener
      // sees this write as soon as it is made).
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
        vatClassification,
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
    <main className="inventory-main">
        <header className="form-page-header">
          <div>
            <p>
              Inventory / <span>Register New Vaccine</span>
            </p>
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

          <label htmlFor="vaccine-name">Vaccine Name</label>
          <input
            id="vaccine-name"
            placeholder="e.g. Comirnaty BNT162b2"
            value={vaccineName}
            onChange={(e) => setVaccineName(e.target.value)}
          />

          <div className="two-col-form">
            <div>
              <label htmlFor="vaccine-manufacturer">
                Manufacturer / Pharma Company
              </label>
              <div className="field-with-icon">
                <Building2 size={16} />
                <input
                  id="vaccine-manufacturer"
                  placeholder="e.g. Pfizer-BioNTech"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                />
              </div>
            </div>

            <div>
              <div className="label-with-action">
                <label htmlFor="vaccine-type">Vaccine Type</label>
                <button
                  type="button"
                  className="mini-link-btn"
                  onClick={() => setShowAddType(true)}
                  aria-expanded={showAddType}
                  aria-controls="add-vaccine-type-panel"
                >
                  <Plus size={12} />
                  Add Type
                </button>
              </div>

              <div className="field-with-icon">
                <FlaskConical size={16} />
                <select
                  id="vaccine-type"
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
            <div className="add-type-box" id="add-vaccine-type-panel">
              <div className="add-type-header">
                <div className="add-type-heading">
                  <h3>Add Vaccine Type</h3>
                  <p id="add-vaccine-type-help">
                    Create a reusable option for the Vaccine Type list.
                  </p>
                </div>
                <button type="button" onClick={() => setShowAddType(false)} aria-label="Cancel new vaccine type">
                  <X size={16} />
                </button>
              </div>

              <div className="add-type-row">
                {/* The field had only a placeholder, which is not an
                    accessible name — it disappears on input and is not
                    reliably announced. The label is visually hidden rather
                    than shown so the compact two-control row is unchanged;
                    the panel's own helper text describes it. */}
                <label htmlFor="new-vaccine-type" className="admin-sr-only">
                  New vaccine type
                </label>
                <input
                  id="new-vaccine-type"
                  aria-describedby="add-vaccine-type-help"
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

          <label htmlFor="vaccine-sku">Internal Inventory SKU</label>
          <div className="field-with-icon">
            <Package size={16} />
            <input
              id="vaccine-sku"
              placeholder="VXT-992-XXXXX"
              value={internalSku}
              onChange={(e) => setInternalSku(e.target.value.toUpperCase())}
            />
          </div>

          <small className="input-helper">
            Format: VXT-123-ABCDE. This is used as the internal inventory
            identifier.
          </small>

          <fieldset className="vat-choice">
            <legend>VAT Classification</legend>
            <div className="vat-choice-options">
              {PRODUCT_VAT_CLASSIFICATIONS.map((value) => (
                <label key={value} className={vatClassification === value ? "selected" : ""}>
                  <input
                    type="radio"
                    name="vat-classification"
                    value={value}
                    checked={vatClassification === value}
                    onChange={() => setVatClassification(value)}
                    required
                  />
                  {PRODUCT_VAT_LABELS[value]}
                </label>
              ))}
            </div>
            <small className="input-helper">
              Becomes the VAT status of every future order item for this
              vaccine. Existing orders and issued invoices are not changed.
            </small>
          </fieldset>

          {message && (
            <p className={`form-response ${messageType}`}>{message}</p>
          )}
        </form>
      </main>
  );
}

export default AddVaccine;