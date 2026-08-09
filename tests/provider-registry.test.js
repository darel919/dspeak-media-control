import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistryDO } from "../src/ProviderRegistryDO.ts";
import { isSelfHostedMediasoupConfigured } from "../src/provider-config.ts";

function registry() {
  return new ProviderRegistryDO(
    {
      storage: {
        get: async () => null,
        put: async () => {},
      },
    },
    {
      MEDIA_CONTROL_ADMIN_TOKEN: "admin",
      DSPEAK_SFU_ENABLED: "true",
      DSPEAK_SFU_SIGNALING_URL: "wss://sfu.example.net/v1/ws",
    },
  );
}

function request() {
  return new Request("https://registry/select", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connectionMode: "auto" }),
  });
}

function registerRequest() {
  return new Request("https://registry/register", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      providerId: "selfhost-primary",
      signalingUrl: "wss://sfu.example.net/v1/ws",
      healthUrl: "https://sfu.example.net/health",
    }),
  });
}

test("self-hosted mediasoup requires an explicit enabled flag and URL", () => {
  assert.equal(
    isSelfHostedMediasoupConfigured({
      DSPEAK_SFU_ENABLED: "false",
      DSPEAK_SFU_SIGNALING_URL: "wss://sfu.example.net/v1/ws",
    }),
    false,
  );
  assert.equal(
    isSelfHostedMediasoupConfigured({
      DSPEAK_SFU_ENABLED: "true",
      DSPEAK_SFU_SIGNALING_URL: "",
    }),
    false,
  );
  assert.equal(
    isSelfHostedMediasoupConfigured({
      DSPEAK_SFU_ENABLED: "true",
      DSPEAK_SFU_SIGNALING_URL: "wss://sfu.example.net/v1/ws",
    }),
    true,
  );
});

test("disabled self-hosted mediasoup does not register or select", async () => {
  const instance = new ProviderRegistryDO(
    {
      storage: {
        get: async () => null,
        put: async () => {},
      },
    },
    { MEDIA_CONTROL_ADMIN_TOKEN: "admin", DSPEAK_SFU_ENABLED: "false" },
  );
  instance.stateLoaded = true;

  const registerResponse = await instance.handleRegister(registerRequest());
  const selectResponse = await instance.handleSelect(request());

  assert.equal(registerResponse.status, 503);
  assert.equal(selectResponse.status, 503);
  assert.equal(instance.providers.size, 0);
});

test("disabled self-hosted mediasoup deletes stale probe alarms", async () => {
  let deletedAlarm = false;
  let probes = 0;
  const instance = new ProviderRegistryDO(
    {
      storage: {
        get: async () => null,
        put: async () => {},
        deleteAlarm: async () => {
          deletedAlarm = true;
        },
      },
    },
    { DSPEAK_SFU_ENABLED: "false" },
  );
  instance.stateLoaded = true;
  instance.providers.set("stale", {
    healthUrl: "https://should-not-be-probed.invalid/health",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    probes += 1;
    throw new Error("probe should not run");
  };

  try {
    await instance.alarm();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(deletedAlarm, true);
  assert.equal(probes, 0);
});

test("provider registry does not select a half-open provider before retry time", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("cloudflare-primary", {
    id: "cloudflare-primary",
    signalingUrl: "wss://provider.example",
    healthUrl: "https://provider.example/health",
    healthy: true,
  });
  instance.circuitBreakers.set("cloudflare-primary", {
    state: "half-open",
    nextAttempt: Date.now() + 60_000,
  });

  const response = await instance.handleSelect(request());

  assert.equal(response.status, 503);
});

test("provider registry allows one half-open retry after cooldown", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("cloudflare-primary", {
    id: "cloudflare-primary",
    signalingUrl: "wss://provider.example",
    healthUrl: "https://provider.example/health",
    healthy: true,
  });
  instance.circuitBreakers.set("cloudflare-primary", {
    state: "half-open",
    nextAttempt: Date.now() - 1,
  });

  const response = await instance.handleSelect(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.route.provider, "cloudflare-realtime");
});
