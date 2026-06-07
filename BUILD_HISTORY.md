# WHOOP Freedom: Complete Build History and Metric Reference

This document explains how WHOOP Freedom was built, why each architectural
decision exists, how Bluetooth packets move through the system, and how every
displayed metric is calculated.

The project was built by Alan Diaz as an independent, open-source experiment.
It is not affiliated with WHOOP.

## 1. The Original Goal

The project started with one constraint: build a health-data pipeline from data
that a user can capture directly from their own WHOOP band.

That constraint excluded:

- the official WHOOP API
- WHOOP cloud sessions
- WHOOP usernames or passwords
- scraping the WHOOP app
- official WHOOP sleep, recovery, strain, or stage endpoints

The browser has to work with whatever Bluetooth services the band and browser
actually expose. If a value is not present in those packets, the app does not
pretend that it decoded it.

## 2. Why Bluefy Is Required on iPhone

Safari on iPhone does not provide the Web Bluetooth API used by this project.
Bluefy is an iOS browser that provides Web Bluetooth support, which makes these
browser calls available:

```ts
navigator.bluetooth.requestDevice(...)
device.gatt?.connect()
server.getPrimaryServices()
characteristic.startNotifications()
```

Bluefy is not used as a backend and does not calculate the health metrics. It
is the browser bridge that lets the web page ask iOS for Bluetooth access.

The user flow is:

1. Install Bluefy.
2. Open the Netlify site inside Bluefy.
3. Create or sign into a WHOOP Freedom account.
4. Accept the capture and sync disclosure.
5. Tap **Connect WHOOP**.
6. Select the band in Bluefy's Bluetooth picker.
7. Leave the page active while the browser receives packets.

Safari can display the landing page, but it cannot make the direct band
connection.

## 3. What "Proprietary WHOOP Packets" Means

Standard Bluetooth health services have published formats. For example:

- Heart Rate service: `180d`
- Heart Rate Measurement: `2a37`
- Battery service: `180f`
- Battery Level: `2a19`

Those values can be decoded using the Bluetooth specification.

WHOOP also exposes a proprietary service:

```text
61080001-8d6d-82b8-614a-1c8cb0f8dcc6
```

Important observed characteristics include:

```text
61080004-8d6d-82b8-614a-1c8cb0f8dcc6
61080007-8d6d-82b8-614a-1c8cb0f8dcc6
```

The meaning and layout of these packets are not publicly documented by WHOOP.
That is why the project had to preserve raw bytes and reverse-engineer patterns
instead of importing an official schema.

"Proprietary" does not mean the app bypasses encryption or authentication. The
app only reads characteristics that the band and Web Bluetooth make available
after the user selects the device.

## 4. Complete Runtime Sequence

This is the full sequence from opening the site to seeing a metric.

1. Netlify serves the React/Vite application over HTTPS.
2. Convex Auth checks whether an app session already exists.
3. An unauthenticated visitor sees the landing page and account form.
4. The user creates or signs into a WHOOP Freedom account.
5. The app loads the authenticated capture workspace.
6. The app checks for `navigator.bluetooth`.
7. The app loads previously stored packets, heart-rate readings, battery
   readings, and bookmarks from IndexedDB.
8. The app checks whether the current data disclosure version was accepted.
9. The user presses **Enable & Connect WHOOP**.
10. If necessary, the app records disclosure acceptance in Convex.
11. `requestDevice()` opens Bluefy's device picker.
12. The request includes standard optional services and WHOOP's proprietary
    service UUID.
13. The user selects the WHOOP band.
14. The browser opens a GATT connection.
15. The app requests every primary service that Bluefy exposes.
16. Every service UUID is normalized to canonical 128-bit form.
17. The app requests each service's exposed characteristics.
18. Readable characteristics are read once when possible.
19. Notify/indicate characteristics call `startNotifications()`.
20. A `characteristicvaluechanged` listener is attached.
21. Each incoming `DataView` is converted to a plain byte array.
22. The packet receives a session ID, device ID, service UUID, characteristic
    UUID, direction, timestamp, raw hex, and byte array.
23. The raw packet is immediately written to IndexedDB.
24. If the packet is `2a37`, the standard heart-rate decoder runs.
25. If the packet is `2a19`, the standard battery decoder runs.
26. Decoded heart-rate and battery rows are written to their own IndexedDB
    stores.
