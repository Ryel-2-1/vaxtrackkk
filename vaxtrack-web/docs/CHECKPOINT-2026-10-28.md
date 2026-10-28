# VaxTrack checkpoint — 2026-10-28

Branch `feat/delivery-time-spec`, after these commits and merges:

| Commit | What |
|---|---|
| `3d896e0` … `315aaa0` | Delivery time specification, departure planning, requested-arrival validation, safe checkout retries, cart preservation, Med Rep layout / inventory pagination |
| `2bf5ea4` | Valhalla motorcycle routing (replaces OpenRouteService) |
| `1fca92b` | Merge `fix/rider-start-navigation` — Rider "Sign in to start navigation" fix + return-to-hub location sharing |
| (this merge) | Merge `codex/staging-predeparture-cancellation` — record only: its pre-departure cancellation work was already in `315aaa0` in a newer form, so the merge changes no files |

Every other branch is already contained in this one. Nothing in this
checkpoint has been deployed (Functions, rules, Netlify) or installed on a
phone.

## What works — verified

Automated (all on this exact tree, exit 0):

| Suite | Result |
|---|---|
| Web unit tests (`npm test`) | 1437 / 1437 |
| Web lint | clean |
| Staging and production builds | built |
| Firestore rules (emulator) | 412 / 412 |
| Functions unit tests | 433 / 433 |
| Functions integration (emulator, full suite) | 585 / 585 |
| `flutter analyze` | no issues |
| `flutter test` | 735 / 735 |

In the real web portal (local motorcycle-QA mode: `demo-vaxtrack-motorcycle`
emulators, synthetic accounts and orders, live public Valhalla server):

- Dispatcher Geofence → **Refresh route** called Valhalla `/route` and saved a
  motorcycle route ("checked for highway, toll road and ferry flags").
- **Re-optimize route** called `/sources_to_targets` then `/route` and saved the
  two-stop trip with new per-stop ETAs.
- Both survived a full reload; no console errors.
- Dispatcher Live Tracking renders with the new "Returning to hub" count; no
  console errors.

## Done in this checkpoint (feature summary)

- **Delivery time specification:** requested arrival on orders, validated at
  checkout; departure planning; safe checkout retries; cart preserved.
- **Motorcycle routing (Valhalla):** motorcycle costing only, no API key, no car
  fallback; any highway / toll / ferry flag or missing evidence rejects the
  route; stop order computed in VaxTrack; routes tagged
  `valhalla` / `motorcycle-no-expressways-v1`; older routes labelled
  "unverified — regenerate" on web and in the Rider app.
- **Rider start navigation:** a signed-in Rider is no longer told to sign in;
  the tracking attachment survives screen remounts and app switching.
- **Return-to-hub sharing:** after the last delivery, the Rider app keeps
  sharing location (no order, no route monitoring) until the return is
  confirmed or the Rider signs out; Admin/Dispatcher Live Tracking lists such
  Riders as "Returning to hub" with real location freshness. Arrival is never
  inferred from position.
- **Pre-departure cancellation:** Admin and the owning Med Rep can cancel
  before departure, with a required reason.

## Not yet verified / pending

1. **Physical-phone QA** of the Rider app: start navigation, return-to-hub
   notification and locked-screen sharing, motorcycle route labels. No APK
   installed.
2. **Google Maps background persistence** investigation (parked).
3. **Valhalla endpoint for rollout:** the public server is fair-use only;
   production likely needs a self-hosted or paid endpoint
   (`VITE_MOTORCYCLE_ROUTING_URL` + `connect-src` in `vite.config.js` and
   `netlify.toml`).
4. **Server deviation monitoring** still uses legacy OpenRouteService car routes
   if an order has one (`functions/src/riderTracking.js` `routeForOrder` does
   not check the route profile). Regenerate routes, or decide whether the
   server should refuse unverified ones.
5. **Rules:** a Rider's location may name any order assigned to them, not only
   an active one (the app never does). Tightening needs a rules deploy.
6. **Deployment order** when releasing: confirm trip-state rules + Functions on
   staging → rules (new route provenance fields) → web → Rider app build.
7. Carried over: production `users` data cleanup before the hardened guards,
   App Check enforcement, the no-op Admin Settings / Inventory drawer controls.
8. `CLAUDE.md` and `docs/` still describe OpenRouteService in places.
