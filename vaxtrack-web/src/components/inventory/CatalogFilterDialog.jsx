import { useRef, useState } from "react";
import { X } from "lucide-react";
import DialogLayer from "../ui/DialogLayer";
import { useDialogFocus } from "../ui/useDialogFocus";
import "./catalogFilterDialog.css";

function FilterDialogContent({ title, types, selectedTypes, status, statusOptions, expiry, expiryOptions, onApply, onClose }) {
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState({ types: selectedTypes, status, expiry });
  useDialogFocus({ dialogRef, onDismiss: onClose });

  const toggleType = (type) => setDraft((current) => ({
    ...current,
    types: current.types.includes(type)
      ? current.types.filter((item) => item !== type)
      : [...current.types, type],
  }));

  return (
    <div className="catalog-filter-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="catalog-filter-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-filter-title" tabIndex={-1}>
        <header className="catalog-filter-head">
          <div>
            <h2 id="catalog-filter-title">{title}</h2>
            <p>Choose filters, then apply them to the list.</p>
          </div>
          <button type="button" className="catalog-filter-close" aria-label="Close filters" onClick={onClose}><X size={18} /></button>
        </header>
        {statusOptions?.length > 0 && (
          <label className="catalog-filter-field">Status
            <select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}>
              {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
        {expiryOptions?.length > 0 && (
          <label className="catalog-filter-field">Expiry
            <select value={draft.expiry} onChange={(event) => setDraft((current) => ({ ...current, expiry: event.target.value }))}>
              {expiryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}
        <fieldset className="catalog-filter-types">
          <legend>Vaccine types <span>(select any number)</span></legend>
          {types.length === 0 ? <p>No vaccine types available.</p> : (
            <div className="catalog-filter-type-list">
              {types.map((type) => (
                <label key={type} className={draft.types.includes(type) ? "is-selected" : ""}>
                  <input type="checkbox" checked={draft.types.includes(type)} onChange={() => toggleType(type)} />
                  {type}
                </label>
              ))}
            </div>
          )}
          <small>No selection shows every type.</small>
        </fieldset>
        <footer className="catalog-filter-actions">
          <button type="button" onClick={() => setDraft({ types: [], status: statusOptions?.[0]?.value ?? "all", expiry: expiryOptions?.[0]?.value ?? "all" })}>Clear filters</button>
          <button type="button" className="catalog-filter-apply" onClick={() => onApply(draft)}>Apply filters</button>
        </footer>
      </section>
    </div>
  );
}

export default function CatalogFilterDialog(props) {
  return <DialogLayer scope="salesrep-page salesrep-main"><FilterDialogContent {...props} /></DialogLayer>;
}
