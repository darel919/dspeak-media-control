import {
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
  isCompatibleClientHello,
  SFU_PROVIDER,
  getMediaChannelParticipantLimit,
} from "./protocol.ts";
import { verifyMediaTicket } from "./tickets.ts";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  normalizeMediaOwnerSource,
  normalizeParticipantVoiceState,
  normalizeMediaSources,
  isVideoMediaSource,
  mediaPublicationKey,
  normalizeMediaCapabilities,
} from "./media-room-contracts.ts";
import {
  handleCloudflareRequest,
  handleP2PFailure,
  handleProviderFailure,
  MAX_QOE_PROVIDER_ID_LENGTH,
  MAX_QOE_REPORTS_PER_PARTICIPANT,
  QOE_REPORT_MAX_AGE_MS,
  providerHealthKey,
} from "./media-room-provider.ts";
import { mediaDebug } from "./debug.ts";
import { normalizeQoePath } from "./qoe.ts";

function participantCapabilityPayload(participant) {
  if (!participant) return null;
  const mediaCapabilities =
    participant.mediaCapabilities ||
    normalizeMediaCapabilities({
      source: "fallback",
    });
  return {
    participantId: String(participant.peerId || ""),
    peerId: String(participant.peerId || ""),
    userId: String(participant.userId || ""),
    deviceId: String(participant.deviceId || ""),
    mediaCapabilities,
    capabilityProtocol: String(
      participant.capabilityProtocol || "video-codec-matrix-v1",
    ),
  };
}

function broadcastParticipantCapabilities(
  room,
  participant,
  excludedWs = null,
) {
  const payload = participantCapabilityPayload(participant);
  if (!payload) return false;
  for (const recipient of room.participants.values())
    if (recipient.ws && recipient.ws !== excludedWs)
      room.sendMessage(
        recipient.ws,
        MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_CAPABILITIES,
        payload,
      );
  return true;
}

