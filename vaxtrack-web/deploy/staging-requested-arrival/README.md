# Requested arrival: candidate completion on feat/delivery-time-spec

Base: `3d896e04e70399e77e19eb6f5cfcb3ec742a3b52`. This change is not a
deployment and is not approved for rollout until the emulator gates below pass.
It does not install an APK, change routing algorithms, configure a hub, or
write any cloud data.

## Contract

The optional preference describes arrival at the destination on the order's
requested date, in Asia/Manila, at minute precision. It is not a promised ETA
or a departure time. Absent/null means any time within that day, NOT that the
destination is open 24 hours. Window bounds are inclusive; "before" excludes
the cutoff minute; "exact" names one minute. Midnight is the start of the day;
overnight and equal-endpoint windows are rejected, not silently corrected.
Destination and hub operating hours remain unknown unless explicitly recorded.

The branch already validates, stores and presents requestedArrival. This
follow-up fixes recovery and separates that contract from the WIP planner:

- New request keys use fingerprint version 3, binding date AND arrival. Old
  v1/v2 hashes remain readable. Their unbound schedule is compared with the
  original order so a changed retry is refused, never quietly replayed.
- A committed key replays the original schedule even after its time or day
  passes. Only structural checks precede key lookup. An unknown/new key still
  undergoes strict clock validation before any order/stock write.
- The checkout can recover its durable pending attempt after the cutoff. The
  existing snapshot guard still refuses changed contents and never rotates an
  attempt id automatically. Failure retains the draft.
- The callable response includes the server's stored requested date/arrival on
  both creation and replay. Confirmation still reads the authoritative order.
- A rejected schema gets a compatibility message, not a connection diagnosis.
  The client never retries by dropping a doctor's selected time.
- The manually-entered departure planner is disabled unless
  VITE_DEPARTURE_PLANNER_ENABLED is explicitly true. Leave it false/unset in
  staging/production. Its algorithms are unchanged and remain unfinished.

## Verification

Executed locally on Node 22.23.4:

- Focused checkout/date/arrival/planner unit and wiring tests: 53/53.
- Full web tests: 1343/1343.
- Full Functions unit tests: 422/422.
- ESLint: no errors or warnings.
- Staging compile: succeeded, with the existing >500 kB chunk warning. No
  staging environment file was installed, so this is NOT a configuration or
  live-integration verification.

NOT VERIFIED: changed Firestore transactions, full Functions emulator suite,
rules suite, or browser end-to-end behavior. The emulator command did not start
because obtaining firebase-tools was rejected by the environment (HTTP 403 /
network approval cancellation). No successful emulator result is claimed.

Before any merge/deploy, run these in a configured local checkout using Node
22, Java 21, and firebase-tools 15.17.0. Use demo projects only; do not put
staging credentials into emulator tests:

    # vaxtrack-web/functions
    npm ci
    npm test
    npm run test:emulator

    # vaxtrack-web
    npm ci
    npm test
    npm run lint
    npm run test:rules
    npm run build:staging
    git diff --check

New emulator coverage exercises date/time conflicts, legacy v1/v2 recovery,
replay after cutoff and midnight, refusal of a NEW stale request, and concurrent
creation with stock reserved once. Existing price/VAT/reservation controls stay.

## Staging rollout proposal (separate approval required)

1. Finish the emulator/browser gates and review the combined branch diff. The
   Med Rep UI revision PR is its dependency; do not lose those changes or
   assume that a pushed branch is merged/deployed. Verify staging project ids.
2. Capture live function/rules versions read-only and review the FULL rules
   delta, not merely this follow-up patch. Preserve operational-alert changes.
3. Deploy only the reviewed createOrderWithReservation and
   materializeOrderHistory exports to vaxtrack-staging. The second handles
   initial receipts when the callable stops after commit. These updates include
   the branch's requestedArrival validation and receipt snapshot code. Do not
   deploy all functions or create Scheduler jobs as a shortcut.
4. Deploy the reviewed Firestore rules (requestedArrival is server-only).
   Direct client writes must stay refused. No new index is introduced here.
5. Publish the reviewed web build against staging, leaving the departure
   planner flag false/unset. Old clients omitting requestedArrival use any_time.
   New clients must NOT be published before the compatible callable is live.
6. With approval for the writes, create one identifiable QA order per required
   case: no preference, window, before, exact. Confirm stored order AND receipt,
   the creation response, Med Rep confirmation/tracking/history, and Dispatcher
   queue/calendar/details all preserve the same requested date/time. Check
   standard/negotiated and VAT-exempt/VATable prices and reserve exactly once.
   Verify refreshed/lost-response retries and changed-date/time refusals.

The existing timing scheduler still measures dispatch ETA + grace, not the Med
Rep's preference. No automatic late-delivery policy or lifecycle is changed.
Route-derived travel, hub configuration, motorcycle road restrictions, and
service/opening hours are separate follow-up work; none is claimed finished.

## If problems occur

Pause the new checkout rollout and preserve drafts, ids and existing orders.
Revert the web first if needed; keep the backward-compatible server and the
server-only field rule. Do not restore an old callable while a new timed
checkout is still published. Do not delete orders, release reservations, or
strip requestedArrival to make a failed request appear successful. Review
original order/request key and logs, fix forward, and repeat the demo tests.
