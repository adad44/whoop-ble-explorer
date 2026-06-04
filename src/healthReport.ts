import type { BatteryReading, HeartRateReading, PacketRecord } from './types';
import {
  analyzeLocalSleep,
  analyzeWhoopBacklog,
  bytesToHex,
  decodeWhoopProprietaryFrames,
  hexToBytes,
  normalizeUuid,
  parseHeartRateMeasurement,
} from './utils';
import type { LocalSleepAnalysis, WhoopBacklogAnalysis, WhoopProprietaryFrameDecode } from './utils';

const HEART_RATE_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HEART_RATE_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_LEVEL = '00002a19-0000-1000-8000-00805f9b34fb';
const WHOOP_PROPRIETARY_SERVICE = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';

export interface HealthReport {
  sourceLabel: string;
  packetCount: number;
  captureWindow?: {
    startIso: string;
    endIso: string;
    durationMinutes: number;
  };
  deviceNames: string[];
  services: Array<{ uuid: string; count: number }>;
  standard: {
    heartRatePackets: number;
    heartRateReadings: HeartRateReading[];
    heartRateStats?: {
      min: number;
      avg: number;
      max: number;
      samples: number;
    };
    rrIntervals: number;
    rmssdMs?: number;
    batteryReadings: BatteryReading[];
    latestBattery?: number;
  };
  proprietary: {
    packets: number;
    historicalPackets: number;
    decodedFrames: number;
    cborLikeFrames: number;
    timestampFields: number;
    textFragments: string[];
    backlog: WhoopBacklogAnalysis;
    frames: WhoopProprietaryFrameDecode[];
  };
  sleep: LocalSleepAnalysis;
  confidence: {
    score: number;
    label: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  insights: string[];
  limitations: string[];
  nextActions: string[];
}

export function normalizeBluefyCapture(input: unknown, sourceLabel = 'Imported Bluefy capture'): PacketRecord[] {
  const candidates = findPacketArray(input);
  const sessionId = `import-${Date.now()}`;
  return candidates
    .map((item, index) => normalizePacketLike(item, index, sessionId, sourceLabel))
    .filter((packet): packet is PacketRecord => Boolean(packet))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function buildWhoopHealthReport(
  records: PacketRecord[],
  sourceLabel = 'Local capture',
): HealthReport {
  const packets = records
    .map((record) => ({
      ...record,
      serviceUuid: normalizeUuid(record.serviceUuid),
      characteristicUuid: normalizeUuid(record.characteristicUuid),
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const backlog = analyzeWhoopBacklog(packets);
  const sleep = analyzeLocalSleep(packets, backlog);
  const frames = decodeWhoopProprietaryFrames(packets);
  const heartRateReadings = extractHeartRateReadings(packets);
  const batteryReadings = extractBatteryReadings(packets);
  const rrIntervals = heartRateReadings.flatMap((reading) => reading.rrIntervals ?? []);
  const hrValues = heartRateReadings.map((reading) => reading.bpm);
  const captureWindow = getCaptureWindow(packets);
  const proprietaryPackets = packets.filter((packet) => packet.serviceUuid === WHOOP_PROPRIETARY_SERVICE);
  const confidence = calculateReportConfidence({
    packetCount: packets.length,
    heartRateReadings: heartRateReadings.length,
    rrIntervals: rrIntervals.length,
    historicalPackets: backlog.historicalRecords.length,
    decodedFrames: frames.length,
    sleepConfidence: sleep.dataConfidence,
  });

  return {
    sourceLabel,
    packetCount: packets.length,
    captureWindow,
    deviceNames: unique(packets.map((packet) => packet.deviceName).filter(Boolean)),
    services: summarizeServices(packets),
    standard: {
      heartRatePackets: packets.filter((packet) => packet.serviceUuid === HEART_RATE_SERVICE && packet.characteristicUuid === HEART_RATE_MEASUREMENT).length,
      heartRateReadings,
      heartRateStats: hrValues.length
        ? {
          min: Math.min(...hrValues),
          avg: round(average(hrValues), 1),
          max: Math.max(...hrValues),
          samples: hrValues.length,
        }
        : undefined,
      rrIntervals: rrIntervals.length,
      rmssdMs: rrIntervals.length >= 3 ? round(calculateRmssd(rrIntervals), 1) : undefined,
      batteryReadings,
      latestBattery: batteryReadings.at(-1)?.percentage,
    },
    proprietary: {
      packets: proprietaryPackets.length,
      historicalPackets: backlog.historicalRecords.length,
      decodedFrames: frames.length,
      cborLikeFrames: frames.filter((frame) => frame.cborOffset !== undefined).length,
      timestampFields: frames.reduce((sum, frame) => sum + frame.cborFields.filter((field) => field.timestampIso).length, 0),
      textFragments: unique(frames.flatMap((frame) => frame.textFragments)).slice(0, 10),
      backlog,
      frames,
    },
    sleep,
    confidence,
    insights: buildInsights(heartRateReadings, batteryReadings, backlog, sleep, frames),
    limitations: buildLimitations(heartRateReadings, backlog, sleep),
    nextActions: buildNextActions(heartRateReadings, backlog, rrIntervals),
  };
}

export function healthReportToMarkdown(report: HealthReport): string {
  const lines = [
    `# WHOOP BLE Local Health Report`,
    ``,
    `Source: ${report.sourceLabel}`,
    `Packets: ${report.packetCount}`,
    `Confidence: ${report.confidence.label} (${report.confidence.score}/100)`,
  ];

  if (report.captureWindow) {
    lines.push(`Capture window: ${report.captureWindow.startIso} to ${report.captureWindow.endIso} (${formatDuration(report.captureWindow.durationMinutes)})`);
  }

  lines.push(
    ``,
    `## Standard BLE`,
    `Heart-rate packets: ${report.standard.heartRatePackets}`,
    `Valid HR readings: ${report.standard.heartRateReadings.length}`,
    `Overnight/all HR: ${report.standard.heartRateStats ? `${report.standard.heartRateStats.min}/${report.standard.heartRateStats.avg}/${report.standard.heartRateStats.max} bpm` : 'unavailable'}`,
    `RR intervals: ${report.standard.rrIntervals}`,
    `RMSSD proxy: ${report.standard.rmssdMs === undefined ? 'unavailable' : `${report.standard.rmssdMs} ms`}`,
    `Latest battery: ${report.standard.latestBattery === undefined ? 'unavailable' : `${report.standard.latestBattery}%`}`,
    ``,
    `## Proprietary Decode`,
    `WHOOP proprietary packets: ${report.proprietary.packets}`,
    `Historical packets: ${report.proprietary.historicalPackets}`,
    `Decode attempts: ${report.proprietary.decodedFrames}`,
    `CBOR-like frames: ${report.proprietary.cborLikeFrames}`,
    `Timestamp fields: ${report.proprietary.timestampFields}`,
  );

  if (report.proprietary.textFragments.length) {
    lines.push(`Text fragments: ${report.proprietary.textFragments.join(' | ')}`);
  }

  lines.push(
    ``,
    `## Sleep`,
    `Local score: ${report.sleep.localScore}/100`,
    `Sleep confidence: ${report.sleep.confidenceLabel} (${report.sleep.dataConfidence}/100)`,
    `Estimated start: ${report.sleep.estimatedStartIso ?? 'unknown'}`,
    `Estimated end: ${report.sleep.estimatedEndIso ?? 'unknown'}`,
    `Estimated time asleep: ${report.sleep.estimatedDurationMinutes === undefined ? 'unknown' : formatDuration(report.sleep.estimatedDurationMinutes)}`,
    `Overnight HR: ${report.sleep.hrStats ? `${report.sleep.hrStats.min}/${report.sleep.hrStats.avg}/${report.sleep.hrStats.max} bpm` : 'unavailable'}`,
    `HRV proxy: ${report.sleep.hrvProxy ? `${report.sleep.hrvProxy.rmssdMs} ms from ${report.sleep.hrvProxy.rrIntervals} RR intervals` : 'unavailable'}`,
    ``,
    `## Why This Score`,
    ...report.sleep.breakdown.map((item) => `- ${item.label}: ${item.score}/100 (${item.weight}% weight). ${item.reason}`),
    ``,
    `## Insights`,
    ...report.insights.map((item) => `- ${item}`),
    ``,
    `## Limitations`,
    ...report.limitations.map((item) => `- ${item}`),
    ``,
    `## Next Actions`,
    ...report.nextActions.map((item) => `- ${item}`),
  );

  return lines.join('\n');
}

function findPacketArray(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (isRecord(input)) {
    for (const key of ['packets', 'records', 'packetRecords', 'capturePackets', 'data']) {
      const value = input[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

function normalizePacketLike(item: unknown, index: number, sessionId: string, sourceLabel: string): PacketRecord | null {
  if (!isRecord(item)) {
    return null;
  }

  const serviceUuid = stringValue(item.serviceUuid ?? item.serviceUUID ?? item.service ?? item.primaryServiceUuid);
  const characteristicUuid = stringValue(item.characteristicUuid ?? item.characteristicUUID ?? item.characteristic ?? item.uuid);
  const bytes = bytesValue(item.bytes) ?? rawBytesValue(item.rawHex ?? item.valueHex ?? item.hex ?? item.value);
  if (!serviceUuid || !characteristicUuid || !bytes) {
    return null;
  }

  const timestamp = stringValue(item.timestamp ?? item.time ?? item.date ?? item.createdAt) ?? new Date(Date.now() + index).toISOString();
  return {
    id: numberValue(item.id),
    sessionId: stringValue(item.sessionId) ?? sessionId,
    deviceId: stringValue(item.deviceId) ?? 'imported',
    deviceName: stringValue(item.deviceName) ?? sourceLabel,
    serviceUuid: normalizeUuid(serviceUuid),
    characteristicUuid: normalizeUuid(characteristicUuid),
    direction: packetDirection(item.direction),
    rawHex: stringValue(item.rawHex) ?? bytesToHex(bytes),
    bytes,
    timestamp: normalizeTimestamp(timestamp),
  };
}

function extractHeartRateReadings(records: PacketRecord[]): HeartRateReading[] {
  return records
    .filter((record) => record.serviceUuid === HEART_RATE_SERVICE && record.characteristicUuid === HEART_RATE_MEASUREMENT)
    .map((record) => {
      const parsed = parseHeartRateMeasurement(new DataView(new Uint8Array(record.bytes).buffer));
      return parsed
        ? {
          ...parsed,
          sessionId: record.sessionId,
          deviceId: record.deviceId,
          timestamp: record.timestamp,
        }
        : null;
    })
    .filter((reading): reading is HeartRateReading => Boolean(reading));
}

function extractBatteryReadings(records: PacketRecord[]): BatteryReading[] {
  return records
    .filter((record) => record.serviceUuid === BATTERY_SERVICE && record.characteristicUuid === BATTERY_LEVEL && record.bytes.length > 0)
    .map((record) => ({
      sessionId: record.sessionId,
      deviceId: record.deviceId,
      percentage: record.bytes[0],
      timestamp: record.timestamp,
    }));
}

function getCaptureWindow(records: PacketRecord[]): HealthReport['captureWindow'] {
  if (records.length === 0) {
    return undefined;
  }
  const startIso = records[0].timestamp;
  const endIso = records[records.length - 1].timestamp;
  return {
    startIso,
    endIso,
    durationMinutes: Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)),
  };
}

function summarizeServices(records: PacketRecord[]): Array<{ uuid: string; count: number }> {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.serviceUuid, (counts.get(record.serviceUuid) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([uuid, count]) => ({ uuid, count }))
    .sort((a, b) => b.count - a.count);
}

function calculateReportConfidence(input: {
  packetCount: number;
  heartRateReadings: number;
  rrIntervals: number;
  historicalPackets: number;
  decodedFrames: number;
  sleepConfidence: number;
}): HealthReport['confidence'] {
  const score = clamp(Math.round(
    Math.min(100, input.packetCount / 3) * 0.12
      + Math.min(100, input.heartRateReadings * 2) * 0.18
      + Math.min(100, input.rrIntervals * 2) * 0.12
      + Math.min(100, input.historicalPackets * 14) * 0.22
      + Math.min(100, input.decodedFrames * 10) * 0.16
      + input.sleepConfidence * 0.2,
  ), 0, 100);
  const reasons = [
    `${input.packetCount} total BLE packets`,
    `${input.heartRateReadings} valid HR readings`,
    `${input.rrIntervals} RR intervals`,
    `${input.historicalPackets} proprietary packets with historical timestamps`,
    `${input.decodedFrames} proprietary decode attempts`,
  ];
  return {
    score,
    label: score >= 75 ? 'high' : score >= 45 ? 'medium' : 'low',
    reasons,
  };
}

function buildInsights(
  heartRates: HeartRateReading[],
  batteryReadings: BatteryReading[],
  backlog: WhoopBacklogAnalysis,
  sleep: LocalSleepAnalysis,
  frames: WhoopProprietaryFrameDecode[],
): string[] {
  const insights: string[] = [];
  const hrValues = heartRates.map((reading) => reading.bpm);
  if (hrValues.length) {
    insights.push(`Heart rate was decoded from standard BLE: ${Math.min(...hrValues)}-${Math.max(...hrValues)} bpm across ${hrValues.length} readings.`);
  }
  const rrCount = heartRates.reduce((sum, reading) => sum + (reading.rrIntervals?.length ?? 0), 0);
  if (rrCount) {
    insights.push(`${rrCount} RR intervals were available for HRV proxy calculations.`);
  }
  if (batteryReadings.length) {
    insights.push(`Battery was decoded locally; latest visible reading is ${batteryReadings.at(-1)?.percentage}%.`);
  }
  if (backlog.historicalRecords.length) {
    insights.push(`WHOOP sent proprietary packets containing historical timestamps from ${backlog.firstHistoricalIso} to ${backlog.lastHistoricalIso}.`);
  }
  if (sleep.estimatedDurationMinutes !== undefined) {
    insights.push(`Local sleep estimate is ${formatDuration(sleep.estimatedDurationMinutes)} with ${sleep.confidenceLabel} confidence.`);
  }
  if (frames.some((frame) => frame.cborOffset !== undefined)) {
    insights.push(`CBOR-like proprietary frames were detected; field labels remain inferred.`);
  }
  return insights.length ? insights : ['No meaningful health signal was decoded yet. Capture more HR and proprietary packets.'];
}

function buildLimitations(heartRates: HeartRateReading[], backlog: WhoopBacklogAnalysis, sleep: LocalSleepAnalysis): string[] {
  const limitations = ['This is not the official WHOOP score and does not use the WHOOP cloud API.'];
  if (!heartRates.length) {
    limitations.push('No valid standard HR packets were present, so HR and HRV analysis are unavailable.');
  }
  if (!backlog.historicalRecords.length) {
    limitations.push('No proprietary historical backlog was decoded, so disconnected overnight sleep evidence is weak.');
  }
  if (sleep.confidenceLabel === 'low') {
    limitations.push('Sleep confidence is low because the browser capture does not include enough overnight signal.');
  }
  limitations.push('Sleep stages are not decoded from BLE yet.');
  return limitations;
}

function buildNextActions(heartRates: HeartRateReading[], backlog: WhoopBacklogAnalysis, rrIntervals: number[]): string[] {
  const actions = ['Run the same morning reconnect sequence after a disconnected night and sync the capture.'];
  if (!heartRates.length) {
    actions.push('Keep the page open after connecting until standard 0x2A37 HR packets appear.');
  }
  if (!rrIntervals.length) {
    actions.push('Look for 0x2A37 packets with RR intervals for better HRV proxy scoring.');
  }
  if (!backlog.historicalRecords.length) {
    actions.push('Wait 60-120 seconds after reconnect for 61080004 / 61080007 backlog bursts.');
  }
  actions.push('Compare multiple labeled captures over time in Convex once pipeline sync is configured.');
  return actions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bytesValue(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const bytes = value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 255);
  return bytes.length ? bytes : undefined;
}

function rawBytesValue(value: unknown): number[] | undefined {
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  try {
    const bytes = hexToBytes(raw);
    return bytes.length ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function packetDirection(value: unknown): PacketRecord['direction'] {
  return value === 'read' || value === 'notify' || value === 'indicate' || value === 'write' ? value : 'notify';
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function calculateRmssd(rrIntervalsSeconds: number[]): number {
  const diffs: number[] = [];
  for (let index = 1; index < rrIntervalsSeconds.length; index += 1) {
    diffs.push((rrIntervalsSeconds[index] - rrIntervalsSeconds[index - 1]) * 1000);
  }
  return Math.sqrt(average(diffs.map((diff) => diff ** 2)));
}

function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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