export async function handleRoomMessage(room, ws, session, envelope) {
  const data =
    envelope?.data && typeof envelope.data === "object"
      ? envelope.data
      : envelope;
  const type = envelope?.type;
  const now = Date.now();
  session.lastHeartbeat = now;

  const operationId = data?.operationId;
  const isMutation =
    type === MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_CAPABILITIES ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.LEAVE;

  if (!session.authenticated) {
    await authenticateRoomSession(room, ws, session, type, data, now);
    return;
  }
  if (
    typeof room.isCurrentParticipantSession === "function" &&
    !room.isCurrentParticipantSession(ws, session)
  ) {
    ws.close(4000, "Media session superseded");
    return;
  }

  // Operation replay happens only after authentication and current-session
  // validation. Cache is keyed by participantKey:epoch:operationId so a
  // superseded socket or a newer connection epoch can never replay a result
  // that belongs to a different incarnation.
  if (operationId && isMutation) {
    const cachedKey = `${session.userId}:${session.deviceId}:${
      session.connectionEpoch ?? "?"
    }:${operationId}`;
    if (room.operationResults.has(cachedKey)) {
      const cached = room.operationResults.get(cachedKey);
      mediaDebug(room.env, "room.operation-replay", {
        operationId,
        type,
        peerId: session.peerId,
        scoped: true,
      });
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK, {
        ...cached,
        operationId,
        replayed: true,
      });
      return;
    }
  }
  const participantKey = `${session.userId}:${session.deviceId}`;
  const serverConnectionEpoch =
    room.participantConnectionEpochs?.get(participantKey) || 1;
  const clientEpoch = Number(data.connectionEpoch);
  const staleEpoch =
    Number.isSafeInteger(clientEpoch) && clientEpoch !== serverConnectionEpoch;
  if (
    isMutation &&
    staleEpoch &&
    ![
      MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_CAPABILITIES,
      MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY,
      MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED,
    ].includes(type)
  ) {
    const nackPayload = {
      operationId,
      accepted: false,
      code: "STALE_CONNECTION_EPOCH",
      retryable: true,
      connectionEpoch: serverConnectionEpoch,
      roomRevision: room.roomRevision.toString(),
      canonicalState: room.buildTopologySnapshot
        ? room.buildTopologySnapshot()
        : undefined,
    };
    await room.storeOperationResult(
      operationCacheKey(session, operationId),
      nackPayload,
    );
    room.sendMessage(
      ws,
      MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
      nackPayload,
    );
    return;
  }

  switch (type) {
    case MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT: {
      const clientTopologyEpoch = Number(data.topologyEpoch);
      const clientSourceRevision = Number(data.sourceRevision);
      const clientRoomRevision = Number(data.lastAppliedRoomRevision);
      const clientConnectionEpoch = Number(data.connectionEpoch);
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      const participantKey = `${session.userId}:${session.deviceId}`;
      const serverConnectionEpoch =
        room.participantConnectionEpochs?.get(participantKey) || 1;
      if (participant && participant.ws === ws) {
        participant.lastSeenAt = now;
        participant.status = "connected";
        participant.disconnectedAt = null;
      }
      const stateMismatch =
        (Number.isSafeInteger(clientTopologyEpoch) &&
          clientTopologyEpoch !== room.epoch) ||
        (Number.isSafeInteger(clientSourceRevision) &&
          clientSourceRevision !== room.sourceRevision) ||
        (typeof data.lastAppliedRoomRevision === "string" &&
          data.lastAppliedRoomRevision !== room.roomRevision.toString()) ||
        (Number.isSafeInteger(clientConnectionEpoch) &&
          Number.isSafeInteger(serverConnectionEpoch) &&
          clientConnectionEpoch !== serverConnectionEpoch);
      // Also reconcile client's local source digest if present
      let sourceDigestMismatch = false;
      if (
        data.localSourceDigest &&
        typeof data.localSourceDigest === "object"
      ) {
        const participantSourceStates = participant?.sourceStates || {};
        for (const [source, digest] of Object.entries(data.localSourceDigest)) {
          const serverState = participantSourceStates[source];
          const clientGen = Number(digest?.generation);
          const serverGen = Number(serverState?.generation || 0);
          const clientDesired = digest?.desiredState;
          const serverDesired = serverState?.desiredState;
          if (
            (Number.isSafeInteger(clientGen) && clientGen !== serverGen) ||
            (typeof clientDesired === "string" &&
              clientDesired !== serverDesired)
          ) {
            sourceDigestMismatch = true;
            break;
          }
        }
      }
      if (stateMismatch || sourceDigestMismatch) {
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.STATE_NACK, {
          sequence: data.sequence,
          topology: room.buildTopologySnapshot(),
          roomRevision: room.roomRevision.toString(),
          publicationRevision: room.publicationRevision,
          epoch: room.epoch,
          sourceRevision: room.sourceRevision,
          connectionEpoch:
            room.participantConnectionEpochs?.get(
              `${session.userId}:${session.deviceId}`,
            ) || 1,
        });
        // Also send HEARTBEAT_ACK so the client updates its liveness state
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK, {
          sequence: data.sequence,
          timestamp: now,
          roomRevision: room.roomRevision.toString(),
          epoch: room.epoch,
          sourceRevision: room.sourceRevision,
          publicationRevision: room.publicationRevision,
          connectionEpoch:
            room.participantConnectionEpochs?.get(
              `${session.userId}:${session.deviceId}`,
            ) || 1,
          publishedSourcesDigest: [...room.publishedSources.values()]
            .filter((publication) => publication.peerId !== session.peerId)
            .map((publication) => ({
              source: publication.source,
              peerId: publication.peerId,
              generation: publication.generation,
              trackName: publication.trackName,
              connectionEpoch: publication.connectionEpoch,
              sessionId: publication.sessionId,
              ownerSource: publication.ownerSource ?? null,
              variantId: publication.variantId ?? null,
              logicalStreamId: publication.logicalStreamId ?? null,
              codec: publication.codec ?? null,
              codecAcceleration: publication.codecAcceleration ?? null,
              codecImplementation: publication.codecImplementation ?? null,
              width: publication.width ?? null,
              height: publication.height ?? null,
              fps: publication.fps ?? null,
              bitrate: publication.bitrate ?? null,
              target: publication.target ?? null,
              targetAdjusted: publication.targetAdjusted ?? null,
              receivers: publication.receivers ?? [],
              emergency: publication.emergency ?? false,
              score: publication.score ?? null,
            })),
        });
        break;
      }
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK, {
        sequence: data.sequence,
        timestamp: now,
        roomRevision: room.roomRevision.toString(),
        epoch: room.epoch,
        sourceRevision: room.sourceRevision,
        publicationRevision: room.publicationRevision,
        connectionEpoch:
          room.participantConnectionEpochs?.get(
            `${session.userId}:${session.deviceId}`,
          ) || 1,
        publishedSourcesDigest: [...room.publishedSources.values()]
          .filter((publication) => publication.peerId !== session.peerId)
          .map((publication) => ({
            source: publication.source,
            peerId: publication.peerId,
            generation: publication.generation,
            trackName: publication.trackName,
            connectionEpoch: publication.connectionEpoch,
            sessionId: publication.sessionId,
            ownerSource: publication.ownerSource ?? null,
            variantId: publication.variantId ?? null,
            logicalStreamId: publication.logicalStreamId ?? null,
            codec: publication.codec ?? null,
            codecAcceleration: publication.codecAcceleration ?? null,
            codecImplementation: publication.codecImplementation ?? null,
            width: publication.width ?? null,
            height: publication.height ?? null,
            fps: publication.fps ?? null,
            bitrate: publication.bitrate ?? null,
            target: publication.target ?? null,
            targetAdjusted: publication.targetAdjusted ?? null,
            receivers: publication.receivers ?? [],
            emergency: publication.emergency ?? false,
            score: publication.score ?? null,
          })),
      });
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL:
      await room.relayP2PSignal(session, data, ws);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY:
    case MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED: {
      if (
        Number(data.epoch) !== room.epoch ||
        room.route.kind !== "p2p" ||
        room.route.path !== "direct" ||
        room.route.reason !== "qualifying-direct"
      )
        break;
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      if (!participant) break;
      const qualifiedPeerIds =
        data.qualifiedPeerIds || data.qualifiedPeers || [];
      room.qualificationState.set(session.peerId, {
        qualifiedPeers: new Set(qualifiedPeerIds),
        candidateReports: Array.isArray(data.candidateReports)
          ? data.candidateReports
          : [],
        ready: true,
      });
      session.qualifiedPeerIds = [...qualifiedPeerIds];
      ws.serializeAttachment(session);
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED, {
        epoch: room.epoch,
        acknowledged: true,
        qualifiedPeerIds: [
          ...room.qualificationState.get(session.peerId).qualifiedPeers,
        ],
      });
      room.checkQualificationComplete();
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE: {
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      const voiceState = normalizeParticipantVoiceState(data);
      if (!participant || !voiceState) {
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "INVALID_PARTICIPANT_VOICE_STATE",
          error: "Participant voice state is invalid",
        });
        break;
      }
      participant.muted = voiceState.muted;
      participant.deafened = voiceState.deafened;
      session.muted = voiceState.muted;
      session.deafened = voiceState.deafened;
      session.sourceStates = structuredClone(participant.sourceStates || {});
      session.cloudflareSessionId = participant.cloudflareSessionId ?? null;
      ws.serializeAttachment(session);
      room.roomRevision++;
      void room.state.storage.put("roomRevision", room.roomRevision);
      const ackPayload = {
        operationId,
        accepted: true,
        roomRevision: String(room.roomRevision || 0),
        canonicalState: room.buildTopologySnapshot
          ? room.buildTopologySnapshot()
          : undefined,
      };
      await room.storeOperationResult(
        operationCacheKey(session, operationId),
        ackPayload,
      );
      room.sendMessage(
        ws,
        MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
        ackPayload,
      );
      for (const recipient of room.participants.values())
        if (recipient.ws)
          room.sendMessage(
            recipient.ws,
            MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE,
            {
              userId: participant.userId,
              peerId: participant.peerId,
              ...voiceState,
            },
          );
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_CAPABILITIES: {
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      const mediaCapabilities = normalizeMediaCapabilities(
        data.mediaCapabilities,
      );
      if (!participant || !mediaCapabilities) break;
      participant.mediaCapabilities = mediaCapabilities;
      participant.capabilityProtocol =
        typeof data.capabilityProtocol === "string"
          ? data.capabilityProtocol
          : participant.capabilityProtocol;
      session.mediaCapabilities = mediaCapabilities;
      session.capabilityProtocol = participant.capabilityProtocol;
      session.sourceStates = structuredClone(participant.sourceStates || {});
      session.cloudflareSessionId = participant.cloudflareSessionId ?? null;
      ws.serializeAttachment(session);
      broadcastParticipantCapabilities(room, participant, ws);
      const ackPayload = {
        operationId,
        accepted: true,
        roomRevision: room.roomRevision.toString(),
        canonicalState: room.buildTopologySnapshot
          ? room.buildTopologySnapshot()
          : undefined,
      };
      await room.storeOperationResult(
        operationCacheKey(session, operationId),
        ackPayload,
      );
      room.sendMessage(
        ws,
        MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
        ackPayload,
      );
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.CODEC_MIGRATION_STATE:
      relayCodecMigrationState(room, ws, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES: {
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      if (!participant) break;
      const sources = normalizeMediaSources(data.sources);
      if (!sources) {
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "INVALID_MEDIA_SOURCES",
          error: "Media source identifiers are invalid",
        });
        break;
      }
      const hasVideo = [...room.participants.values()].some((candidate) => {
        const candidateSources =
          candidate === participant ? sources : [...(candidate.sources || [])];
        return candidateSources.some((source) => isVideoMediaSource(source));
      });
      const participantLimit = getMediaChannelParticipantLimit(
        session.connectionMode,
        hasVideo,
      );
      if (room.participants.size > participantLimit) {
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "MEDIA_CHANNEL_PARTICIPANT_LIMIT_EXCEEDED",
          error: `This media channel supports up to ${participantLimit} participants for the active media mode`,
        });
        break;
      }

      const operationId = data.operationId;
      if (!operationId || typeof operationId !== "string") {
        room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "MISSING_OPERATION_ID",
          error: "MEDIA_SOURCES mutation requires operationId",
        });
        break;
      }
      const cachedKey = operationCacheKey(session, operationId);
      if (cachedKey && room.operationResults.has(cachedKey)) {
        const cached = room.operationResults.get(cachedKey);
        if (cached) {
          room.sendMessage(
            ws,
            MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
            cached,
          );
        }
        break;
      }

      // ============================================================
      // VALIDATE-THEN-COMMIT: build all next state in temp structures
      // ============================================================
      const sourceSet = new Set(sources);
      const previousSources = new Set(participant.sources || new Set());
      const clientSourceStates = data.sourceStates || {};

      // Snapshot previous state BEFORE any mutation
      const allSources = new Set([
        ...Object.keys(participant.sourceStates || {}),
        ...previousSources,
        ...sourceSet,
      ]);
      const previousStates = new Map();
      for (const source of allSources) {
        previousStates.set(
          source,
          structuredClone(
            participant.sourceStates?.[source] ?? {
              generation: 0,
              desiredState: "inactive",
              publicationState: "unpublished",
              provider: null,
            },
          ),
        );
      }

      // 1. Validate source identifiers (already done by normalizeMediaSources)

      // 2. Validate participant limits (done above)

      // 3. Validate every generation
      for (const source of allSources) {
        const clientState = clientSourceStates[source];
        const previousState = previousStates.get(source);
        const clientGeneration = Number.isSafeInteger(clientState?.generation)
          ? clientState.generation
          : previousState.generation;
        const inNewSet = sourceSet.has(source);
        const wasInPreviousSet = previousSources.has(source);
        const desired = inNewSet ? "active" : "inactive";
        const desiredChanged = desired !== previousState.desiredState;
        const membershipChanged = inNewSet !== wasInPreviousSet;
        const isStale = clientGeneration < previousState.generation;
        // Enforce strictly increasing generation for actual state transitions
        // Idempotent replays (same desired state + same membership) allow equality
        const requiresGenerationAdvance = desiredChanged || membershipChanged;
        const generationValid = requiresGenerationAdvance
          ? clientGeneration > previousState.generation
          : clientGeneration >= previousState.generation;
        if (isStale || !generationValid) {
          const canonicalState = room.buildTopologySnapshot
            ? room.buildTopologySnapshot()
            : undefined;
          const nackPayload = {
            operationId,
            accepted: false,
            code: "STALE_SOURCE_GENERATION",
            retryable: false,
            adoptsCanonicalGeneration: true,
            roomRevision: String(room.roomRevision),
            sourceRevision: Number(room.sourceRevision),
            publicationRevision: room.publicationRevision,
            source,
            expectedGeneration:
              previousState.generation + (requiresGenerationAdvance ? 1 : 0),
            receivedGeneration: clientGeneration,
            canonicalState,
          };
          await room.storeOperationResult(
            operationCacheKey(session, operationId),
            nackPayload,
          );
          room.sendMessage(
            ws,
            MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
            nackPayload,
          );
          return;
        }
      }

      // 4. Validate epoch (control epoch is implicit in session)

      // 5. Calculate complete next state
      const nextSources = new Set(sourceSet);
      const nextSourceStates = {};
      const nowFs = Date.now();
      for (const source of allSources) {
        const previousState = previousStates.get(source);
        const inNewSet = sourceSet.has(source);
        const desired = inNewSet ? "active" : "inactive";
        const clientState = clientSourceStates[source];
        const clientGeneration = Number.isSafeInteger(clientState?.generation)
          ? clientState.generation
          : previousState.generation;
        const newPublicationState = inNewSet
          ? previousState.publicationState === "published"
            ? "published"
            : "announced"
          : "unpublished";
        nextSourceStates[source] = {
          ...previousState,
          desiredState: desired,
          generation: clientGeneration,
          publicationState: newPublicationState,
          provider: previousState.provider,
          updatedAt: nowFs,
        };
      }

      // Compute publications to retire
      const publicationsToRetire = [];
      for (const [key, publication] of room.publishedSources) {
        if (
          publication.peerId === session.peerId &&
          !sourceSet.has(publication.source)
        ) {
          publicationsToRetire.push({
            key,
            publication: { ...publication, closed: true },
          });
        }
        // Also retire older generations for sources that are still present but advanced generation
        else if (
          publication.peerId === session.peerId &&
          sourceSet.has(publication.source) &&
          publication.generation <
            nextSourceStates[publication.source]?.generation
        ) {
          publicationsToRetire.push({
            key,
            publication: { ...publication, closed: true },
          });
        }
      }

      // 6. Commit atomically - do NOT store provisional result
      // Store only the final result after all mutations and revisions are committed
      participant.sources = nextSources;
      session.sources = [...nextSources];
      participant.sourceStates = nextSourceStates;
      session.sourceStates = structuredClone(nextSourceStates);
      session.cloudflareSessionId = participant.cloudflareSessionId ?? null;
      for (const retired of publicationsToRetire) {
        room.publishedSources.delete(retired.key);
      }
      ws.serializeAttachment(session);

      // Compute sourceStateChanged for revision bump
      const sourceStateChanged = [...previousStates.keys()].some((source) => {
        const prev = previousStates.get(source);
        const curr = nextSourceStates[source];
        if (!prev && !curr) return false;
        if (!prev || !curr) return true;
        return (
          prev.generation !== curr.generation ||
          prev.desiredState !== curr.desiredState ||
          prev.publicationState !== curr.publicationState ||
          prev.provider !== curr.provider
        );
      });

      if (
        previousSources.size !== nextSources.size ||
        [...previousSources].some((s) => !nextSources.has(s)) ||
        sourceStateChanged
      ) {
        room.roomRevision++;
        room.sourceRevision++;
        await Promise.all([
          room.state.storage.put("roomRevision", room.roomRevision),
          room.state.storage.put("sourceRevision", room.sourceRevision),
        ]);
      }
      // Publication retirement goes through the centralized revision helper:
      // one bump, one persistence commit (publishedSources +
      // publicationRevision + roomRevision), and close pushes that carry the
      // new revision. The helper also bumps roomRevision, so skipping the
      // source-only branch above is safe when retirements occur.
      if (publicationsToRetire.length > 0) {
        room.commitPublicationMutation({
          removed: publicationsToRetire.map((retired) => retired.publication),
          excludedWs: ws,
          sourceRevision: room.sourceRevision,
        });
      }

      const ackPayload = {
        operationId,
        accepted: true,
        roomRevision: room.roomRevision.toString(),
        sourceRevision: Number(room.sourceRevision),
        publicationRevision: room.publicationRevision,
        canonicalState: room.buildTopologySnapshot
          ? room.buildTopologySnapshot()
          : undefined,
      };
      await room.storeOperationResult(
        operationCacheKey(session, operationId),
        ackPayload,
      );
      room.sendMessage(
        ws,
        MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
        ackPayload,
      );
      await room.refreshPendingRouteSourceRevision?.();
      room.maybeStartQualification();
      room.broadcastTopology();
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED:
      if (
        Number(data.epoch) !== room.epoch ||
        room.route.kind !== "p2p" ||
        room.route.path !== "direct" ||
        !["qualifying-direct", "qualified-direct-mesh"].includes(
          room.route.reason,
        )
      )
        break;
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED, {
        epoch: room.epoch,
        acknowledged: true,
        failed: true,
        reason: data.reason || "p2p-failed",
      });
      await handleP2PFailure(room, session, data.reason);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE: {
      const participant = room.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      if (!participant || !Array.isArray(data.paths)) break;
      const provider = String(data.provider || "");
      const providerId =
        typeof data.providerId === "string" && data.providerId.trim()
          ? data.providerId.trim()
          : null;
      if (providerId && providerId.length > MAX_QOE_PROVIDER_ID_LENGTH) break;
      const storedReports = room.qoeMetrics.get(participant.peerId);
      const reports = storedReports instanceof Map ? storedReports : new Map();
      if (storedReports && !(storedReports instanceof Map))
        reports.set(
          `${storedReports.provider}:${storedReports.providerId || "family"}`,
          storedReports,
        );
      const reportKey = `${provider}:${providerId || "family"}`;
      const previous = reports.get(reportKey);
      const receivedAt = Date.now();
      const previousSampledAt = Number(previous?.sampledAt);
      const previousReceivedAt = Number(previous?.receivedAt);
      const previousFreshnessAt = Number.isFinite(previousReceivedAt)
        ? previousReceivedAt
        : previousSampledAt;
      const previousIsFresh =
        previous &&
        (!Number.isFinite(previousFreshnessAt) ||
          receivedAt - previousFreshnessAt <= QOE_REPORT_MAX_AGE_MS);
      const report = {
        provider,
        paths: data.paths.slice(0, 32).map((path) => normalizeQoePath(path)),
        sampledAt: Number(data.sampledAt) || receivedAt,
        receivedAt,
        stableSince:
          previousIsFresh &&
          previous.provider === provider &&
          previous.providerId === providerId
            ? previous.stableSince
            : receivedAt,
        ...(providerId ? { providerId } : {}),
      };
      reports.set(reportKey, report);
      while (reports.size > MAX_QOE_REPORTS_PER_PARTICIPANT) {
        let oldestKey = null;
        let oldestReceivedAt = Number.POSITIVE_INFINITY;
        for (const [key, candidate] of reports) {
          const candidateReceivedAt = Number(candidate?.receivedAt);
          if (candidateReceivedAt < oldestReceivedAt) {
            oldestKey = key;
            oldestReceivedAt = candidateReceivedAt;
          }
        }
        if (oldestKey === null) break;
        reports.delete(oldestKey);
      }
      room.qoeMetrics.set(participant.peerId, reports);
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.CLIENT_SFU_RTT:
      relayClientSfuRtt(room, ws, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_READY:
      await handleProviderReady(room, ws, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_READY:
      await handleTopologyReady(room, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_FAILED:
      if (
        room.pendingRoute &&
        Number(data.epoch) === room.pendingRoute.epoch &&
        Number(data.sourceRevision) === room.pendingRoute.sourceRevision &&
        matchesProviderIdentity(room.pendingRoute, data)
      )
        await handleProviderFailure(room, {
          provider: room.pendingRoute.provider,
          reason: data.reason || "provider-transition-failed",
          providerId: data.providerId || null,
          eventEpoch: Number(data.epoch),
          sourceRevision: Number(data.sourceRevision),
          failedRoute: room.pendingRoute,
        });
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE: {
      mediaDebug(room.env, "room.provider-failure", {
        provider: data.provider,
        epoch: data.epoch,
        sourceRevision: data.sourceRevision,
        reason: data.reason,
      });
      const sourceRevision = Number(data.sourceRevision);
      const failedPending =
        room.pendingRoute &&
        Number(data.epoch) === room.pendingRoute.epoch &&
        sourceRevision === room.pendingRoute.sourceRevision &&
        matchesProviderIdentity(room.pendingRoute, data);
      const failedActive =
        room.route.kind === "sfu" &&
        Number(data.epoch) === room.route.epoch &&
        sourceRevision === room.sourceRevision &&
        matchesProviderIdentity(room.route, data);
      const failedQualificationFallback =
        room.route.kind === "p2p" &&
        room.route.reason === "qualifying-direct" &&
        Number(data.epoch) === room.route.epoch &&
        sourceRevision === room.sourceRevision &&
        matchesProviderIdentity(room.qualificationFallbackRoute, data);
      const failedRoute = failedPending
        ? room.pendingRoute
        : failedActive
          ? room.route
          : failedQualificationFallback
            ? room.qualificationFallbackRoute
            : null;
      if (failedPending || failedActive || failedQualificationFallback) {
        if (failedPending || !room.pendingRoute) {
          room.providerReadiness.clear();
          room.transitionReadiness.clear();
        }
        await handleProviderFailure(room, {
          provider: data.provider,
          reason: data.reason || "client-provider-failure",
          providerId: data.providerId || null,
          eventEpoch: Number(data.epoch),
          sourceRevision,
          failedRoute,
        });
      }
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_REQUEST:
      await handleCloudflareRequest(room, ws, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION:
      await handleCloudflarePublication(room, ws, session, data);
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.RESUME:
      room.sendTopology(ws, { resumed: true });
      break;
    case MEDIA_CONTROL_MESSAGE_TYPES.LEAVE: {
      await handleLeave(room, ws, session, data);
      break;
    }
    case MEDIA_CONTROL_MESSAGE_TYPES.REQUEST_SNAPSHOT: {
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.STATE_NACK, {
        topology: room.buildTopologySnapshot(),
        roomRevision: room.roomRevision.toString(),
        epoch: room.epoch,
        sourceRevision: room.sourceRevision,
      });
      break;
    }
    default:
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        error: `Unknown message type: ${type}`,
      });
  }
}

function relayClientSfuRtt(room, ws, session, data) {
  const rttMs = Number(data.rttMs);
  if (!Number.isFinite(rttMs) || rttMs < 0) return;
  const participant = room.participants.get(
    `${session.userId}:${session.deviceId}`,
  );
  if (!participant) return;
  for (const recipient of room.participants.values()) {
    if (!recipient.ws || recipient.ws === ws) continue;
    room.sendMessage(
      recipient.ws,
      MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_SFU_RTT,
      {
        userId: session.userId,
        rttMs,
      },
    );
  }
}

function relayCodecMigrationState(room, ws, session, data) {
  const logicalStreamId =
    typeof data.logicalStreamId === "string" &&
    data.logicalStreamId.length > 0 &&
    data.logicalStreamId.length <= 256
      ? data.logicalStreamId
      : null;
  const variantId =
    typeof data.variantId === "string" &&
    data.variantId.length > 0 &&
    data.variantId.length <= 256
      ? data.variantId
      : null;
  const state =
    data.state === "stable" || data.state === "abort" ? data.state : null;
  const generation = Number(data.generation);
  if (
    !logicalStreamId ||
    !variantId ||
    !state ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return false;
  if (data.receiverId != null && String(data.receiverId) !== session.peerId)
    return false;
  const publication = [...room.publishedSources.values()].find((candidate) => {
    if (
      // The sender is a receiver; the publication belongs to another peer.
      candidate.peerId === session.peerId ||
      candidate.logicalStreamId !== logicalStreamId ||
      candidate.variantId !== variantId ||
      Math.max(1, Math.floor(Number(candidate.generation) || 1)) !== generation
    )
      return false;
    if (!Array.isArray(candidate.receivers) || candidate.receivers.length === 0)
      return true;
    return candidate.receivers.map(String).includes(String(session.peerId));
  });
  if (!publication) return false;
  const publisher = [...room.participants.values()].find(
    (participant) =>
      participant.peerId === publication.peerId && participant.ws,
  );
  if (!publisher) return false;
  const reason =
    typeof data.reason === "string" && data.reason.length <= 256
      ? data.reason
      : null;
  return room.sendMessage(
    publisher.ws,
    MEDIA_CONTROL_MESSAGE_TYPES.CODEC_MIGRATION_STATE,
    {
      receiverId: session.peerId,
      logicalStreamId,
      variantId,
      generation,
      state,
      ...(reason ? { reason } : {}),
    },
  );
}

async function authenticateRoomSession(room, ws, session, type, data, now) {
  if (type !== MEDIA_CONTROL_CLIENT_HELLO) {
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      error: "Authentication required",
    });
    ws.close(1008, "Authentication required");
    return;
  }
  const verified = await verifyRoomTicket(room, data.ticket);
  if (!verified.valid) {
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      error: verified.error,
    });
    ws.close(1008, verified.error);
    return;
  }
  if (!isCompatibleClientHello(data, session.mediaSessionId)) {
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      error: "Media control protocol mismatch",
    });
    ws.close(4002, "Media client update required");
    return;
  }
  const claims = verified.claims;
  if (room.channelId && claims.channelId !== room.channelId) {
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      error: "Media ticket channel mismatch",
    });
    ws.close(4003, "Media ticket channel mismatch");
    return;
  }
  session.authenticated = true;
  session.userId = claims.sub;
  session.deviceId = claims.deviceId;
  session.channelId = claims.channelId;
  session.connectionMode = claims.connectionMode || "auto";
  session.routeEpoch = claims.routeEpoch || 0;
  const participantKey = `${claims.sub}:${claims.deviceId}`;
  const resumedParticipant = room.participants.get(participantKey);
  const isSameWebSocketResume = resumedParticipant?.ws === ws;
  let connectionEpoch;
  if (isSameWebSocketResume) {
    connectionEpoch =
      room.participantConnectionEpochs?.get(participantKey) ||
      session.connectionEpoch ||
      1;
  } else {
    connectionEpoch =
      (room.participantConnectionEpochs?.get(participantKey) || 0) + 1;
    room.participantConnectionEpochs.set(participantKey, connectionEpoch);
    void room.state.storage.put(
      "participantConnectionEpochs",
      Object.fromEntries(room.participantConnectionEpochs),
    );
  }
  session.connectionEpoch = connectionEpoch;

  // Preserve Cloudflare session ID across control-plane reconnects.
  // The client preserves the Cloudflare PeerConnection and re-announces
  // publications with the new connectionEpoch. We must retain the
  // provider-session identity so the server accepts those re-announces.
  const preservedCloudflareSessionId = resumedParticipant?.cloudflareSessionId;
  if (preservedCloudflareSessionId) {
    session.cloudflareSessionId = preservedCloudflareSessionId;
  }

  // Synchronize resumed participant state into session BEFORE first serialization.
  // This ensures hibernation captures canonical source state even if no subsequent
  // source/voice/capability mutation occurs before hibernation.
  if (resumedParticipant) {
    session.sources = [...(resumedParticipant.sources || [])];
    session.sourceStates = structuredClone(
      resumedParticipant.sourceStates || {},
    );
  }

  const hasVideo = [...room.participants.values()].some((participant) =>
    [...(participant.sources || [])].some((source) =>
      isVideoMediaSource(source),
    ),
  );
  const participantLimit = getMediaChannelParticipantLimit(
    session.connectionMode,
    hasVideo,
  );
  const projectedParticipantCount = resumedParticipant
    ? room.participants.size
    : room.participants.size + 1;
  if (projectedParticipantCount > participantLimit) {
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      code: "MEDIA_CHANNEL_PARTICIPANT_LIMIT_EXCEEDED",
      error: `This media channel supports up to ${participantLimit} participants for the active media mode`,
    });
    ws.close(4004, "Media channel participant limit exceeded");
    return;
  }
  session.muted = resumedParticipant?.muted !== false;
  session.deafened = resumedParticipant?.deafened === true;
  const configured = room.getConfiguredProviderCapabilities();
  session.providerCapabilities = Array.isArray(data.providerCapabilities)
    ? data.providerCapabilities.filter((provider) => configured.has(provider))
    : [...configured];
  session.mediaCapabilities =
    normalizeMediaCapabilities(data.mediaCapabilities) ||
    resumedParticipant?.mediaCapabilities ||
    null;
  session.capabilityProtocol =
    typeof data.capabilityProtocol === "string"
      ? data.capabilityProtocol
      : resumedParticipant?.capabilityProtocol || "video-codec-matrix-v1";
  ws.serializeAttachment(session);
  mediaDebug(room.env, "room.client-authenticated", {
    peerId: session.peerId,
    connectionMode: session.connectionMode,
    capabilities: session.providerCapabilities,
  });
  room.replaceParticipantSession(participantKey, resumedParticipant, ws);
  if (room.participants.size === 0 && room.epoch === 0)
    room.commitRoute(room.createInitialRoute("room-ready"));
  room.participants.set(participantKey, {
    userId: claims.sub,
    deviceId: claims.deviceId,
    channelId: claims.channelId,
    peerId: session.peerId,
    ws,
    sources: new Set(resumedParticipant?.sources || []),
    sourceStates: resumedParticipant?.sourceStates || {},
    providerCapabilities: new Set(session.providerCapabilities),
    muted: session.muted,
    deafened: session.deafened,
    joinedAt: resumedParticipant?.joinedAt || now,
    lastSeenAt: now,
    status: "connected",
    disconnectedAt: null,
    mediaCapabilities: session.mediaCapabilities,
    capabilityProtocol: session.capabilityProtocol,
    connectionEpoch,
    cloudflareSessionId: session.cloudflareSessionId,
  });
  if (!resumedParticipant) {
    room.roomRevision++;
    void room.state.storage.put("roomRevision", room.roomRevision);
  }
  await room.refreshPendingRouteSourceRevision?.();
  const participants = [...room.participants.values()]
    .filter((participant) => participant.peerId !== session.peerId)
    .map(participantCapabilityPayload)
    .filter(Boolean);
  room.sendMessage(ws, "connected", {
    peerId: session.peerId,
    participants,
    inRoom: participants,
    roomRevision: room.roomRevision.toString(),
    epoch: room.epoch,
    sourceRevision: room.sourceRevision,
    publicationRevision: room.publicationRevision,
    connectionEpoch,
  });
  broadcastParticipantCapabilities(
    room,
    room.participants.get(participantKey),
    ws,
  );
  if (room.participants.size === 1 && room.epoch === 0)
    await room.commitRoute(room.createInitialRoute("single-participant"));
  else room.sendTopology(ws);
  for (const publication of room.publishedSources.values())
    if (publication.peerId !== session.peerId)
      room.sendMessage(
        ws,
        MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
        {
          ...publication,
          publicationRevision: room.publicationRevision,
          roomRevision: room.roomRevision.toString(),
          sourceRevision: room.sourceRevision,
        },
      );
  if (room.pendingRoute)
    await room.issueProviderTicket(
      room.participants.get(participantKey),
      room.pendingRoute,
    );
  room.maybeStartQualification();
}

