import type { BatteryReading, HeartRateReading, PacketRecord } from './types';

const WHOOP_PROPRIETARY_SERVICE = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
const WHOOP_BACKLOG_CHARACTERISTICS = new Set([
  '61080004-8d6d-82b8-614a-1c8cb0f8dcc6',
  '61080007-8d6d-82b8-614a-1c8cb0f8dcc6',
]);
const HEART_RATE_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const TIMESTAMP_MIN_SECONDS = Date.UTC(2020, 0, 1) / 1000;
const TRUSTED_SLEEP_LOOKBACK_MINUTES = 36 * 60;
const MIN_SLEEP_WINDOW_MINUTES = 3 * 60;
const MAX_SLEEP_WINDOW_MINUTES = 10 * 60;
const MAX_SLEEP_TIMESTAMP_GAP_MINUTES = 130;
const MIN_OVERNIGHT_DISCONNECT_GAP_MINUTES = 4 * 60;
const MAX_OVERNIGHT_DISCONNECT_GAP_MINUTES = 13 * 60;

const STANDARD_SERVICES: Record<string, string> = {
  '00001800-0000-1000-8000-00805f9b34fb': 'Generic Access',
  '00001801-0000-1000-8000-00805f9b34fb': 'Generic Attribute',
  '0000180a-0000-1000-8000-00805f9b34fb': 'Device Information',
  '0000180d-0000-1000-8000-00805f9b34fb': 'Heart Rate',
  '0000180f-0000-1000-8000-00805f9b34fb': 'Battery',
};

const STANDARD_CHARACTERISTICS: Record<string, string> = {
  '00002a00-0000-1000-8000-00805f9b34fb': 'Device Name',
  '00002a01-0000-1000-8000-00805f9b34fb': 'Appearance',
  '00002a05-0000-1000-8000-00805f9b34fb': 'Service Changed',
  '00002a19-0000-1000-8000-00805f9b34fb': 'Battery Level',
  '00002a24-0000-1000-8000-00805f9b34fb': 'Model Number',
  '00002a25-0000-1000-8000-00805f9b34fb': 'Serial Number',
  '00002a26-0000-1000-8000-00805f9b34fb': 'Firmware Revision',
  '00002a27-0000-1000-8000-00805f9b34fb': 'Hardware Revision',
  '00002a28-0000-1000-8000-00805f9b34fb': 'Software Revision',
  '00002a29-0000-1000-8000-00805f9b34fb': 'Manufacturer Name',
  '00002a37-0000-1000-8000-00805f9b34fb': 'Heart Rate Measurement',
  '00002a38-0000-1000-8000-00805f9b34fb': 'Body Sensor Location',
};

export const OPTIONAL_SERVICES: BluetoothServiceUUID[] = [
  'generic_access',
  'generic_attribute',
  'device_information',
  'heart_rate',
  'battery_service',
  WHOOP_PROPRIETARY_SERVICE,
];

export function normalizeUuid(uuid: string): string {
  const clean = uuid.toLowerCase();
  if (/^[0-9a-f]{4}$/.test(clean)) {
    return `0000${clean}-0000-1000-8000-00805f9b34fb`;
  }
  if (/^[0-9a-f]{8}$/.test(clean)) {
    return `${clean}-0000-1000-8000-00805f9b34fb`;
  }
  return clean;
}

export function uuidLabel(uuid: string): string {
  const normalized = normalizeUuid(uuid);
  return STANDARD_SERVICES[normalized] ?? STANDARD_CHARACTERISTICS[normalized] ?? 'Unknown';
}

export function isKnownUuid(uuid: string): boolean {
  const normalized = normalizeUuid(uuid);
  return normalized in STANDARD_SERVICES || normalized in STANDARD_CHARACTERISTICS;
}

export function dataViewToBytes(view: DataView): number[] {
  return Array.from({ length: view.byteLength }, (_, index) => view.getUint8(index));
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export function hexToBytes(input: string): number[] {
  const clean = input.replace(/0x/gi, '').replace(/[^a-fA-F0-9]/g, '');
  if (clean.length === 0) {
    return [];
  }
  if (clean.length % 2 !== 0) {
    throw new Error('Hex input must contain an even number of digits.');
  }
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 2) {
    bytes.push(Number.parseInt(clean.slice(index, index + 2), 16));
  }
  if (bytes.some((byte) => Number.isNaN(byte))) {
    throw new Error('Hex input contains invalid bytes.');
  }
  return bytes;
}

export function tryDecodeUtf8(bytes: number[]): string | null {
  if (bytes.length === 0) {
    return '';
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    const printable = [...text].filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    });
    return printable.length === text.length ? text : null;
  } catch {
    return null;
  }
}

export function decimalValues(bytes: number[]): string {
  return bytes.join(', ');
}

export function parseHeartRateMeasurement(view: DataView): Omit<HeartRateReading, 'sessionId' | 'deviceId' | 'timestamp'> | null {
  if (view.byteLength < 2) {
    return null;
  }
  const flags = view.getUint8(0);
  const isUint16 = (flags & 0x01) === 0x01;
  const hasEnergy = (flags & 0x08) === 0x08;
  const hasRr = (flags & 0x10) === 0x10;
  let offset = 1;
  const bpm = isUint16 ? view.getUint16(offset, true) : view.getUint8(offset);
  offset += isUint16 ? 2 : 1;
  if (bpm <= 0 || bpm > 240) {
    return null;
  }

  let energyExpended: number | undefined;
  if (hasEnergy && offset + 1 < view.byteLength) {
    energyExpended = view.getUint16(offset, true);
    offset += 2;
  }

  const rrIntervals: number[] = [];
  if (hasRr) {
    while (offset + 1 < view.byteLength) {
      rrIntervals.push(view.getUint16(offset, true) / 1024);
      offset += 2;
    }
  }

  return { bpm, energyExpended, rrIntervals: rrIntervals.length ? rrIntervals : undefined };
}

