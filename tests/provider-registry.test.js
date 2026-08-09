import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistryDO } from "../src/ProviderRegistryDO.ts";

function registry() {
  return new ProviderRegistryDO(
    {
      storage: {
        get: async () => null,
        put: async () => {},
      },
    },
    { MEDIA_CONTROL_ADMIN_TOKEN: "admin" },
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
