import {
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_ROUTE_KIND,
  P2P_PATH,
  SFU_PROVIDER,
  checkP2PEligibility,
  createP2PRoute,
  createSFURoute,
} from "./protocol.js";
import { qoeWouldImprove, rankQoeCandidates } from "./qoe.ts";
import { mediaDebug } from "./debug.ts";
import {
  getQoeCandidates,
  getAvailableProviderCapabilities,
  getProviderRecoveryTarget,
  getNextProviderRecoveryAt,
  providerHealthKey,
  scheduleProviderRecovery,
} from "./media-room-provider.ts";
import { isVideoMediaSource } from "./media-room-contracts.ts";

const P2P_QUALIFICATION_STABILITY_MS = 2_000;

export function maybeCommitPendingRoute(room) {
  if (!room.pendingRoute) return Promise.resolve();
  const expected = new Set(
    [...room.participants.values()].map((participant) => participant.peerId),
  );
  const providerReady =
    room.pendingRoute.provider === SFU_PROVIDER.CLOUDFLARE_REALTIME ||
    (room.providerReadiness.size === expected.size &&
      [...room.providerReadiness].every((peerId) => expected.has(peerId)));
  if (
    providerReady &&
    room.transitionReadiness.size === expected.size &&
    [...room.transitionReadiness].every((peerId) => expected.has(peerId))
  )
    return room.commitRoute(room.pendingRoute);
  return Promise.resolve();
}

export function maybeStartQualification(room) {
  const participantCount = room.participants.size;
  if (participantCount === 0) return;
  const hasVideo = [...room.participants.values()].some((participant) =>
    [...participant.sources].some((source) => isVideoMediaSource(source)),
  );
  const connectionMode = room.getConnectionMode();
  const eligibility = checkP2PEligibility({
    connectionMode,
    participantCount,
    hasVideo,
    requiredSources: [...room.publishedSources.values()].map(
      (source) => source.source,
    ),
  });
  if (!eligibility.eligible) {
    if (connectionMode === "direct") {
      const latest = [...room.sessions.values()].find(
        (session) => session.authenticated,
      );
      room.sendMessage(latest?.ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        code:
          eligibility.reason === "server-source-requires-auto-mode"
            ? "DIRECT_MEDIA_UNAVAILABLE"
            : "DIRECT_PARTICIPANT_LIMIT_EXCEEDED",
        error: "Direct mode supports fewer participants for this media mix",
      });
      return;
    }
    if (!room.pendingRoute) {
      const fallbackProvider = room.qualificationFallbackRoute?.provider;
      if (
        fallbackProvider &&
        getAvailableProviderCapabilities(room).has(fallbackProvider)
      )
        void room.restoreQualificationRoute(
          `p2p-ineligible-${eligibility.reason}`,
        );
      else if (
        room.route.kind !== MEDIA_ROUTE_KIND.SFU ||
        room.route.provider !== SFU_PROVIDER.CLOUDFLARE_REALTIME
      )
        void room.beginTransition(SFU_PROVIDER.CLOUDFLARE_REALTIME);
    }
    return;
  }
  if (room.pendingRoute) return;
  if (participantCount === 1) {
    if (
      connectionMode === "auto" &&
      !room.pendingRoute &&
      room.route.kind === MEDIA_ROUTE_KIND.LOCAL
    )
      void room.beginTransition(SFU_PROVIDER.CLOUDFLARE_REALTIME);
    return;
  }
  if (connectionMode === "auto" && room.route.kind === MEDIA_ROUTE_KIND.LOCAL) {
    void room.beginTransition(
      SFU_PROVIDER.CLOUDFLARE_REALTIME,
      "qualification-fallback",
    );
    return;
  }
  if (
    room.route.kind === MEDIA_ROUTE_KIND.P2P &&
    room.route.reason === "qualifying-direct" &&
    room.route.sourceRevision === room.sourceRevision &&
    room.qualificationParticipantSignature === room.getParticipantSignature()
  )
    return;
  if (
    room.route.kind === MEDIA_ROUTE_KIND.P2P &&
    room.route.reason === "qualified-direct-mesh" &&
    room.qualifiedParticipantSignature === room.getParticipantSignature()
  )
    return;
  const allReady = [...room.participants.values()].every(
    (participant) => participant.ws?.readyState === WebSocket.OPEN,
  );
  if (!allReady) return;
  const fallbackRoute =
    room.route.kind === MEDIA_ROUTE_KIND.SFU && room.route.provider
      ? { ...room.route }
      : room.route.kind === MEDIA_ROUTE_KIND.P2P &&
          room.route.reason === "qualifying-direct" &&
          room.qualificationFallbackRoute
        ? { ...room.qualificationFallbackRoute }
        : null;
  room.qualificationFallbackRoute = fallbackRoute;
  room.qualificationParticipantSignature = room.getParticipantSignature();
  room.qualificationState.clear();
  for (const [ws, session] of room.sessions) {
    session.qualifiedPeerIds = [];
    session.providerReadyEpoch = null;
    session.providerReadySourceRevision = null;
    ws.serializeAttachment?.(session);
  }
  room.route = createP2PRoute(
    P2P_PATH.DIRECT,
    ++room.epoch,
    room.sourceRevision,
    "qualifying-direct",
  );
  room.qualificationStartedAt = Date.now();
  void Promise.all([
    room.state.storage.put("route", room.route),
    room.state.storage.put("epoch", room.epoch),
    room.state.storage.put("sourceRevision", room.sourceRevision),
    room.state.storage.put(
      "qualificationStartedAt",
      room.qualificationStartedAt,
    ),
    room.state.storage.put(
      "qualificationParticipantSignature",
      room.qualificationParticipantSignature,
    ),
    fallbackRoute
      ? room.state.storage.put("qualificationFallbackRoute", fallbackRoute)
      : room.state.storage.delete("qualificationFallbackRoute"),
  ]);
  room.transitionGeneration++;
  mediaDebug(room.env, "room.p2p-qualification-start", {
    epoch: room.epoch,
    participants: room.participants.size,
  });
  for (const participant of room.participants.values())
    room.sendTopology(participant.ws, { action: "qualify-p2p" });
}

