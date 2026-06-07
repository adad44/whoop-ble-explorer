# WHOOP BLE Health Pipeline - Project Context

Last updated: June 7, 2026

## What This Project Is

This is a Bluefy-first WHOOP Bluetooth capture and health-analysis web app with app-specific accounts and signed-in Convex storage.

The main idea is:

1. Wear WHOOP normally.
2. Open the Netlify page in Bluefy.
3. Create an account for this app. This is not a WHOOP account.
4. Press **Enable & Connect WHOOP** and select the band.
5. The page captures whatever BLE data WHOOP sends while connected.
6. The app decodes standard Bluetooth data immediately: heart rate, RR intervals when present, and battery.
7. Raw packets and decoded fields are stored locally in IndexedDB.
8. Signed-in captures and local analysis are automatically uploaded to Convex.
9. Over time, the backend can become the source for a custom health pipeline and history.

This does not use the WHOOP API, WHOOP cloud, WHOOP credentials, or any official WHOOP score endpoint.

## Current Folder

Project root:

```text
/Users/alandiaz/Documents/WhoopFreedom/whoop-ble-explorer
```

Important files:

```text
src/App.tsx              Main React UI and live capture flow
src/utils.ts            BLE parsing, backlog decoder, local sleep analysis
src/healthReport.ts     Imported capture normalization and report builder
src/pipelineSync.ts     Convex upload client
src/authStorage.ts      Convex Auth token storage with Keep me signed in preference
convex/auth.ts          Convex Auth password provider setup
convex/http.ts          Convex Auth HTTP routes
convex/schema.ts        Convex database schema
convex/captures.ts      Convex capture mutation/query code
README.md               Setup and run notes
BUILD_HISTORY.md        Complete build sequence, packet research, and metric formulas
LICENSE                 MIT open-source license, copyright Alan Diaz
netlify.toml            Netlify build and SPA routing config
```

## Live App

Production URL:

```text
https://whoop-ble-explorer.netlify.app
```

Netlify site:

```text
whoop-ble-explorer
```

Normal deploy command:

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

## Current UX Direction

The public unauthenticated route is now a product landing page. It includes:

- a direct-Bluetooth product explanation
- an illustrative dashboard preview
- direct, calculated, and estimated metric boundaries
- a three-step Bluefy setup walkthrough
- embedded create-account and sign-in controls

The first-run flow is intentionally linear:

1. Open the site inside Bluefy.
2. Create an app account.
3. Press one button to accept the capture disclosure and open the Bluetooth picker.
4. Select WHOOP.
5. Capture, decoding, local storage, and sync run automatically.

After sign-in, a persistent connection strip stays above the metric tabs. The first metric screen is the Today Feed:

- BPM
- Sleep Score
- Recovery proxy
- Strain proxy
- Battery
- Pipeline status

Below that, the user can see:

- live Bluetooth capture status
- automatic capture/send progress
- WHOOP band alarm controls
- local sleep estimate
- backlog decoder
- local health report tools
- advanced BLE explorer hidden behind disclosure

The Today Feed also contains a **How every metric works** section that distinguishes direct BLE readings, local calculations, and estimates. The previous WHOOP-style circle dashboard was removed because it looked forced and confusing.

## Current Capture Flow

The intended sequence is:

1. User wears WHOOP during the day and/or overnight.
2. If sleeping, the WHOOP can stay disconnected from Bluefy overnight.
3. In the morning, user opens the Netlify page in Bluefy.
4. User signs in or creates an app account.
5. User presses **Enable & Connect WHOOP**. The first press records the disclosure acceptance and opens the Bluefy picker.
6. User selects WHOOP.
7. The page automatically subscribes to available notify/indicate characteristics.
8. Incoming packets are stored locally.
9. New packets are automatically batched and sent to Convex when the authenticated pipeline is ready.
10. Metrics update from the browser-captured data.

## Data We Can Decode Reliably

Standard BLE:

- Heart Rate service `180d`
- Heart Rate Measurement characteristic `2a37`
- Battery service `180f`
- Battery Level characteristic `2a19`
- RR intervals when they are included in `2a37`

WHOOP proprietary service:

- Service `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`
- Important characteristics seen so far:
  - `61080004-8d6d-82b8-614a-1c8cb0f8dcc6`
  - `61080007-8d6d-82b8-614a-1c8cb0f8dcc6`

The proprietary packets are partially decoded. We can find:

- some CBOR-like structures
- text fragments like firmware/build labels
- embedded timestamp fields
- trusted historical timestamp fields in some `61080007` packets

We cannot yet fully decode official WHOOP sleep score, recovery score, strain score, or sleep stages from BLE.

## Local Sleep Pipeline State

The sleep estimate is automatic only. Manual sleep start/wake controls were removed.

