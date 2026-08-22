export const MEDIA_CONTROL_PROTOCOL_VERSION = 919 as const;
export const MEDIA_CONTROL_CONTRACT_REVISION = 5 as const;
export const MEDIA_PROVIDER_PROTOCOL_REVISION = 919 as const;

export const ROOM_REVISION = "roomRevision" as const;
export const CONNECTION_EPOCH = "connectionEpoch" as const;
export const OPERATION_ID = "operationId" as const;
export const REQUEST_ID = "requestId" as const;
export const SOURCE_GENERATION = "sourceGeneration" as const;
export const DESIRED_STATE = "desiredState" as const;

export const MEDIA_CONTROL_CLIENT_HELLO = "hello919" as const;
export const MEDIA_CONTROL_SERVER_HELLO = "hi919" as const;
export const MEDIA_CONTROL_ERROR = "error919" as const;

export interface MediaControlClientHello {
  protocolVersion: number;
  contractRevision: number;
  mediaSessionId: string;
  [field: string]: unknown;
}

export interface MediaControlServerHello {
  protocolVersion: number;
  contractRevision: number;
  mediaSessionId: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  serverTime: number;
  roomRevision: string;
  epoch: number;
  sourceRevision: number;
}

export function isCompatibleClientHello(
  data: unknown,
  mediaSessionId: string,
): data is MediaControlClientHello {
  if (!data || typeof data !== "object") return false;
  const hello = data as Record<string, unknown>;
  return (
    hello.protocolVersion === MEDIA_CONTROL_PROTOCOL_VERSION &&
    hello.contractRevision === MEDIA_CONTROL_CONTRACT_REVISION &&
    hello.mediaSessionId === mediaSessionId
  );
}

export function buildServerHello({
  mediaSessionId,
  roomRevision = "0",
  epoch = 0,
  sourceRevision = 0,
  serverTime = Date.now(),
}: {
  mediaSessionId: string;
  roomRevision?: bigint | number | string;
  epoch?: number;
  sourceRevision?: number;
  serverTime?: number;
}): MediaControlServerHello {
  return {
    protocolVersion: MEDIA_CONTROL_PROTOCOL_VERSION,
    contractRevision: MEDIA_CONTROL_CONTRACT_REVISION,
    mediaSessionId,
    heartbeatIntervalMs: CONTROL_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: CONTROL_HEARTBEAT_TIMEOUT_MS,
    serverTime,
    roomRevision: String(roomRevision),
    epoch,
    sourceRevision,
  };
}

export const MEDIA_CONTROL_MESSAGE_TYPES = {
  HELLO: MEDIA_CONTROL_CLIENT_HELLO,
  P2P_SIGNAL: "p2p-signal",
  P2P_READY: "p2p-ready",
  MEDIA_SOURCES: "media-sources",
  PARTICIPANT_VOICE_STATE: "participant-voice-state",
  MEDIA_CAPABILITIES: "media-capabilities",
  CODEC_MIGRATION_STATE: "codec-migration-state",
  PARTICIPANT_CAPABILITIES: "participant-capabilities",
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
  CLIENT_SFU_RTT: "client-sfu-rtt",
  HEARTBEAT: "heartbeat",
  RESUME: "resume",
  STATE_NACK: "state-nack",
  ROOM_SNAPSHOT: "room-snapshot",
  LEAVE: "leave",
  REQUEST_SNAPSHOT: "request-snapshot",
  WELCOME: MEDIA_CONTROL_SERVER_HELLO,
  TOPOLOGY_STATE: "topology-state",
  P2P_SIGNAL_RELAY: "p2p-signal-relay",
  ROUTE_COMMIT: "route-commit",
  HEARTBEAT_ACK: "heartbeat-ack",
  OPERATION_ACK: "operation-ack",
  ERROR: MEDIA_CONTROL_ERROR,
  PROVIDER_TICKET: "provider-ticket",
  CLOUDFLARE_RESPONSE: "cloudflare-response",
  CLOUDFLARE_PUBLICATION_AVAILABLE: "cloudflare-publication-available",
  PARTICIPANT_SFU_RTT: "participant-sfu-rtt",
} as const;

export const ROOM_STATE = {
  IDLE: "idle",
  JOINING: "joining",
  QUALIFYING: "qualifying",
  ACTIVE: "active",
  PREPARING_TRANSITION: "preparing-transition",
  COMMITTING_TRANSITION: "committing-transition",
  RECOVERING: "recovering",
  DEGRADED: "degraded",
} as const;

export const MEDIA_ROUTE_KIND = {
  LOCAL: "local",
  P2P: "p2p",
  SFU: "sfu",
} as const;

export const P2P_PATH = {
  DIRECT: "direct",
  RELAY: "relay",
} as const;

export const SFU_PROVIDER = {
  CLOUDFLARE_REALTIME: "cloudflare-realtime",
  MEDIASOUP: "mediasoup",
} as const;

export const CONTROL_HEARTBEAT_INTERVAL_MS = 5000;
export const CONTROL_HEARTBEAT_TIMEOUT_MS = 15000;
export const CONTROL_GRACE_PERIOD_MS = 10000;
export const MAX_MEDIA_CHANNEL_PARTICIPANTS = 100;
export const MEDIA_OPERATION_ACK_TIMEOUT_MS = 5000;

export const P2P_PARTICIPANT_LIMITS = {
  directAudio: 8,
  directVideo: 4,
  autoAudio: 8,
  autoVideo: 4,
} as const;

