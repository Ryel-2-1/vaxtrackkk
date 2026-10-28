import { orderArrivalNote } from "../../services/requestedArrival.js";
import "./RequestedArrivalNote.css";

/** Compact, wrapping text: adds no table column or status/ETA implication. */
export default function RequestedArrivalNote({ order }) {
  return (
    <small
      className="requested-arrival-note"
      title="Requested arrival at the destination, in Philippine time. A planning request, not a guaranteed ETA."
    >
      {orderArrivalNote(order)}
    </small>
  );
}
