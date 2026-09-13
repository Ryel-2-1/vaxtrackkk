// Dispatcher mobile-navigation state machine.
//
// The open/closed decision lives here rather than inline in DispatcherLayout so
// it can be exercised as behaviour: this repo has no jsdom or testing-library,
// so a rule kept inside the component could only ever be asserted as source
// text. Every transition the drawer has to get right — Escape but not other
// keys, growing past the breakpoint but not shrinking within it, choosing a
// destination — is a real defect shape, so each one is a function call a test
// can make. The component is the thin binding: it owns the refs, the listeners
// and the focus moves, and defers every "should it be open now?" answer here.

// One breakpoint, shared by the markup (matchMedia) and the stylesheet, so the
// drawer and the desktop rail can never both be absent — the gap that bit the
// Admin sidebar when its two halves drifted to 900px and 1001px.
export const DRAWER_BREAKPOINT_PX = 1024;
export const DRAWER_MEDIA_QUERY = `(max-width: ${DRAWER_BREAKPOINT_PX}px)`;

const SIDEBAR_CLASS = "dispatcher-sidebar";
const OPEN_CLASS = "dispatcher-nav-open";

/**
 * The next open state, given the current one and something that happened.
 *
 * @param {boolean} open  current state
 * @param {{type: string, key?: string, matches?: boolean}} event
 * @returns {boolean}
 */
export function nextNavState(open, event) {
  switch (event && event.type) {
    case "toggle":
      return !open;
    // The toggle's close half, the scrim, and picking a destination all mean
    // the same thing.
    case "dismiss":
    case "navigate":
      return false;
    // Only Escape closes. A drawer that closed on any keypress would swallow
    // Tab and arrow navigation through its own links.
    case "key":
      return event.key === "Escape" ? false : open;
    // The drawer is a narrow-viewport affordance: once the desktop rail is back
    // it must not be left open behind it. Staying under the breakpoint changes
    // nothing, so rotating a phone does not slam the drawer shut.
    case "viewport":
      return event.matches ? open : false;
    default:
      return open;
  }
}

/** Accessible name for the toggle — it is also the close control. */
export function toggleLabel(open) {
  return open ? "Close navigation menu" : "Open navigation menu";
}

/** Class list for the sidebar; the open class is what the stylesheet slides. */
export function sidebarClassName(open) {
  return open ? `${SIDEBAR_CLASS} ${OPEN_CLASS}` : SIDEBAR_CLASS;
}
