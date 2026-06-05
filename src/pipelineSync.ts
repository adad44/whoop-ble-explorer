import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { BatteryReading, HeartRateReading, PacketRecord } from './types';
import type { LocalSleepAnalysis, WhoopBacklogAnalysis, WhoopProprietaryFrameDecode } from './utils';
import { decodeWhoopProprietaryFrames } from './utils';

export type CaptureLabel = 'morning_reconnect' | 'awake' | 'sleep' | 'exercise' | 'charging' | 'custom';

const MIN_SYNC_SLEEP_EVIDENCE_POINTS = 4;
const MIN_SYNC_SLEEP_CONFIDENCE = 60;
const LAST_TRUSTED_SLEEP_ESTIMATE = {
  date: 'Jun 4, 2026',
  windowStart: '1:15 AM',
  windowEnd: '7:27 AM',
  durationMinutes: 372,
  processNote: 'Last trusted estimate from the local BLE sleep process. Current capture must beat the evidence gate before replacing it.',
};

interface ReportedSleepSnapshot {
  startLabel: string;
  endLabel: string;
  durationMinutes: number;
  durationLabel: string;
}

export interface PipelineSyncInput {
  label: CaptureLabel;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  captureStartedAt: string | null;
  packets: PacketRecord[];
  heartRates: HeartRateReading[];
  batteryReadings: BatteryReading[];
  backlog: WhoopBacklogAnalysis;
  localSleep: LocalSleepAnalysis;
  reportedSleep: ReportedSleepSnapshot;
}

export interface PipelineSyncResult {
  ok: boolean;
  status: 'synced' | 'not_configured' | 'empty' | 'failed';
  message: string;
  captureId?: string;
  packetCount?: number;
  decodedCount?: number;
}

type SyncCaptureArgs = {
  capture: Record<string, unknown>;
  packets: Array<Record<string, unknown>>;
  decodedReadings: Array<Record<string, unknown>>;
};

type SyncCaptureReturn = {
  captureId: string;
  packetCount: number;
  decodedCount: number;
};

const syncCaptureMutation = makeFunctionReference<'mutation', SyncCaptureArgs, SyncCaptureReturn>('captures:syncCapture');

export function isPipelineConfigured(): boolean {
  return Boolean(getConvexUrl());
}

