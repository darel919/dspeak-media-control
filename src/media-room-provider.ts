import {
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_ROUTE_KIND,
  MEDIA_PROVIDER_PROTOCOL_REVISION,
  SFU_PROVIDER,
  chooseAvailableProvider,
  createSFURoute,
} from "./protocol.js";
import { signProviderTicket } from "./tickets.js";
import {
  configuredSfuProviders,
  isCloudflareRealtimeConfigured,
  isSelfHostedMediasoupConfigured,
  providerRegistryEnabled,
} from "./provider-config.ts";
import { mediaDebug } from "./debug.ts";
import { isVideoMediaSource } from "./media-room-contracts.ts";

const PROVIDER_FAILURE_COOLDOWN_MS = 30_000;

export function getConfiguredProviderCapabilities(room) {
  return configuredSfuProviders(room.env);
}

export function getCommonProviderCapabilities(room) {
  if (
    (!room.participants || typeof room.participants.values !== "function") &&
    typeof room.getCommonProviderCapabilities === "function"
  )
    return room.getCommonProviderCapabilities();
  const participants = [...room.participants.values()];
  const configured = getConfiguredProviderCapabilities(room);
  if (!participants.length) return configured;
  return new Set(
    [...configured].filter((provider) =>
      participants.every((participant) =>
        participant.providerCapabilities?.has(provider),
      ),
    ),
  );
}

export function getAvailableProviderCapabilities(room) {
  const available = getCommonProviderCapabilities(room);
  const now = Date.now();
  for (const provider of available) {
    const health = room.providerHealth.get(provider);
    if (health?.healthy === false && Number(health.unhealthyUntil) > now)
      available.delete(provider);
  }
  return available;
}

export function getNextProviderRecoveryAt(room, now = Date.now()) {
  let retryAt = null;
  for (const provider of getCommonProviderCapabilities(room)) {
    const health = room.providerHealth.get(provider);
    const unhealthyUntil = Number(health?.unhealthyUntil);
    if (
      health?.healthy === false &&
      Number.isFinite(unhealthyUntil) &&
      unhealthyUntil > now &&
      (retryAt === null || unhealthyUntil < retryAt)
    )
      retryAt = unhealthyUntil;
  }
  return retryAt;
}

export function getProviderRecoveryTarget(room, now = Date.now()) {
  const candidates = [...getCommonProviderCapabilities(room)].filter(
    (provider) => {
      const health = room.providerHealth.get(provider);
      const unhealthyUntil = Number(health?.unhealthyUntil);
      return (
        health?.healthy === false &&
        Number.isFinite(unhealthyUntil) &&
        unhealthyUntil <= now
      );
    },
  );
  return candidates.includes(SFU_PROVIDER.CLOUDFLARE_REALTIME)
    ? SFU_PROVIDER.CLOUDFLARE_REALTIME
    : candidates.includes(SFU_PROVIDER.MEDIASOUP)
      ? SFU_PROVIDER.MEDIASOUP
      : null;
}

export function scheduleProviderRecovery(room, now = Date.now()) {
  const retryAt = getNextProviderRecoveryAt(room, now);
  if (retryAt) void room.state.storage.setAlarm?.(Math.max(now + 1, retryAt));
}

export function getQoeCandidates(room) {
  const grouped = new Map();
  for (const report of room.qoeMetrics.values()) {
    const provider =
      report.provider === "sfu"
        ? room.route.provider ||
          (room.route.kind === MEDIA_ROUTE_KIND.P2P &&
          room.route.reason === "qualifying-direct"
            ? room.qualificationFallbackRoute?.provider
            : null) ||
          SFU_PROVIDER.CLOUDFLARE_REALTIME
        : report.provider;
    if (!["p2p", ...getConfiguredProviderCapabilities(room)].includes(provider))
      continue;
    const candidate = grouped.get(provider) || {
      id: provider,
      provider,
      paths: [],
      readyParticipants: 0,
      requiredParticipants: room.participants.size,
      stableSince: report.stableSince,
    };
    candidate.paths.push(...report.paths);
    candidate.readyParticipants += 1;
    candidate.stableSince = Math.min(
      candidate.stableSince || report.stableSince,
      report.stableSince,
    );
    grouped.set(provider, candidate);
  }
  return [...grouped.values()];
}

export function shouldUseProviderRegistry(
  room,
  targetProvider,
  excludedProvider,
) {
  if (!providerRegistryEnabled(room.env)) return false;
  if (targetProvider === SFU_PROVIDER.MEDIASOUP) return true;
  if (excludedProvider === SFU_PROVIDER.CLOUDFLARE_REALTIME) return true;
  return !getAvailableProviderCapabilities(room).has(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
  );
}

