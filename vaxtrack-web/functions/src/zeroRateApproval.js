"use strict";

/** Match only the batch identities and vial counts that Admin reviewed. */
function approvedCartMatches(approvedItems, orderItems) {
  if (!Array.isArray(approvedItems) || !Array.isArray(orderItems) || approvedItems.length !== orderItems.length) return false;
  const normalized = (lines) => JSON.stringify(lines.map((line) => [line.inventoryId, line.quantity])
    .sort(([a], [b]) => String(a).localeCompare(String(b))));
  return normalized(approvedItems) === normalized(orderItems);
}

module.exports = { approvedCartMatches };
