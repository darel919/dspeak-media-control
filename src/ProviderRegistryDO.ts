import { SFU_PROVIDER, MEDIA_ROUTE_KIND } from "./protocol.js";

export class ProviderRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.providers = new Map(); // providerId -> { id, signalingUrl, healthUrl, region, priority, healthy, lastCheck, failures }
    this.circuitBreakers = new Map(); // providerId -> { state: 'closed'|'open'|'half-open', failureCount, lastFailure, nextAttempt }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      return this.handleRegister(request);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return this.handleHealth();
    }

    if (url.pathname === "/select" && request.method === "POST") {
      return this.handleSelect(request);
    }

    if (url.pathname === "/report-failure" && request.method === "POST") {
      return this.handleReportFailure(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleRegister(request) {
    const data = await request.json();
    const { providerId, signalingUrl, healthUrl, region, priority = 10 } = data;

    if (!providerId || !signalingUrl || !healthUrl) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400 },
      );
    }

    this.providers.set(providerId, {
      id: providerId,
      signalingUrl,
      healthUrl,
      region: region || "unknown",
      priority,
      healthy: true,
      lastCheck: Date.now(),
      failures: 0,
    });

    this.circuitBreakers.set(providerId, {
      state: "closed",
      failureCount: 0,
      lastFailure: 0,
      nextAttempt: 0,
    });

    await this.persist();
    return new Response(JSON.stringify({ success: true }));
  }

  async handleHealth() {
    const providers = [];
    for (const [id, provider] of this.providers) {
      const cb = this.circuitBreakers.get(id);
      providers.push({
        id,
        ...provider,
        circuitBreaker: cb,
      });
    }
    return new Response(JSON.stringify({ providers }));
  }

  async handleSelect(request) {
    const data = await request.json();
    const {
      roomId,
      connectionMode,
      participantCount,
      hasVideo,
      requiredSources,
    } = data;

    // Filter eligible providers
    let candidates = [...this.providers.values()].filter((p) => p.healthy);

    // Apply circuit breaker
    candidates = candidates.filter((p) => {
      const cb = this.circuitBreakers.get(p.id);
      return (
        !cb ||
        cb.state !== "open" ||
        (cb.state === "half-open" && Date.now() >= cb.nextAttempt)
      );
    });

    // Direct mode: only P2P
    if (connectionMode === "direct") {
      return new Response(
        JSON.stringify({
          route: { kind: MEDIA_ROUTE_KIND.P2P, path: "direct" },
        }),
      );
    }

    // Auto mode: prefer P2P for small rooms, then Cloudflare, then mediasoup
    if (participantCount <= 4 && !hasVideo) {
      // Try P2P first
      return new Response(
        JSON.stringify({
          route: { kind: MEDIA_ROUTE_KIND.P2P, path: "direct" },
        }),
      );
    }

    // Cloudflare Realtime preferred for Auto
    const cfProvider = candidates.find((p) => p.id.includes("cloudflare"));
    if (cfProvider) {
      return new Response(
        JSON.stringify({
          route: {
            kind: MEDIA_ROUTE_KIND.SFU,
            provider: SFU_PROVIDER.CLOUDFLARE_REALTIME,
          },
          provider: cfProvider,
        }),
      );
    }

    // Fallback to mediasoup
    const msProvider = candidates.find(
      (p) => p.id.includes("mediasoup") || p.id.includes("selfhost"),
    );
    if (msProvider) {
      return new Response(
        JSON.stringify({
          route: {
            kind: MEDIA_ROUTE_KIND.SFU,
            provider: SFU_PROVIDER.MEDIASOUP,
          },
          provider: msProvider,
        }),
      );
    }

    return new Response(
      JSON.stringify({ error: "No healthy provider available" }),
      { status: 503 },
    );
  }

  async handleReportFailure(request) {
    const data = await request.json();
    const { providerId, error, correlated } = data;

    const cb = this.circuitBreakers.get(providerId);
    if (!cb)
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
      });

    cb.failureCount++;
    cb.lastFailure = Date.now();

    const cooldowns = [30000, 60000, 120000, 300000]; // 30s, 60s, 2m, 5m cap
    const index = Math.min(cb.failureCount - 1, cooldowns.length - 1);
    cb.nextAttempt = Date.now() + cooldowns[index];

    if (cb.failureCount >= 3) {
      cb.state = "open";
      // Mark provider unhealthy
      const provider = this.providers.get(providerId);
      if (provider) {
        provider.healthy = false;
        provider.failures = cb.failureCount;
      }
    }

    await this.persist();
    return new Response(JSON.stringify({ success: true, circuitBreaker: cb }));
  }

  async persist() {
    // State is automatically persisted by Durable Object
    this.state.storage.put("providers", Object.fromEntries(this.providers));
    this.state.storage.put(
      "circuitBreakers",
      Object.fromEntries(this.circuitBreakers),
    );
  }

  async alarm() {
    // Periodic health checks
    for (const [id, provider] of this.providers) {
      try {
        const response = await fetch(provider.healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        const healthy = response.ok;
        provider.healthy = healthy;
        provider.lastCheck = Date.now();

        const cb = this.circuitBreakers.get(id);
        if (healthy && cb && cb.state === "open") {
          // Try half-open
          cb.state = "half-open";
          cb.nextAttempt = Date.now();
        }
      } catch {
        provider.healthy = false;
      }
    }
    await this.persist();

    // Schedule next alarm
    this.state.storage.setAlarm(Date.now() + 60000); // Every minute
  }
}