27. Proprietary packets remain preserved even when their meaning is unknown.
28. The backlog analyzer scans proprietary packets for historical timestamps.
29. The sleep analyzer looks for a plausible overnight disconnect/reconnect
    window supported by those timestamps.
30. The report builder calculates direct readings, local estimates, and data
    confidence.
31. React updates the Today, Sleep, Recovery, Strain, and Connect screens.
32. An auto-sync timer waits 4.5 seconds so nearby packets can be batched.
33. The browser builds one capture payload containing raw packets and decoded
    records.
34. The Convex client attaches the current auth token.
35. The server obtains the user ID from the authenticated session, never from a
    browser-supplied owner field.
36. Convex inserts or updates the capture and deduplicates packets/readings by
    stable keys.
37. Later captures can be reprocessed as the proprietary decoder improves.

## 5. How the Packet Capture Layer Was Built

### 5.1 Requesting the device

The app requests standard services plus the proprietary WHOOP service. Optional
services matter because Web Bluetooth may hide services that were not included
when the picker opened.

### 5.2 Normalizing UUIDs

Bluefy may return a standard UUID as `180d`, `0000180d`, or its complete
128-bit UUID. The first decoder failed to match some packets because those
representations were treated as different strings.

The fix was:

```text
180d
-> 0000180d-0000-1000-8000-00805f9b34fb
```

All service and characteristic comparisons now use the normalized form.

### 5.3 Enumerating services and characteristics

After GATT connection, the app calls `getPrimaryServices()`, then requests each
service's characteristics. It records:

- UUID
- service UUID
- read/write/notify/indicate properties
- the browser characteristic object

The app does not assume that every WHOOP firmware version exposes the same
characteristics.

### 5.4 Subscribing to notifications

For each notify/indicate characteristic:

1. Call `startNotifications()`.
2. Attach `characteristicvaluechanged`.
3. Read the event's `DataView`.
4. Copy the bytes before the browser reuses the underlying value.
5. pass the packet through storage and decoder paths.

### 5.5 Preserving raw data first

Every packet is stored before relying on a decoder. This was essential because
the proprietary interpretation changed repeatedly. Keeping the original bytes
means old captures can be analyzed by newer code.

IndexedDB stores:

- `packet_records`
- `heart_rate_readings`
- `battery_readings`
- `bookmarks`

## 6. Standard Bluetooth Decoding

### 6.1 Heart rate

The first byte of `2a37` is a flags byte.

1. Bit 0 selects an 8-bit or 16-bit BPM value.
2. Bit 3 indicates an energy-expended field.
3. Bit 4 indicates one or more RR intervals.
4. BPM values outside `1..240` are rejected.
5. RR values are unsigned 16-bit integers in units of `1/1024` second.

Formula:

```text
RR seconds = raw RR value / 1024
```

The Today feed reports minimum, average, maximum, and sample count from valid
heart-rate readings.

### 6.2 Battery

For `2a19`, the first byte is interpreted as the percentage:

```text
battery percentage = bytes[0]
```

The most recent valid battery packet is displayed.

### 6.3 HRV / RMSSD

At least three RR intervals are required. Consecutive RR differences are
converted to milliseconds:

```text
difference[i] = (RR[i] - RR[i - 1]) * 1000
RMSSD = sqrt(mean(difference[i]^2))
```

This is an RMSSD calculation from available RR intervals. Its usefulness is
limited by how many RR intervals the band exposes to the browser.

## 7. How Proprietary Packets Were Decoded

The reverse-engineering process was deliberately incremental.

1. Capture all packets without filtering unknown values.
2. Group packets by service and characteristic UUID.
3. Compare packet lengths and repeated byte positions.
4. Render bytes as hex and decimal.
5. attempt strict UTF-8 decoding.
6. Extract printable ASCII fragments such as firmware/build text.
7. Scan every four-byte offset as both big-endian and little-endian Unix time.
8. Reject timestamps before 2020 or implausibly after the packet time.
9. Mark a narrower set of positions in `61080007` as trusted historical
   timestamp candidates.