export function checkQualificationComplete(room) {
  const expectedPeers = new Set(
    [...room.participants.values()].map((participant) => participant.peerId),
  );
  let allQualified = room.qualificationState.size === expectedPeers.size;
  for (const [peerId, state] of room.qualificationState) {
    if (!expectedPeers.has(peerId) || !state.ready) {
      allQualified = false;
      break;
    }
    const qualified = state.qualifiedPeers;
    const expectedForPeer = new Set(expectedPeers);
    expectedForPeer.delete(peerId);
    if (qualified.size !== expectedForPeer.size) {
      allQualified = false;
      break;
    }
    for (const qualifiedPeerId of qualified)
      if (!expectedForPeer.has(qualifiedPeerId)) {
        allQualified = false;
        break;
      }
    if (!allQualified) break;
  }
  if (!allQualified || room.participants.size < 2) return;
  if (
    Date.now() - room.qualificationStartedAt <
    P2P_QUALIFICATION_STABILITY_MS
  ) {
    void room.state.storage.setAlarm?.(
      room.qualificationStartedAt + P2P_QUALIFICATION_STABILITY_MS,
    );
    return;
  }
  const candidateReports = [...room.qualificationState.values()].flatMap(
    (state) => state.candidateReports || [],
  );
  const p2pCandidate = rankQoeCandidates([
    {
      provider: "p2p",
      paths: candidateReports,
      stableSince: room.qualificationStartedAt,
    },
  ])[0];
  const activeProvider = room.qualificationFallbackRoute?.provider || null;
  const activeCandidate = rankQoeCandidates(getQoeCandidates(room)).find(
    (candidate) => candidate.provider === activeProvider,
  );
  if (
    activeCandidate &&
    (!p2pCandidate.paths.every((path) => path.rttMs != null) ||
      !qoeWouldImprove(activeCandidate, p2pCandidate, Date.now()))
  ) {
    void room.state.storage.setAlarm?.(Date.now() + 1_000);
    return;
  }
  room.commitRoute(
    createP2PRoute(
      P2P_PATH.DIRECT,
      room.epoch,
      room.sourceRevision,
      "qualified-direct-mesh",
    ),
  );
}

