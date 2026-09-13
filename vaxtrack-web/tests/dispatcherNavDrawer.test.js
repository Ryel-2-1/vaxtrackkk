import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DRAWER_BREAKPOINT_PX,
  DRAWER_MEDIA_QUERY,
  nextNavState,
  sidebarClassName,
  toggleLabel,
} from "../src/pages/dispatcher/navDrawer.js";

// Dispatcher responsive shell.
//
// Two separate failures are pinned here.
//
// 1. Behaviour — the drawer's open/closed decisions. `navDrawer.js` exists so
//    these can be *run* rather than grepped for: this repo has no jsdom, and a
//    rule living inline in the component could only be asserted as source text.
//
// 2. The cascade — the actual defect. `Dispatcher.css` already contained a
//    `@media (max-width: 760px)` block saying the right things; it never
//    applied, because `@media` adds no specificity and later un-mediated
//    `!important` declarations in the same file simply won. Asserting that the
//    mobile rules *exist* would therefore have passed on the broken file. So
//    the tests below resolve the cascade the way a browser does — declaration
//    order, `!important`, specificity, media condition — and assert which
//    declaration actually WINS at a given viewport width.

const here = dirname(fileURLToPath(import.meta.url));
const dispatcherCss = readFileSync(
  join(here, "..", "src", "pages", "dispatcher", "Dispatcher.css"),
  "utf8"
);
// Prose that merely mentions an API must not satisfy — or trip — a guard about
// USING it, so code assertions run against a comment-stripped copy.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const layoutJsx = readFileSync(
  join(here, "..", "src", "pages", "dispatcher", "DispatcherLayout.jsx"),
  "utf8"
);

// ---------------------------------------------------------------------------
// A very small CSS cascade resolver
// ---------------------------------------------------------------------------

function parseDeclarations(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const stack = [];
  let buf = "";
  let order = 0;

  for (const ch of source) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";") {
      const decl = buf.trim();
      buf = "";
      const colon = decl.indexOf(":");
      if (!stack.length || colon < 0) continue;
      let value = decl.slice(colon + 1).trim();
      const important = /!important$/i.test(value);
      out.push({
        selector: stack[stack.length - 1],
        conditions: stack.slice(0, -1).filter((s) => s.startsWith("@")),
        prop: decl.slice(0, colon).trim().toLowerCase(),
        value: value.replace(/!important$/i, "").trim(),
        important,
        order: order++,
      });
    } else {
      buf += ch;
    }
  }
  return out;
}

/** Does every `@media` wrapping a declaration hold at this viewport width? */
function conditionsHold(conditions, width) {
  return conditions.every((cond) => {
    // Only width media are simulated; anything else (print, reduced motion)
    // is treated as not applying so it cannot silently decide a test.
    if (!/^@media/.test(cond) || /prefers-|print|hover|orientation/.test(cond)) {
      return false;
    }
    const maxes = [...cond.matchAll(/max-width:\s*(\d+)px/g)].map((m) => +m[1]);
    const mins = [...cond.matchAll(/min-width:\s*(\d+)px/g)].map((m) => +m[1]);
    return maxes.every((v) => width <= v) && mins.every((v) => width >= v);
  });
}

