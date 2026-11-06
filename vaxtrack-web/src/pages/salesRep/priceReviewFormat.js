import { formatCentavos } from "../../services/money";

/** A zero-valued order line is a real amount, not a missing price. */
export function formatAmount(centavos) {
  return centavos === 0 ? "₱0.00" : formatCentavos(centavos);
}
