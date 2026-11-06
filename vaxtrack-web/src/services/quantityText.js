/**
 * "1 vial", "2 vials", "1,560 vials". A stored unit other than vials is kept
 * as it is; the singular only ever applies to the word vials.
 */
export function quantityText(quantity, unit = "vials") {
  const n = Number(quantity) || 0;
  const name = unit || "vials";
  const word = /^vials?$/i.test(name) ? (n === 1 ? "vial" : "vials") : name;
  return `${n.toLocaleString()} ${word}`;
}
