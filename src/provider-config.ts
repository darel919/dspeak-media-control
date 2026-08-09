import { SFU_PROVIDER } from "./protocol.js";

function flag(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return value === true || value === "1" || value === "true";
}

export function isSelfHostedMediasoupConfigured(env) {
  if (!flag(env?.DSPEAK_SFU_ENABLED)) return false;
  const signalingUrl = String(env?.DSPEAK_SFU_SIGNALING_URL || "").trim();
  if (!/^wss?:\/\//.test(signalingUrl)) return false;
  if (/example\.com|your-domain|localhost/i.test(signalingUrl)) return false;
  return true;
}

export function isCloudflareRealtimeConfigured(env) {
  return Boolean(
    String(env?.CLOUDFLARE_REALTIME_APP_ID || "").trim() &&
    String(env?.CLOUDFLARE_REALTIME_APP_SECRET || "").trim(),
  );
}

export function configuredSfuProviders(env) {
  const providers = new Set();
  if (isCloudflareRealtimeConfigured(env))
    providers.add(SFU_PROVIDER.CLOUDFLARE_REALTIME);
  if (isSelfHostedMediasoupConfigured(env))
    providers.add(SFU_PROVIDER.MEDIASOUP);
  return providers;
}

export function providerRegistryEnabled(env) {
  return Boolean(
    env?.PROVIDER_REGISTRY_DO && isSelfHostedMediasoupConfigured(env),
  );
}