export function commitRoute(room, route) {
  const validation = room.validateRoute(route, room.getConnectionMode());
  if (!validation.valid) {
    console.warn("[MediaRoomDO] Route rejected:", validation.error);
    mediaDebug(room.env, "room.route-rejected", {
      provider: route.provider,
      kind: route.kind,
      epoch: route.epoch,
      reason: validation.error,
    });
    return Promise.resolve(false);
  }
  const shouldStartQualification =
    route.kind === MEDIA_ROUTE_KIND.SFU &&
    route.reason === "qualification-fallback";
  room.route = route;
  room.epoch = route.epoch;
  room.qualifiedParticipantSignature =
    route.kind === MEDIA_ROUTE_KIND.P2P ? room.getParticipantSignature() : null;
  room.pendingRoute = null;
  room.pendingStartedAt = 0;
  room.providerReadiness.clear();
  room.qualificationFallbackRoute = null;
  room.qualificationParticipantSignature = null;
  if (route.kind === MEDIA_ROUTE_KIND.SFU && route.provider)
    room.providerHealth.set(
      providerHealthKey(route.provider, route.providerId),
      {
        healthy: true,
        provider: route.provider,
        providerId: route.providerId || null,
        epoch: route.epoch,
        unhealthyUntil: 0,
        updatedAt: Date.now(),
      },
    );
  room.qualificationState.clear();
  room.transitionReadiness.clear();
  mediaDebug(room.env, "room.route-committed", {
    kind: route.kind,
    provider: route.provider,
    epoch: route.epoch,
    sourceRevision: route.sourceRevision,
  });
  const persistence = Promise.all([
    room.state.storage.put("route", route),
    room.state.storage.put("epoch", room.epoch),
    room.state.storage.put("sourceRevision", room.sourceRevision),
    room.state.storage.put(
      "qualifiedParticipantSignature",
      room.qualifiedParticipantSignature,
    ),
    room.state.storage.put(
      "qualificationStartedAt",
      room.qualificationStartedAt,
    ),
    room.state.storage.put(
      "providerHealth",
      Object.fromEntries(room.providerHealth),
    ),
    room.state.storage.delete("pendingRoute"),
    room.state.storage.delete("pendingStartedAt"),
    room.state.storage.delete("qualificationFallbackRoute"),
    room.state.storage.delete("qualificationParticipantSignature"),
  ]);
  room.broadcastTopology();
  for (const [ws, session] of room.sessions)
    if (session.authenticated && ws.readyState === WebSocket.OPEN)
      room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ROUTE_COMMIT, {
        route,
        mode:
          route.kind === MEDIA_ROUTE_KIND.P2P
            ? "p2p"
            : route.kind === MEDIA_ROUTE_KIND.SFU
              ? "sfu"
              : "idle",
        provider: route.provider,
        providerId: route.providerId,
        epoch: route.epoch,
        sourceRevision: route.sourceRevision,
        participants: room.getParticipantList(),
        peers: room.getParticipantList(),
      });
  return persistence.then(() => {
    if (shouldStartQualification) void room.maybeStartQualification?.();
    return true;
  });
}

export function restoreQualificationRoute(
  room,
  reason = "p2p-qualification-failed",
) {
  const fallback = room.qualificationFallbackRoute;
  if (!fallback?.provider) return Promise.resolve(false);
  if (!getAvailableProviderCapabilities(room).has(fallback.provider))
    return Promise.resolve(false);
  return room.commitRoute(
    createSFURoute(
      fallback.provider,
      room.epoch + 1,
      room.sourceRevision,
      reason,
      fallback.providerId || null,
    ),
  );
}