async function handleProviderReady(room, ws, session, data) {
  if (
    !room.pendingRoute ||
    Number(data.epoch) !== room.pendingRoute.epoch ||
    Number(data.sourceRevision) !== room.pendingRoute.sourceRevision ||
    !matchesProviderIdentity(room.pendingRoute, data)
  )
    return;
  room.providerReadiness.add(session.peerId);
  session.providerReadyEpoch = Number(data.epoch);
  session.providerReadySourceRevision = Number(data.sourceRevision);
  const participant = room.participants.get(
    `${session.userId}:${session.deviceId}`,
  );
  if (participant) {
    session.sourceStates = structuredClone(participant.sourceStates || {});
    session.cloudflareSessionId = participant.cloudflareSessionId ?? null;
  }
  ws.serializeAttachment(session);
  room.providerHealth.set(
    providerHealthKey(data.provider, data.providerId || null),
    {
      healthy: true,
      provider: data.provider,
      providerId: data.providerId || null,
      epoch: Number(data.epoch),
      unhealthyUntil: 0,
      updatedAt: Date.now(),
    },
  );
  await room.state.storage.put(
    "providerHealth",
    Object.fromEntries(room.providerHealth),
  );
  await room.maybeCommitPendingRoute();
}

async function handleTopologyReady(room, session, data) {
  if (
    !room.pendingRoute ||
    room.pendingRoute.kind !== "sfu" ||
    data.target !== "sfu" ||
    Number(data.epoch) !== room.pendingRoute.epoch ||
    Number(data.sourceRevision) !== room.pendingRoute.sourceRevision ||
    !matchesProviderIdentity(room.pendingRoute, data)
  )
    return;
  room.transitionReadiness.add(session.peerId);
  await room.maybeCommitPendingRoute();
}

