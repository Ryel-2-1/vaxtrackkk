// Admin Clinics: List / Grid presentation — pure, no Firebase, no DOM.
//
// Both views render ONE collection: the live clinics, filtered by the same
// search and status, in the same order (newest first, as the subscription
// delivers them), sliced to the same page. Only the markup differs, so the two
// views can never disagree about which clinics are shown.
//
// The chosen view is a per-browser UI preference: a versioned, namespaced
// localStorage key, read and written defensively. It never reaches Firestore.

export const CLINIC_VIEWS = Object.freeze(["list", "grid"]);
export const DEFAULT_CLINIC_VIEW = "list";
export const CLINIC_VIEW_STORAGE_KEY = "vaxtrack.admin.clinics.view.v1";
export const CLINICS_PAGE_SIZE = 10;

/** Placeholder for a value the clinic record does not have. Never invented. */
export const MISSING = "—";

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some browsers throw on access (blocked storage, sandboxed frames).
    return null;
  }
}

/**
 * The saved view, or the default when storage is unavailable, empty, throws,
 * or holds anything that is not exactly a known view.
 */
export function readClinicView(storage = browserStorage()) {
  try {
    const stored = storage?.getItem?.(CLINIC_VIEW_STORAGE_KEY);
    return CLINIC_VIEWS.includes(stored) ? stored : DEFAULT_CLINIC_VIEW;
  } catch {
    return DEFAULT_CLINIC_VIEW;
  }
}

/** Remember the view. Returns false (and changes nothing) when it cannot. */
export function writeClinicView(view, storage = browserStorage()) {
  if (!CLINIC_VIEWS.includes(view)) return false;
  try {
    if (!storage?.setItem) return false;
    storage.setItem(CLINIC_VIEW_STORAGE_KEY, view);
    return true;
  } catch {
    // Private mode / quota: the choice simply is not remembered.
    return false;
  }
}

/** The polite screen-reader announcement after the Admin changes the view. */
export function clinicViewAnnouncement(view) {
  return view === "grid" ? "Showing clinics as a grid." : "Showing clinics as a list.";
}

/**
 * The clinics both views show, before paging: the same search over the same
 * fields, the same status filter, the subscription's own order kept.
 */
export function selectVisibleClinics(clinics, { searchTerm = "", statusFilter = "all" } = {}) {
  const needle = String(searchTerm).toLowerCase();
  return (Array.isArray(clinics) ? clinics : []).filter((clinic) => {
    const haystack =
      `${clinic.name} ${clinic.id} ${clinic.location} ${clinic.contact} ${clinic.phone} ${clinic.note} ${clinic.statusLabel}`.toLowerCase();
    return haystack.includes(needle) && (statusFilter === "all" || clinic.status === statusFilter);
  });
}

/**
 * One page of `list`. The requested page is clamped, so a live removal that
 * shortens the list never leaves the Admin on an empty page past the end.
 */
export function paginateClinics(list, requestedPage, pageSize = CLINICS_PAGE_SIZE) {
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  return {
    page,
    totalPages,
    items: list.slice(start, start + pageSize),
    startItem: total === 0 ? 0 : start + 1,
    endItem: Math.min(start + pageSize, total),
    total,
  };
}

const present = (value) => (typeof value === "string" && value.trim() !== "" && value !== MISSING ? value : MISSING);

/**
 * What a grid card shows — only what the clinic record actually holds, the
 * same values the list shows. A missing value reads "—".
 */
export function clinicCardFields(clinic) {
  return {
    name: present(clinic?.name),
    clinicId: present(clinic?.id),
    contact: present(clinic?.contact),
    phone: present(clinic?.phone),
    email: present(clinic?.email),
    location: present(clinic?.location),
    area: present(clinic?.area),
    lastDelivery: present(clinic?.lastDelivery),
    statusLabel: present(clinic?.statusLabel),
    note: present(clinic?.note),
    locationVerified: clinic?.locationInfo?.hasCoordinates === true,
  };
}
