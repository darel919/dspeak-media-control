import type { MediaRoute } from "./protocol.ts";
import type { WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";

export type DynamicRecord = Record<string, any>;

export interface MediaControlEnv extends DynamicRecord {
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

export type RoomSession = DynamicRecord & {
  ws?: CloudflareWebSocket | null;
  userId?: string | null;
  deviceId?: string | null;
  peerId?: string | null;
  connectionEpoch?: number | null;
  mediaSessionId?: string | null;
  authenticated?: boolean;
};

export type RoomParticipant = DynamicRecord & {
  ws?: CloudflareWebSocket | null;
  userId?: string | null;
  deviceId?: string | null;
  peerId?: string | null;
  connectionEpoch?: number | null;
};

export type RoomRoute = MediaRoute & {
  provider?: string;
  providerId?: string;
};
export type RoomProviderHealth = DynamicRecord;
export type RoomProviderConfig = DynamicRecord;
export type RoomPublication = DynamicRecord;
export type RoomQoeMetrics = DynamicRecord;
export type OperationResult = DynamicRecord;
