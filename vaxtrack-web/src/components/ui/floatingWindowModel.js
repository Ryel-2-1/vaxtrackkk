/**
 * Geometry for movable, resizable dialog windows (2026-11-14). Pure, so it is
 * tested without a browser; floatingWindow.js applies it to the DOM.
 */

/** Height of the top band (title area) that moves the window. */
export const HANDLE_BAND_PX = 64;
/** Size of the bottom-right square that resizes the window. */
export const RESIZE_GRIP_PX = 20;
/** Smallest window a person can resize to. */
export const MIN_WIDTH_PX = 320;
export const MIN_HEIGHT_PX = 220;
/** Gap kept from the viewport edge when a window is resized. */
export const EDGE_PX = 8;
/** Below this viewport width windows are full-width and stay put. */
export const MIN_VIEWPORT_WIDTH_PX = 640;

/** Can windows move and resize in a viewport this wide? (Not on phones.) */
export function floatingEnabled(viewportWidth) {
  return Number.isFinite(viewportWidth) && viewportWidth >= MIN_VIEWPORT_WIDTH_PX;
}

/**
 * Which part of the window a pointer at (x, y) is over: "resize" (the
 * bottom-right grip), "move" (the title band), or null.
 * [interactive] is true when the pointer is on a button, field, link or map,
 * which keep their own behaviour.
 */
export function pointerZone({ x, y, rect, interactive }) {
  if (!rect) return null;
  if (x >= rect.right - RESIZE_GRIP_PX && x <= rect.right && y >= rect.bottom - RESIZE_GRIP_PX && y <= rect.bottom) {
    return "resize";
  }
  if (interactive) return null;
  if (y >= rect.top && y <= rect.top + HANDLE_BAND_PX && x >= rect.left && x <= rect.right) return "move";
  return null;
}

/**
 * The window's new top-left after a drag of (dx, dy). The whole window stays
 * on screen, so its title band and its pinned buttons are always reachable.
 * A window as tall (or wide) as the screen can then only move the other way;
 * resize it smaller to move it freely.
 */
export function movedPosition({ start, dx, dy, viewport }) {
  const maxLeft = Math.max(0, viewport.width - start.width);
  const maxTop = Math.max(0, viewport.height - start.height);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(0, start.left + dx))),
    top: Math.round(Math.min(maxTop, Math.max(0, start.top + dy))),
  };
}

/**
 * The window's new size after dragging the grip by (dx, dy): never below the
 * minimum, and never past the viewport's right or bottom edge.
 */
export function resizedSize({ start, dx, dy, viewport }) {
  const maxWidth = Math.max(MIN_WIDTH_PX, viewport.width - start.left - EDGE_PX);
  const maxHeight = Math.max(MIN_HEIGHT_PX, viewport.height - start.top - EDGE_PX);
  return {
    width: Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH_PX, start.width + dx))),
    height: Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT_PX, start.height + dy))),
  };
}
