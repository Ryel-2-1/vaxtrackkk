import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Structural guard for the two clinic dialogs that embed the location picker.
//
// WHY A SOURCE-SHAPE TEST: this repo's suites are plain `node --test` over pure
// modules (clinicLocation, invoiceModel). There is no jsdom/RTL, and adding one
// would be a dependency change, so the dialogs cannot be rendered here. What CAN
// be pinned cheaply is the markup contract the accessibility and short-viewport
// fixes depend on — exactly the properties a careless refactor breaks silently:
//
//   * The primary action must stay `type="submit"` inside a `<form onSubmit>`,
//     because that is what makes Enter from a field run the SAME validated path
//     as clicking the button. A stray `type="button"` would leave the click
//     working while Enter silently did nothing.
//   * Cancel and the close control must stay `type="button"`. Inside a <form>,
//     a button with no explicit type defaults to `submit` — so omitting it would
//     turn Cancel into a save/registration.
//   * The action row must stay OUTSIDE `.clinics-modal-body`. The body is the
//     scrolling region; moving the actions inside it would let the primary
//     action scroll out of reach again on a short viewport, which is the exact
//     defect this guards (unreachable at a 563px-tall viewport).
//
// It asserts structure, not behaviour, and does not replace a rendered-DOM test.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "..", "src", "pages", "admin", "Clinics.jsx"),
  "utf8"
);

