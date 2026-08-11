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
export const QOE_REPORT_MAX_AGE_MS = 30_000;
export const MAX_QOE_REPORTS_PER_PARTICIPANT = 16;
export const MAX_QOE_PROVIDER_ID_LENGTH = 128;

export function providerHealthKey(provider, providerId = null) {
  return providerId ? `${provider}:${providerId}` : provider;
}

export function getProviderHealth(room, provider, providerId = null) {
  const familyHealth = room.providerHealth.get(provider);
  if (
    familyHealth?.healthy === false &&
    Number(familyHealth.unhealthyUntil) > Date.now()
  )
    return familyHealth;
  return (
    room.providerHealth.get(providerHealthKey(provider, providerId)) ||
    (providerId ? familyHealth : null)
  );
}

function providerFromHealthKey(healthKey) {
  if (healthKey === SFU_PROVIDER.CLOUDFLARE_REALTIME)
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  if (healthKey === SFU_PROVIDER.MEDIASOUP) return SFU_PROVIDER.MEDIASOUP;
  if (healthKey.startsWith(`${SFU_PROVIDER.CLOUDFLARE_REALTIME}:`))
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  if (healthKey.startsWith(`${SFU_PROVIDER.MEDIASOUP}:`))
    return SFU_PROVIDER.MEDIASOUP;
  return healthKey;
}

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
    const health = getProviderHealth(room, provider);
    if (health?.healthy === false && Number(health.unhealthyUntil) > now)
      available.delete(provider);
  }
  return available;
}

