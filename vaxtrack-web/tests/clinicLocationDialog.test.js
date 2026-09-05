import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Structural guard for the Manage-location dialog.
//
// WHY A SOURCE-SHAPE TEST: this repo's suites are plain `node --test` over pure
// modules (clinicLocation, invoiceModel). There is no jsdom/RTL, and adding one
// would be a dependency change, so the dialog cannot be rendered here. What CAN
// be pinned cheaply is the markup contract that the accessibility and
// short-viewport fixes depend on. These are exactly the properties that a
// careless refactor silently breaks:
//
//   * Save must stay `type="submit"` inside a `<form onSubmit>`, because that is
//     what makes Enter from latitude/longitude/radius run the SAME validated
//     path as clicking Save. A stray `type="button"` would leave the click
//     working while Enter silently did nothing.
//   * Cancel and the close control must stay `type="button"`. Inside a <form>,
//     a button with no explicit type defaults to `submit` — so omitting it would
//     turn Cancel into a save.
//   * The action row must stay OUTSIDE `.clinics-modal-body`. The body is the
//     scrolling region; moving the actions inside it would let Save scroll out
//     of reach again on a short viewport, which is the exact defect this
//     guards (Save was unreachable at a 563px-tall viewport).
//
// It asserts structure, not behaviour, and does not claim to replace a
// rendered-DOM test.

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

const dialog = componentSource("ManageLocationModal");

test("manage-location dialog submits through a semantic form", () => {
  assert.match(
    dialog,
    /<form[\s\S]*?onSubmit=\{handleSubmit\}/,
    "the dialog must be a <form> wired to handleSubmit, so Enter and Save share one validated path"
  );
  assert.match(
    dialog,
    /<form[\s\S]*?noValidate/,
    "noValidate keeps validateClinicLocation the single source of validation feedback"
  );
});

test("Save is a submit control", () => {
  const save = dialog.match(/<button[^>]*?type="submit"[\s\S]*?<\/button>/);
  assert.ok(save, "expected a type=submit button in the dialog");
  assert.match(
    save[0],
    /Save location|Saving/,
    "the submit control should be the Save button"
  );
});

test("Cancel and close never submit the form", () => {
  // Every button that is not the submit control must be explicitly type=button:
  // inside a <form>, an untyped button defaults to submit.
  const buttons = dialog.match(/<button[\s\S]*?>/g) ?? [];
  assert.ok(buttons.length >= 3, "expected close, submit and cancel controls");

  const nonSubmit = buttons.filter((b) => !/type="submit"/.test(b));
  for (const button of nonSubmit) {
    assert.match(
      button,
      /type="button"/,
      `non-submit control is missing an explicit type="button": ${button.replace(/\s+/g, " ").slice(0, 90)}`
    );
  }

  // The close control is labelled for assistive tech.
  assert.match(
    dialog,
    /className="clinics-modal-close"[\s\S]*?aria-label="[^"]+"/,
    "the close control needs an accessible name"
  );
});

test("action row stays outside the scrolling body so Save cannot scroll away", () => {
  const bodyStart = dialog.indexOf('className="clinics-modal-body"');
  const actionsStart = dialog.indexOf('className="clinics-modal-actions"');

  assert.notEqual(bodyStart, -1, "the dialog needs a scrolling body wrapper");
  assert.notEqual(actionsStart, -1, "the dialog needs an action row");
  assert.ok(
    actionsStart > bodyStart,
    "the action row must come after the body wrapper"
  );

  // The body element must be closed before the actions begin — i.e. the actions
  // are a sibling of the body, not a child of it.
  const between = dialog.slice(bodyStart, actionsStart);
  const opened = (between.match(/<div/g) ?? []).length;
  const closed = (between.match(/<\/div>/g) ?? []).length;
  assert.ok(
    closed >= opened,
    "the scrolling body must be closed before the action row, otherwise Save scrolls with the content"
  );
});

test("dialog carries its own scoping class", () => {
  // `.clinics-form-modal` is shared with the Register-Clinic modal, so the
  // viewport-height rules hang off a class unique to this dialog.
  assert.match(
    dialog,
    /clinics-location-modal/,
    "the viewport-aware height rules are scoped to .clinics-location-modal"
  );
});