10. Search payloads for likely CBOR starting offsets.
11. Decode supported CBOR-like integers, strings, arrays, maps, booleans,
    byte strings, and timestamp-looking values.
12. Preserve parser failures instead of treating a failed parse as proof that
    the packet contains no structured data.
13. Compare repeated fields across multiple packets and saved captures.
14. Use only repeatable, plausible fields in user-facing logic.

An early generic CBOR parser stopped on a reserved/simple byte. The packet
format is therefore described as CBOR-like, not confirmed standard CBOR.

Research also found repeatable candidate fields for respiratory rate, skin
temperature, and SpO2. Respiratory rate had the strongest repeated candidate,
but the app does not label those proprietary fields as confirmed until several
captures can be compared against known values from the same nights.

## 8. Automatic Sleep Window

The browser is often disconnected overnight. That means it cannot claim to
have a continuous overnight stream. The sleep-window method instead uses:

- the time the browser stopped receiving packets
- the morning reconnect time
- trusted historical timestamps returned in proprietary backlog packets

### Candidate requirements

1. A disconnect gap must be between 4 and 13 hours.
2. It must begin at night, approximately `19:00..03:59`.
3. It must end in the morning, approximately `04:00..12:59`.
4. At least two trusted historical points must fall inside the gap.
5. The resulting sleep duration must be between 3 and 10 hours.

The first plausible backlog point is used as onset when it is 15 minutes to
3 hours after disconnect. Otherwise, onset defaults to 30 minutes after
disconnect.

Candidate score:

```text
durationScore = 120 - min(90, abs(durationMinutes - 390) / 2)
latencyScore = 40 when latency is 15..150 minutes, otherwise 10
evidenceScore = min(80, evidencePoints * 22)
recencyScore = max(0, 35 - recencyMinutes / 10)

candidateScore =
  durationScore + latencyScore + evidenceScore + recencyScore
```

The best valid candidate becomes the local sleep window.

### Why this changed

The first heuristic accepted an impossible-looking `10:14 PM - 3:15 AM`
window. The decoder was tightened to require a real overnight no-packet gap
and trusted backlog evidence.

A later version used the second roughly hourly backlog point as onset. That
systematically moved onset about one hour too late. The current implementation
uses the first plausible point.

## 9. Every Displayed Metric

Metrics are labeled as:

- **Direct**: decoded from a published Bluetooth characteristic.
- **Calculated**: mathematical transformation of captured values.
- **Estimated**: a local heuristic, not an official WHOOP result.

### 9.1 BPM

Type: direct.

Source: standard Heart Rate Measurement `2a37`.

The current dashboard uses valid decoded BPM samples. Summary values are:

```text
minimum BPM = min(samples)
average BPM = mean(samples)
maximum BPM = max(samples)
```

### 9.2 Battery

Type: direct.

Source: standard Battery Level `2a19`.

```text
battery = latest bytes[0]
```

### 9.3 RR intervals

Type: direct after unit conversion.

Source: optional RR fields inside `2a37`.

```text
RR seconds = raw uint16 / 1024
```

### 9.4 HRV / RMSSD

Type: calculated.

Source: captured RR intervals.

```text
RMSSD = sqrt(mean(((RR[i] - RR[i - 1]) * 1000)^2))
```

### 9.5 Sleep duration component

Type: estimated.

```text
under 4 hours: score = hours * 12.5
4 to 7.5 hours: score rises linearly from 50 to 95
7.5 to 9 hours: score = 100
over 9 hours: score falls by 12 points per extra hour
final over-9 score is clamped to 60..100
```

### 9.6 Resting-HR stability component

Type: calculated from captured HR in the estimated sleep window.

```text
averageScore = clamp(120 - max(0, averageBpm - 45) * 2.2, 20, 100)
stabilityScore = clamp(100 - max(0, bpmRange - 8) * 2, 35, 100)
HR score = round(averageScore * 0.65 + stabilityScore * 0.35)
```

If no sleep-window HR exists, this component uses neutral `50`.

### 9.7 HRV score component

Type: calculated.

```text
RMSSD >= 70 ms: 100
45..70 ms: linear 80..100
25..45 ms: linear 55..80
below 25 ms: clamp(RMSSD * 2, 10, 55)
```

If HRV is unavailable, this component uses neutral `50`.

### 9.8 Continuity

