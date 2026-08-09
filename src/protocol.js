export const MEDIA_CONTROL_PROTOCOL_VERSION = 919;
export const MEDIA_PROVIDER_PROTOCOL_REVISION = 919;

export const MEDIA_CONTROL_CLIENT_HELLO = "hello919";
export const MEDIA_CONTROL_SERVER_HELLO = "hi919";
export const MEDIA_CONTROL_ERROR = "error919";

export const MEDIA_CONTROL_MESSAGE_TYPES = {
  HELLO: MEDIA_CONTROL_CLIENT_HELLO,
  P2P_SIGNAL: "p2p-signal",
  P2P_READY: "p2p-ready",
  MEDIA_SOURCES: "media-sources",
  PARTICIPANT_VOICE_STATE: "participant-voice-state",
  P2P_QUALIFIED: "p2p-qualified",
  P2P_FAILED: "p2p-failed",
  PROVIDER_READY: "provider-ready",
  PROVIDER_FAILURE: "provider-failure",
  PROVIDER_RECOVERING: "provider-recovering",
  TOPOLOGY_READY: "topology-ready",
  TOPOLOGY_FAILED: "topology-failed",
  CLOUDFLARE_REQUEST: "cloudflare-request",
  CLOUDFLARE_PUBLICATION: "cloudflare-publication",
  MEDIA_QOE: "media-qoe",
  HEARTBEAT: "heartbeat",
  RESUME: "resume",

  WELCOME: MEDIA_CONTROL_SERVER_HELLO,
  TOPOLOGY_STATE: "topology-state",
  P2P_SIGNAL_RELAY: "p2p-signal-relay",
  ROUTE_COMMIT: "route-commit",
  HEARTBEAT_ACK: "heartbeat-ack",
  ERROR: MEDIA_CONTROL_ERROR,
  PROVIDER_TICKET: "provider-ticket",
  CLOUDFLARE_RESPONSE: "cloudflare-response",
  CLOUDFLARE_PUBLICATION_AVAILABLE: "cloudflare-publication-available",
};

export const ROOM_STATE = {
  IDLE: "idle",
  JOINING: "joining",
  QUALIFYING: "qualifying",
  ACTIVE: "active",
  PREPARING_TRANSITION: "preparing-transition",
  COMMITTING_TRANSITION: "committing-transition",
  RECOVERING: "recovering",
  DEGRADED: "degraded",
};

export const MEDIA_ROUTE_KIND = {
  LOCAL: "local",
  P2P: "p2p",
  SFU: "sfu",
};

export const P2P_PATH = {
  DIRECT: "direct",
  RELAY: "relay",
};

export const SFU_PROVIDER = {
  CLOUDFLARE_REALTIME: "cloudflare-realtime",
  MEDIASOUP: "mediasoup",
};

export const CONTROL_HEARTBEAT_INTERVAL_MS = 30000;
export const CONTROL_HEARTBEAT_TIMEOUT_MS = 90000;

export const P2P_PARTICIPANT_LIMITS = {
  directAudio: 12,
  directVideo: 4,
  autoAudio: 8,
  autoVideo: 4,
};

export function checkP2PEligibility({
  connectionMode,
  participantCount,
  hasVideo,
  requiredSources = [],
}) {
  const limit =
    connectionMode === "direct"
      ? hasVideo
        ? P2P_PARTICIPANT_LIMITS.directVideo
        : P2P_PARTICIPANT_LIMITS.directAudio
      : hasVideo
        ? P2P_PARTICIPANT_LIMITS.autoVideo
        : P2P_PARTICIPANT_LIMITS.autoAudio;
  if (participantCount > limit)
    return {
      eligible: false,
      reason: `participant-count-${participantCount}-exceeds-${limit}`,
    };
  if (connectionMode === "direct" && requiredSources.includes("server-dj"))
    return { eligible: false, reason: "server-source-requires-auto-mode" };
  return { eligible: true };
}

export function createLocalRoute(epoch, sourceRevision, reason) {
  return {
    kind: MEDIA_ROUTE_KIND.LOCAL,
    epoch,
    sourceRevision,
    reason,
  };
}

export function createP2PRoute(path, epoch, sourceRevision, reason) {
  return {
    kind: MEDIA_ROUTE_KIND.P2P,
    path,
    epoch,
    sourceRevision,
    reason,
  };
}

export function createSFURoute(provider, epoch, sourceRevision, reason) {
  return {
    kind: MEDIA_ROUTE_KIND.SFU,
    provider,
    epoch,
    sourceRevision,
    reason,
  };
}

export function validateRouteForMode(route, mode) {
  if (mode === "direct") {
    if (route.kind === MEDIA_ROUTE_KIND.LOCAL) return { valid: true };
    if (route.kind === MEDIA_ROUTE_KIND.P2P && route.path === P2P_PATH.DIRECT)
      return { valid: true };
    return {
      valid: false,
      error: `Route ${route.kind}${route.kind === "p2p" ? "/" + route.path : ""} not allowed in Direct mode`,
    };
  }
  return { valid: true };
}

export function compareRouteEpoch(a, b) {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.sourceRevision !== b.sourceRevision)
    return a.sourceRevision < b.sourceRevision ? -1 : 1;
  return 0;
}

export function chooseAvailableProvider({
  requestedProvider,
  availableProviders = [],
  excludedProvider = null,
  registrySelectionSucceeded = false,
}) {
  const available = new Set(availableProviders);
  if (excludedProvider) available.delete(excludedProvider);
  if (
    !registrySelectionSucceeded &&
    requestedProvider === SFU_PROVIDER.CLOUDFLARE_REALTIME &&
    !available.has(SFU_PROVIDER.CLOUDFLARE_REALTIME)
  )
    return null;
  if (requestedProvider && available.has(requestedProvider))
    return requestedProvider;
  if (available.has(SFU_PROVIDER.CLOUDFLARE_REALTIME))
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  if (available.has(SFU_PROVIDER.MEDIASOUP)) return SFU_PROVIDER.MEDIASOUP;
  return null;
}
