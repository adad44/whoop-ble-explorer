# WHOOP Freedom

A Bluefy-first web app that captures data directly from a WHOOP band over Bluetooth. Users create an account for this app, connect the band, and then capture, decoding, local storage, and Convex sync run automatically.

Open source by Alan Diaz under the [MIT License](LICENSE).

Production:

```text
https://whoop-ble-explorer.netlify.app
```

The public unauthenticated route is a responsive landing page that explains the product boundaries, shows an illustrative dashboard preview, links users to Bluefy when Web Bluetooth is unavailable, and includes create-account/sign-in entry. Authenticated users enter the existing capture workspace.

## Complete Technical Documentation

Read [BUILD_HISTORY.md](BUILD_HISTORY.md) for:

- every capture and processing microstep
- why Bluefy is required on iPhone
- how standard and proprietary WHOOP packets were decoded
- the exact formula for every displayed metric
- the complete sleep-window heuristic
- Convex authentication, ownership, and deduplication
- failed approaches, incorrect assumptions, and fixes
- the UI and deployment history

## User Flow

1. Install Bluefy on iPhone.
2. Open the production URL inside Bluefy.
3. Create an account using an email and password for this app.
4. Press **Enable & Connect WHOOP**.
5. Select the WHOOP in Bluefy's Bluetooth picker.
6. Leave the page open while packets are captured, decoded, saved locally, and synced.

No WHOOP account, WHOOP password, WHOOP API token, or WHOOP cloud session is used.

## Where Metrics Come From

| Metric | Source | Method |
| --- | --- | --- |
| BPM | Standard BLE Heart Rate Measurement `2a37` | Directly decoded from valid heart-rate packets. |
| Battery | Standard BLE Battery Level `2a19` | Directly decoded from the percentage byte. |
| RR / HRV | RR intervals in `2a37` packets | RMSSD across consecutive RR intervals; at least three intervals are required. |
| Sleep window | Trusted timestamps in proprietary `61080004` and `61080007` backlog packets | Finds a plausible overnight disconnect gap, uses the first plausible trusted interval as onset, and uses morning reconnect as the wake boundary. |
| Sleep score | Sleep duration, HR stability, HRV, continuity, and confidence | Local weights: 35%, 25%, 20%, 10%, and 10%. |
| Recovery | Local sleep score, HRV, HR profile, and confidence | Local weights: 48%, 24%, 20%, and 8%. |
| Strain | Same-day captured HR | Fifteen-minute HR windows score only sustained elevation above a resting-relative threshold; sample volume affects confidence, not load. |
| Resting HR | Captured sleep-window HR | Lowest valid sleep-window HR, with local HR as fallback. |
| Sleep stages | Duration, HR stability, HRV, and confidence | Heuristic awake/light/deep/REM split; no official stage labels are decoded. |
| Sleep efficiency | Estimated asleep and in-bed time | Time asleep divided by estimated time in bed. |
| Sleep latency | HR, HRV, and evidence confidence | Bounded local estimate, not a decoded onset event. |
| Sleep need/debt | Eight-hour baseline, recovery, strain, and current sleep | Adjusted local target between 7.5 and 9 hours, minus time asleep. |
| Stress | Sustained HR load and HRV | HR load increases the proxy; stronger HRV reduces it. |
| Data confidence | Packet and decoder coverage | Measures evidence completeness, not health status. |

Direct standard BLE values are labeled separately from local calculations and estimates. None of the scores are official WHOOP values or medical advice.

## Architecture

- React, Vite, and TypeScript for the browser app.
- Web Bluetooth through Bluefy for band access.
- IndexedDB for raw packets, HR, RR, battery, and bookmarks on the device.
- Convex Auth for app accounts.
- Convex for signed-in capture storage and future history views.
- Netlify for the production HTTPS site.

Important files:

```text
src/App.tsx           UI, auth flow, Bluetooth connection, live capture, and metric views
src/utils.ts         BLE normalization, packet decoding, sleep analysis, and score components
src/healthReport.ts  Capture normalization and local report generation
src/db.ts            IndexedDB persistence
src/pipelineSync.ts  Authenticated Convex upload
convex/schema.ts     Backend schema
convex/captures.ts   Consent, viewer, capture sync, and history functions
```

## Boundaries

- No WHOOP API.
- No WHOOP credentials.
- No attempt to bypass pairing, bonding, encryption, or device authorization.
- The browser can inspect only services and characteristics exposed through Web Bluetooth.
- Proprietary WHOOP packets are only partially decoded.
- Official WHOOP sleep, recovery, strain, and sleep-stage values are not available from the current BLE decode.

## Development

Install and run:

```bash
npm install
npm run dev
```

Configure Convex:

```bash
npx convex dev
```

Add the generated deployment URL to `.env.local` and Netlify:

```bash
VITE_CONVEX_URL=https://your-convex-deployment.convex.cloud
```

Build and deploy:

```bash
npm run build
npx netlify deploy --prod --dir=dist
```

## Bluefy Limitations

Bluefy and Web Bluetooth may hide services, expose short UUIDs, interrupt clipboard/download behavior, or disconnect when iOS suspends the page. UUIDs are normalized before matching, and exports remain visible on-screen so they can still be selected manually.