export function packetToCsv(records: PacketRecord[]): string {
  const header = ['timestamp', 'deviceId', 'deviceName', 'serviceUuid', 'characteristicUuid', 'direction', 'decoded', 'rawHex', 'bytes'];
  const rows = records.map((record) =>
    [
      record.timestamp,
      record.deviceId,
      record.deviceName,
      record.serviceUuid,
      record.characteristicUuid,
      record.direction,
      describePacket(record) ?? '',
      record.rawHex,
      record.bytes.join(' '),
    ].map(csvEscape).join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

export function describePacket(record: PacketRecord): string | null {
  const serviceUuid = normalizeUuid(record.serviceUuid);
  const characteristicUuid = normalizeUuid(record.characteristicUuid);

  if (serviceUuid === '0000180d-0000-1000-8000-00805f9b34fb' && characteristicUuid === '00002a37-0000-1000-8000-00805f9b34fb') {
    const parsed = parseHeartRateMeasurement(new DataView(new Uint8Array(record.bytes).buffer));
    if (!parsed) {
      return 'Heart Rate Measurement: placeholder or invalid zero reading';
    }
    const rr = parsed.rrIntervals?.length ? `, RR ${parsed.rrIntervals.map((value) => `${value.toFixed(3)}s`).join(', ')}` : '';
    return `Heart Rate Measurement: ${parsed.bpm} bpm${rr}`;
  }

  if (serviceUuid === '0000180f-0000-1000-8000-00805f9b34fb' && characteristicUuid === '00002a19-0000-1000-8000-00805f9b34fb') {
    return record.bytes.length ? `Battery Level: ${record.bytes[0]}%` : 'Battery Level: empty packet';
  }

  if (serviceUuid === '61080001-8d6d-82b8-614a-1c8cb0f8dcc6') {
    const text = tryDecodeUtf8(record.bytes);
    const embedded = extractPrintableAscii(record.bytes);
    const detail = embedded.length ? `, text fragments: ${embedded.join(' | ')}` : text ? `, text: ${text}` : '';
    return `WHOOP proprietary notify ${record.characteristicUuid}, ${record.bytes.length} bytes${detail}`;
  }

  return null;
}

export interface WhoopEmbeddedTimestamp {
  iso: string;
  offset: number;
  endian: 'be' | 'le';
  ageMinutes: number;
}

export interface WhoopBacklogRecord {
  packet: PacketRecord;
  kind: 'historical' | 'current' | 'unknown';
  embeddedTimestamps: WhoopEmbeddedTimestamp[];
  trustedHistoricalTimestamps: WhoopEmbeddedTimestamp[];
  historicalTimestamps: WhoopEmbeddedTimestamp[];
  textFragments: string[];
}

export interface WhoopBacklogGroup {
  key: string;
  label: string;
  firstHistoricalIso: string;
  lastHistoricalIso: string;
  records: WhoopBacklogRecord[];
}

export interface WhoopBacklogAnalysis {
  proprietaryRecords: WhoopBacklogRecord[];
  historicalRecords: WhoopBacklogRecord[];
  currentRecords: WhoopBacklogRecord[];
  unknownRecords: WhoopBacklogRecord[];
  groups: WhoopBacklogGroup[];
  firstHistoricalIso?: string;
  lastHistoricalIso?: string;
  characteristicCounts: Record<string, number>;
}

type CborValue =
  | number
  | string
  | boolean
  | null
  | { kind: 'undefined' }
  | { kind: 'bytes'; bytes: number[] }
  | { kind: 'array'; items: CborValue[] }
  | { kind: 'map'; entries: Array<{ key: CborValue; value: CborValue }> };

interface CborDecodeResult {
  value: CborValue;
  offset: number;
}

export interface WhoopCborField {
  path: string;
  value: string;
  timestampIso?: string;
}

export interface WhoopProprietaryFrameDecode {
  packet: PacketRecord;
  label: string;
  cborOffset?: number;
  cborFields: WhoopCborField[];
  embeddedTimestamps: WhoopEmbeddedTimestamp[];
  textFragments: string[];
  repeatedRuns: string[];
}

export interface LocalSleepScoreComponent {
  label: string;
  score: number;
  weight: number;
  reason: string;
}

export interface LocalSleepAnalysis {
  estimatedStartIso?: string;
  estimatedEndIso?: string;
  estimatedDurationMinutes?: number;
  windowSource: 'trusted_backlog' | 'embedded_backlog' | 'none';
  windowEvidencePoints: number;
  hrStats?: {
    min: number;
    avg: number;
    max: number;
    samples: number;
  };
  hrvProxy?: {
    rmssdMs: number;
    rrIntervals: number;
  };
  dataConfidence: number;
  confidenceLabel: 'low' | 'medium' | 'high';
  localScore: number;
  breakdown: LocalSleepScoreComponent[];
  notes: string[];
}

interface SleepWindowCandidate {
  startIso: string;
  endIso: string;
  durationMinutes: number;
  source: LocalSleepAnalysis['windowSource'];
  evidenceIsoValues: string[];
  evidencePoints: number;
}

export function analyzeWhoopBacklog(records: PacketRecord[]): WhoopBacklogAnalysis {
  const proprietaryRecords = records
    .filter((record) => normalizeUuid(record.serviceUuid) === WHOOP_PROPRIETARY_SERVICE && WHOOP_BACKLOG_CHARACTERISTICS.has(normalizeUuid(record.characteristicUuid)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((packet) => {
      const embeddedTimestamps = extractEmbeddedUnixTimestamps(packet);
      const trustedHistoricalTimestamps = extractTrustedHistoricalTimestamps(packet);
      const historicalTimestamps = trustedHistoricalTimestamps;
      const kind: WhoopBacklogRecord['kind'] = historicalTimestamps.length ? 'historical' : embeddedTimestamps.length ? 'current' : 'unknown';
      return {
        packet,
        kind,
        embeddedTimestamps,
        trustedHistoricalTimestamps,
        historicalTimestamps,
        textFragments: extractPrintableAscii(packet.bytes),
      };
    });

  const historicalRecords = proprietaryRecords.filter((record) => record.kind === 'historical');
  const currentRecords = proprietaryRecords.filter((record) => record.kind === 'current');
  const unknownRecords = proprietaryRecords.filter((record) => record.kind === 'unknown');
  const allHistoricalTimestamps = historicalRecords.flatMap((record) => record.historicalTimestamps.map((item) => item.iso)).sort();
  const characteristicCounts = proprietaryRecords.reduce<Record<string, number>>((counts, record) => {
    const key = normalizeUuid(record.packet.characteristicUuid);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  return {
    proprietaryRecords,
    historicalRecords,
    currentRecords,
    unknownRecords,
    groups: groupBacklogRecords(historicalRecords),
    firstHistoricalIso: allHistoricalTimestamps[0],
    lastHistoricalIso: allHistoricalTimestamps[allHistoricalTimestamps.length - 1],
    characteristicCounts,
  };
}

export function decodeWhoopProprietaryFrames(records: PacketRecord[]): WhoopProprietaryFrameDecode[] {
  return records
    .filter((record) => normalizeUuid(record.serviceUuid) === WHOOP_PROPRIETARY_SERVICE && WHOOP_BACKLOG_CHARACTERISTICS.has(normalizeUuid(record.characteristicUuid)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((packet) => {
      const cborOffset = findLikelyCborOffset(packet.bytes);
      const cborFields = cborOffset === undefined ? [] : decodeCborFields(packet.bytes, cborOffset);
      return {
        packet,
        label: describeWhoopFrame(packet, cborOffset),
        cborOffset,
        cborFields,
        embeddedTimestamps: extractEmbeddedUnixTimestamps(packet),
        textFragments: extractPrintableAscii(packet.bytes),
        repeatedRuns: detectRepeatedRuns(packet.bytes),
      };
    });
}

export function analyzeLocalSleep(records: PacketRecord[], backlog: WhoopBacklogAnalysis): LocalSleepAnalysis {
  const trustedIsoValues = uniqueSorted(backlog.historicalRecords.flatMap((record) => record.trustedHistoricalTimestamps.map((item) => item.iso)));
  const historicalIsoValues = uniqueSorted(backlog.historicalRecords.flatMap((record) => record.historicalTimestamps.map((item) => item.iso)));
  const sleepWindow = selectPlausibleSleepWindow(trustedIsoValues.length >= 3 ? trustedIsoValues : historicalIsoValues, records, trustedIsoValues.length >= 3 ? 'trusted_backlog' : 'embedded_backlog');
  const estimatedStartIso = sleepWindow?.startIso;
  const estimatedEndIso = sleepWindow?.endIso;
  const estimatedDurationMinutes = sleepWindow?.durationMinutes;
  const sleepEvidenceIsoValues = sleepWindow?.evidenceIsoValues ?? [];
  const windowSource = sleepWindow?.source ?? 'none';
  const sleepHrPackets = estimatedStartIso && estimatedEndIso ? extractHeartRatePackets(records, estimatedStartIso, estimatedEndIso) : [];
  const hrValues = sleepHrPackets.map((item) => item.bpm);
  const rrIntervals = sleepHrPackets.flatMap((item) => item.rrIntervals ?? []);
  const hrStats = hrValues.length
    ? {
      min: Math.min(...hrValues),
      avg: round(average(hrValues), 1),
      max: Math.max(...hrValues),
      samples: hrValues.length,
    }
    : undefined;
  const hrvProxy = rrIntervals.length >= 3
    ? {
      rmssdMs: round(calculateRmssd(rrIntervals), 1),
      rrIntervals: rrIntervals.length,
    }
    : undefined;
  const continuityScore = scoreContinuity(sleepEvidenceIsoValues.length ? sleepEvidenceIsoValues : historicalIsoValues);
  const durationScore = estimatedDurationMinutes === undefined ? 0 : scoreDuration(estimatedDurationMinutes);
  const hrScore = hrStats ? scoreHeartRate(hrStats.avg, hrStats.max - hrStats.min) : 50;
  const hrvScore = hrvProxy ? scoreRmssd(hrvProxy.rmssdMs) : 50;
  const confidenceScore = scoreDataConfidence({
    historicalRecords: backlog.historicalRecords.length,
    durationMinutes: estimatedDurationMinutes ?? 0,
    continuityScore,
    hrSamples: hrValues.length,
    rrIntervals: rrIntervals.length,
  });
  const breakdown: LocalSleepScoreComponent[] = [
    {
      label: 'Duration',
      score: durationScore,
      weight: 35,
      reason: estimatedDurationMinutes === undefined
        ? 'No historical sleep window found yet.'
        : `${formatDuration(estimatedDurationMinutes)} inferred from ${sleepWindow?.evidencePoints ?? 0} trusted overnight backlog timestamp${sleepWindow?.evidencePoints === 1 ? '' : 's'}.`,
    },
    {
      label: 'Resting HR stability',
      score: hrScore,
      weight: 25,
      reason: hrStats
        ? `${hrStats.samples} overnight HR samples, avg ${hrStats.avg} bpm, range ${hrStats.min}-${hrStats.max}.`
        : 'No standard heart-rate packets were timestamped inside the estimated sleep window.',
    },
    {
      label: 'HRV proxy',
      score: hrvScore,
      weight: 20,
      reason: hrvProxy
        ? `RMSSD proxy ${hrvProxy.rmssdMs} ms from ${hrvProxy.rrIntervals} RR intervals.`
        : 'Not enough overnight RR intervals for an RMSSD proxy.',
    },
    {
      label: 'Continuity',
      score: continuityScore,
      weight: 10,
      reason: sleepEvidenceIsoValues.length
        ? `${sleepEvidenceIsoValues.length} automatic sleep-window timestamp point${sleepEvidenceIsoValues.length === 1 ? '' : 's'} found.`
        : 'No historical timestamp continuity detected yet.',
    },
    {
      label: 'Data confidence',
      score: confidenceScore,
      weight: 10,
      reason: `${backlog.historicalRecords.length} historical proprietary packet${backlog.historicalRecords.length === 1 ? '' : 's'} and ${hrValues.length} overnight HR sample${hrValues.length === 1 ? '' : 's'}.`,
    },
  ];
  const localScore = Math.round(breakdown.reduce((sum, component) => sum + component.score * (component.weight / 100), 0));
  const notes = [
    'This is a local estimate, not the official WHOOP sleep score.',
    hrStats ? 'Overnight HR was available from locally timestamped standard HR packets.' : 'Overnight HR was not available in standard HR packets; HR and HRV components are neutral placeholders.',
    estimatedDurationMinutes !== undefined
      ? 'Sleep window is automatic and based on trusted overnight timestamp fields in proprietary WHOOP packets.'
      : historicalIsoValues.length
        ? 'Embedded timestamps were detected, but they did not form a plausible sleep window yet.'
        : 'Reconnect again after a disconnected night to populate the sleep window.',
  ];

  return {
    estimatedStartIso,
    estimatedEndIso,
    estimatedDurationMinutes,
    windowSource,
    windowEvidencePoints: sleepWindow?.evidencePoints ?? 0,
    hrStats,
    hrvProxy,
    dataConfidence: confidenceScore,
    confidenceLabel: confidenceScore >= 75 ? 'high' : confidenceScore >= 45 ? 'medium' : 'low',
    localScore,
    breakdown,
    notes,
  };
}

function selectPlausibleSleepWindow(
  isoValues: string[],
  records: PacketRecord[],
  source: LocalSleepAnalysis['windowSource'],
): SleepWindowCandidate | undefined {
  const latestPacketTime = records
    .map((record) => new Date(record.timestamp).getTime())
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => b - a)[0];
  const lookbackStart = latestPacketTime === undefined ? undefined : latestPacketTime - TRUSTED_SLEEP_LOOKBACK_MINUTES * 60000;
  const sorted = isoValues
    .map((iso) => ({ iso, time: new Date(iso).getTime() }))
    .filter((item) => Number.isFinite(item.time))
    .filter((item) => lookbackStart === undefined || (item.time >= lookbackStart && item.time <= latestPacketTime + 5 * 60000))
    .filter((item) => isOvernightTimestamp(item.time))
    .sort((a, b) => a.time - b.time);

  const gapWindow = selectOvernightDisconnectSleepWindow(records, sorted, source, latestPacketTime);
  if (gapWindow) {
    return gapWindow;
  }

  if (sorted.length < 3) {
    return undefined;
  }

  const clusters: Array<typeof sorted> = [];
  let current: typeof sorted = [];

  for (const item of sorted) {
    const previous = current.at(-1);
    const gapMinutes = previous ? (item.time - previous.time) / 60000 : 0;
    const wouldExceedMax = current.length > 0 && (item.time - current[0].time) / 60000 > MAX_SLEEP_WINDOW_MINUTES;

    if (previous && (gapMinutes > MAX_SLEEP_TIMESTAMP_GAP_MINUTES || wouldExceedMax)) {
      clusters.push(current);
      current = [];
    }

    current.push(item);
  }

  if (current.length) {
    clusters.push(current);
  }

  const candidates = clusters
    .map((cluster) => {
      const first = cluster[0];
      const last = cluster.at(-1);
      if (!first || !last) {
        return undefined;
      }
      const intervalMinutes = estimateSampleIntervalMinutes(cluster);
      const inferredEndTime = Math.min(last.time + intervalMinutes * 60000, first.time + MAX_SLEEP_WINDOW_MINUTES * 60000);
      const durationMinutes = Math.round((inferredEndTime - first.time) / 60000);
      return {
        startIso: first.iso,
        endIso: new Date(inferredEndTime).toISOString(),
        durationMinutes,
        points: cluster.length,
        evidenceIsoValues: cluster.map((item) => item.iso),
        score: scoreSleepWindowCandidate(first.time, inferredEndTime, cluster.length, source),
      };
    })
    .filter((candidate): candidate is SleepWindowCandidate & { points: number; score: number } => {
      if (!candidate) {
        return false;
      }
      return candidate.points >= 3
        && candidate.durationMinutes >= MIN_SLEEP_WINDOW_MINUTES
        && candidate.durationMinutes <= MAX_SLEEP_WINDOW_MINUTES;
    });

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  return best ? {
    startIso: best.startIso,
    endIso: best.endIso,
    durationMinutes: best.durationMinutes,
    source,
    evidenceIsoValues: best.evidenceIsoValues,
    evidencePoints: best.points,
  } : undefined;
}

function selectOvernightDisconnectSleepWindow(
  records: PacketRecord[],
  trustedPoints: Array<{ iso: string; time: number }>,
  source: LocalSleepAnalysis['windowSource'],
  latestPacketTime?: number,
): SleepWindowCandidate | undefined {
  if (latestPacketTime === undefined) {
    return undefined;
  }

  const lookbackStart = latestPacketTime - TRUSTED_SLEEP_LOOKBACK_MINUTES * 60000;
  const packetTimes = [...new Set(records
    .map((record) => new Date(record.timestamp).getTime())
    .filter((time) => Number.isFinite(time))
    .filter((time) => time >= lookbackStart && time <= latestPacketTime + 5 * 60000))]
    .sort((a, b) => a - b);

  if (packetTimes.length < 2) {
    return undefined;
  }

  const candidates: Array<SleepWindowCandidate & { score: number }> = [];

  for (let index = 1; index < packetTimes.length; index += 1) {
    const gapStartTime = packetTimes[index - 1];
    const gapEndTime = packetTimes[index];
    const gapMinutes = (gapEndTime - gapStartTime) / 60000;

    if (
      gapMinutes < MIN_OVERNIGHT_DISCONNECT_GAP_MINUTES
      || gapMinutes > MAX_OVERNIGHT_DISCONNECT_GAP_MINUTES
      || !isLikelyOvernightDisconnectGap(gapStartTime, gapEndTime)
    ) {
      continue;
    }

    const evidencePoints = trustedPoints.filter((point) => point.time > gapStartTime + 15 * 60000 && point.time < gapEndTime + 15 * 60000);
    if (evidencePoints.length < 2) {
      continue;
    }
    const startTime = inferSleepStartFromDisconnectGap(gapStartTime, gapEndTime, evidencePoints);
    const endTime = gapEndTime;
    const durationMinutes = Math.round((endTime - startTime) / 60000);

    if (durationMinutes < MIN_SLEEP_WINDOW_MINUTES || durationMinutes > MAX_SLEEP_WINDOW_MINUTES) {
      continue;
    }

    candidates.push({
      startIso: new Date(startTime).toISOString(),
      endIso: new Date(endTime).toISOString(),
      durationMinutes,
      source,
      evidenceIsoValues: evidencePoints.map((point) => point.iso),
      evidencePoints: evidencePoints.length,
      score: scoreDisconnectSleepWindow(gapStartTime, gapEndTime, startTime, evidencePoints.length, latestPacketTime),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  return best ? {
    startIso: best.startIso,
    endIso: best.endIso,
    durationMinutes: best.durationMinutes,
    source: best.source,
    evidenceIsoValues: best.evidenceIsoValues,
    evidencePoints: best.evidencePoints,
  } : undefined;
}

function isLikelyOvernightDisconnectGap(startTime: number, endTime: number): boolean {
  const startHour = new Date(startTime).getHours();
  const endHour = new Date(endTime).getHours();
  const startsAtNight = startHour >= 19 || startHour <= 3;
  const endsInMorning = endHour >= 4 && endHour <= 12;
  return startsAtNight && endsInMorning;
}

function inferSleepStartFromDisconnectGap(
  gapStartTime: number,
  gapEndTime: number,
  evidencePoints: Array<{ time: number }>,
): number {
  const sortedPoints = [...evidencePoints].sort((a, b) => a.time - b.time);
  const firstPoint = sortedPoints[0];
  const secondPoint = sortedPoints[1];
  const defaultStartTime = gapStartTime + 90 * 60000;

  if (secondPoint && secondPoint.time - gapStartTime <= 3 * 60 * 60000) {
    return secondPoint.time;
  }

  if (firstPoint && firstPoint.time - gapStartTime >= 75 * 60000) {
    return firstPoint.time;
  }

  return Math.min(defaultStartTime, gapEndTime - MIN_SLEEP_WINDOW_MINUTES * 60000);
}

function scoreDisconnectSleepWindow(
  gapStartTime: number,
  gapEndTime: number,
  sleepStartTime: number,
  evidencePoints: number,
  latestPacketTime: number,
): number {
  const durationMinutes = (gapEndTime - sleepStartTime) / 60000;
  const latencyMinutes = (sleepStartTime - gapStartTime) / 60000;
  const recencyMinutes = Math.abs(latestPacketTime - gapEndTime) / 60000;
  const durationScore = 120 - Math.min(90, Math.abs(durationMinutes - 390) / 2);
  const latencyScore = latencyMinutes >= 35 && latencyMinutes <= 180 ? 40 : 10;
  const evidenceScore = Math.min(80, evidencePoints * 22);
  const recencyScore = Math.max(0, 35 - recencyMinutes / 10);
  return durationScore + latencyScore + evidenceScore + recencyScore;
}

function isOvernightTimestamp(time: number): boolean {
  const hour = new Date(time).getHours();
  return hour >= 18 || hour <= 12;
}

function estimateSampleIntervalMinutes(cluster: Array<{ time: number }>): number {
  const gaps = cluster
    .slice(1)
    .map((item, index) => (item.time - cluster[index].time) / 60000)
    .filter((gap) => gap >= 35 && gap <= MAX_SLEEP_TIMESTAMP_GAP_MINUTES)
    .sort((a, b) => a - b);
  if (!gaps.length) {
    return 60;
  }
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

function scoreSleepWindowCandidate(
  startTime: number,
  endTime: number,
  points: number,
  source: LocalSleepAnalysis['windowSource'],
): number {
  const durationMinutes = (endTime - startTime) / 60000;
  const startHour = new Date(startTime).getHours();
  const endHour = new Date(endTime).getHours();
  const durationScore = 100 - Math.min(75, Math.abs(durationMinutes - 390) / 3);
  const startScore = startHour >= 20 || startHour <= 3 ? 35 : startHour >= 18 ? 20 : 0;
  const endScore = endHour >= 4 && endHour <= 10 ? 35 : endHour >= 2 && endHour <= 12 ? 18 : 0;
  const pointScore = Math.min(90, points * 18);
  const sourceScore = source === 'trusted_backlog' ? 35 : 0;
  return durationScore + startScore + endScore + pointScore + sourceScore;
}

export function extractPrintableAscii(bytes: number[]): string[] {
  const fragments: string[] = [];
  let current = '';

  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 4) {
        fragments.push(current);
      }
      current = '';
    }
  }

  if (current.length >= 4) {
    fragments.push(current);
  }

  return fragments.slice(0, 6);
}

function extractHeartRatePackets(records: PacketRecord[], startIso: string, endIso: string): Array<{ bpm: number; rrIntervals?: number[] }> {
  return records
    .filter((record) => {
      const serviceUuid = normalizeUuid(record.serviceUuid);
      const characteristicUuid = normalizeUuid(record.characteristicUuid);
      return serviceUuid === HEART_RATE_SERVICE
        && characteristicUuid === HEART_RATE_MEASUREMENT
        && record.timestamp >= startIso
        && record.timestamp <= endIso;
    })
    .map((record) => parseHeartRateMeasurement(new DataView(new Uint8Array(record.bytes).buffer)))
    .filter((reading): reading is Omit<HeartRateReading, 'sessionId' | 'deviceId' | 'timestamp'> => Boolean(reading));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function calculateRmssd(rrIntervalsSeconds: number[]): number {
  const diffs: number[] = [];
  for (let index = 1; index < rrIntervalsSeconds.length; index += 1) {
    diffs.push((rrIntervalsSeconds[index] - rrIntervalsSeconds[index - 1]) * 1000);
  }
  return Math.sqrt(average(diffs.map((diff) => diff ** 2)));
}

function scoreDuration(minutes: number): number {
  if (minutes <= 0) {
    return 0;
  }
  const hours = minutes / 60;
  if (hours < 4) {
    return Math.round(hours * 12.5);
  }
  if (hours < 7.5) {
    return Math.round(50 + ((hours - 4) / 3.5) * 45);
  }
  if (hours <= 9) {
    return 100;
  }
  return clamp(Math.round(100 - (hours - 9) * 12), 60, 100);
}

function scoreHeartRate(avgBpm: number, range: number): number {
  const avgScore = clamp(Math.round(120 - Math.max(0, avgBpm - 45) * 2.2), 20, 100);
  const stabilityScore = clamp(Math.round(100 - Math.max(0, range - 8) * 2), 35, 100);
  return Math.round(avgScore * 0.65 + stabilityScore * 0.35);
}

function scoreRmssd(rmssdMs: number): number {
  if (rmssdMs >= 70) {
    return 100;
  }
  if (rmssdMs >= 45) {
    return Math.round(80 + ((rmssdMs - 45) / 25) * 20);
  }
  if (rmssdMs >= 25) {
    return Math.round(55 + ((rmssdMs - 25) / 20) * 25);
  }
  return clamp(Math.round(rmssdMs * 2), 10, 55);
}

function scoreContinuity(timestamps: string[]): number {
  if (timestamps.length === 0) {
    return 0;
  }
  if (timestamps.length === 1) {
    return 25;
  }
  const gaps = timestamps.slice(1).map((iso, index) => (new Date(iso).getTime() - new Date(timestamps[index]).getTime()) / 60000);
  const reasonableGaps = gaps.filter((gap) => gap > 0 && gap <= 95).length;
  const regularity = reasonableGaps / gaps.length;
  const countScore = Math.min(100, timestamps.length * 16);
  return Math.round(countScore * 0.45 + regularity * 55);
}

function scoreDataConfidence({
  historicalRecords,
  durationMinutes,
  continuityScore,
  hrSamples,
  rrIntervals,
}: {
  historicalRecords: number;
  durationMinutes: number;
  continuityScore: number;
  hrSamples: number;
  rrIntervals: number;
}): number {
  const packetScore = Math.min(100, historicalRecords * 12);
  const durationScore = Math.min(100, (durationMinutes / 480) * 100);
  const hrScore = Math.min(100, hrSamples * 2);
  const rrScore = Math.min(100, rrIntervals * 2);
  return clamp(Math.round(packetScore * 0.35 + durationScore * 0.25 + continuityScore * 0.25 + hrScore * 0.1 + rrScore * 0.05), 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) {
    return `${remainder}m`;
  }
  return `${hours}h ${String(remainder).padStart(2, '0')}m`;
}

function extractEmbeddedUnixTimestamps(packet: PacketRecord): WhoopEmbeddedTimestamp[] {
  const packetSeconds = Math.floor(new Date(packet.timestamp).getTime() / 1000);
  const maxSeconds = Math.floor(Math.max(Date.now(), new Date(packet.timestamp).getTime()) / 1000) + 24 * 60 * 60;
  const seen = new Set<string>();
  const hits: WhoopEmbeddedTimestamp[] = [];

  for (let offset = 0; offset <= packet.bytes.length - 4; offset += 1) {
    const be = packet.bytes[offset] * 0x1000000 + packet.bytes[offset + 1] * 0x10000 + packet.bytes[offset + 2] * 0x100 + packet.bytes[offset + 3];
    const le = packet.bytes[offset] + packet.bytes[offset + 1] * 0x100 + packet.bytes[offset + 2] * 0x10000 + packet.bytes[offset + 3] * 0x1000000;
    addTimestampHit(hits, seen, be, offset, 'be', packetSeconds, maxSeconds);
    addTimestampHit(hits, seen, le, offset, 'le', packetSeconds, maxSeconds);
  }

  return hits.sort((a, b) => a.iso.localeCompare(b.iso));
}

function extractTrustedHistoricalTimestamps(packet: PacketRecord): WhoopEmbeddedTimestamp[] {
  if (normalizeUuid(packet.characteristicUuid) !== '61080007-8d6d-82b8-614a-1c8cb0f8dcc6') {
    return [];
  }

  const packetSeconds = Math.floor(new Date(packet.timestamp).getTime() / 1000);
  const maxSeconds = packetSeconds + 5 * 60;
  const minSeconds = packetSeconds - TRUSTED_SLEEP_LOOKBACK_MINUTES * 60;
  const seen = new Set<string>();
  const hits: WhoopEmbeddedTimestamp[] = [];

  for (let offset = 1; offset <= packet.bytes.length - 4; offset += 1) {
    if (packet.bytes[offset - 1] !== 0x1a) {
      continue;
    }
    const seconds = packet.bytes[offset] * 0x1000000
      + packet.bytes[offset + 1] * 0x10000
      + packet.bytes[offset + 2] * 0x100
      + packet.bytes[offset + 3];
    if (seconds < minSeconds || seconds > maxSeconds || seconds < TIMESTAMP_MIN_SECONDS) {
      continue;
    }
    const iso = new Date(seconds * 1000).toISOString();
    if (seen.has(iso)) {
      continue;
    }
    seen.add(iso);
    hits.push({
      iso,
      offset,
      endian: 'be',
      ageMinutes: Math.max(0, Math.round((packetSeconds - seconds) / 60)),
    });
  }

  return hits.sort((a, b) => a.iso.localeCompare(b.iso));
}

function addTimestampHit(
  hits: WhoopEmbeddedTimestamp[],
  seen: Set<string>,
  seconds: number,
  offset: number,
  endian: WhoopEmbeddedTimestamp['endian'],
  packetSeconds: number,
  maxSeconds: number,
): void {
  if (seconds < TIMESTAMP_MIN_SECONDS || seconds > maxSeconds) {
    return;
  }
  const iso = new Date(seconds * 1000).toISOString();
  const key = `${iso}:${offset}:${endian}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  hits.push({
    iso,
    offset,
    endian,
    ageMinutes: Math.max(0, Math.round((packetSeconds - seconds) / 60)),
  });
}

function groupBacklogRecords(records: WhoopBacklogRecord[]): WhoopBacklogGroup[] {
  const groups = new Map<string, WhoopBacklogGroup>();

  for (const record of records) {
    const firstTimestamp = record.historicalTimestamps[0];
    if (!firstTimestamp) {
      continue;
    }
    const date = new Date(firstTimestamp.iso);
    const key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      String(date.getHours()).padStart(2, '0'),
    ].join('-');
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(record);
      existing.firstHistoricalIso = [existing.firstHistoricalIso, ...record.historicalTimestamps.map((item) => item.iso)].sort()[0];
      existing.lastHistoricalIso = [existing.lastHistoricalIso, ...record.historicalTimestamps.map((item) => item.iso)].sort().at(-1) ?? existing.lastHistoricalIso;
    } else {
      const isoValues = record.historicalTimestamps.map((item) => item.iso).sort();
      groups.set(key, {
        key,
        label: new Intl.DateTimeFormat(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
        }).format(date),
        firstHistoricalIso: isoValues[0],
        lastHistoricalIso: isoValues[isoValues.length - 1],
        records: [record],
      });
    }
  }

  return [...groups.values()].sort((a, b) => a.firstHistoricalIso.localeCompare(b.firstHistoricalIso));
}

function findLikelyCborOffset(bytes: number[]): number | undefined {
  const offset = bytes.findIndex((byte, index) => index <= 8 && byte >= 0xa0 && byte <= 0xbf);
  return offset >= 0 ? offset : undefined;
}

function decodeCborFields(bytes: number[], offset: number): WhoopCborField[] {
  try {
    const decoded = decodeCborValue(bytes, offset, 0);
    const fields = flattenCborValue(decoded.value);
    const consumed = decoded.offset - offset;
    return [
      { path: 'root', value: `${formatCborType(decoded.value)} (${consumed} decoded bytes)` },
      ...fields.slice(0, 48),
    ];
  } catch (error) {
    return [{ path: 'decode_error', value: error instanceof Error ? error.message : 'CBOR parse failed' }];
  }
}

function decodeCborValue(bytes: number[], offset: number, depth: number): CborDecodeResult {
  if (depth > 8) {
    throw new Error('CBOR nesting too deep');
  }
  if (offset >= bytes.length) {
    throw new Error('Unexpected end of CBOR data');
  }

  const first = bytes[offset];
  const major = first >> 5;
  const additional = first & 0x1f;
  const argument = readCborArgument(bytes, offset + 1, additional);
  let cursor = argument.offset;

  if (major === 0) {
    return { value: argument.value, offset: cursor };
  }
  if (major === 1) {
    return { value: -1 - argument.value, offset: cursor };
  }
  if (major === 2) {
    const end = cursor + argument.value;
    if (end > bytes.length) {
      throw new Error('Byte string exceeds packet length');
    }
    return { value: { kind: 'bytes', bytes: bytes.slice(cursor, end) }, offset: end };
  }
  if (major === 3) {
    const end = cursor + argument.value;
    if (end > bytes.length) {
      throw new Error('Text string exceeds packet length');
    }
    return { value: new TextDecoder().decode(new Uint8Array(bytes.slice(cursor, end))), offset: end };
  }
  if (major === 4) {
    const items: CborValue[] = [];
    for (let index = 0; index < argument.value; index += 1) {
      const decoded = decodeCborValue(bytes, cursor, depth + 1);
      items.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value: { kind: 'array', items }, offset: cursor };
  }
  if (major === 5) {
    const entries: Array<{ key: CborValue; value: CborValue }> = [];
    for (let index = 0; index < argument.value; index += 1) {
      const key = decodeCborValue(bytes, cursor, depth + 1);
      const value = decodeCborValue(bytes, key.offset, depth + 1);
      entries.push({ key: key.value, value: value.value });
      cursor = value.offset;
    }
    return { value: { kind: 'map', entries }, offset: cursor };
  }
  if (major === 7) {
    if (additional === 20) {
      return { value: false, offset: offset + 1 };
    }
    if (additional === 21) {
      return { value: true, offset: offset + 1 };
    }
    if (additional === 22) {
      return { value: null, offset: offset + 1 };
    }
    if (additional === 23) {
      return { value: { kind: 'undefined' }, offset: offset + 1 };
    }
    return { value: `simple(${additional})`, offset: cursor };
  }

  throw new Error(`Unsupported CBOR major type ${major}`);
}

function readCborArgument(bytes: number[], offset: number, additional: number): { value: number; offset: number } {
  if (additional < 24) {
    return { value: additional, offset };
  }
  if (additional === 24) {
    ensureBytes(bytes, offset, 1);
    return { value: bytes[offset], offset: offset + 1 };
  }
  if (additional === 25) {
    ensureBytes(bytes, offset, 2);
    return { value: bytes[offset] * 0x100 + bytes[offset + 1], offset: offset + 2 };
  }
  if (additional === 26) {
    ensureBytes(bytes, offset, 4);
    return {
      value: bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3],
      offset: offset + 4,
    };
  }
  if (additional === 27) {
    ensureBytes(bytes, offset, 8);
    const high = bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
    const low = bytes[offset + 4] * 0x1000000 + bytes[offset + 5] * 0x10000 + bytes[offset + 6] * 0x100 + bytes[offset + 7];
    return { value: high * 0x100000000 + low, offset: offset + 8 };
  }
  throw new Error(`Unsupported CBOR additional value ${additional}`);
}

function ensureBytes(bytes: number[], offset: number, length: number): void {
  if (offset + length > bytes.length) {
    throw new Error('Unexpected end of CBOR data');
  }
}

function flattenCborValue(value: CborValue, path = 'root'): WhoopCborField[] {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' || value === null || 'kind' in value && (value.kind === 'bytes' || value.kind === 'undefined')) {
    return [formatCborField(path, value)];
  }

  if ('kind' in value && value.kind === 'array') {
    return value.items.flatMap((item, index) => flattenCborValue(item, `${path}[${index}]`));
  }

  if ('kind' in value && value.kind === 'map') {
    return value.entries.flatMap((entry) => flattenCborValue(entry.value, `${path}.${formatCborKey(entry.key)}`));
  }

  return [];
}

function formatCborField(path: string, value: CborValue): WhoopCborField {
  const timestampIso = typeof value === 'number' && isPlausibleUnixTimestamp(value) ? new Date(value * 1000).toISOString() : undefined;
  return {
    path,
    value: timestampIso ? `${value} (${timestampIso})` : formatCborScalar(value),
    timestampIso,
  };
}

function formatCborKey(value: CborValue): string {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }
  return formatCborScalar(value);
}

function formatCborType(value: CborValue): string {
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'text';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (value === null) {
    return 'null';
  }
  if (value.kind === 'bytes') {
    return `bytes[${value.bytes.length}]`;
  }
  if (value.kind === 'array') {
    return `array[${value.items.length}]`;
  }
  if (value.kind === 'map') {
    return `map[${value.entries.length}]`;
  }
  return 'undefined';
}

function formatCborScalar(value: CborValue): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (value === null) {
    return 'null';
  }
  if (value.kind === 'bytes') {
    return `bytes[${value.bytes.length}] ${bytesToHex(value.bytes.slice(0, 12))}${value.bytes.length > 12 ? '...' : ''}`;
  }
  if (value.kind === 'array') {
    return `array[${value.items.length}]`;
  }
  if (value.kind === 'map') {
    return `map[${value.entries.length}]`;
  }
  return 'undefined';
}

function isPlausibleUnixTimestamp(value: number): boolean {
  const maxSeconds = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  return Number.isInteger(value) && value >= TIMESTAMP_MIN_SECONDS && value <= maxSeconds;
}

function describeWhoopFrame(packet: PacketRecord, cborOffset?: number): string {
  const characteristic = normalizeUuid(packet.characteristicUuid);
  const byte = cborOffset === undefined ? undefined : packet.bytes[cborOffset];
  const text = extractPrintableAscii(packet.bytes).join(' ');
  if (characteristic.endsWith('0007-8d6d-82b8-614a-1c8cb0f8dcc6') && byte === 0xa7) {
    return text.includes('harvard') ? 'CBOR telemetry/history frame (harvard)' : 'CBOR telemetry/history frame';
  }
  if (characteristic.endsWith('0007-8d6d-82b8-614a-1c8cb0f8dcc6') && byte === 0xa6) {
    return text.includes('boylston') ? 'CBOR status/config frame (boylston)' : 'CBOR status/config frame';
  }
  if (characteristic.endsWith('0004-8d6d-82b8-614a-1c8cb0f8dcc6') && packet.bytes[0] === 0xaa) {
    return 'Compact binary event frame';
  }
  return cborOffset === undefined ? 'Unknown proprietary binary frame' : 'CBOR-like proprietary frame';
}

function detectRepeatedRuns(bytes: number[]): string[] {
  const runs: string[] = [];
  let start = 0;
  for (let index = 1; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] === bytes[start]) {
      continue;
    }
    const length = index - start;
    if (length >= 4) {
      runs.push(`${bytes[start].toString(16).padStart(2, '0')} x${length} @${start}`);
    }
    start = index;
  }
  return runs.slice(0, 8);
}

export function downloadText(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function latestByTimestamp<T extends HeartRateReading | BatteryReading>(items: T[]): T | undefined {
  return [...items].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
