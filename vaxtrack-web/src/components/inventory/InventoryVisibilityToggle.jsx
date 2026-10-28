import { useId } from "react";
import "./InventoryVisibilityToggle.css";

export default function InventoryVisibilityToggle({ checked, onChange, count }) {
  const descriptionId = useId();
  return (
    <div className="inventory-visibility-control">
      <label className="inventory-visibility-toggle">
        <input type="checkbox" checked={checked} aria-describedby={descriptionId}
          onChange={(event) => onChange(event.target.checked)} />
        <span>Show inactive inventory ({count} product{count === 1 ? "" : "s"})</span>
      </label>
      <p id={descriptionId}>Products confirmed empty for more than three months are hidden by default. New stock makes them appear again.</p>
    </div>
  );
}
