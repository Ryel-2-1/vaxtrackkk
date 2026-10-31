import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import DialogLayer from "../ui/DialogLayer";
import { useDialogFocus } from "../ui/useDialogFocus";
import "./catalogFilterDialog.css";

// How long the type search waits after the last keystroke before filtering.
const TYPE_SEARCH_DEBOUNCE_MS = 150;

function FilterDialogContent({ title, types, selectedTypes, status, statusOptions, expiry, expiryOptions, onApply, onClose }) {
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState({ types: selectedTypes, status, expiry });
  useDialogFocus({ dialogRef, onDismiss: onClose });

  // Type search: narrows the checkbox list as the rep types (debounced, so a
  // long list is not re-filtered on every keystroke). It only hides options —
  // a ticked type stays ticked while hidden, and Apply sends every tick.
  const [typeQuery, setTypeQuery] = useState("");
  const [shownQuery, setShownQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setShownQuery(typeQuery), TYPE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typeQuery]);
  const needle = shownQuery.trim().toLowerCase();
  const visibleTypes = needle ? types.filter((type) => type.toLowerCase().includes(needle)) : types;

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
          {types.length > 0 && (
            <label className="catalog-filter-type-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={typeQuery}
                onChange={(event) => setTypeQuery(event.target.value)}
                placeholder="Search vaccine type..."
                aria-label="Search vaccine types"
              />
            </label>
          )}
          {types.length === 0 ? <p>No vaccine types available.</p> : visibleTypes.length === 0 ? (
            <p className="catalog-filter-type-none" role="status">No vaccine type matches &ldquo;{shownQuery.trim()}&rdquo;.</p>
          ) : (
            <div className="catalog-filter-type-list">
              {visibleTypes.map((type) => (
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
          <button type="button" onClick={() => { setDraft({ types: [], status: statusOptions?.[0]?.value ?? "all", expiry: expiryOptions?.[0]?.value ?? "all" }); setTypeQuery(""); setShownQuery(""); }}>Clear filters</button>
          <button type="button" className="catalog-filter-apply" onClick={() => onApply(draft)}>Apply filters</button>
        </footer>
      </section>
    </div>
  );
}

/**
 * [scope] is the role shell's class list the portaled dialog re-applies
 * (DialogLayer). Med Rep pages use the default; Admin Inventory passes its
 * own shell classes, so each role keeps its own scoped styles.
 */
export default function CatalogFilterDialog({ scope = "salesrep-page salesrep-main", ...props }) {
  return <DialogLayer scope={scope}><FilterDialogContent {...props} /></DialogLayer>;
}
