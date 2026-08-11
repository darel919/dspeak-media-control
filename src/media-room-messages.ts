import {
  MEDIA_CONTROL_CONTRACT_REVISION,
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_CONTROL_PROTOCOL_VERSION,
  SFU_PROVIDER,
} from "./protocol.js";
import { verifyMediaTicket } from "./tickets.js";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  normalizeMediaOwnerSource,
  normalizeParticipantVoiceState,
  normalizeMediaSources,
} from "./media-room-contracts.ts";
import {
  handleCloudflareRequest,
  handleP2PFailure,
  handleProviderFailure,
  QOE_REPORT_MAX_AGE_MS,
  providerHealthKey,
} from "./media-room-provider.ts";
import { mediaDebug } from "./debug.ts";
import { normalizeQoePath } from "./qoe.ts";

export async function handleRoomMessage(room, ws, session, envelope) {
  const data =
    envelope?.data && typeof envelope.data === "object"
      ? envelope.data
      : envelope;
  const type = envelope?.type;
  const now = Date.now();
  session.lastHeartbeat = now;

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

  switch (type) {
    case MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT: {
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK, {
        sequence: data.sequence,
        timestamp: now,
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
      if (!sourcesChanged && stalePublications.length === 0) break;
      room.sourceRevision++;
      await Promise.all([
        room.state.storage.put("sourceRevision", room.sourceRevision),
        stalePublications.length
          ? room.state.storage.put("publishedSources", [
              ...room.publishedSources.values(),
            ])
          : Promise.resolve(),
      ]);
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
        await handleProviderFailure(
          room,
          room.pendingRoute.provider,
          data.reason || "provider-transition-failed",
        );
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
      if (failedPending || failedActive || failedQualificationFallback) {
        room.providerReadiness.clear();
        room.transitionReadiness.clear();
        await handleProviderFailure(
          room,
          data.provider,
          data.reason || "client-provider-failure",
        );
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
  session.muted = resumedParticipant?.muted !== false;
  session.deafened = resumedParticipant?.deafened === true;
  const configured = room.getConfiguredProviderCapabilities();
  session.providerCapabilities = Array.isArray(data.providerCapabilities)
    ? data.providerCapabilities.filter((provider) => configured.has(provider))
    : [...configured];
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
    providerCapabilities: new Set(session.providerCapabilities),
    muted: session.muted,
    deafened: session.deafened,
    joinedAt: resumedParticipant?.joinedAt || now,
    disconnectedAt: null,
  });
  await room.refreshPendingRouteSourceRevision?.();
  room.sendMessage(ws, "connected", { peerId: session.peerId });
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
  const publication = {
    sessionId: session.cloudflareSessionId,
    trackName: data.trackName,
    source,
    ownerSource: normalizeMediaOwnerSource(source, data.ownerSource),
    userId: session.userId,
    peerId: session.peerId,
    closed: data.closed === true,
  };
  const publicationKey = `${session.peerId}:${source}`;
  if (publication.closed) room.publishedSources.delete(publicationKey);
  else room.publishedSources.set(publicationKey, publication);
  await room.state.storage.put("publishedSources", [
    ...room.publishedSources.values(),
  ]);
  for (const participant of room.participants.values())
    if (participant.ws !== ws)
      room.sendMessage(
        participant.ws,
        MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
        publication,
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