Type: calculated from historical timestamps.

1. Consecutive timestamp gaps up to 95 minutes count as reasonable.
2. `regularity = reasonableGaps / allGaps`.
3. `countScore = min(100, timestampCount * 16)`.

```text
continuity =
  round(countScore * 0.45 + regularity * 55)
```

### 9.9 Sleep data confidence

Type: calculated evidence-quality score.

```text
packetScore = min(100, historicalPacketCount * 12)
durationScore = min(100, durationMinutes / 480 * 100)
hrScore = min(100, sleepHRSamples * 2)
rrScore = min(100, RRIntervalCount * 2)

confidence = round(
  packetScore * 0.35 +
  durationScore * 0.25 +
  continuity * 0.25 +
  hrScore * 0.10 +
  rrScore * 0.05
)
```

Labels:

```text
75..100 = high
45..74 = medium
0..44 = low
```

### 9.10 Local Sleep Score

Type: estimated.

```text
sleepScore = round(
  durationScore * 0.35 +
  restingHRStability * 0.25 +
  hrvScore * 0.20 +
  continuity * 0.10 +
  dataConfidence * 0.10
)
```

This is not the official WHOOP Sleep Performance score.

### 9.11 Recovery

Type: estimated.

```text
HR component =
  clamp(round(120 - max(0, averageHR - 45) * 2.1), 20, 100)

recovery = round(
  sleepScore * 0.48 +
  hrvScore * 0.24 +
  HRComponent * 0.20 +
  sleepDataConfidence * 0.08
)
```

Missing inputs use a neutral value of `50`. Recovery is hidden only when no
sleep, HRV, or HR evidence exists at all.

### 9.12 Resting HR

Type: calculated.

The app uses the minimum captured heart rate inside the estimated sleep window.
If sleep-window HR is unavailable, it falls back to the minimum valid local HR.

### 9.13 Strain

Type: estimated.

The strain model avoids treating passive packet volume as physical effort.

1. Keep BPM values in `35..220`.
2. Select readings from the latest local day.
3. Estimate resting floor as the 15th percentile minus 2 BPM.
4. Clamp the resting floor to `45..85`.
5. Group readings into 15-minute windows.
6. For each window:

```text
loadBpm = averageBpm * 0.70 + medianBpm * 0.30
loadThreshold = max(88, restingFloor + 12)
elevated = max(0, loadBpm - loadThreshold)
sustainedHigh = max(0, loadBpm - 105)
peakPressure = max(0, peakBpm - 135) / 28

windowRaw =
  elevated / 8.5 +
  sustainedHigh / 11 +
  peakPressure
```

7. Clamp the raw window score to `0..21`.
8. Apply sample confidence:

```text
6+ samples = 1.00
3..5 samples = 0.84
1..2 samples = 0.58
```

9. Combine the average window, top three windows, and active time:

```text
dailyStrain = clamp(
  averageWindowScore * 0.25 +
  averageTopThreeScore * 0.55 +
  min(3, activeMinutes / 75),
  0,
  21
)
```

This is not official WHOOP Strain and does not represent activity outside the
captured Bluefy session.

### 9.14 Stress monitor

Type: estimated.

```text
heartRateLoad =
  dailyStrain * 4.2 +
  max(0, peakWindowScore - 5) * 2.1

hrvRelief =
  clamp((RMSSD - 30) * 0.45, -10, 18)

stress = clamp(round(42 + heartRateLoad - hrvRelief), 5, 100)
```

Without RMSSD, `hrvRelief` is zero.

### 9.15 Estimated sleep stages

Type: estimated.

These are heuristic proportions, not decoded WHOOP stage labels.

```text
confidence multiplier:
  high = 1.0
  medium = 0.7
  low = 0.35

stableHRBonus =
  clamp((18 - sleepHRRange) / 4, -4, 5) * confidenceMultiplier

hrvBonus =
  clamp((RMSSD - 35) / 10, -3, 4) * confidenceMultiplier

shortSleepPenalty:
  under 6 hours = 4
  over 9 hours = 2
  otherwise = 0

awake% = clamp(10 + shortSleepPenalty - stableHRBonus, 6, 22)
deep% = clamp(15 + stableHRBonus + hrvBonus, 8, 24)
REM% = clamp(22 + max(0, hrvBonus / 2), 16, 28)
light% = 100 - awake% - deep% - REM%
```

