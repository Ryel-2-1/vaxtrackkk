/**
 * The VaxTrack logo: a map pin holding a "V" drawn as a road, with a red
 * medical cross above it. The same mark as the rider app's launcher icon
 * (vaxtrack_mobile/branding/vaxtrack-icon-production.png), redrawn as SVG so it
 * stays sharp at any size. It replaced the login page's snowflake on
 * 2026-11-15: VaxTrack has no temperature (cold-chain) function, so an ice
 * symbol promised something the system does not do.
 *
 * variant="mark"    the full-colour app-icon tile (green square, white pin and
 *                   road, green lane dashes, red cross).
 * variant="outline" one colour (currentColor), no tile: for large decorative
 *                   use such as the faint shape behind the login message.
 *
 * Decorative by default (aria-hidden): every place it appears has the name
 * "VaxTrack" written beside it. Pass `title` to give it an accessible name.
 */
const GREEN = "#146a47";
const RED = "#d9363b";

// Pin: a teardrop whose tip is at the bottom centre.
const PIN = "M512 902 C 316 752 178 604 178 440 A 334 334 0 0 1 846 440 C 846 604 708 752 512 902 Z";

export default function VaxTrackLogo({ variant = "mark", size = 32, title, className }) {
  const label = title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: "false" };
  const outline = variant === "outline";
  const ink = outline ? "currentColor" : "#ffffff";
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      {...label}
    >
      {title && <title>{title}</title>}
      {!outline && <rect width="1024" height="1024" rx="224" fill={GREEN} />}
      <path d={PIN} fill="none" stroke={ink} strokeWidth="62" strokeLinejoin="round" />
      {/* The road: two wide arms meeting at the bottom of the V. */}
      <path d="M322 348 L512 748 L702 348" fill="none" stroke={ink} strokeWidth="96" strokeLinecap="round" strokeLinejoin="round" />
      {/* Lane markings down the middle of each arm (full-colour mark only). */}
      {!outline && (
        <path
          d="M360 396 L500 702 M664 396 L524 702"
          fill="none"
          stroke={GREEN}
          strokeWidth="22"
          strokeLinecap="round"
          strokeDasharray="44 56"
        />
      )}
      {/* The medical cross. */}
      <path
        d="M487 224 a10 10 0 0 1 10 -10 h30 a10 10 0 0 1 10 10 v31 h31 a10 10 0 0 1 10 10 v30 a10 10 0 0 1 -10 10 h-31 v31 a10 10 0 0 1 -10 10 h-30 a10 10 0 0 1 -10 -10 v-31 h-31 a10 10 0 0 1 -10 -10 v-30 a10 10 0 0 1 10 -10 h31 Z"
        fill={outline ? "currentColor" : RED}
      />
    </svg>
  );
}