export async function handleCloudflareRequest(room, ws, session, data) {
  const requestId = data.requestId;
  const operation = data.operation;
  const appId = room.env.CLOUDFLARE_REALTIME_APP_ID;
  const appSecret = room.env.CLOUDFLARE_REALTIME_APP_SECRET;
  const sendResult = (result) =>
    room.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_RESPONSE, {
      requestId,
      ...result,
    });
  const selectedProvider =
    room.pendingRoute?.provider ||
    room.route.provider ||
    (room.route.kind === MEDIA_ROUTE_KIND.P2P &&
    room.route.reason === "qualifying-direct"
      ? room.qualificationFallbackRoute?.provider
      : null);
  if (selectedProvider !== SFU_PROVIDER.CLOUDFLARE_REALTIME) {
    sendResult({ error: "Cloudflare Realtime is not the active route" });
    return;
  }
  if (!requestId || !isCloudflareRealtimeConfigured(room.env)) {
    mediaDebug(room.env, "room.cloudflare-unavailable", {
      operation,
      hasAppId: Boolean(appId),
      hasAppSecret: Boolean(appSecret),
    });
    sendResult({ error: "Cloudflare Realtime is unavailable" });
    return;
  }
  const allowed = new Map([
    ["new-session", { method: "POST", suffix: "sessions/new" }],
    ["tracks-new", { method: "POST", suffix: "tracks/new" }],
    ["tracks-update", { method: "PUT", suffix: "tracks/update" }],
    ["tracks-close", { method: "PUT", suffix: "tracks/close" }],
    ["renegotiate", { method: "PUT", suffix: "renegotiate" }],
  ]);
  const selected = allowed.get(operation);
  if (!selected) {
    sendResult({ error: "Unsupported Cloudflare operation" });
    return;
  }
  if (operation !== "new-session" && !session.cloudflareSessionId) {
    sendResult({ error: "Cloudflare session is not initialized" });
    return;
  }
  if (operation === "tracks-new") {
    const remoteTracks = (data.body?.tracks || []).filter(
      (track) => track?.location === "remote",
    );
    const knownTracks = new Set(
      [...room.publishedSources.values()].map(
        (publication) => `${publication.sessionId}:${publication.trackName}`,
      ),
    );
    if (
      remoteTracks.some(
        (track) => !knownTracks.has(`${track.sessionId}:${track.trackName}`),
      )
    ) {
      sendResult({ error: "Cloudflare track is not published in this room" });
      return;
    }
  }
  const sessionPrefix =
    operation === "new-session"
      ? ""
      : `sessions/${encodeURIComponent(session.cloudflareSessionId)}/`;
  let response;
  try {
    mediaDebug(room.env, "room.cloudflare-request", {
      operation,
      requestId,
      sessionId: session.cloudflareSessionId || null,
    });
    response = await fetch(
      `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}/${sessionPrefix}${selected.suffix}`,
      {
        method: selected.method,
        headers: {
          Authorization: `Bearer ${appSecret}`,
          "Content-Type": "application/json",
        },
        body:
          operation === "new-session"
            ? undefined
            : JSON.stringify(data.body || {}),
      },
    );
  } catch {
    sendResult({ error: "Cloudflare Realtime request failed" });
    return;
  }
  const result = await response.json().catch(() => ({}));
  if (response.ok && operation === "new-session" && result.sessionId) {
    session.cloudflareSessionId = result.sessionId;
    ws.serializeAttachment(session);
  }
  mediaDebug(room.env, "room.cloudflare-response", {
    operation,
    requestId,
    status: response.status,
    ok: response.ok,
  });
  sendResult(
    response.ok
      ? { result }
      : {
          error:
            result.errorDescription || `Cloudflare error ${response.status}`,
        },
  );
}

export function handleP2PFailure(room, session, reason) {
  if (room.route.kind !== MEDIA_ROUTE_KIND.P2P || room.route.path !== "direct")
    return;
  const participant = room.participants.get(
    `${session.userId}:${session.deviceId}`,
  );
  const participantWs = participant?.ws;
  if (room.getConnectionMode() === "direct") {
    room.sendMessage(participantWs, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
      code: "DIRECT_MEDIA_UNAVAILABLE",
      error: "Direct media connection failed",
    });
    return;
  }
  const qualificationFallback = room.qualificationFallbackRoute;
  if (
    qualificationFallback?.provider &&
    getAvailableProviderCapabilities(room).has(qualificationFallback.provider)
  ) {
    void room.restoreQualificationRoute(`p2p-failed-${reason}`);
    return;
  }
  if (qualificationFallback) {
    room.qualificationFallbackRoute = null;
    void room.state.storage.delete("qualificationFallbackRoute");
  }
  const available = getAvailableProviderCapabilities(room);
  const fallback = available.has(SFU_PROVIDER.CLOUDFLARE_REALTIME)
    ? SFU_PROVIDER.CLOUDFLARE_REALTIME
    : available.has(SFU_PROVIDER.MEDIASOUP)
      ? SFU_PROVIDER.MEDIASOUP
      : null;
  if (fallback) {
    void beginTransition(room, fallback, `p2p-failed-${reason}`);
    return;
  }
  room.sendMessage(participantWs, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
    code: "MEDIA_PROVIDER_UNAVAILABLE",
    error: "No configured SFU provider is available",
  });
}

