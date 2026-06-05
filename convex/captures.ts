import { getAuthUserId } from '@convex-dev/auth/server';
import { mutationGeneric, queryGeneric } from 'convex/server';
import { v } from 'convex/values';

const captureValidator = v.object({
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
  localSleepEstimateMode: v.optional(v.string()),
  localSleepWindowSource: v.optional(v.string()),
  localSleepWindowEvidencePoints: v.optional(v.number()),
  localSleepWindowStart: v.optional(v.string()),
  localSleepWindowEnd: v.optional(v.string()),
  localSleepWindowDurationMinutes: v.optional(v.number()),
  localSleepProcessNote: v.optional(v.string()),
});

const packetValidator = v.object({
  clientId: v.string(),
  captureOrder: v.number(),
  localId: v.optional(v.number()),
  sessionId: v.string(),
  deviceId: v.string(),
  deviceName: v.string(),
  serviceUuid: v.string(),
  characteristicUuid: v.string(),
  direction: v.string(),
  packetKey: v.string(),
  rawHex: v.string(),
  bytes: v.array(v.number()),
  timestamp: v.string(),
});

const decodedReadingValidator = v.object({
  clientId: v.string(),
  kind: v.string(),
  readingKey: v.string(),
  timestamp: v.string(),
  data: v.any(),
});

export const syncCapture = mutationGeneric({
  args: {
    capture: captureValidator,
    packets: v.array(packetValidator),
    decodedReadings: v.array(decodedReadingValidator),
  },
  returns: v.object({
    captureId: v.id('captures'),
    packetCount: v.number(),
    decodedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireSignedInUser(ctx);

    if (args.packets.length === 0) {
      throw new Error('No local packets to sync yet. Connect WHOOP and capture data first.');
    }

    if (args.packets.length > 2500) {
      throw new Error('Capture is too large for one sync. Export JSON and split the upload.');
    }

    const ownedCapture = await ctx.db
      .query('captures')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', args.capture.sessionId))
      .filter((q) =>
        q.and(
          q.eq(q.field('clientId'), args.capture.clientId),
          q.eq(q.field('userId'), userId),
        )
      )
      .first();
    const legacyCapture = ownedCapture ? null : await ctx.db
      .query('captures')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', args.capture.sessionId))
      .filter((q) =>
        q.and(
          q.eq(q.field('clientId'), args.capture.clientId),
          q.eq(q.field('userId'), undefined),
        )
      )
      .first();

    const capture = {
      ...args.capture,
      userId,
    };
    const captureId = ownedCapture?._id ?? legacyCapture?._id ?? await ctx.db.insert('captures', capture);
    if (ownedCapture || legacyCapture) {
      await ctx.db.patch(captureId, capture);
    }

    for (const packet of args.packets) {
      const ownedPacket = await ctx.db
        .query('capturePackets')
        .withIndex('by_packetKey', (q) => q.eq('packetKey', packet.packetKey))
        .filter((q) => q.eq(q.field('userId'), userId))
        .first();
      const legacyPacket = ownedPacket ? null : await ctx.db
        .query('capturePackets')
        .withIndex('by_packetKey', (q) => q.eq('packetKey', packet.packetKey))
        .filter((q) =>
          q.and(
            q.eq(q.field('clientId'), args.capture.clientId),
            q.eq(q.field('userId'), undefined),
          )
        )
        .first();

      if (ownedPacket) {
        continue;
      }

      if (legacyPacket) {
        await ctx.db.patch(legacyPacket._id, {
          captureId,
          userId,
        });
      } else {
        await ctx.db.insert('capturePackets', {
          captureId,
          userId,
          ...packet,
        });
      }
    }

    for (const reading of args.decodedReadings) {
      const ownedReading = await ctx.db
        .query('decodedReadings')
        .withIndex('by_readingKey', (q) => q.eq('readingKey', reading.readingKey))
        .filter((q) => q.eq(q.field('userId'), userId))
        .first();
      const legacyReading = ownedReading ? null : await ctx.db
        .query('decodedReadings')
        .withIndex('by_readingKey', (q) => q.eq('readingKey', reading.readingKey))
        .filter((q) =>
          q.and(
            q.eq(q.field('clientId'), args.capture.clientId),
            q.eq(q.field('userId'), undefined),
          )
        )
        .first();

      if (ownedReading) {
        await ctx.db.patch(ownedReading._id, {
          timestamp: reading.timestamp,
          data: reading.data,
        });
      } else if (legacyReading) {
        await ctx.db.patch(legacyReading._id, {
          captureId,
          userId,
          timestamp: reading.timestamp,
          data: reading.data,
        });
      } else {
        await ctx.db.insert('decodedReadings', {
          captureId,
          userId,
          ...reading,
        });
      }
    }

    return {
      captureId,
      packetCount: args.packets.length,
      decodedCount: args.decodedReadings.length,
    };
  },
});

export const recentCaptures = queryGeneric({
  args: {
    clientId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const userId = await requireSignedInUser(ctx);
    const captures = await ctx.db
      .query('captures')
      .withIndex('by_user_uploadedAt', (q) => q.eq('userId', userId))
      .order('desc')
      .take(args.limit ?? 20);
    return args.clientId === undefined
      ? captures
      : captures.filter((capture) => capture.clientId === args.clientId);
  },
});

export const viewer = queryGeneric({
  args: {},
  returns: v.union(v.null(), v.object({
    id: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }
    return {
      id: userId,
      email: user.email,
      name: user.name,
    };
  },
});

export const currentUserConsent = queryGeneric({
  args: {
    version: v.string(),
  },
  returns: v.object({
    accepted: v.boolean(),
    version: v.string(),
    acceptedAt: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireSignedInUser(ctx);
    const consent = await ctx.db
      .query('userConsents')
      .withIndex('by_user_version', (q) => q.eq('userId', userId))
      .filter((q) => q.eq(q.field('version'), args.version))
      .first();

    return {
      accepted: Boolean(consent),
      version: args.version,
      acceptedAt: consent?.acceptedAt,
    };
  },
});

export const acceptDataConsent = mutationGeneric({
  args: {
    version: v.string(),
  },
  returns: v.object({
    accepted: v.boolean(),
    version: v.string(),
    acceptedAt: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireSignedInUser(ctx);
    const existing = await ctx.db
      .query('userConsents')
      .withIndex('by_user_version', (q) => q.eq('userId', userId))
      .filter((q) => q.eq(q.field('version'), args.version))
      .first();

    if (existing) {
      return {
        accepted: true,
        version: existing.version,
        acceptedAt: existing.acceptedAt,
      };
    }

    const acceptedAt = new Date().toISOString();
    await ctx.db.insert('userConsents', {
      userId,
      version: args.version,
      acceptedAt,
      source: 'bluefy_public_app',
    });

    return {
      accepted: true,
      version: args.version,
      acceptedAt,
    };
  },
});

async function requireSignedInUser(ctx: Parameters<typeof getAuthUserId>[0]) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error('Sign in before syncing WHOOP captures.');
  }
  return userId;
}
