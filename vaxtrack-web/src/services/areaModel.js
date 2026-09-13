export const MIN_AREA_NAME_LENGTH = 2;
export const MAX_AREA_NAME_LENGTH = 80;

/**
 * Canonical comparison form for an area name.
 *
 * NFKC folds visually-equivalent Unicode forms, whitespace is collapsed, and
 * case is ignored. The display name is kept separately so the UI never has to
 * show this normalized value.
 */
export function normalizeAreaName(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** A deterministic Firestore document id for one normalized area name. */
export function areaDocumentId(nameNormalized) {
  return encodeURIComponent(nameNormalized);
}

/**
 * Validate and canonicalize an operator-entered area name.
 *
 * The deterministic key makes case/spacing variants target the same document,
 * so two concurrent admins cannot create duplicate areas.
 */
export function validateAreaName(value) {
  const displayName =
    typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
      : "";
  const nameNormalized = normalizeAreaName(displayName);

  if (displayName.length < MIN_AREA_NAME_LENGTH) {
    return {
      ok: false,
      error: `Area name must be at least ${MIN_AREA_NAME_LENGTH} characters.`,
    };
  }
  if (displayName.length > MAX_AREA_NAME_LENGTH) {
    return {
      ok: false,
      error: `Area name must be ${MAX_AREA_NAME_LENGTH} characters or fewer.`,
    };
  }
  if (!/[\p{L}\p{N}]/u.test(displayName)) {
    return {
      ok: false,
      error: "Area name must contain at least one letter or number.",
    };
  }

  try {
    return {
      ok: true,
      value: {
        name: displayName,
        nameNormalized,
        key: areaDocumentId(nameNormalized),
      },
    };
  } catch {
    return { ok: false, error: "Area name contains an unsupported character." };
  }
}