Current sleep-window logic:

1. Decode trusted historical timestamps from WHOOP proprietary backlog packets.
2. Look for a real overnight no-packet gap where the user disconnected from Bluefy.
3. Require at least 2 trusted WHOOP backlog timestamp points inside that gap.
4. Use the morning reconnect/gap end as the wake boundary.
5. Use the first plausible trusted backlog interval inside the gap as sleep onset. Do not skip to the second hourly point, which can push onset about an hour late.
6. Reject windows shorter than 3 hours or longer than 10 hours.

This was retuned after the app incorrectly estimated an impossible `10:14 PM - 3:15 AM` window, then retuned again on June 6 after a second-interval onset estimate overshot reported sleep onset by about an hour.

Validation against the saved morning capture:

```text
Capture file:
/Users/alandiaz/Downloads/whoop-morning-capture-2026-06-03T14_32_23.287Z.json

New estimate:
Jun 3, 2026, 1:15 AM - 7:27 AM
6h 12m asleep
3 trusted backlog points
local score 64/100
medium confidence
```

This is still a local estimate, not an official WHOOP sleep score.

## Current Local Scores

The app currently produces local proxy scores:

- Sleep Score: based on estimated duration, HR stability, HRV/RR proxy, continuity, and data confidence.
- Recovery: based on local sleep score, RR/HRV proxy when available, HR profile, and confidence.
- Strain: based on sustained HR load above a resting-relative threshold. Passive sample volume increases confidence but does not add strain.
- BPM: min/avg/max from valid heart-rate packets.
- Battery: latest decoded battery packet.

These are browser-local estimates and should be displayed as estimates/proxies.

## Convex Backend State

Convex support exists in code and now requires Convex Auth for sync.

The upload bundle includes:

- raw BLE packets
- decoded HR/RR/battery
- proprietary frame decode attempts
- local sleep analysis
- capture label
- timestamps
- device/session IDs
- a placeholder reportedSleep object for schema compatibility

Important file:

```text
src/pipelineSync.ts
```

Convex is used through:

```text
VITE_CONVEX_URL
```

If this environment variable is not available to the browser build, the public signed-in app shows a Convex configuration warning.

Convex Auth requirements:

- `@convex-dev/auth`
- `convex/auth.ts`
- `convex/http.ts`
- `convex/auth.config.ts`
- `authTables` in `convex/schema.ts`
- Convex deployment env vars `JWT_PRIVATE_KEY` and `JWKS`

The browser never sends a `userId` for capture ownership. `convex/captures.ts` calls `getAuthUserId(ctx)` and adds `userId` server-side. Existing capture tables keep `userId` optional so older records remain schema-compatible.

## Current Boundaries

Do not claim:

- official WHOOP sleep score
- official WHOOP recovery
- official WHOOP strain
- official sleep stages
- complete proprietary decode

Do claim:

- local BLE capture
- standard BLE HR/RR/battery decode
- partial WHOOP proprietary decode
- local sleep/recovery/strain estimates
- confidence level based on available data

## Known Limitations

- Bluefy/Web Bluetooth only exposes services and characteristics the browser allows.
- Some WHOOP characteristics may be hidden, encrypted, bonded, or unavailable.
- Sleeping disconnected means the browser has no live overnight HR stream unless WHOOP sends backlog data later.
- The proprietary backlog format is not fully understood.
- Sleep stages are currently heuristic only, not decoded labels.
- A no-packet gap alone is not enough evidence for sleep; the current logic requires trusted backlog points too.
- Convex receives only what the browser captures or imports.

## Next Useful Work

Highest-value next steps:

1. Collect more morning reconnect captures from different nights.
2. Store those captures in Convex and compare repeated proprietary fields.
3. Improve the `61080004` and `61080007` decoder with field clustering.
4. Separate trusted timestamp fields from random timestamp-looking byte sequences.
5. Improve sleep-stage proxy using HR, RR intervals, movement-like proprietary fields if decoded, and overnight continuity.
6. Add backend aggregate views for daily history once enough captures exist.
7. Keep the UI simple: Today Feed first, advanced decoder hidden unless needed.

## Development Commands

Install:

```bash
npm install
```

Run locally:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Deploy:

```bash
npx netlify deploy --prod --dir=dist
```

Check Netlify link/auth:

```bash
npx netlify status
```

Run Convex locally:

```bash
npx convex dev
```

## Mental Model For Future Codex Work

This project is not trying to hack WHOOP cloud data.

It is trying to build the best possible independent health pipeline from BLE data that the user can capture directly from their own band in Bluefy. The right engineering posture is:

- decode only what is actually present
- keep raw packets forever for later decoding
- show confidence honestly
- avoid fake precision
- prefer simple user-facing flows
- keep advanced reverse-engineering tools available but not front-and-center