function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes =
    (selector.match(/\.[\w-]+/g) || []).length +
    (selector.match(/\[[^\]]*\]/g) || []).length +
    (selector.match(/:(?!:)[\w-]+/g) || []).length;
  const elements = (
    selector
      .replace(/[.#][\w-]+|\[[^\]]*\]|:{1,2}[\w-]+/g, " ")
      .match(/\b[a-z][\w-]*\b/gi) || []
  ).length;
  return ids * 10000 + classes * 100 + elements;
}

// Ancestors this fixture's element genuinely has. Anything else in a matching
// selector makes the test fail loudly rather than quietly skip a rule.
const KNOWN_ANCESTORS = new Set(["#root", ".dispatcher-page", ".dispatcher-main"]);

/**
 * Does `selector` match an element carrying `classes` (with `tag`), given the
 * fixture's ancestor chain?
 */
function selectorMatches(selector, tag, classes) {
  return selector.split(",").some((partRaw) => {
    const part = partRaw.trim();
    const compounds = part.split(/\s*>\s*|\s+/).filter(Boolean);
    const last = compounds[compounds.length - 1];

    const wantedClasses = (last.match(/\.[\w-]+/g) || []).map((c) => c.slice(1));
    if (!wantedClasses.length) return false;
    if (!wantedClasses.every((c) => classes.includes(c))) return false;

    const wantedTag = last.match(/^[a-z][\w-]*/i);
    if (wantedTag && wantedTag[0] !== tag) return false;

    for (const ancestor of compounds.slice(0, -1)) {
      if (!KNOWN_ANCESTORS.has(ancestor)) {
        throw new Error(
          `unrecognised ancestor "${ancestor}" in "${part}" — teach the test about it ` +
            `rather than letting it silently drop out of the cascade`
        );
      }
    }
    return true;
  });
}

const DECLARATIONS = parseDeclarations(dispatcherCss);

/** The declaration a browser would use for `prop` at `width`. */
function winner({ prop, width, tag, classes }) {
  const candidates = DECLARATIONS.filter(
    (d) =>
      d.prop === prop &&
      conditionsHold(d.conditions, width) &&
      selectorMatches(d.selector, tag, classes)
  );
  assert.ok(candidates.length, `no ${prop} declaration matched at ${width}px`);
  return candidates.reduce((best, d) => {
    if (d.important !== best.important) return d.important ? d : best;
    const ds = specificity(d.selector);
    const bs = specificity(best.selector);
    if (ds !== bs) return ds > bs ? d : best;
    return d.order > best.order ? d : best;
  });
}

const asideClosed = { tag: "aside", classes: ["dispatcher-sidebar"] };
const topbar = { tag: "header", classes: ["dispatcher-topbar"] };

// ---------------------------------------------------------------------------
// The cascade: the mobile rules must actually win
// ---------------------------------------------------------------------------

test("the resolver reproduces the original defect on the pre-fix declarations", () => {
  // Sanity check on the tool itself: given the two competing declarations the
  // file used to end with, the un-mediated later one wins — which is exactly
  // why the 760px block was dead. If this ever stops holding, the resolver is
  // wrong and every assertion below is worthless.
  const before = parseDeclarations(
    `@media (max-width: 760px) { .dispatcher-sidebar { width: 100% !important; } }
     .dispatcher-sidebar { width: 260px !important; }`
  );
  const applicable = before.filter((d) => conditionsHold(d.conditions, 375));
  const won = applicable.reduce((a, b) => (b.order > a.order ? b : a));
  assert.equal(won.value, "260px");
});

test("the narrow-viewport sidebar width is decided by a media query, not by file order", () => {
  for (const width of [320, 375, 640, 768, 1024]) {
    const won = winner({ prop: "width", width, ...asideClosed });
    assert.ok(
      won.conditions.length,
      `at ${width}px the winning sidebar width came from an un-mediated rule ` +
        `(${won.value}) — that is the bug this change fixes`
    );
    assert.notEqual(won.value, "260px", `the 260px rail must not win at ${width}px`);
    assert.match(won.value, /min\(/, `at ${width}px expected a viewport-capped width`);
  }
});

test("the desktop rail is untouched", () => {
  for (const width of [1025, 1280, 1440]) {
    assert.equal(winner({ prop: "width", width, ...asideClosed }).value, "260px");
    assert.equal(
      winner({ prop: "position", width, ...asideClosed }).value,
      "sticky",
      "the desktop sidebar must not become a fixed drawer"
    );
  }
});

test("the closed drawer is taken out of the tab order, not merely moved", () => {
  // Translating it off-canvas alone leaves all seven controls focusable.
  const vis = winner({ prop: "visibility", width: 375, ...asideClosed });
  assert.equal(vis.value, "hidden");
  const open = winner({
    prop: "visibility",
    width: 375,
    tag: "aside",
    classes: ["dispatcher-sidebar", "dispatcher-nav-open"],
  });
  assert.equal(open.value, "visible");
});

test("no topbar track can demand more width than the viewport", () => {
  // The old winner at 375px was `190px minmax(280px, 1fr) 46px`: 516px of
  // fixed minimums, which is what put the search field 138px off-screen.
  for (const width of [320, 375, 640, 768, 1024]) {
    const cols = winner({ prop: "grid-template-columns", width, ...topbar }).value;
    const fixed = [...cols.matchAll(/(?:^|[\s(])(\d+)px/g)].map((m) => +m[1]);
    const minima = [...cols.matchAll(/minmax\(\s*([^,]+),/g)].map((m) => m[1].trim());
    const total = fixed.reduce((a, b) => a + b, 0);
    assert.ok(
      total < width,
      `at ${width}px the topbar's fixed tracks total ${total}px (${cols})`
    );
    for (const min of minima) {
      assert.equal(min, "0", `flexible topbar tracks must be able to shrink (${cols})`);
    }
  }
});

test("the desktop topbar grid is unchanged", () => {
  assert.equal(
    winner({ prop: "grid-template-columns", width: 1440, ...topbar }).value,
    "230px minmax(380px, 1fr) 46px 220px"
  );
});

// ---------------------------------------------------------------------------
// One breakpoint, agreed on by the markup and the stylesheet
// ---------------------------------------------------------------------------

test("markup and stylesheet cannot drift apart on the breakpoint", () => {
  assert.equal(DRAWER_BREAKPOINT_PX, 1024);
  assert.equal(DRAWER_MEDIA_QUERY, "(max-width: 1024px)");
  assert.ok(
    dispatcherCss.includes(`@media (max-width: ${DRAWER_BREAKPOINT_PX}px)`),
    "the drawer stylesheet must use the same breakpoint the component watches"
  );
  assert.ok(
    dispatcherCss.includes(`@media (min-width: ${DRAWER_BREAKPOINT_PX + 1}px)`),
    "and the rail must resume on the very next pixel, leaving no band with neither"
  );
});

test("every width has exactly one navigation affordance", () => {
  // A drawer at <=1024 and a rail at >=1025 leaves no gap and no overlap.
  for (const width of [320, 375, 768, 1024]) {
    assert.ok(conditionsHold(["@media (max-width: 1024px)"], width));
    assert.ok(!conditionsHold(["@media (min-width: 1025px)"], width));
  }
  for (const width of [1025, 1440]) {
    assert.ok(!conditionsHold(["@media (max-width: 1024px)"], width));
    assert.ok(conditionsHold(["@media (min-width: 1025px)"], width));
  }
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

test("the drawer starts closed", () => {
  // The initial state is `useState(false)`; what that has to mean downstream is
  // no open class and a toggle that offers to OPEN.
  assert.match(layoutJsx, /const \[navOpen, setNavOpen\] = useState\(false\)/);
  assert.equal(sidebarClassName(false), "dispatcher-sidebar");
  assert.equal(toggleLabel(false), "Open navigation menu");
});

test("the toggle opens and closes", () => {
  assert.equal(nextNavState(false, { type: "toggle" }), true);
  assert.equal(nextNavState(true, { type: "toggle" }), false);
});

test("repeated open/close cycles return to a clean closed state", () => {
  // A drawer that drifts after a few uses strands its backdrop over the page.
  let open = false;
  for (let i = 0; i < 6; i++) {
    open = nextNavState(open, { type: "toggle" });
    assert.equal(open, true, `cycle ${i + 1} should open`);
    open = nextNavState(open, { type: "toggle" });
    assert.equal(open, false, `cycle ${i + 1} should close`);
  }
  assert.equal(open, false);
  assert.equal(sidebarClassName(open), "dispatcher-sidebar");
});

test("choosing a destination is its own event, not an anonymous dismiss", () => {
  // Route changes close the drawer two ways: the link's own handler fires
  // `navigate`, and DispatcherLayout is remounted by the router because each
  // Dispatcher route is a different lazy page component. This covers the first;
  // the second was verified in the browser (back/forward both close it).
  assert.equal(nextNavState(true, { type: "navigate" }), false);
  assert.equal(nextNavState(false, { type: "navigate" }), false);
  assert.match(
    layoutJsx,
    /applyNav\(\{ type: "navigate" \}\)/,
    "and the layout must actually dispatch it"
  );
});

test("every dismissal route closes it", () => {
  for (const event of [
    { type: "dismiss" }, // the toggle's close half and the backdrop
    { type: "navigate" }, // choosing a destination, and logging out
    { type: "key", key: "Escape" },
  ]) {
    assert.equal(nextNavState(true, event), false, JSON.stringify(event));
    assert.equal(nextNavState(false, event), false, "and it stays closed");
  }
});

test("keys other than Escape leave it alone", () => {
  // Closing on any keypress would swallow Tab and arrow navigation through the
  // drawer's own links.
  for (const key of ["Tab", "Enter", " ", "ArrowDown", "a", "Shift"]) {
    assert.equal(nextNavState(true, { type: "key", key }), true, key);
  }
});

test("growing past the breakpoint closes it; staying narrow does not", () => {
  // A drawer left open behind the desktop rail strands a full-page backdrop.
  assert.equal(nextNavState(true, { type: "viewport", matches: false }), false);
  // Rotating a phone must not slam it shut.
  assert.equal(nextNavState(true, { type: "viewport", matches: true }), true);
  // And a viewport change never opens it.
  assert.equal(nextNavState(false, { type: "viewport", matches: true }), false);
});

test("an unrecognised event cannot change the state", () => {
  for (const event of [undefined, null, {}, { type: "wat" }]) {
    assert.equal(nextNavState(true, event), true);
    assert.equal(nextNavState(false, event), false);
  }
});

test("the accessible name states what the control will do", () => {
  assert.equal(toggleLabel(false), "Open navigation menu");
  assert.equal(toggleLabel(true), "Close navigation menu");
});

test("the open class is applied only when open", () => {
  assert.equal(sidebarClassName(false), "dispatcher-sidebar");
  assert.equal(sidebarClassName(true), "dispatcher-sidebar dispatcher-nav-open");
});

// ---------------------------------------------------------------------------
// The layout must route its interactions through the machine
// ---------------------------------------------------------------------------

test("the layout defers every open/closed decision to navDrawer", () => {
  // Otherwise the tests above would pass while the component did its own thing.
  assert.match(layoutJsx, /applyNav\(\{ type: "toggle" \}\)/, "toggle");
  assert.match(layoutJsx, /applyNav\(\{ type: "dismiss" \}\)/, "backdrop / close");
  assert.match(layoutJsx, /applyNav\(\{ type: "key", key: e\.key \}\)/, "Escape");
  assert.match(layoutJsx, /applyNav\(\{ type: "viewport", matches: mq\.matches \}\)/, "resize");
  assert.ok(
    !/setNavOpen\((true|false)\)/.test(layoutJsx),
    "no direct state pokes that bypass nextNavState"
  );
});

test("the toggle reports its state and names the panel it controls", () => {
  assert.match(layoutJsx, /aria-expanded=\{navOpen\}/);
  assert.match(layoutJsx, /aria-label=\{toggleLabel\(navOpen\)\}/);
  assert.match(layoutJsx, /aria-controls="dispatcher-nav"/);
  assert.match(layoutJsx, /id="dispatcher-nav"/, "and that panel carries the id");
});

test("focus moves into the drawer and returns to the toggle", () => {
  assert.match(layoutJsx, /panel\?\.querySelector\("a\[href\], button:not\(\[disabled\]\)"\)\?\.focus\(\)/);
  // Restored only while the toggle is still rendered AND visible — focusing a
  // `display: none` toggle after a resize-to-desktop would drop focus to body.
  assert.match(layoutJsx, /toggle && toggle\.isConnected && shown\(toggle\)/);
  assert.match(layoutJsx, /toggle\.focus\(\);/);
  assert.match(layoutJsx, /document\.body\.style\.overflow = "hidden"/, "scroll lock");
  assert.match(layoutJsx, /document\.body\.style\.overflow = prevOverflow/, "and its release");
});

// The next two are SOURCE-SHAPE guards, not proof of behaviour. Node cannot
// show that focus is contained — that was verified in the browser with real
// Tab / Shift+Tab key input. What these pin is the two mechanisms that made it
// work, so neither can be dropped or silently regressed.

test("the background is made inert while the drawer is open", () => {
  // One declaration on <main> covers every control the backdrop hides, and
  // React removes it on close/unmount so it cannot leak.
  assert.match(layoutJsx, /<main className="dispatcher-main" inert=\{navOpen \|\| undefined\}>/);
  // `false` would still render the attribute in some React versions and trap
  // the desktop rail; `undefined` is what keeps inert out of play above 1024px.
  assert.ok(
    !/inert=\{navOpen\}/.test(layoutJsx),
    "must be `navOpen || undefined`, never a bare boolean"
  );
});

test("the focus loop measures visibility by rects, not offsetParent", () => {
  // `offsetParent` is ALWAYS null for `position: fixed`, which the toggle is.
  // Using it silently dropped the close control out of the tab loop and out of
  // the focus-restore on close — caught only by real keyboard testing.
  assert.match(layoutJsx, /el\.getClientRects\(\)\.length > 0/);
  assert.ok(
    !/offsetParent/.test(stripComments(layoutJsx)),
    "offsetParent must not gate the fixed-position toggle"
  );
  assert.match(layoutJsx, /e\.key !== "Tab"/, "Tab is handled, not routed to the state machine");
});

test("both viewport signals are watched", () => {
  // A CDP device-metric override updates matchMedia().matches and re-evaluates
  // the stylesheet while firing no `change` event, so the media query alone is
  // not enough to guarantee the drawer closes on the way back to desktop.
  assert.match(layoutJsx, /mq\.addEventListener\("change", sync\)/);
  assert.match(layoutJsx, /window\.addEventListener\("resize", sync\)/);
  assert.match(layoutJsx, /mq\.removeEventListener\("change", sync\)/);
  assert.match(layoutJsx, /window\.removeEventListener\("resize", sync\)/);
});

test("no navigation destination, active state or action was dropped", () => {
  for (const to of [
    "/dispatcher",
    "/dispatcher/assign-rider",
    "/dispatcher/shipments",
    "/dispatcher/cargo-loading",
    "/dispatcher/geofence",
    "/dispatcher/settings",
  ]) {
    assert.ok(layoutJsx.includes(`to="${to}"`), to);
  }
  assert.equal(
    (layoutJsx.match(/onClick=\{selectDestination\}/g) || []).length,
    6,
    "every destination closes the drawer"
  );
  assert.equal(
    (layoutJsx.match(/onClick=\{closeNav\}/g) || []).length,
    1,
    "and the backdrop dismisses it"
  );
  assert.match(layoutJsx, /className="dispatcher-logout"/);
  assert.match(layoutJsx, /onSubmit=\{handleSearchSubmit\}/, "search behaviour is untouched");
});
