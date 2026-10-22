/**
 * The Admin shell's wrapper class per route (used by AdminShell, and by
 * AdminDialogLayer to re-apply the same page scope on portaled dialogs).
 *
 * The wrapper class is chosen per route so the existing shell CSS still applies
 * unchanged: `.adl-root` for the AdminLayout pages, `.clinics-shell` (+ page
 * modifiers) for the clinic screens, plain `.inventory-page` otherwise.
 */
const WRAPPER_CLASS = {
  "/admin": "inventory-page adl-root",
  "/admin/inventory": "inventory-page adl-root",
  "/admin/allocation": "inventory-page adl-root",
  "/admin/order-history": "inventory-page adl-root",
  "/admin/analytics": "inventory-page adl-root",
  "/admin/ai-inventory-analytics": "inventory-page adl-root",
  "/admin/delivery-calendar": "inventory-page adl-root",
  "/admin/live-tracking": "inventory-page adl-root",
  "/admin/clinics": "inventory-page clinics-shell",
};

export function adminWrapperClassFor(pathname) {
  return WRAPPER_CLASS[pathname] || "inventory-page";
}
