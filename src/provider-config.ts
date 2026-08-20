import { SFU_PROVIDER } from "./protocol.ts";

import type { MediaControlEnv } from "./domain-types.ts";

function flag(value: unknown, fallback = false) {
  if (value == null || value === "") return fallback;
  return value === true || value === "1" || value === "true";
}

export function isSelfHostedMediasoupConfigured(env: MediaControlEnv) {
  if (!flag(env?.DSPEAK_SFU_ENABLED)) return false;
  const signalingUrl = String(env?.DSPEAK_SFU_SIGNALING_URL || "").trim();
  if (!/^wss?:\/\//.test(signalingUrl)) return false;
  if (/example\.com|your-domain|localhost/i.test(signalingUrl)) return false;
  return true;
}

export function isCloudflareRealtimeConfigured(env: MediaControlEnv) {
  return Boolean(
    String(env?.CLOUDFLARE_REALTIME_APP_ID || "").trim() &&
    String(env?.CLOUDFLARE_REALTIME_APP_SECRET || "").trim(),
  );
}

export function configuredSfuProviders(env: MediaControlEnv) {
  const providers = new Set<string>();
  if (isCloudflareRealtimeConfigured(env))
    providers.add(SFU_PROVIDER.CLOUDFLARE_REALTIME);
  if (isSelfHostedMediasoupConfigured(env))
    providers.add(SFU_PROVIDER.MEDIASOUP);
  return providers;
}

export function providerRegistryEnabled(env: MediaControlEnv) {
  return Boolean(
    env?.PROVIDER_REGISTRY_DO && isSelfHostedMediasoupConfigured(env),
  );
}