/** Slice one top-level `function Name(...) { ... }` out of the module source. */
function componentSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in Clinics.jsx`);
  // The next top-level declaration starts at column 0.
  const rest = source.slice(start + 1);
  const nextTop = rest.search(/\n(?:function |export default |const \w+ = \()/);
  return nextTop === -1 ? rest : rest.slice(0, nextTop);
}

// The two dialogs that host ClinicLocationSection. Both received the same
// viewport-aware structure, so both are held to the same contract.
const DIALOGS = [
  {
    name: "ManageLocationModal",
    scopeClass: "clinics-location-modal",
    submitLabel: /Save location|Saving/,
  },
  {
    name: "NewClinicModal",
    scopeClass: "clinics-register-modal",
    submitLabel: /Register Clinic|Registering/,
  },
];

for (const dialogSpec of DIALOGS) {
  const dialog = componentSource(dialogSpec.name);

  test(`${dialogSpec.name}: submits through a semantic form`, () => {
    assert.match(
      dialog,
      /<form[\s\S]*?onSubmit=\{/,
      "the dialog must be a <form> with an onSubmit handler, so Enter and the primary button share one validated path"
    );
    assert.match(
      dialog,
      /<form[\s\S]*?noValidate/,
      "noValidate keeps the app validators the single source of validation feedback"
    );
  });

  test(`${dialogSpec.name}: primary action is a submit control`, () => {
    const submit = dialog.match(/<button[^>]*?type="submit"[\s\S]*?<\/button>/);
    assert.ok(submit, "expected a type=submit button in the dialog");
    assert.match(
      submit[0],
      dialogSpec.submitLabel,
      "the submit control should be the dialog's primary action"
    );
  });

  test(`${dialogSpec.name}: cancel and close never submit the form`, () => {
    // Inside a <form>, an untyped button defaults to submit — so every
    // non-submit control needs an explicit type="button".
    const buttons = dialog.match(/<button[\s\S]*?>/g) ?? [];
    assert.ok(buttons.length >= 3, "expected close, submit and cancel controls");

    for (const button of buttons.filter((b) => !/type="submit"/.test(b))) {
      assert.match(
        button,
        /type="button"/,
        `non-submit control is missing an explicit type="button": ${button.replace(/\s+/g, " ").slice(0, 90)}`
      );
    }

    assert.match(
      dialog,
      /className="clinics-modal-close"[\s\S]*?aria-label="[^"]+"/,
      "the close control needs an accessible name"
    );
  });

  test(`${dialogSpec.name}: action row stays outside the scrolling body`, () => {
    const bodyStart = dialog.indexOf('className="clinics-modal-body"');
    const actionsStart = dialog.indexOf('className="clinics-modal-actions"');

    assert.notEqual(bodyStart, -1, "the dialog needs a scrolling body wrapper");
    assert.notEqual(actionsStart, -1, "the dialog needs an action row");
    assert.ok(
      actionsStart > bodyStart,
      "the action row must come after the body wrapper"
    );

    // The body must be closed before the actions begin — i.e. the actions are a
    // sibling of the body, not a child of it. Otherwise the primary action
    // scrolls away with the content and the defect returns.
    const between = dialog.slice(bodyStart, actionsStart);
    const opened = (between.match(/<div/g) ?? []).length;
    const closed = (between.match(/<\/div>/g) ?? []).length;
    assert.ok(
      closed >= opened,
      "the scrolling body must be closed before the action row"
    );
  });

  test(`${dialogSpec.name}: carries its own scoping class`, () => {
    // `.clinics-form-modal` is shared by both dialogs, so the viewport-height
    // rules hang off a class unique to each one.
    assert.match(
      dialog,
      new RegExp(dialogSpec.scopeClass),
      `the viewport-aware height rules are scoped to .${dialogSpec.scopeClass}`
    );
  });

  test(`${dialogSpec.name}: hosts the shared location picker`, () => {
    assert.match(
      dialog,
      /<ClinicLocationSection/,
      "this dialog is only in scope because it embeds the location picker"
    );
  });
}

test("the two dialogs use DIFFERENT scoping classes", () => {
  // Guards against a copy-paste that would couple them (or silently leave one
  // dialog unstyled while its tests still pass via the other's class).
  const manage = componentSource("ManageLocationModal");
  const register = componentSource("NewClinicModal");

  assert.ok(
    manage.includes("clinics-location-modal") &&
      !manage.includes("clinics-register-modal"),
    "ManageLocationModal should carry only its own scoping class"
  );
  assert.ok(
    register.includes("clinics-register-modal") &&
      !register.includes("clinics-location-modal"),
    "NewClinicModal should carry only its own scoping class"
  );
});

test("unrelated clinic modal is left untouched", () => {
  // ClinicDetailsModal is a read-only details panel: no form, no location
  // picker, and short enough that it never had the overflow defect. It must NOT
  // pick up the scrolling structure or either scoping class — that is what keeps
  // this change from leaking into an unrelated dialog.
  const details = componentSource("ClinicDetailsModal");

  assert.doesNotMatch(details, /<ClinicLocationSection/);
  assert.doesNotMatch(details, /clinics-modal-body/);
  assert.doesNotMatch(details, /clinics-location-modal/);
  assert.doesNotMatch(details, /clinics-register-modal/);
});

test("guard is not vacuous: the slices are distinct and non-trivial", () => {
  // If componentSource ever silently returned the whole file (or an empty
  // string), every assertion above could pass or fail for the wrong reason.
  const slices = ["ManageLocationModal", "NewClinicModal", "ClinicDetailsModal"].map(
    componentSource
  );
  for (const slice of slices) {
    assert.ok(slice.length > 200, "component slice looks too short to be real");
    assert.ok(
      slice.length < source.length,
      "component slice must be a proper subset of the module"
    );
  }
  assert.notEqual(slices[0], slices[1]);
  assert.notEqual(slices[1], slices[2]);
});

// ---------------------------------------------------------------------------
// Keyboard-dismissal safety for the registration dialog.
//
// These pin the behaviour that protects a partially typed clinic registration:
// a focus trap (required because the dialog claims aria-modal), one dismissal
// gate shared by Escape / Cancel / close, and a draft reset that happens only
// once the dismissal is actually confirmed.
// ---------------------------------------------------------------------------

/** The `Clinics` page component itself (parent of the dialogs). */
function pageSource() {
  const start = source.indexOf("function Clinics()");
  assert.notEqual(start, -1, "Clinics component not found");
  const rest = source.slice(start + 1);
  const nextTop = rest.search(/\nfunction [A-Z]/);
  return nextTop === -1 ? rest : rest.slice(0, nextTop);
}

test("NewClinicModal: traps Tab and Shift+Tab inside the dialog", () => {
  const dialog = componentSource("NewClinicModal");

  assert.match(
    dialog,
    /document\.addEventListener\("keydown", onKeyDown, true\)/,
    "the dialog needs a keydown listener to contain focus"
  );
  assert.match(
    dialog,
    /document\.removeEventListener\("keydown", onKeyDown, true\)/,
    "the listener must be torn down, otherwise reopening stacks handlers"
  );
  assert.match(dialog, /e\.key !== "Tab"/, "Tab must be handled");
  assert.match(
    dialog,
    /e\.shiftKey && document\.activeElement === first/,
    "Shift+Tab must wrap backwards from the first control to the last"
  );
  assert.match(
    dialog,
    /!e\.shiftKey && document\.activeElement === last/,
    "Tab must wrap forwards from the last control to the first"
  );
  assert.match(
    dialog,
    /!root\.contains\(document\.activeElement\)/,
    "focus that escapes the dialog must be pulled back in"
  );
});

test("NewClinicModal: moves focus into the dialog on open", () => {
  const dialog = componentSource("NewClinicModal");
  assert.match(
    dialog,
    /first\?\.focus\(\)/,
    "opening the dialog should place focus on its first control"
  );
});

test("NewClinicModal: Escape and every close control share one guarded path", () => {
  const dialog = componentSource("NewClinicModal");

  assert.match(dialog, /const requestClose = useCallback\(/);
  assert.match(dialog, /if \(saving\) return;/, "must not close mid-write");
  assert.match(
    dialog,
    /if \(isDirty\) \{[\s\S]*?setConfirmingDiscard\(true\);[\s\S]*?return;/,
    "a dirty form must ask before discarding"
  );

  assert.match(
    dialog,
    /e\.key === "Escape"[\s\S]*?requestClose\(\)/,
    "Escape must go through requestClose, not straight to onClose"
  );

  const closeBtn = dialog.match(
    /<button[^>]*className="clinics-modal-close"[\s\S]*?<\/button>/
  );
  assert.ok(closeBtn, "close control not found");
  assert.match(
    closeBtn[0],
    /onClick=\{requestClose\}/,
    "the close control must be protected by the same gate"
  );

  assert.match(
    dialog,
    /onClick=\{requestClose\}[\s\S]*?Cancel/,
    "Cancel must be protected by the same gate"
  );
});

test("NewClinicModal: dirty state covers every editable field", () => {
  const dialog = componentSource("NewClinicModal");

  // Derived from EMPTY_CLINIC rather than a hand-listed subset, so a field
  // added to the draft shape is covered automatically and defaults still read
  // as pristine.
  assert.match(
    dialog,
    /const isDirty = Object\.keys\(EMPTY_CLINIC\)\.some\(/,
    "dirty tracking must be derived from EMPTY_CLINIC, not a partial list"
  );

  const emptyBlock = source.slice(
    source.indexOf("const EMPTY_CLINIC = {"),
    source.indexOf("function Clinics()")
  );
  for (const field of [
    "name",
    "location",
    "area",
    "contact",
    "phone",
    "email",
    "deliveryNotes",
    "status",
    "latitude",
    "longitude",
    "geofenceRadiusM",
  ]) {
    assert.match(
      emptyBlock,
      new RegExp("\\b" + field + ":"),
      "EMPTY_CLINIC is missing a field, so dirty tracking would ignore it: " +
        field
    );
  }
});

test("NewClinicModal: only a confirmed discard bypasses the gate", () => {
  const dialog = componentSource("NewClinicModal");

  const discardAt = dialog.indexOf('className="clinic-loc-discard"');
  assert.notEqual(discardAt, -1, "discard confirmation block not found");
  const discard = dialog.slice(discardAt, discardAt + 1200);

  assert.match(discard, /role="alert"/, "the confirmation must be announced");
  assert.match(
    discard,
    /onClick=\{\(\) => setConfirmingDiscard\(false\)\}[\s\S]*?Keep editing/,
    "declining must dismiss the confirmation and keep the values"
  );
  assert.match(
    discard,
    /onClick=\{onClose\}[\s\S]*?Discard changes/,
    "confirming is the ONLY control that calls onClose directly"
  );

  // Pinned outside the scrolling body: this form is tall enough that a prompt
  // inside the scroll area could sit off-screen.
  const bodyAt = dialog.indexOf('className="clinics-modal-body"');
  const actionsAt = dialog.indexOf('className="clinics-modal-actions"');
  assert.ok(
    discardAt > bodyAt && discardAt < actionsAt,
    "the confirmation belongs between the scrolling body and the pinned actions"
  );
});

test("NewClinicModal: exposes dialog semantics", () => {
  const dialog = componentSource("NewClinicModal");
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(
    dialog,
    /aria-labelledby=\{headingId\}/,
    "the dialog needs a title relationship"
  );
  assert.match(
    dialog,
    /<h2 id=\{headingId\}>/,
    "the heading must carry the id the dialog points at"
  );
  assert.match(
    dialog,
    /className="clinics-modal-close"[\s\S]*?aria-label="[^"]+"/,
    "the close control needs an accessible name"
  );
});

test("Clinics page: restores focus to the opener and resets only on dismissal", () => {
  const page = pageSource();

  assert.match(
    page,
    /const newClinicTriggerRef = useRef\(null\)/,
    "the opener must be remembered so focus can be handed back"
  );
  assert.match(
    page,
    /onClick=\{\(e\) => openNewClinic\(e\.currentTarget\)\}/,
    "the Register New Clinic button must register itself as the opener"
  );
  assert.match(
    page,
    /newClinicTriggerRef\.current\.focus\(\)/,
    "dismissal must return focus to the opener"
  );

  // Reset happens in exactly one place — the shared dismissal path — so it
  // cannot fire while the discard confirmation is still open.
  const resets = source.match(/setNewClinic\(EMPTY_CLINIC\)/g) ?? [];
  assert.equal(
    resets.length,
    1,
    "the draft should be reset in exactly one place (the dismissal path)"
  );
  const closeFn = page.slice(
    page.indexOf("const closeNewClinic = useCallback("),
    page.indexOf("const handleCreateClinic")
  );
  assert.match(
    closeFn,
    /setNewClinic\(EMPTY_CLINIC\)/,
    "the single reset must live inside closeNewClinic"
  );
});

test("ManageLocationModal keyboard behaviour is unchanged", () => {
  // The registration dialog reuses this pattern; this guards against the reuse
  // accidentally rewriting the original.
  const manage = componentSource("ManageLocationModal");
  assert.match(manage, /const requestClose = useCallback\(/);
  assert.match(manage, /e\.key === "Escape"/);
  assert.match(
    manage,
    /document\.addEventListener\("keydown", onKeyDown, true\)/
  );
  assert.match(manage, /setConfirmingDiscard\(true\)/);
  assert.match(
    manage,
    /Discard the unsaved location changes\?/,
    "the location dialog keeps its own confirmation copy"
  );
});

test("ClinicDetailsModal gains no dialog machinery", () => {
  const details = componentSource("ClinicDetailsModal");
  assert.doesNotMatch(details, /requestClose/);
  assert.doesNotMatch(details, /addEventListener/);
  assert.doesNotMatch(details, /confirmingDiscard/);
  assert.doesNotMatch(details, /aria-modal/);
});