export async function handleProviderFailure(room, provider, reason) {
  if (!provider) return;
  const epoch = room.pendingRoute?.epoch || room.route.epoch;
  room.providerHealth.set(provider, {
    healthy: false,
    reason,
    epoch,
    unhealthyUntil: Date.now() + PROVIDER_FAILURE_COOLDOWN_MS,
    updatedAt: Date.now(),
  });
  await room.state.storage.put(
    "providerHealth",
    Object.fromEntries(room.providerHealth),
  );
  for (const participant of room.participants.values())
    room.sendMessage(
      participant.ws,
      MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE,
      { provider, epoch, sourceRevision: room.sourceRevision, reason },
    );
  if (
    provider === SFU_PROVIDER.MEDIASOUP &&
    providerRegistryEnabled(room.env)
  ) {
    const registryNamespace = room.env.PROVIDER_REGISTRY_DO;
    try {
      const registryId = registryNamespace.idFromName("global");
      const registry = registryNamespace.get(registryId);
      await registry.fetch(
        new Request("https://registry/report-failure", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${room.env.MEDIA_CONTROL_ADMIN_TOKEN || ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            providerId: "selfhost-primary",
            error: reason,
          }),
        }),
      );
    } catch (error) {
      console.warn("[MediaRoomDO] Provider failure report unavailable:", error);
      mediaDebug(room.env, "room.registry-report-failed", { error });
    }
  }
  const alternate =
    provider === SFU_PROVIDER.CLOUDFLARE_REALTIME
      ? isSelfHostedMediasoupConfigured(room.env)
        ? SFU_PROVIDER.MEDIASOUP
        : null
      : isCloudflareRealtimeConfigured(room.env)
        ? SFU_PROVIDER.CLOUDFLARE_REALTIME
        : null;
  if (room.pendingRoute?.provider === provider) {
    room.pendingRoute = null;
    room.pendingStartedAt = 0;
    room.providerReadiness.clear();
    room.transitionReadiness.clear();
    void Promise.all([
      room.state.storage.delete("pendingRoute"),
      room.state.storage.delete("pendingStartedAt"),
    ]);
  }
  if (room.qualificationFallbackRoute?.provider === provider) {
    room.qualificationFallbackRoute = null;
    void room.state.storage.delete("qualificationFallbackRoute");
  }
  await beginTransition(room, alternate, `provider-failed-${reason}`, provider);
}

