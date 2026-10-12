// Field-level validation, presented accessibly.
//
// A form validates on submit (never before the user has tried), shows each
// problem beside its own field, ties the message to the input with
// aria-describedby, marks the input aria-invalid, and moves focus to the
// first invalid field. Values are never cleared by a failed attempt.
//
// Pure — no DOM here except the optional focus helper, which takes a lookup.

/** The id of a field's error message element. */
export function errorIdFor(formId, field) {
  return `${formId}-${field}-error`;
}

/**
 * The ARIA attributes for one input. `hint` is the id of any help text that
 * should stay associated alongside the error.
 */
export function fieldA11y(formId, field, errors, { hint } = {}) {
  const hasError = Boolean(errors && errors[field]);
  const describedBy = [hasError ? errorIdFor(formId, field) : null, hint || null].filter(Boolean).join(" ");
  return {
    "aria-invalid": hasError ? "true" : undefined,
    "aria-describedby": describedBy || undefined,
  };
}

/** The first field, in on-screen order, that has an error — or null. */
export function firstInvalidField(order, errors) {
  if (!errors) return null;
  for (const field of order) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * Focus (and scroll to) the first invalid field. `lookup(field)` returns its
 * element — typically `(f) => document.getElementById(ids[f])`. Returns the
 * field focused, or null.
 */
export function focusFirstInvalid(order, errors, lookup) {
  const field = firstInvalidField(order, errors);
  if (!field) return null;
  const el = lookup(field);
  if (el && typeof el.focus === "function") {
    el.focus();
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  }
  return field;
}

/** True when an errors object holds at least one message. */
export function hasErrors(errors) {
  return Boolean(errors) && Object.values(errors).some(Boolean);
}