export function getNextProviderRecoveryAt(room, now = Date.now()) {
  let retryAt = null;
  const configured = getCommonProviderCapabilities(room);
  for (const [healthKey, health] of room.providerHealth) {
    const provider = providerFromHealthKey(healthKey);
    if (!configured.has(provider)) continue;
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
  const candidates = new Set();
  const configured = getCommonProviderCapabilities(room);
  for (const [healthKey, health] of room.providerHealth) {
    const provider = providerFromHealthKey(healthKey);
    const unhealthyUntil = Number(health?.unhealthyUntil);
    if (
      configured.has(provider) &&
      health?.healthy === false &&
      Number.isFinite(unhealthyUntil) &&
      unhealthyUntil <= now
    )
      candidates.add(provider);
  }
  return candidates.has(SFU_PROVIDER.CLOUDFLARE_REALTIME)
    ? SFU_PROVIDER.CLOUDFLARE_REALTIME
    : candidates.has(SFU_PROVIDER.MEDIASOUP)
      ? SFU_PROVIDER.MEDIASOUP
      : null;
}

export function scheduleProviderRecovery(room, now = Date.now()) {
  const retryAt = getNextProviderRecoveryAt(room, now);
  if (retryAt) void room.state.storage.setAlarm?.(Math.max(now + 1, retryAt));
}

export function getQoeCandidates(room) {
  const grouped = new Map();
  const now = Date.now();
  for (const [peerId, storedReports] of room.qoeMetrics) {
    const reports =
      storedReports instanceof Map
        ? [...storedReports.entries()]
        : [[null, storedReports]];
    const expiredKeys = [];
    for (const [reportKey, report] of reports) {
      if (!Array.isArray(report?.paths)) continue;
      const receivedAt = Number(report.receivedAt);
      const sampledAt = Number(report.sampledAt);
      const freshnessAt = Number.isFinite(receivedAt) ? receivedAt : sampledAt;
      if (
        Number.isFinite(freshnessAt) &&
        now - freshnessAt > QOE_REPORT_MAX_AGE_MS
      ) {
        if (reportKey !== null) expiredKeys.push(reportKey);
        continue;
      }
      const fallbackRoute =
        room.route.kind === MEDIA_ROUTE_KIND.P2P &&
        room.route.reason === "qualifying-direct"
          ? room.qualificationFallbackRoute
          : null;
      const activeRoute =
        room.route.kind === MEDIA_ROUTE_KIND.SFU ? room.route : fallbackRoute;
      const provider =
        report.provider === "sfu"
          ? activeRoute?.provider || SFU_PROVIDER.CLOUDFLARE_REALTIME
          : report.provider;
      const providerId =
        report.providerId ||
        (activeRoute?.provider === provider ? activeRoute.providerId : null) ||
        (room.providerConfig?.provider === provider
          ? room.providerConfig.id
          : null);
      if (
        !["p2p", ...getConfiguredProviderCapabilities(room)].includes(provider)
      )
        continue;
      const key = providerId ? `${provider}:${providerId}` : provider;
      const candidate = grouped.get(key) || {
        id: providerId || provider,
        provider,
        ...(providerId ? { providerId } : {}),
        paths: [],
        participantIds: new Set(),
        requiredParticipants: room.participants.size,
        stableSince: report.stableSince,
      };
      candidate.paths.push(...report.paths);
      candidate.participantIds.add(peerId);
      const stableSince = Number(report.stableSince);
      if (Number.isFinite(stableSince))
        candidate.stableSince = Math.min(
          Number(candidate.stableSince) || stableSince,
          stableSince,
        );
      grouped.set(key, candidate);
    }
    if (storedReports instanceof Map) {
      for (const reportKey of expiredKeys) storedReports.delete(reportKey);
      if (storedReports.size === 0) room.qoeMetrics.delete(peerId);
    }
  }
  return [...grouped.values()].map(({ participantIds, ...candidate }) => ({
    ...candidate,
    readyParticipants: participantIds.size,
  }));
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

export async function handleP2PFailure(room, session, reason) {
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
  const qualificationFallbackHealth = qualificationFallback?.provider
    ? getProviderHealth(
        room,
        qualificationFallback.provider,
        qualificationFallback.providerId,
      )
    : null;
  if (
    qualificationFallback?.provider &&
    getAvailableProviderCapabilities(room).has(
      qualificationFallback.provider,
    ) &&
    !(
      qualificationFallbackHealth?.healthy === false &&
      Number(qualificationFallbackHealth.unhealthyUntil) > Date.now()
    )
  ) {
    await room.restoreQualificationRoute(`p2p-failed-${reason}`);
    return;
  }
  if (qualificationFallback) {
    room.qualificationFallbackRoute = null;
    await room.state.storage.delete("qualificationFallbackRoute");
  }
  const available = getAvailableProviderCapabilities(room);
  const fallback = available.has(SFU_PROVIDER.CLOUDFLARE_REALTIME)
    ? SFU_PROVIDER.CLOUDFLARE_REALTIME
    : available.has(SFU_PROVIDER.MEDIASOUP)
      ? SFU_PROVIDER.MEDIASOUP
      : null;
  if (fallback) {
    await beginTransition(room, fallback, `p2p-failed-${reason}`);
    return;
  }
  room.sendMessage(participantWs, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
    code: "MEDIA_PROVIDER_UNAVAILABLE",
    error: "No configured SFU provider is available",
  });
}

export async function handleProviderFailure(
  room,
  provider,
  reason,
  failedProviderId = null,
  failedEpoch = null,
  failedSourceRevision = null,
  failedRoute = null,
) {
  if (!provider) return;
  const normalizedEpoch =
    failedEpoch == null && failedEpoch !== 0
      ? null
      : Number.isSafeInteger(Number(failedEpoch))
        ? Number(failedEpoch)
        : null;
  const normalizedSourceRevision =
    failedSourceRevision == null && failedSourceRevision !== 0
      ? null
      : Number.isSafeInteger(Number(failedSourceRevision))
        ? Number(failedSourceRevision)
        : null;
  const explicitFailedRoute =
    failedRoute?.provider === provider &&
    (failedRoute.providerId
      ? failedRoute.providerId === failedProviderId
      : !failedProviderId)
      ? failedRoute
      : null;
  const routeMatchesFailure = (route) => {
    if (!route || route.provider !== provider) return false;
    if (
      route.providerId
        ? route.providerId !== failedProviderId
        : failedProviderId
    )
      return false;
    if (normalizedEpoch !== null && Number(route.epoch) !== normalizedEpoch)
      return false;
    if (
      normalizedSourceRevision !== null &&
      Number(route.sourceRevision) !== normalizedSourceRevision
    )
      return false;
    return true;
  };
  const pendingFailed = explicitFailedRoute
    ? explicitFailedRoute === room.pendingRoute
    : routeMatchesFailure(room.pendingRoute);
  const activeFailed = explicitFailedRoute
    ? explicitFailedRoute === room.route
    : routeMatchesFailure(room.route);
  const qualificationFallbackFailed = explicitFailedRoute
    ? explicitFailedRoute === room.qualificationFallbackRoute
    : routeMatchesFailure(room.qualificationFallbackRoute);
  const matchedRoute =
    explicitFailedRoute ||
    (pendingFailed
      ? room.pendingRoute
      : activeFailed
        ? room.route
        : qualificationFallbackFailed
          ? room.qualificationFallbackRoute
          : null);
  const providerId =
    failedProviderId ||
    matchedRoute?.providerId ||
    (room.providerConfig?.provider === provider
      ? room.providerConfig.id
      : null);
  const epoch =
    normalizedEpoch ??
    matchedRoute?.epoch ??
    room.pendingRoute?.epoch ??
    room.route.epoch;
  const sourceRevision =
    normalizedSourceRevision ??
    matchedRoute?.sourceRevision ??
    room.sourceRevision;
  room.providerHealth.set(providerHealthKey(provider, providerId), {
    healthy: false,
    reason,
    provider,
    providerId: providerId || null,
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
      {
        provider,
        providerId: providerId || undefined,
        epoch,
        sourceRevision,
        reason,
      },
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
            providerId:
              providerId ||
              room.providerConfig?.id ||
              room.env.DSPEAK_SFU_PROVIDER_ID ||
              "selfhost-primary",
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
      : providerId && isSelfHostedMediasoupConfigured(room.env)
        ? SFU_PROVIDER.MEDIASOUP
        : isCloudflareRealtimeConfigured(room.env)
          ? SFU_PROVIDER.CLOUDFLARE_REALTIME
          : null;
  if (pendingFailed) {
    room.pendingRoute = null;
    room.pendingStartedAt = 0;
    room.providerReadiness.clear();
    room.transitionReadiness.clear();
    await Promise.all([
      room.state.storage.delete("pendingRoute"),
      room.state.storage.delete("pendingStartedAt"),
    ]);
  }
  const qualificationFallback = room.qualificationFallbackRoute;
  if (qualificationFallbackFailed) {
    room.qualificationFallbackRoute = null;
    await room.state.storage.delete("qualificationFallbackRoute");
  }
  await beginTransition(
    room,
    alternate,
    `provider-failed-${reason}`,
    provider,
    providerId,
  );
}

export async function beginTransition(
  room,
  targetProvider,
  reason = "provider-transition",
  excludedProvider = null,
  excludedProviderId = null,
) {
  if (room.pendingRoute || room.transitionInFlight) return;
  room.transitionInFlight = true;
  const selectionExcludedProvider = excludedProviderId
    ? null
    : excludedProvider;
  let selectedProvider = targetProvider;
  let selectedProviderConfig = null;
  let selectedProviderId = null;
  let registrySelectionSucceeded = false;
  const shouldUseRegistry = shouldUseProviderRegistry(
    room,
    targetProvider,
    selectionExcludedProvider,
  );
  const registryNamespace = room.env.PROVIDER_REGISTRY_DO;
  if (shouldUseRegistry && registryNamespace) {
    mediaDebug(room.env, "room.registry-select", {
      targetProvider,
      excludedProvider: selectionExcludedProvider,
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
            excludedProvider: selectionExcludedProvider,
            excludedProviderId,
            qoeCandidates: getQoeCandidates(room),
          }),
        }),
      );
      if (response.ok) {
        const selection = await response.json();
        selectedProvider = selection.route?.provider || selectedProvider;
        selectedProviderConfig = selection.provider || null;
        selectedProviderId =
          selection.route?.providerId || selectedProviderConfig?.id || null;
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
  if (
    !registrySelectionSucceeded &&
    selectedProvider === SFU_PROVIDER.MEDIASOUP &&
    excludedProviderId
  )
    availableProviders.delete(SFU_PROVIDER.MEDIASOUP);
  selectedProvider = chooseAvailableProvider({
    requestedProvider: selectedProvider,
    availableProviders,
    excludedProvider: selectionExcludedProvider,
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
  selectedProviderId ||=
    selectedProviderConfig?.id ||
    (selectedProvider === SFU_PROVIDER.MEDIASOUP
      ? room.env.DSPEAK_SFU_PROVIDER_ID || null
      : null);
  room.providerConfig = selectedProviderConfig;
  const targetRoute = createSFURoute(
    selectedProvider,
    room.epoch + 1,
    room.sourceRevision,
    reason,
    selectedProviderId,
  );
  room.pendingRoute = targetRoute;
  room.pendingStartedAt = Date.now();
  await Promise.all([
    room.state.storage.put("providerConfig", room.providerConfig),
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
    providerId: selectedProviderId,
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
      targetRoute.providerId,
      targetRoute.epoch,
      targetRoute.sourceRevision,
      targetRoute,
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
      providerId: route.providerId || room.providerConfig?.id || null,
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
      route.providerId ||
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
