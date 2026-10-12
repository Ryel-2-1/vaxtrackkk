import { useEffect, useRef, useState } from "react";
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
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import "./AdminForms.css";

// Each validated field's input id, and the id of the one field message shown
// at a time (validation stops at the first problem, top to bottom).
const VACCINE_FIELD_IDS = {
  vaccineName: "vaccine-name",
  manufacturer: "vaccine-manufacturer",
  vaccineType: "vaccine-type",
  newType: "new-vaccine-type",
  internalSku: "vaccine-sku",
  vatClassification: `vaccine-vat-${PRODUCT_VAT_CLASSIFICATIONS[0]}`,
};
const VACCINE_FIELD_ERROR_ID = "vaccine-field-error";

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

  // One write at a time: a ref flips synchronously, before the async SKU
  // check, so a double-click cannot register the vaccine twice.
  const submittingRef = useRef(false);
  // The last load-failure message shown, so recovery clears only that one.
  const loadMessageRef = useRef("");

  // The field a validation message belongs to — shown beside it, tied with
  // aria-describedby, marked aria-invalid and focused. Values are kept.
  const [fieldError, setFieldError] = useState(null); // { field, text } | null
  const failField = (field, text) => {
    setFieldError({ field, text });
    showMessage(field === "newType" ? text : "Check the highlighted field. Nothing was saved.");
    const el = document.getElementById(VACCINE_FIELD_IDS[field]);
    el?.focus();
    el?.scrollIntoView?.({ block: "center" });
    return false;
  };
  const a11y = (field, hint) => {
    const invalid = fieldError?.field === field;
    const describedBy = [invalid ? VACCINE_FIELD_ERROR_ID : null, hint].filter(Boolean).join(" ");
    return { "aria-invalid": invalid ? "true" : undefined, "aria-describedby": describedBy || undefined };
  };
  const fieldMessage = (field) =>
    fieldError?.field === field ? (
      <small id={VACCINE_FIELD_ERROR_ID} className="form-field-error">
        {fieldError.text}
      </small>
    ) : null;
  const clearFieldErrorFor = (event) => {
    if (!fieldError) return;
    const id = event.target?.id || "";
    const flagged = VACCINE_FIELD_IDS[fieldError.field];
    if (id === flagged || (fieldError.field === "vatClassification" && event.target?.name === "vat-classification")) {
      setFieldError(null);
    }
  };

  // Vaccine types are LIVE: the dropdown and the duplicate-type check follow
  // the collection, so a type added here or in another browser appears without
  // a reload. (The list used to be read once on open and re-read after each
  // add.) State is set only in the listener's callbacks, and the listener is
  // closed on unmount.
  useEffect(
    () =>
      subscribeVaccineTypes(
        (types) => {
          setVaccineTypes(types);
          // A recovered listener clears ITS message — never a validation
          // message the admin is reading.
          setMessage((prev) => (prev && prev === loadMessageRef.current ? "" : prev));
        },
        (error) => {
          setMessage(liveErrorMessage(error, "vaccine types"));
          loadMessageRef.current = liveErrorMessage(error, "vaccine types");
          setMessageType("error");
        }
      ),
    []
  );

  const validateForm = async () => {
    const skuRegex = /^VXT-\d{3}-[A-Z0-9]{5}$/;

    if (!vaccineName.trim()) {
      return failField("vaccineName", "Vaccine name is required.");
    }

    if (vaccineName.trim().length < 3) {
      return failField("vaccineName", "Vaccine name must be at least 3 characters.");
    }

    if (!manufacturer.trim()) {
      return failField("manufacturer", "Manufacturer or pharma company is required.");
    }

    if (manufacturer.trim().length < 2) {
      return failField("manufacturer", "Manufacturer name is too short.");
    }

    if (!vaccineType.trim()) {
      return failField("vaccineType", "Please select a vaccine type.");
    }

    if (!internalSku.trim()) {
      return failField("internalSku", "Internal inventory SKU is required.");
    }

    if (!skuRegex.test(internalSku.trim().toUpperCase())) {
      return failField("internalSku", "SKU format must be like VXT-992-ABCDE.");
    }

    if (!PRODUCT_VAT_CLASSIFICATIONS.includes(vatClassification)) {
      return failField("vatClassification", "Select VAT, VAT Exempt or Zero-Rated for this vaccine.");
    }

    if (await skuExists(internalSku.trim().toUpperCase())) {
      return failField("internalSku", "This internal inventory SKU already exists.");
    }

    return true;
  };

  const handleAddType = async () => {
    setMessage("");

    const typeName = newTypeName.trim();

    if (!typeName) {
      failField("newType", "Vaccine type name is required.");
      return;
    }

    if (typeName.length < 3) {
      failField("newType", "Vaccine type name must be at least 3 characters.");
      return;
    }

    const alreadyExists = vaccineTypes.some(
      (type) => type.name.toLowerCase() === typeName.toLowerCase()
    );

    if (alreadyExists) {
      failField("newType", "This vaccine type already exists.");
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
      logSafeError("Add vaccine type", error);
      showMessage(friendlyErrorMessage(error, "The vaccine type could not be added. Please try again."));
    } finally {
      setTypeSaving(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setMessage("");
    setMessageType("error");
    setFieldError(null);

    let isValid = false;
    try {
      isValid = await validateForm();
    } catch (error) {
      logSafeError("Validate vaccine", error);
      showMessage(friendlyErrorMessage(error, "The SKU could not be checked. Nothing was saved — please try again."));
    }
    if (!isValid) {
      submittingRef.current = false;
      return;
    }

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
      logSafeError("Register vaccine", error);
      showMessage(
        friendlyErrorMessage(
          error,
          "The vaccine could not be registered. Nothing was saved — your entries are still here; please try again."
        )
      );
    } finally {
      submittingRef.current = false;
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

        <form className="vaccine-form-card" onSubmit={handleSubmit} onInput={clearFieldErrorFor} onChange={clearFieldErrorFor} noValidate>
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
            {...a11y("vaccineName")}
          />
          {fieldMessage("vaccineName")}

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
                  {...a11y("manufacturer")}
                />
              </div>
              {fieldMessage("manufacturer")}
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
                  {...a11y("vaccineType")}
                >
                  <option value="">Select Type</option>

                  {vaccineTypes.map((type) => (
                    <option key={type.id} value={type.name}>
                      {type.name}
                    </option>
                  ))}
                </select>
              </div>
              {fieldMessage("vaccineType")}
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
                  {...a11y("newType", "add-vaccine-type-help")}
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
              {fieldMessage("newType")}
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
              {...a11y("internalSku", "vaccine-sku-help")}
            />
          </div>
          {fieldMessage("internalSku")}

          <small id="vaccine-sku-help" className="input-helper">
            Format: VXT-123-ABCDE. This is used as the internal inventory
            identifier.
          </small>

          <fieldset className="vat-choice" {...a11y("vatClassification")}>
            <legend>VAT Classification</legend>
            <div className="vat-choice-options">
              {PRODUCT_VAT_CLASSIFICATIONS.map((value) => (
                <label key={value} className={vatClassification === value ? "selected" : ""}>
                  <input
                    id={`vaccine-vat-${value}`}
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
            {fieldMessage("vatClassification")}
          </fieldset>

          <div aria-live="assertive">
            {message && (
              <p className={`form-response ${messageType}`} role={messageType === "success" ? "status" : "alert"}>
                {message}
              </p>
            )}
          </div>
        </form>
      </main>
  );
}

export default AddVaccine;