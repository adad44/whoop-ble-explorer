# WHOOP BLE Explorer

Signed-in Web Bluetooth capture app designed for Bluefy on iPhone. It uses the browser's Web Bluetooth API, stores captured packets in IndexedDB on the device, and automatically syncs new connected-session captures to Convex after the user signs in and accepts the cloud sync disclosure.

## Boundaries

- No WHOOP API.
- No WHOOP credentials.
- Convex sync only uploads data captured by this page after sign-in and disclosure acceptance.
- Convex mutations attach ownership from the authenticated session, not from browser-supplied user IDs.
- No attempt to bypass pairing, bonding, authorization, encryption, or device authentication.
- The app can only inspect BLE services and characteristics exposed by the connected device to Web Bluetooth.
- Sleep, recovery, strain, and sleep-stage outputs are local estimates, not official WHOOP scores or medical advice.

## Health Pipeline Sync

The intended capture flow is:

1. Wear WHOOP during the day or overnight.
2. Open the public site in Bluefy.
3. Sign in or create an account.
4. Accept the cloud sync disclosure.
5. Connect WHOOP.
6. Capture starts automatically.
7. New connected-session packets and decoded fields are stored locally and batched to Convex under the signed-in user.

## Convex Auth Setup

Install dependencies:

```bash
npm install
```

Run Convex and generate backend bindings:

```bash
npx convex dev
```

Set the Convex deployment URL in local `.env.local` and Netlify environment variables:

```bash
VITE_CONVEX_URL=https://your-convex-deployment.convex.cloud
```

Convex Auth also requires JWT signing keys in the Convex deployment environment. Generate and set `JWT_PRIVATE_KEY` and `JWKS` using the Convex Auth setup guide, then deploy functions:

```bash
npx convex deploy
```

For password-only auth, no email provider is required for basic sign-up/sign-in. Add email verification and password reset before a broad public launch.

## Local BLE Decoder Pipeline

The page includes a local report pipeline that can analyze:

- packets currently stored in IndexedDB
- JSON exports from this app
- Bluefy-style JSON records with `serviceUuid`, `characteristicUuid`, `bytes`, `rawHex`, and `timestamp` fields

The pipeline normalizes UUIDs, decodes standard HR/RR/battery packets, attempts proprietary WHOOP 61080004/61080007 frame decoding, estimates local sleep metrics, assigns data confidence, and exports a Markdown health report. It does not claim official WHOOP sleep stages or official WHOOP recovery/sleep scores.

## Run Locally

```bash
npm install
npm run dev
```

Open the printed local URL in Bluefy on iPhone. For a phone on the same network, use the Mac's LAN IP address instead of `localhost`, for example `http://192.168.1.20:5173`.

## Production Build

```bash
npm run build
npm run preview
```

## Notes For Web Bluetooth

Web Bluetooth browser implementations can limit access to services that were not advertised or not included in the optional service list during device selection. This app requests standard services for heart rate, battery, device information, generic access, and generic attribute, then enumerates everything the browser exposes through the connected GATT server.

If Bluefy exposes additional device services, they will appear in the Service Explorer. If the browser hides services, the app reports the limitation rather than working around it.
