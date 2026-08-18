import {
  MEDIA_CONTROL_CONTRACT_REVISION,
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_CONTROL_PROTOCOL_VERSION,
  SFU_PROVIDER,
  getMediaChannelParticipantLimit,
} from "./protocol.js";
import { verifyMediaTicket } from "./tickets.js";
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
    type === MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED;

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
  const operationCacheKey = (operationId) =>
    operationId
      ? `${participantKey}:${session.connectionEpoch ?? "?"}:${operationId}`
      : null;
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
    room.storeOperationResult(operationCacheKey(operationId), nackPayload);
    room.sendMessage(
      ws,
      MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
      nackPayload,
    );
    return;
  }
  const hasExpectedRoomRevision =
    typeof data.expectedRoomRevision === "string" &&
    data.expectedRoomRevision.length > 0;
  const expectedRoomRevision = hasExpectedRoomRevision
    ? data.expectedRoomRevision
    : null;
  const isParticipantLocalMutation =
    type === MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_CAPABILITIES ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY ||
    type === MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED;
  if (
    isMutation &&
    !isParticipantLocalMutation &&
    hasExpectedRoomRevision &&
    expectedRoomRevision !== room.roomRevision.toString()
  ) {
    const nackPayload = {
      operationId,
      accepted: false,
      code: "ROOM_REVISION_CONFLICT",
      retryable: true,
      roomRevision: room.roomRevision.toString(),
      canonicalState: room.buildTopologySnapshot
        ? room.buildTopologySnapshot()
        : undefined,
    };
    room.storeOperationResult(operationCacheKey(operationId), nackPayload);
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
          connectionEpoch:
            room.participantConnectionEpochs?.get(
              `${session.userId}:${session.deviceId}`,
            ) || 1,
          publishedSourcesDigest: [...room.publishedSources.values()].map(
            (publication) => ({
              source: publication.source,
              peerId: publication.peerId,
              generation: publication.generation,
            }),
          ),
        });
        break;
      }
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK, {
        sequence: data.sequence,
        timestamp: now,
        roomRevision: room.roomRevision.toString(),
        epoch: room.epoch,
        sourceRevision: room.sourceRevision,
        connectionEpoch:
          room.participantConnectionEpochs?.get(
            `${session.userId}:${session.deviceId}`,
          ) || 1,
        publishedSourcesDigest: [...room.publishedSources.values()].map(
          (publication) => ({
            source: publication.source,
            peerId: publication.peerId,
            generation: publication.generation,
          }),
        ),
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
      room.storeOperationResult(operationCacheKey(operationId), ackPayload);
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
      room.storeOperationResult(operationCacheKey(operationId), ackPayload);
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
      const hasVideo = [...room.participants.values()].some((candidate) =>
        [
          ...(candidate === participant ? sources : candidate.sources || []),
        ].some((source) => isVideoMediaSource(source)),
      );
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
      const stalePublications = [];
      const sourceSet = new Set(sources);
      const previousSources = participant.sources || new Set();
      const sourcesChanged =
        previousSources.size !== sourceSet.size ||
        [...previousSources].some((source) => !sourceSet.has(source));
      for (const [key, publication] of room.publishedSources) {
        if (
          publication.peerId === session.peerId &&
          !sourceSet.has(publication.source)
        ) {
          room.publishedSources.delete(key);
          stalePublications.push({ ...publication, closed: true });
        }
      }
      participant.sources = new Set(sources);
      session.sources = [...participant.sources];
      ws.serializeAttachment(session);
      if (!participant.sourceStates) participant.sourceStates = {};
      const nowFs = Date.now();
      const clientSourceStates = data.sourceStates || {};
      for (const source of sourceSet) {
        const clientState = clientSourceStates[source];
        const previousState = participant.sourceStates[source] || {
          generation: 0,
          desiredState: "inactive",
          publicationState: "unpublished",
          provider: null,
        };
        const isAudioSource = source === "audio";
        // Source-specific desired state - microphone mute does not deactivate camera/screen
        const desired =
          participant.sources.has(source) &&
          (isAudioSource ? !participant.muted : true)
            ? "active"
            : "inactive";
        const clientGeneration = Number.isSafeInteger(clientState?.generation)
          ? clientState.generation
          : previousState.generation;
        const isStale = clientGeneration < previousState.generation;
        if (isStale) {
          const canonicalState = room.buildTopologySnapshot
            ? room.buildTopologySnapshot()
            : undefined;
          const nackPayload = {
            operationId,
            accepted: false,
            code: "STALE_SOURCE_GENERATION",
            retryable: false,
            // Not blindly retryable: client adopts canonical generation and
            // reconciles latest desired state with a new fenced operation.
            adoptsCanonicalGeneration: true,
            roomRevision: String(room.roomRevision),
            source: source,
            expectedGeneration: previousState.generation,
            receivedGeneration: clientGeneration,
            canonicalState: canonicalState,
          };
          room.storeOperationResult(operationCacheKey(operationId), nackPayload);
          room.sendMessage(
            ws,
            MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
            nackPayload,
          );
          return;
        }
        participant.sourceStates[source] = {
          ...previousState,
          desiredState: desired,
          generation: clientGeneration,
          publicationState: sourceSet.has(source)
            ? previousState.publicationState === "published"
              ? "published"
              : "announced"
            : "unpublished",
          provider: previousState.provider,
          updatedAt: nowFs,
        };
      }
      for (const previousSource of previousSources) {
        if (!sourceSet.has(previousSource)) {
          participant.sourceStates[previousSource] = {
            generation:
              (participant.sourceStates[previousSource]?.generation || 0) + 1,
            desiredState: "inactive",
            publicationState: "unpublished",
            provider: null,
            updatedAt: nowFs,
          };
        }
      }
      // Increment revisions BEFORE sending ACK (post-commit revision)
      if (sourcesChanged || stalePublications.length > 0) {
        room.roomRevision++;
        room.sourceRevision++;
        await Promise.all([
          room.state.storage.put("roomRevision", room.roomRevision),
          room.state.storage.put("sourceRevision", room.sourceRevision),
          stalePublications.length
            ? room.state.storage.put("publishedSources", [
                ...room.publishedSources.values(),
              ])
            : Promise.resolve(),
        ]);
      }
      const ackPayload = {
        operationId,
        accepted: true,
        roomRevision: room.roomRevision.toString(),
        canonicalState: room.buildTopologySnapshot
          ? room.buildTopologySnapshot()
          : undefined,
      };
      room.storeOperationResult(operationCacheKey(operationId), ackPayload);
      room.sendMessage(
        ws,
        MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK,
        ackPayload,
      );
      for (const publication of stalePublications)
        for (const recipient of room.participants.values())
          if (recipient.ws && recipient.ws !== ws)
            room.sendMessage(
              recipient.ws,
              MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
              publication,
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
  if (
    Number(data.protocolVersion) !== MEDIA_CONTROL_PROTOCOL_VERSION ||
    Number(data.contractRevision) !== MEDIA_CONTROL_CONTRACT_REVISION ||
    data.mediaSessionId !== session.mediaSessionId
  ) {
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
        publication,
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
  room.storeOperationResult(operationCacheKey(data.operationId), ackPayload);
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
      )
        room.publishedSources.delete(key);
  } else room.publishedSources.set(publicationKey, publication);
  room.sourceRevision += 1;
  room.roomRevision = (room.roomRevision || 0n) + 1n;
  await room.state.storage.put("publishedSources", [
    ...room.publishedSources.values(),
  ]);
  await room.state.storage.put("sourceRevision", room.sourceRevision);
  await room.state.storage.put("roomRevision", room.roomRevision);
  for (const participant of room.participants.values())
    if (participant.ws !== ws)
      room.sendMessage(
        participant.ws,
        MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
        {
          ...publication,
          sourceRevision: room.sourceRevision,
          roomRevision: room.roomRevision.toString(),
        },
      );
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