export async function syncCaptureToPipeline(input: PipelineSyncInput, authToken: string | null): Promise<PipelineSyncResult> {
  const convexUrl = getConvexUrl();
  if (!convexUrl) {
    return {
      ok: false,
      status: 'not_configured',
      message: 'Convex URL is not configured yet. The capture is still stored locally on this device.',
    };
  }

  if (!authToken) {
    return {
      ok: false,
      status: 'failed',
      message: 'Sign in before syncing WHOOP captures to the health pipeline.',
    };
  }

  if (input.packets.length === 0) {
    return {
      ok: false,
      status: 'empty',
      message: 'No local packets to sync yet. Connect WHOOP and capture data first.',
    };
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(authToken);
    const frameDecodes = decodeWhoopProprietaryFrames(input.packets);
    const payload = buildSyncPayload(input, frameDecodes);
    const result = await client.mutation(syncCaptureMutation, stripUndefined(payload));

    return {
      ok: true,
      status: 'synced',
      captureId: result.captureId,
      packetCount: result.packetCount,
      decodedCount: result.decodedCount,
      message: `Synced ${result.packetCount} packets and ${result.decodedCount} decoded records to the health pipeline.`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSyncPayload(input: PipelineSyncInput, frameDecodes: WhoopProprietaryFrameDecode[]): SyncCaptureArgs {
  const sortedPackets = [...input.packets].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstPacket = sortedPackets[0];
  const lastPacket = sortedPackets[sortedPackets.length - 1];
  const clientId = getOrCreateClientId();
  const uploadedAt = new Date().toISOString();
  const sleepEstimateMetadata = buildSleepEstimateMetadata(input.localSleep);

  const capture = {
    clientId,
    source: 'bluefy_web_bluetooth',
    appVersion: 'whoop-ble-explorer-0.1.0',
    label: input.label,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    captureStartedAt: input.captureStartedAt ?? undefined,
    uploadedAt,
    firstPacketAt: firstPacket?.timestamp,
    lastPacketAt: lastPacket?.timestamp,
    packetCount: input.packets.length,
    heartRateCount: input.heartRates.length,
    batteryCount: input.batteryReadings.length,
    proprietaryFrameCount: frameDecodes.length,
    historicalPacketCount: input.backlog.historicalRecords.length,
    reportedSleepStart: input.reportedSleep.startLabel,
    reportedSleepEnd: input.reportedSleep.endLabel,
    reportedSleepDurationMinutes: input.reportedSleep.durationMinutes,
    localSleepScore: input.localSleep.localScore,
    localSleepConfidence: input.localSleep.confidenceLabel,
    localSleepConfidencePercent: input.localSleep.dataConfidence,
    localSleepEstimateMode: sleepEstimateMetadata.mode,
    localSleepWindowSource: sleepEstimateMetadata.windowSource,
    localSleepWindowEvidencePoints: sleepEstimateMetadata.windowEvidencePoints,
    localSleepWindowStart: sleepEstimateMetadata.windowStart,
    localSleepWindowEnd: sleepEstimateMetadata.windowEnd,
    localSleepWindowDurationMinutes: sleepEstimateMetadata.durationMinutes,
    localSleepProcessNote: sleepEstimateMetadata.processNote,
  };

  const packets = input.packets.map((packet, index) => ({
    clientId,
    captureOrder: index,
    localId: packet.id,
    sessionId: packet.sessionId,
    deviceId: packet.deviceId,
    deviceName: packet.deviceName,
    serviceUuid: packet.serviceUuid,
    characteristicUuid: packet.characteristicUuid,
    direction: packet.direction,
    packetKey: buildPacketKey(packet),
    rawHex: packet.rawHex,
    bytes: packet.bytes,
    timestamp: packet.timestamp,
  }));

  const decodedReadings = [
    ...input.heartRates.map((reading) => ({
      clientId,
      kind: 'heart_rate',
      readingKey: `heart_rate:${reading.sessionId}:${reading.timestamp}:${reading.bpm}:${reading.rrIntervals?.join(',') ?? ''}`,
      timestamp: reading.timestamp,
      data: {
        sessionId: reading.sessionId,
        deviceId: reading.deviceId,
        bpm: reading.bpm,
        energyExpended: reading.energyExpended,
        rrIntervals: reading.rrIntervals,
      },
    })),
    ...input.batteryReadings.map((reading) => ({
      clientId,
      kind: 'battery',
      readingKey: `battery:${reading.sessionId}:${reading.timestamp}:${reading.percentage}`,
      timestamp: reading.timestamp,
      data: {
        sessionId: reading.sessionId,
        deviceId: reading.deviceId,
        percentage: reading.percentage,
      },
    })),
    ...frameDecodes.map((frame) => ({
      clientId,
      kind: 'proprietary_frame',
      readingKey: `proprietary_frame:${buildPacketKey(frame.packet)}`,
      timestamp: frame.packet.timestamp,
      data: {
        label: frame.label,
        serviceUuid: frame.packet.serviceUuid,
        characteristicUuid: frame.packet.characteristicUuid,
        bytesLength: frame.packet.bytes.length,
        cborOffset: frame.cborOffset,
        cborFields: frame.cborFields.slice(0, 80),
        embeddedTimestamps: frame.embeddedTimestamps,
        textFragments: frame.textFragments,
        repeatedRuns: frame.repeatedRuns,
      },
    })),
    {
      clientId,
      kind: 'sleep_analysis',
      readingKey: `sleep_analysis:${input.sessionId}`,
      timestamp: uploadedAt,
      data: {
        reportedSleep: input.reportedSleep,
        displayEstimate: sleepEstimateMetadata,
        backlog: {
          historicalRecords: input.backlog.historicalRecords.length,
          currentRecords: input.backlog.currentRecords.length,
          unknownRecords: input.backlog.unknownRecords.length,
          firstHistoricalIso: input.backlog.firstHistoricalIso,
          lastHistoricalIso: input.backlog.lastHistoricalIso,
          characteristicCounts: input.backlog.characteristicCounts,
        },
        localSleep: input.localSleep,
      },
    },
  ];

  return { capture, packets, decodedReadings };
}

function buildSleepEstimateMetadata(localSleep: LocalSleepAnalysis): {
  mode: 'current_ble_estimate' | 'last_trusted_estimate';
  windowSource: LocalSleepAnalysis['windowSource'];
  windowEvidencePoints: number;
  windowStart: string;
  windowEnd: string;
  durationMinutes: number;
  processNote: string;
} {
  const hasCurrentEstimate = Boolean(
    localSleep.estimatedStartIso
    && localSleep.estimatedEndIso
    && localSleep.estimatedDurationMinutes !== undefined
    && Number.isFinite(localSleep.estimatedDurationMinutes)
    && localSleep.estimatedDurationMinutes > 0
    && localSleep.estimatedDurationMinutes <= 14 * 60
    && localSleep.windowEvidencePoints >= MIN_SYNC_SLEEP_EVIDENCE_POINTS
    && localSleep.dataConfidence >= MIN_SYNC_SLEEP_CONFIDENCE,
  );

  if (!hasCurrentEstimate || !localSleep.estimatedStartIso || !localSleep.estimatedEndIso || localSleep.estimatedDurationMinutes === undefined) {
    return {
      mode: 'last_trusted_estimate',
      windowSource: localSleep.windowSource,
      windowEvidencePoints: localSleep.windowEvidencePoints,
      windowStart: LAST_TRUSTED_SLEEP_ESTIMATE.windowStart,
      windowEnd: LAST_TRUSTED_SLEEP_ESTIMATE.windowEnd,
      durationMinutes: LAST_TRUSTED_SLEEP_ESTIMATE.durationMinutes,
      processNote: LAST_TRUSTED_SLEEP_ESTIMATE.processNote,
    };
  }

  return {
    mode: 'current_ble_estimate',
    windowSource: localSleep.windowSource,
    windowEvidencePoints: localSleep.windowEvidencePoints,
    windowStart: localSleep.estimatedStartIso,
    windowEnd: localSleep.estimatedEndIso,
    durationMinutes: localSleep.estimatedDurationMinutes,
    processNote: `${localSleep.windowEvidencePoints} BLE backlog points decoded from the current capture. This estimate passed the local sleep evidence gate.`,
  };
}

function buildPacketKey(packet: PacketRecord): string {
  if (packet.id !== undefined) {
    return `${packet.sessionId}:${packet.id}`;
  }
  return [
    packet.sessionId,
    packet.timestamp,
    packet.serviceUuid,
    packet.characteristicUuid,
    packet.direction,
    packet.rawHex,
  ].join(':');
}

function getConvexUrl(): string | undefined {
  const value = import.meta.env.VITE_CONVEX_URL;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getOrCreateClientId(): string {
  const key = 'whoop-health-pipeline-client-id';
  const existing = window.localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const created = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(key, created);
  return created;
}

function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
