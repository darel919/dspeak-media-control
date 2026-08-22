import type { MediaRoute } from "./protocol.ts";
import type { WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";

export type DynamicRecord = Record<string, any>;

export type ConnectionMode = "auto" | "direct";
export type SourceState = {
  generation?: number | null;
  desiredState?: string | null;
  publicationState?: string | null;
  updatedAt?: number | null;
  [key: string]: unknown;
};
export type SourceStateMap = Record<string, SourceState>;
export type MediaCapabilities = Record<string, unknown>;

export interface MediaControlEnv {
  MEDIA_CONTROL_ADMIN_TOKEN?: string;
  MEDIA_CONTROL_ALLOWED_ORIGINS?: string;
  MEDIA_CONTROL_DEBUG?: string;
  MEDIA_CONTROL_ISSUER?: string;
  MEDIA_TICKET_PUBLIC_KEY?: string;
  PROVIDER_TICKET_PRIVATE_KEY?: string;
  PROVIDER_TICKET_TTL_SECONDS?: string | number;
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_APP_SECRET?: string;
  DSPEAK_SFU_ENABLED?: string | boolean;
  DSPEAK_SFU_SIGNALING_URL?: string;
  DSPEAK_SFU_PROVIDER_ID?: string;
  PROVIDER_REGISTRY_DO?: DurableObjectNamespace;
}

export interface RoomSession {
  ws?: CloudflareWebSocket | null;
  userId?: string | null;
  deviceId?: string | null;
  peerId?: string | null;
  connectionEpoch?: number | null;
  mediaSessionId?: string | null;
  authenticated?: boolean;
  channelId?: string | null;
  lastHeartbeat: number;
  connectionMode?: ConnectionMode | string;
  routeEpoch?: number;
  sources?: string[];
  sourceStates?: SourceStateMap;
  providerCapabilities?: string[];
  mediaCapabilities?: MediaCapabilities | null;
  capabilityProtocol?: string;
  muted?: boolean;
  deafened?: boolean;
  joinedAt?: number;
  cloudflareSessionId?: string | null;
  qualifiedPeerIds?: string[];
  providerReadyEpoch?: number | null;
  providerReadySourceRevision?: number | null;
  audioLatencyCapabilities?: AudioLatencyCapabilitiesV1 | null;
}

export interface RoomParticipant {
  ws?: CloudflareWebSocket | null;
  userId?: string | null;
  deviceId?: string | null;
  peerId?: string | null;
  connectionEpoch?: number | null;
  channelId?: string | null;
  sources: Set<string>;
  sourceStates?: SourceStateMap;
  providerCapabilities?: Set<string>;
  mediaCapabilities?: MediaCapabilities | null;
  capabilityProtocol?: string;
  muted?: boolean;
  deafened?: boolean;
  joinedAt?: number;
  lastSeenAt?: number;
  status?: "connected" | "disconnected" | string;
  disconnectedAt?: number | null;
  cloudflareSessionId?: string | null;
  audioLatencyCapabilities?: AudioLatencyCapabilitiesV1 | null;
}

export type RoomRoute = MediaRoute & {
  provider?: string;
  providerId?: string;
};

export type AudioLatencyProfileValue = "standard" | "ultra-low";
export type AudioQuantumUs = 2500 | 5000 | 10000;

export type EffectiveAudioLatencyMode =
  | "standard-10ms"
  | "ultra-low-10ms-compat"
  | "ultra-low-5ms"
  | "ultra-low-2_5ms";

export interface AudioLatencyCapabilitiesV1 {
  version: 1;
  nativeAudioEngine: boolean;
  restrictedLowDelayOpus: boolean;
  captureQuantaUs: readonly AudioQuantumUs[];
  encodeFrameDurationsUs: readonly AudioQuantumUs[];
  decodeFrameDurationsUs: readonly AudioQuantumUs[];
  renderQuantaUs: readonly AudioQuantumUs[];
}

export interface MediaPolicySnapshot {
  audioLatencyProfile: AudioLatencyProfileValue;
  revision: number;
  updatedAt: string | null;
}

export interface ParticipantAudioLatencyStatus {
  requested: AudioLatencyProfileValue;
  effectiveMode: EffectiveAudioLatencyMode;
  quantumUs: AudioQuantumUs;
}

export interface ProviderHealth {
  healthy?: boolean;
  provider?: string;
  providerId?: string | null;
  reason?: string;
  epoch?: number;
  sourceRevision?: number;
  unhealthyUntil?: number;
  updatedAt?: number;
  lastCheck?: number;
  failures?: number;
  recoveringSince?: number | null;
  [key: string]: unknown;
}
export type RoomProviderHealth = ProviderHealth;
export interface ProviderConfig {
  id?: string;
  provider?: string;
  signalingUrl?: string;
  healthUrl?: string;
  region?: string;
  priority?: number;
  [key: string]: unknown;
}
export type RoomProviderConfig = ProviderConfig;
export interface RoomPublication {
  sessionId?: string | null;
  trackName?: string;
  source?: string;
  ownerSource?: string | null;
  userId?: string | null;
  peerId?: string | null;
  logicalStreamId?: string;
  generation?: number;
  connectionEpoch?: number;
  variantId?: string;
  codec?: string;
  codecAcceleration?: "hardware" | "software" | "unsupported";
  codecImplementation?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  target?: Record<string, number>;
  targetAdjusted?: boolean;
  receivers?: string[];
  emergency?: boolean;
  score?: number;
  closed?: boolean;
  updatedAt?: number;
  [key: string]: unknown;
}
export interface QoeReport {
  provider?: string;
  providerId?: string | null;
  paths?: Array<Record<string, unknown>>;
  receivedAt?: number;
  sampledAt?: number;
  [key: string]: unknown;
}
export type RoomQoeMetrics = QoeReport | Map<string, QoeReport>;
export interface OperationResult {
  operationId?: string;
  accepted?: boolean;
  replayed?: boolean;
  code?: string;
  retryable?: boolean;
  connectionEpoch?: number;
  roomRevision?: string;
  createdAt?: number;
  [key: string]: unknown;
}
