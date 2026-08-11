import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistryDO } from "../src/ProviderRegistryDO.ts";
import { SFU_PROVIDER } from "../src/protocol.js";
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

function request(data = {}) {
  return new Request("https://registry/select", {
    method: "POST",
    headers: {
      Authorization: "Bearer admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ connectionMode: "auto", ...data }),
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

test("provider registry rehydrates persisted state before a cold alarm", async () => {
  const provider = {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://singapore.example",
    healthUrl: "https://singapore.example/health",
    region: "sg",
    priority: 1,
    healthy: true,
    failures: 0,
    recoveringSince: null,
  };
  const circuitBreaker = {
    state: "closed",
    failureCount: 0,
    lastFailure: 0,
    nextAttempt: 0,
  };
  const values = new Map([
    ["providers", { "sfu-singapore": provider }],
    ["circuitBreakers", { "sfu-singapore": circuitBreaker }],
  ]);
  const probes = [];
  const storage = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    setAlarm: async () => {},
  };
  const instance = new ProviderRegistryDO(
    { storage },
    {
      DSPEAK_SFU_ENABLED: "true",
      DSPEAK_SFU_SIGNALING_URL: "wss://sfu.example.net/v1/ws",
    },
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    probes.push(String(url));
    return new Response("ok", { status: 200 });
  };

  try {
    await instance.alarm();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(instance.stateLoaded, true);
  assert.equal(instance.providers.size, 1);
  assert.equal(instance.providers.get("sfu-singapore").id, "sfu-singapore");
  assert.deepEqual(Object.keys(values.get("providers")), ["sfu-singapore"]);
  assert.deepEqual(Object.keys(values.get("circuitBreakers")), [
    "sfu-singapore",
  ]);
  assert.deepEqual(probes, ["https://singapore.example/health"]);
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

test("provider registry selects a concrete provider by region and priority", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://singapore.example",
    healthUrl: "https://singapore.example/health",
    region: "sg",
    priority: 20,
    healthy: true,
  });
  instance.providers.set("sfu-frankfurt", {
    id: "sfu-frankfurt",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://frankfurt.example",
    healthUrl: "https://frankfurt.example/health",
    region: "eu",
    priority: 1,
    healthy: true,
  });
  instance.circuitBreakers.set("sfu-singapore", { state: "closed" });
  instance.circuitBreakers.set("sfu-frankfurt", { state: "closed" });

  const response = await instance.handleSelect(
    request({ preferredRegion: "sg" }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider.id, "sfu-singapore");
  assert.equal(body.route.provider, SFU_PROVIDER.MEDIASOUP);
});

test("provider registry recognizes arbitrary mediasoup instance ids", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://singapore.example",
    healthUrl: "https://singapore.example/health",
    healthy: true,
    priority: 10,
  });
  instance.circuitBreakers.set("sfu-singapore", { state: "closed" });

  const response = await instance.handleSelect(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider.id, "sfu-singapore");
  assert.equal(body.route.provider, SFU_PROVIDER.MEDIASOUP);
});

test("provider registry honors a QoE candidate for a concrete instance", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://singapore.example",
    healthUrl: "https://singapore.example/health",
    priority: 20,
    healthy: true,
  });
  instance.providers.set("sfu-frankfurt", {
    id: "sfu-frankfurt",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://frankfurt.example",
    healthUrl: "https://frankfurt.example/health",
    priority: 1,
    healthy: true,
  });
  instance.circuitBreakers.set("sfu-singapore", { state: "closed" });
  instance.circuitBreakers.set("sfu-frankfurt", { state: "closed" });

  const response = await instance.handleSelect(
    request({
      qoeCandidates: [
        {
          provider: SFU_PROVIDER.MEDIASOUP,
          providerId: "sfu-singapore",
          readyParticipants: 1,
          requiredParticipants: 1,
          paths: [{ rttMs: 20 }],
        },
      ],
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider.id, "sfu-singapore");
});

test("provider registry ranks concrete instances by room QoE", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://singapore.example",
    healthUrl: "https://singapore.example/health",
    priority: 1,
    healthy: true,
  });
  instance.providers.set("sfu-tokyo", {
    id: "sfu-tokyo",
    provider: SFU_PROVIDER.MEDIASOUP,
    signalingUrl: "wss://tokyo.example",
    healthUrl: "https://tokyo.example/health",
    priority: 20,
    healthy: true,
  });
  instance.circuitBreakers.set("sfu-singapore", { state: "closed" });
  instance.circuitBreakers.set("sfu-tokyo", { state: "closed" });

  const response = await instance.handleSelect(
    request({
      qoeCandidates: [
        {
          provider: SFU_PROVIDER.MEDIASOUP,
          providerId: "sfu-singapore",
          readyParticipants: 2,
          requiredParticipants: 2,
          paths: [{ rttMs: 31, jitterMs: 18, fractionLost: 0.032 }],
        },
        {
          provider: SFU_PROVIDER.MEDIASOUP,
          providerId: "sfu-tokyo",
          readyParticipants: 2,
          requiredParticipants: 2,
          paths: [{ rttMs: 42, jitterMs: 3, fractionLost: 0.001 }],
        },
      ],
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.provider.id, "sfu-tokyo");
  assert.equal(body.route.providerId, "sfu-tokyo");
});

test("provider registry closes a breaker after consecutive healthy probes", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    healthUrl: "https://singapore.example/health",
    healthy: false,
    failures: 3,
  });
  instance.circuitBreakers.set("sfu-singapore", {
    state: "open",
    failureCount: 3,
    lastFailure: Date.now() - 60_000,
    nextAttempt: Date.now(),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  try {
    await instance.alarm();
    assert.equal(
      instance.circuitBreakers.get("sfu-singapore").state,
      "half-open",
    );
    await instance.alarm();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(instance.circuitBreakers.get("sfu-singapore"), {
    state: "closed",
    failureCount: 0,
    lastFailure: 0,
    nextAttempt: 0,
  });
  assert.equal(instance.providers.get("sfu-singapore").failures, 0);
});

test("provider registry supports an explicit success report", async () => {
  const instance = registry();
  instance.stateLoaded = true;
  instance.providers.set("sfu-singapore", {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
    healthy: false,
    failures: 4,
    recoveringSince: Date.now(),
  });
  instance.circuitBreakers.set("sfu-singapore", {
    state: "half-open",
    failureCount: 4,
    lastFailure: Date.now(),
    nextAttempt: Date.now(),
  });

  const response = await instance.handleReportSuccess(
    new Request("https://registry/report-success", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ providerId: "sfu-singapore" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(instance.circuitBreakers.get("sfu-singapore").state, "closed");
  assert.equal(instance.circuitBreakers.get("sfu-singapore").failureCount, 0);
  assert.equal(instance.providers.get("sfu-singapore").healthy, true);
  assert.equal(instance.providers.get("sfu-singapore").recoveringSince, null);
});