Minutes are each percentage multiplied by the estimated sleep duration.

### 9.16 Time in bed

Type: estimated.

```text
timeInBed = asleepMinutes + estimatedAwakeMinutes + estimatedLatencyMinutes
```

### 9.17 Sleep efficiency

Type: calculated from estimates.

```text
sleepEfficiency = round(asleepMinutes / timeInBedMinutes * 100)
```

### 9.18 Sleep latency

Type: estimated.

```text
base = 16 minutes
confidence offset:
  high = -4
  low = +6
  medium = 0

HR offset = clamp((averageHR - 62) / 4, -3, 7)
HRV offset = clamp((35 - RMSSD) / 8, -4, 3)

latency = clamp(round(base + confidenceOffset + HROffset + HRVOffset), 8, 35)
```

### 9.19 Sleep consistency

Type: estimated evidence stability.

```text
evidenceBonus = min(16, sleepWindowEvidencePoints * 3)
confidenceBonus = round(dataConfidence * 0.14)
missingHRVPenalty = 5 when no HRV exists, otherwise 0

consistency = clamp(
  68 + evidenceBonus + confidenceBonus - missingHRVPenalty,
  60,
  94
)
```

### 9.20 Sleep need

Type: estimated.

The baseline is eight hours:

```text
baseline = 480 minutes

recovery adjustment:
  recovery < 55 = +20 minutes
  recovery >= 75 = -10 minutes
  otherwise = 0

strain adjustment:
  strain >= 12 = +18 minutes
  strain >= 8 = +10 minutes
  otherwise = 0

sleepNeed = clamp(
  baseline + recoveryAdjustment + strainAdjustment,
  450,
  540
)
```

### 9.21 Sleep debt

Type: estimated.

```text
sleepDebt = max(0, sleepNeed - asleepMinutes)
```

The current UI labels this as a weekly-reset view, but the displayed value is
the current calculated deficit, not a multi-night clinical debt model.

### 9.22 Overall report confidence

Type: calculated capture-quality score.

```text
reportConfidence = round(
  min(100, packetCount / 3) * 0.12 +
  min(100, validHRReadings * 2) * 0.18 +
  min(100, RRIntervals * 2) * 0.12 +
  min(100, historicalPackets * 14) * 0.22 +
  min(100, decodedFrames * 10) * 0.16 +
  sleepConfidence * 0.20
)
```

The same high/medium/low thresholds are used. Confidence describes evidence
coverage, not health quality.

## 10. Convex Accounts and Sync

WHOOP Freedom accounts are separate from WHOOP accounts.

The backend uses:

- Convex Auth password provider
- `users` and auth tables supplied by `@convex-dev/auth`
- `userConsents`
- `captures`
- `capturePackets`
- `decodedReadings`

The sync security sequence is:

1. The browser receives an auth token after app sign-in.
2. The Convex HTTP client attaches that token.
3. The `syncCapture` mutation calls `getAuthUserId(ctx)`.
4. The mutation rejects anonymous uploads.
5. The server adds `userId` to captures, packets, and decoded rows.
6. Queries use indexes beginning with the authenticated `userId`.

The browser cannot choose another user's ID.

Stable packet and reading keys prevent repeated reconnect/sync attempts from
creating unlimited duplicates.

## 11. Export and Import

The project supports JSON/CSV export and local report import because packet
research requires reproducible captures.

An iPhone-specific problem appeared early: download and clipboard behavior can
fail or be interrupted in Bluefy. The fix was to keep export output visible in
the page so it can still be selected manually.

Imported captures are normalized before analysis:

- UUIDs are canonicalized.
- byte arrays and raw hex are reconstructed.
- timestamps are sorted.
- standard and proprietary decoders run against the same report pipeline.

## 12. UI Evolution

The interface changed several times:

1. The first version emphasized a low-level BLE service explorer.
2. Raw packets and decoder controls were useful for development but too dense
   for daily use.
3. A WHOOP-like circular dashboard was tried.
4. The circular UI looked forced and made independent estimates appear more
   official than they were.
