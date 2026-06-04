import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  ...authTables,

  userConsents: defineTable({
    userId: v.id('users'),
    version: v.string(),
    acceptedAt: v.string(),
    source: v.string(),
  })
    .index('by_user_version', ['userId', 'version'])
    .index('by_user_acceptedAt', ['userId', 'acceptedAt']),

  captures: defineTable({
    userId: v.optional(v.id('users')),
    clientId: v.string(),
    source: v.string(),
    appVersion: v.string(),
    label: v.string(),
    sessionId: v.string(),
    deviceId: v.string(),
    deviceName: v.string(),
    captureStartedAt: v.optional(v.string()),
    uploadedAt: v.string(),
    firstPacketAt: v.optional(v.string()),
    lastPacketAt: v.optional(v.string()),
    packetCount: v.number(),
    heartRateCount: v.number(),
    batteryCount: v.number(),
    proprietaryFrameCount: v.number(),
    historicalPacketCount: v.number(),
    reportedSleepStart: v.string(),
    reportedSleepEnd: v.string(),
    reportedSleepDurationMinutes: v.number(),
    localSleepScore: v.number(),
    localSleepConfidence: v.string(),
    localSleepConfidencePercent: v.number(),
  })
    .index('by_user_uploadedAt', ['userId', 'uploadedAt'])
    .index('by_user_sessionId', ['userId', 'sessionId'])
    .index('by_client_uploadedAt', ['clientId', 'uploadedAt'])
    .index('by_sessionId', ['sessionId'])
    .index('by_client_sessionId', ['clientId', 'sessionId'])
    .index('by_label_uploadedAt', ['label', 'uploadedAt']),

  capturePackets: defineTable({
    captureId: v.id('captures'),
    userId: v.optional(v.id('users')),
    clientId: v.string(),
    captureOrder: v.number(),
    localId: v.optional(v.number()),
    sessionId: v.string(),
    deviceId: v.string(),
    deviceName: v.string(),
    serviceUuid: v.string(),
    characteristicUuid: v.string(),
    direction: v.string(),
    packetKey: v.optional(v.string()),
    rawHex: v.string(),
    bytes: v.array(v.number()),
    timestamp: v.string(),
  })
    .index('by_user_timestamp', ['userId', 'timestamp'])
    .index('by_captureId_captureOrder', ['captureId', 'captureOrder'])
    .index('by_packetKey', ['packetKey'])
    .index('by_capture_packetKey', ['captureId', 'packetKey'])
    .index('by_client_timestamp', ['clientId', 'timestamp'])
    .index('by_characteristic_timestamp', ['characteristicUuid', 'timestamp']),

  decodedReadings: defineTable({
    captureId: v.id('captures'),
    userId: v.optional(v.id('users')),
    clientId: v.string(),
    kind: v.string(),
    readingKey: v.optional(v.string()),
    timestamp: v.string(),
    data: v.any(),
  })
    .index('by_user_kind_timestamp', ['userId', 'kind', 'timestamp'])
    .index('by_captureId_kind', ['captureId', 'kind'])
    .index('by_readingKey', ['readingKey'])
    .index('by_capture_readingKey', ['captureId', 'readingKey'])
    .index('by_client_kind_timestamp', ['clientId', 'kind', 'timestamp']),
});