export async function beginTransition(
  room,
  targetProvider,
  reason = "provider-transition",
  excludedProvider = null,
) {
  if (room.pendingRoute || room.transitionInFlight) return;
  room.transitionInFlight = true;
  let selectedProvider = targetProvider;
  let selectedProviderConfig = null;
  let registrySelectionSucceeded = false;
  const shouldUseRegistry = shouldUseProviderRegistry(
    room,
    targetProvider,
    excludedProvider,
  );
  const registryNamespace = room.env.PROVIDER_REGISTRY_DO;
  if (shouldUseRegistry && registryNamespace) {
    mediaDebug(room.env, "room.registry-select", {
      targetProvider,
      excludedProvider,
      participantCount: room.participants.size,
    });
    try {
      const registryId = registryNamespace.idFromName("global");
      const registry = registryNamespace.get(registryId);
      const response = await registry.fetch(
        new Request("https://registry/select", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${room.env.MEDIA_CONTROL_ADMIN_TOKEN || ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            roomId: room.getRoomId(),
            connectionMode: room.getConnectionMode(),
            participantCount: room.participants.size,
            hasVideo: [...room.participants.values()].some((participant) =>
              [...participant.sources].some((source) =>
                isVideoMediaSource(source),
              ),
            ),
            requiredSources: [],
            excludedProvider,
            qoeCandidates: getQoeCandidates(room),
          }),
        }),
      );
      if (response.ok) {
        const selection = await response.json();
        selectedProvider = selection.route?.provider || selectedProvider;
        selectedProviderConfig = selection.provider || null;
        registrySelectionSucceeded = true;
      }
    } catch (error) {
      mediaDebug(room.env, "room.registry-select-failed", { error });
    }
  } else if (!shouldUseRegistry && targetProvider === SFU_PROVIDER.MEDIASOUP) {
    mediaDebug(room.env, "room.registry-select-skipped", {
      reason: "self-hosted-mediasoup-disabled-or-unconfigured",
    });
  }
  const availableProviders = getAvailableProviderCapabilities(room);
  if (
    !registrySelectionSucceeded &&
    selectedProvider === SFU_PROVIDER.MEDIASOUP &&
    !isSelfHostedMediasoupConfigured(room.env)
  )
    availableProviders.delete(SFU_PROVIDER.MEDIASOUP);
  selectedProvider = chooseAvailableProvider({
    requestedProvider: selectedProvider,
    availableProviders,
    excludedProvider,
    registrySelectionSucceeded,
    allowDirectMediasoupFallback: isSelfHostedMediasoupConfigured(room.env),
  });
  if (!selectedProvider) {
    room.transitionInFlight = false;
    const retryAt = getNextProviderRecoveryAt(room);
    if (retryAt) {
      scheduleProviderRecovery(room);
      for (const participant of room.participants.values())
        room.sendMessage(
          participant.ws,
          MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_RECOVERING,
          {
            reason,
            retryAt,
            retryAfterMs: Math.max(0, retryAt - Date.now()),
          },
        );
      mediaDebug(room.env, "room.provider-recovering", { reason, retryAt });
      return;
    }
    for (const participant of room.participants.values())
      room.sendMessage(participant.ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        code: "MEDIA_PROVIDER_UNAVAILABLE",
        error: "No eligible media provider is available; recovering media",
        reason,
      });
    mediaDebug(room.env, "room.provider-unavailable", { reason });
    return;
  }
  room.providerConfig = selectedProviderConfig;
  void room.state.storage.put("providerConfig", room.providerConfig);
  const targetRoute = createSFURoute(
    selectedProvider,
    room.epoch + 1,
    room.sourceRevision,
    reason,
  );
  room.pendingRoute = targetRoute;
  room.pendingStartedAt = Date.now();
  void Promise.all([
    room.state.storage.put("pendingRoute", targetRoute),
    room.state.storage.put("pendingStartedAt", room.pendingStartedAt),
  ]);
  room.providerReadiness.clear();
  room.transitionReadiness.clear();
  room.route = {
    ...room.route,
    reason: `transitioning-to-${selectedProvider}`,
  };
  mediaDebug(room.env, "room.transition-start", {
    provider: selectedProvider,
    epoch: targetRoute.epoch,
    reason,
    registrySelectionSucceeded,
  });
  room.broadcastTopology();
  try {
    await issueProviderTickets(room, targetRoute);
  } catch (error) {
    room.transitionInFlight = false;
    await handleProviderFailure(
      room,
      selectedProvider,
      `provider-ticket-${error?.message || "failed"}`,
    );
    return;
  }
  room.transitionInFlight = false;
}

export async function issueProviderTickets(room, route) {
  await Promise.all(
    [...room.participants.values()]
      .filter((participant) => participant.ws)
      .map((participant) => issueProviderTicket(room, participant, route)),
  );
}

export async function issueProviderTicket(room, participant, route) {
  if (route.provider !== SFU_PROVIDER.MEDIASOUP) return;
  const ticket = await createProviderTicket(
    room,
    participant,
    route,
    room.providerConfig,
  );
  room.sendMessage(
    participant.ws,
    MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_TICKET,
    {
      route,
      provider: route.provider,
      epoch: route.epoch,
      signalingUrl:
        room.providerConfig?.signalingUrl || room.env.DSPEAK_SFU_SIGNALING_URL,
      ticket,
    },
  );
}

export async function createProviderTicket(
  room,
  participant,
  route,
  providerConfig = null,
) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(room.env.PROVIDER_TICKET_TTL_SECONDS);
  const claims = {
    iss: room.env.MEDIA_CONTROL_ISSUER,
    aud: "dspeak-sfu",
    sub: participant.userId,
    deviceId: participant.deviceId,
    roomId: participant.channelId,
    routeEpoch: route.epoch,
    providerId:
      providerConfig?.id ||
      room.env.DSPEAK_SFU_PROVIDER_ID ||
      "selfhost-primary",
    generation: 1,
    permissions: { produce: true, consume: true },
    iat: now,
    exp: now + (Number.isFinite(ttl) && ttl > 0 ? ttl : 120),
    jti: crypto.randomUUID(),
    protocolRevision: MEDIA_PROVIDER_PROTOCOL_REVISION,
  };
  return signProviderTicket(claims, room.env);
}