export const ULTRA_LOW_MESH_BUDGET = 4;

export type ConnectionMode = "auto" | "direct";
export type MediaRouteKind =
  (typeof MEDIA_ROUTE_KIND)[keyof typeof MEDIA_ROUTE_KIND];
export type P2PPath = (typeof P2P_PATH)[keyof typeof P2P_PATH];
export type SfuProvider = (typeof SFU_PROVIDER)[keyof typeof SFU_PROVIDER];

export interface LocalRoute {
  kind: "local";
  epoch: number;
  sourceRevision: number;
  reason: string;
}

export interface P2PRoute {
  kind: "p2p";
  path: P2PPath;
  epoch: number;
  sourceRevision: number;
  reason: string;
}

export interface SfuRoute {
  kind: "sfu";
  provider: string;
  providerId?: string;
  epoch: number;
  sourceRevision: number;
  reason: string;
}

export type MediaRoute = LocalRoute | P2PRoute | SfuRoute;

export function getMediaChannelParticipantLimit(
  connectionMode: string,
  hasVideo = false,
): number {
  if (connectionMode === "auto") return MAX_MEDIA_CHANNEL_PARTICIPANTS;
  return hasVideo
    ? P2P_PARTICIPANT_LIMITS.directVideo
    : P2P_PARTICIPANT_LIMITS.directAudio;
}

export function getP2PQualificationLimit(
  connectionMode: string,
  hasVideo: boolean,
  audioLatencyProfile: string = "standard",
): number {
  if (audioLatencyProfile === "ultra-low" && !hasVideo)
    return Math.min(ULTRA_LOW_MESH_BUDGET, P2P_PARTICIPANT_LIMITS.autoAudio);
  return connectionMode === "direct"
    ? hasVideo
      ? P2P_PARTICIPANT_LIMITS.directVideo
      : P2P_PARTICIPANT_LIMITS.directAudio
    : hasVideo
      ? P2P_PARTICIPANT_LIMITS.autoVideo
      : P2P_PARTICIPANT_LIMITS.autoAudio;
}

export function checkP2PEligibility({
  connectionMode,
  participantCount,
  hasVideo,
  requiredSources = [],
  audioLatencyProfile = "standard",
}: {
  connectionMode: string;
  participantCount: number;
  hasVideo: boolean;
  requiredSources?: readonly string[];
  audioLatencyProfile?: string;
}): { eligible: true } | { eligible: false; reason: string } {
  const limit = getP2PQualificationLimit(
    connectionMode,
    hasVideo,
    audioLatencyProfile,
  );
  if (participantCount > limit)
    return {
      eligible: false,
      reason: `participant-count-${participantCount}-exceeds-${limit}`,
    };
  if (connectionMode === "direct" && requiredSources.includes("server-dj"))
    return { eligible: false, reason: "server-source-requires-auto-mode" };
  return { eligible: true };
}

export function createLocalRoute(
  epoch: number,
  sourceRevision: number,
  reason: string,
): LocalRoute {
  return { kind: MEDIA_ROUTE_KIND.LOCAL, epoch, sourceRevision, reason };
}

export function createP2PRoute(
  path: P2PPath,
  epoch: number,
  sourceRevision: number,
  reason: string,
): P2PRoute {
  return { kind: MEDIA_ROUTE_KIND.P2P, path, epoch, sourceRevision, reason };
}

export function createSFURoute(
  provider: string,
  epoch: number,
  sourceRevision: number,
  reason: string,
  providerId: string | null = null,
): SfuRoute {
  const route: SfuRoute = {
    kind: MEDIA_ROUTE_KIND.SFU,
    provider,
    epoch,
    sourceRevision,
    reason,
  };
  if (providerId) route.providerId = providerId;
  return route;
}

export function validateRouteForMode(
  route: MediaRoute,
  mode: string,
): { valid: true } | { valid: false; error: string } {
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

export function qualificationUsesRelay(
  candidateReports: Array<Record<string, unknown>> | null | undefined,
): boolean {
  const reports = Array.isArray(candidateReports) ? candidateReports : [];
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    if (report.path === P2P_PATH.RELAY) return true;
    const localType =
      typeof report.localCandidateType === "string"
        ? report.localCandidateType
        : null;
    const remoteType =
      typeof report.remoteCandidateType === "string"
        ? report.remoteCandidateType
        : null;
    if (localType === "relay" || remoteType === "relay") return true;
  }
  return false;
}

export function compareRouteEpoch(
  a: Pick<MediaRoute, "epoch" | "sourceRevision">,
  b: Pick<MediaRoute, "epoch" | "sourceRevision">,
): number {
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
  allowDirectMediasoupFallback = false,
}: {
  requestedProvider?: string | null;
  availableProviders?: readonly string[];
  excludedProvider?: string | null;
  registrySelectionSucceeded?: boolean;
  allowDirectMediasoupFallback?: boolean;
}): string | null {
  const available = new Set(availableProviders);
  if (excludedProvider) available.delete(excludedProvider);
  if (requestedProvider && available.has(requestedProvider))
    return requestedProvider;
  if (available.has(SFU_PROVIDER.CLOUDFLARE_REALTIME))
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  if (
    available.has(SFU_PROVIDER.MEDIASOUP) &&
    (registrySelectionSucceeded || allowDirectMediasoupFallback)
  )
    return SFU_PROVIDER.MEDIASOUP;
  return null;
}