function matchesProviderIdentity(route, data) {
  if (!route || data?.provider !== route.provider) return false;
  if (route.providerId) return data.providerId === route.providerId;
  return !data.providerId || data.providerId === null;
}

function operationCacheKey(session, operationId) {
  if (!operationId || !session) return null;
  return `${session.userId}:${session.deviceId}:${
    session.connectionEpoch ?? "?"
  }:${operationId}`;
}

async function handleLeave(room, ws, session, data) {
  const participantKey = `${session.userId}:${session.deviceId}`;
  const participant = room.participants.get(participantKey);
  room.leavePending.delete(participantKey);
  if (participant && participant.ws === ws) {
    await room.finalizeParticipantDisconnect(participantKey, participant);
  }
  const ackPayload = {
    operationId: data.operationId,
    accepted: true,
    roomRevision: room.roomRevision.toString(),
    canonicalState: room.buildTopologySnapshot
      ? room.buildTopologySnapshot()
      : undefined,
  };
  await room.storeOperationResult(
    operationCacheKey(session, data.operationId),
    ackPayload,
  );
  room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK, ackPayload);
  ws.close(4000, "leave-acknowledged");
}

async function handleCloudflarePublication(room, ws, session, data) {
  const source = normalizeMediaSources([data.source])?.[0];
  if (
    !session.cloudflareSessionId ||
    typeof data.trackName !== "string" ||
    data.trackName.length === 0 ||
    data.trackName.length > 256 ||
    !source
  )
    return;
  const target =
    data.target && typeof data.target === "object"
      ? Object.fromEntries(
          ["width", "height", "fps", "bitrate"]
            .map((field) => [field, Number(data.target[field])])
            .filter(([, value]) => Number.isFinite(value) && value > 0)
            .map(([field, value]) => [field, Math.floor(value)]),
        )
      : {};
  const publication = {
    sessionId: session.cloudflareSessionId,
    trackName: data.trackName,
    source,
    ownerSource: normalizeMediaOwnerSource(source, data.ownerSource),
    userId: session.userId,
    peerId: session.peerId,
    ...(typeof data.logicalStreamId === "string"
      ? { logicalStreamId: data.logicalStreamId.slice(0, 256) }
      : {}),
    ...(Number.isSafeInteger(Number(data.generation)) &&
    Number(data.generation) > 0
      ? { generation: Math.floor(Number(data.generation)) }
      : {}),
    ...(typeof data.connectionEpoch === "number" &&
    Number.isSafeInteger(data.connectionEpoch)
      ? { connectionEpoch: Math.floor(data.connectionEpoch) }
      : {}),
    ...(typeof data.variantId === "string" && data.variantId.length <= 256
      ? { variantId: data.variantId }
      : {}),
    ...(typeof data.codec === "string" && data.codec.length <= 16
      ? { codec: data.codec.toUpperCase() }
      : {}),
    ...(data.codecAcceleration === "hardware" ||
    data.codecAcceleration === "software" ||
    data.codecAcceleration === "unsupported"
      ? { codecAcceleration: data.codecAcceleration }
      : {}),
    ...(typeof data.codecImplementation === "string" &&
    data.codecImplementation.length <= 128
      ? { codecImplementation: data.codecImplementation }
      : {}),
    ...(Number.isFinite(Number(data.width)) && Number(data.width) > 0
      ? { width: Math.floor(Number(data.width)) }
      : {}),
    ...(Number.isFinite(Number(data.height)) && Number(data.height) > 0
      ? { height: Math.floor(Number(data.height)) }
      : {}),
    ...(Number.isFinite(Number(data.fps)) && Number(data.fps) > 0
      ? { fps: Math.floor(Number(data.fps)) }
      : {}),
    ...(Number.isFinite(Number(data.bitrate)) && Number(data.bitrate) > 0
      ? { bitrate: Math.floor(Number(data.bitrate)) }
      : {}),
    ...(Object.keys(target).length ? { target } : {}),
    ...(data.targetAdjusted === true ? { targetAdjusted: true } : {}),
    ...(Array.isArray(data.receivers)
      ? {
          receivers: [
            ...new Set(
              data.receivers.filter(
                (receiver) =>
                  typeof receiver === "string" && receiver.length <= 128,
              ),
            ),
          ].slice(0, 100),
        }
      : {}),
    ...(data.emergency === true ? { emergency: true } : {}),
    ...(Number.isFinite(Number(data.score))
      ? { score: Number(data.score) }
      : {}),
    closed: data.closed === true,
  };
  const publicationKey = mediaPublicationKey(publication);
  const participant = room.participants.get(
    `${session.userId}:${session.deviceId}`,
  );
  const canonical = participant?.sourceStates?.[source];
  // Provider callbacks are NOT authoritative. The canonical source state
  // (participant desired state + generation + epoch) decides whether a
  // publication is current. A stale provider completion must not resurrect
  // a source the participant already stopped.
  const clientEpoch = Number(publication.connectionEpoch);
  // Server-owned epoch: prefer the participant record (set at attach),
  // fall back to the session for restored/hibernated paths.
  const serverEpoch = Number(
    participant?.connectionEpoch ?? session.connectionEpoch,
  );
  const canonicalGeneration = Number(canonical?.generation || 0);
  const publicationGeneration = Number(publication.generation || 0);
  const epochMismatch =
    Number.isSafeInteger(clientEpoch) &&
    Number.isSafeInteger(serverEpoch) &&
    clientEpoch !== serverEpoch;
  const generationMismatch =
    canonicalGeneration > 0 && publicationGeneration !== canonicalGeneration;
  const notActive =
    !participant ||
    !participant.sources?.has(source) ||
    canonical?.desiredState !== "active";
  if (
    !publication.closed &&
    (epochMismatch || generationMismatch || notActive)
  ) {
    mediaDebug(room.env, "cloudflare.publication-rejected", {
      source,
      reason: epochMismatch
        ? "epoch-mismatch"
        : generationMismatch
          ? "generation-mismatch"
          : "not-active",
      clientEpoch,
      serverEpoch,
      publicationGeneration,
      canonicalGeneration,
    });
    return;
  }
  let changed = false;
  const closedPublications = [];
  const previous = room.publishedSources.get(publicationKey);
  if (publication.closed) {
    for (const [key, current] of room.publishedSources)
      if (
        current.peerId === publication.peerId &&
        current.source === publication.source &&
        (!publication.variantId ||
          current.variantId === publication.variantId) &&
        (!publication.trackName ||
          current.trackName === publication.trackName) &&
        // Generation/epoch fencing: only retire if the publication being closed
        // is the same or older generation than what we have
        (!publication.generation ||
          !current.generation ||
          Number(publication.generation) >= Number(current.generation)) &&
        (!publication.connectionEpoch ||
          !current.connectionEpoch ||
          Number(publication.connectionEpoch) >=
            Number(current.connectionEpoch))
      ) {
        room.publishedSources.delete(key);
        closedPublications.push({ ...current, closed: true });
        changed = true;
      }
  } else if (previous) {
    // Idempotent replay: identical canonical publication must not move
    // revisions. Compare the stored vs incoming publication field-by-field.
    const ignoredFields = new Set(["updatedAt"]);
    const same = [
      ...new Set([...Object.keys(previous), ...Object.keys(publication)]),
    ]
      .filter((field) => !ignoredFields.has(field))
      .every(
        (field) =>
          Object.is(previous[field], publication[field]) ||
          String(previous[field]) === String(publication[field]),
      );
    if (!same) {
      room.publishedSources.set(publicationKey, publication);
      changed = true;
    }
  } else {
    room.publishedSources.set(publicationKey, publication);
    changed = true;
  }
  // Revision domains are distinct: publicationRevision tracks provider
  // publication changes, sourceRevision tracks logical desired source-set
  // mutations, roomRevision tracks any canonical snapshot change.
  if (changed) {
    room.commitPublicationMutation({
      removed: publication.closed ? closedPublications : [],
      upserted: publication.closed ? [] : [publication],
      excludedWs: ws,
    });
  }
  // publicationState mirrors the canonical FSM: a live provider publication
  // means "published"; a closed one means the source has no provider
  // publication and returns to "announced" (still active by intent) or
  // "unpublished" (inactive). This keeps sourceState.publicationState
  // authoritative instead of frozen from an earlier intent mutation.
  if (participant?.sourceStates?.[source]) {
    const sourceState = participant.sourceStates[source];
    const nextPublicationState = publication.closed
      ? sourceState.desiredState === "active"
        ? "announced"
        : "unpublished"
      : "published";
    if (sourceState.publicationState !== nextPublicationState) {
      participant.sourceStates[source] = {
        ...sourceState,
        publicationState: nextPublicationState,
        updatedAt: Date.now(),
      };
      room.sourceRevision++;
      room.roomRevision = (room.roomRevision || 0n) + 1n;
      void Promise.all([
        room.state.storage.put("sourceRevision", room.sourceRevision),
        room.state.storage.put("roomRevision", room.roomRevision),
      ]);
      // Copy the authoritative participant state into the session BEFORE
      // serializing: hibernation reconstructs entirely from the attachment,
      // so a stale session.sourceStates would persist the old
      // publicationState ("announced") even though the revision already
      // advanced to the transition that produced "published".
      session.sourceStates = structuredClone(participant.sourceStates);
      if (participant.cloudflareSessionId)
        session.cloudflareSessionId = participant.cloudflareSessionId;
      if (typeof ws.serializeAttachment === "function")
        ws.serializeAttachment(session);
      room.broadcastTopology();
    }
  }
}

export async function verifyRoomTicket(room, ticket) {
  if (!ticket || typeof ticket !== "string")
    return { valid: false, error: "Missing ticket" };
  try {
    const claims = await verifyMediaTicket(ticket, room.env);
    if (!claims.sub || !claims.deviceId || !claims.channelId)
      return { valid: false, error: "Media ticket is missing required claims" };
    if (!["auto", "direct"].includes(claims.connectionMode || "auto"))
      return {
        valid: false,
        error: "Media ticket has an invalid connection mode",
      };
    return { valid: true, claims };
  } catch (error) {
    return { valid: false, error: error.message || "Invalid media ticket" };
  }
}