5. It was replaced by a simpler Today Feed.
6. Sleep, Recovery, Strain, and Connect became separate tabs.
7. Advanced packet tools stayed available but moved behind detail sections.
8. A persistent quick-connect strip was added above the tabs.
9. The disclosure and device-picker actions were combined into one first-run
   button.
10. A public landing page was added before authentication.
11. The landing page explains Bluefy, data ownership, and metric boundaries.
12. The footer credits the project as **Open source by Alan Diaz**.

## 13. Band Alarm Work

The app can construct a WHOOP command packet containing:

- an alarm Unix timestamp
- a command counter
- a calculated CRC32

Alarm preferences are stored in browser local storage, including:

- enabled state
- time
- selected weekdays
- next target timestamp

This feature depends on the writable command characteristic being exposed and
on Bluefy/iOS keeping enough page state alive. It is not a cloud alarm.

## 14. Important Hiccups and What Changed

### Short UUID mismatch

Problem: Bluefy sometimes returned `180d` while code expected a full UUID.

Fix: normalize 16-bit and 32-bit UUIDs before every comparison.

### Bluefy downloads and clipboard

Problem: iOS browser behavior made exports unreliable.

Fix: render the export text inside the page as a fallback.

### CBOR parse failure

Problem: a reserved/simple byte stopped a strict CBOR parser.

Fix: treat the structure as CBOR-like, preserve bytes, and continue with
field-by-field comparison.

### False sleep window

Problem: timestamp-looking bytes created an implausible sleep result.

Fix: require a real overnight disconnect gap, trusted points, duration bounds,
and morning reconnect.

### Sleep onset one hour late

Problem: selecting the second roughly hourly backlog point delayed onset.

Fix: use the first plausible trusted point.

### Passive samples inflated strain

Problem: a simple aggregate could make more packets look like more effort.

Fix: group HR into 15-minute windows, use resting-relative thresholds, and let
sample count affect confidence rather than raw strain.

### Dense dashboard implied false precision

Problem: official-looking visual patterns could blur the distinction between
direct values and local estimates.

Fix: simplify the dashboard and visibly label direct, calculated, and estimated
metrics.

### Sleep step described as manual

Problem: earlier wording made it sound like the user manually entered sleep.

Fix: the current docs and UI state clearly that sleep analysis runs
automatically after reconnect/capture.

## 15. File-by-File Architecture

```text
src/App.tsx
  Landing page, auth UI, BLE connection, notification handling,
  metric screens, metric formulas, alarms, and sync orchestration.

src/utils.ts
  UUID normalization, standard packet parsing, proprietary backlog analysis,
  timestamp extraction, CBOR-like decoding, and local sleep score.

src/db.ts
  IndexedDB stores and local persistence functions.

src/healthReport.ts
  Capture normalization, report construction, overall confidence,
  insights, limitations, and Markdown export.

src/pipelineSync.ts
  Authenticated Convex payload construction and upload.

src/authStorage.ts
  Keep-me-signed-in token-storage preference.

convex/auth.ts
  Convex Auth password provider.

convex/http.ts
  Convex Auth HTTP routes.

convex/schema.ts
  Auth, consent, capture, packet, and decoded-reading tables/indexes.

convex/captures.ts
  Authenticated consent, viewer, upload, ownership, deduplication,
  and recent-capture functions.

netlify.toml
  Netlify build and SPA routing configuration.
```

## 16. Build and Deployment

Local development:

```bash
npm install
npm run dev
```

TypeScript and production build:

```bash
npm run build
```

Convex development:

```bash
npx convex dev
```

Production deployment:

```bash
npx netlify deploy --prod --dir=dist
```

Live site:

```text
https://whoop-ble-explorer.netlify.app
```

## 17. Current Scientific and Product Boundaries

The app can honestly claim:

- direct browser BLE capture
- standard heart-rate, RR, and battery decoding
- partial proprietary packet analysis
- automatic local sleep-window estimation
- independent local sleep, recovery, strain, stress, and stage estimates
- evidence-quality confidence scores

The app cannot honestly claim:

- official WHOOP scores
- official WHOOP sleep stages
- a complete proprietary protocol decode
- continuous overnight HR when the browser was disconnected
- medical diagnosis

The core rule is: preserve the raw evidence, explain every transformation, and
never present an estimate as a decoded official value.
