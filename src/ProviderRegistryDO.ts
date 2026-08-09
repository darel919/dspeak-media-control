import { SFU_PROVIDER, MEDIA_ROUTE_KIND } from "./protocol.js";
import { rankQoeCandidates } from "./qoe.ts";

export class ProviderRegistryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.providers = new Map();
    this.circuitBreakers = new Map();
    this.stateLoaded = false;
  }

  async fetch(request) {
    await this.loadDurableState();
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      return this.handleRegister(request);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return this.handleHealth(request);
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
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
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
      recoveringSince: null,
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

  async handleHealth(request) {
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
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
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
    const data = await request.json();
    const {
      roomId,
      connectionMode,
      participantCount,
      hasVideo,
      requiredSources,
      excludedProvider,
      qoeCandidates = [],
    } = data;

    let candidates = [...this.providers.values()].filter((p) => p.healthy);
    if (excludedProvider)
      candidates = candidates.filter((provider) =>
        excludedProvider === SFU_PROVIDER.CLOUDFLARE_REALTIME
          ? !provider.id.includes("cloudflare")
          : !(
              provider.id.includes("mediasoup") ||
              provider.id.includes("selfhost")
            ),
      );

    candidates = candidates.filter((p) => {
      const cb = this.circuitBreakers.get(p.id);
      const now = Date.now();
      return (
        !cb ||
        cb.state === "closed" ||
        (cb.state === "half-open" && now >= cb.nextAttempt)
      );
    });
    candidates = candidates.filter((provider) => {
      if (!provider.recoveringSince) return true;
      if (Date.now() - provider.recoveringSince < 300_000) return false;
      provider.recoveringSince = null;
      return true;
    });

    if (connectionMode === "direct") {
      return new Response(
        JSON.stringify({
          route: { kind: MEDIA_ROUTE_KIND.P2P, path: "direct" },
        }),
      );
    }

    const rankedQoe = rankQoeCandidates(
      qoeCandidates.filter(
        (candidate) =>
          Number(candidate.readyParticipants) >=
            Number(candidate.requiredParticipants) &&
          candidate.paths?.length > 0 &&
          candidate.paths.every((path) =>
            Number.isFinite(Number(path.rttMs)),
          ) &&
          candidates.some((provider) =>
            candidate.provider === SFU_PROVIDER.CLOUDFLARE_REALTIME
              ? provider.id.includes("cloudflare")
              : (provider.id.includes("mediasoup") ||
                  provider.id.includes("selfhost")) &&
                candidate.provider === SFU_PROVIDER.MEDIASOUP,
          ),
      ),
    );
    const qoeProvider = rankedQoe[0]?.provider;
    if (qoeProvider) {
      const provider = candidates.find((candidate) =>
        qoeProvider === SFU_PROVIDER.CLOUDFLARE_REALTIME
          ? candidate.id.includes("cloudflare")
          : candidate.id.includes("mediasoup") ||
            candidate.id.includes("selfhost"),
      );
      if (provider)
        return new Response(
          JSON.stringify({
            route: { kind: MEDIA_ROUTE_KIND.SFU, provider: qoeProvider },
            provider,
          }),
        );
    }

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
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
    const data = await request.json();
    const { providerId, error, correlated } = data;

    const cb = this.circuitBreakers.get(providerId);
    if (!cb)
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
      });

    cb.failureCount++;
    cb.lastFailure = Date.now();

    const cooldowns = [30000, 60000, 120000, 300000];
    const index = Math.min(cb.failureCount - 1, cooldowns.length - 1);
    cb.nextAttempt = Date.now() + cooldowns[index];

    if (cb.failureCount >= 3) {
      cb.state = "open";
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
    await Promise.all([
      this.state.storage.put("providers", Object.fromEntries(this.providers)),
      this.state.storage.put(
        "circuitBreakers",
        Object.fromEntries(this.circuitBreakers),
      ),
    ]);
  }

  async loadDurableState() {
    if (this.stateLoaded) return;
    const [providers, circuitBreakers] = await Promise.all([
      this.state.storage.get("providers"),
      this.state.storage.get("circuitBreakers"),
    ]);
    if (providers && typeof providers === "object")
      this.providers = new Map(Object.entries(providers));
    if (circuitBreakers && typeof circuitBreakers === "object")
      this.circuitBreakers = new Map(Object.entries(circuitBreakers));
    this.stateLoaded = true;
  }

  isAuthorized(request) {
    const expected = this.env.MEDIA_CONTROL_ADMIN_TOKEN;
    return Boolean(
      expected && request.headers.get("authorization") === `Bearer ${expected}`,
    );
  }

  async alarm() {
    for (const [id, provider] of this.providers) {
      try {
        const response = await fetch(provider.healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        const healthy = response.ok;
        const wasHealthy = provider.healthy;
        provider.healthy = healthy;
        provider.lastCheck = Date.now();
        if (healthy && !wasHealthy) provider.recoveringSince = Date.now();

        const cb = this.circuitBreakers.get(id);
        if (healthy && cb && cb.state === "open") {
          cb.state = "half-open";
          cb.nextAttempt = Date.now();
        }
      } catch {
        provider.healthy = false;
        provider.recoveringSince = null;
      }
    }
    await this.persist();

    this.state.storage.setAlarm(Date.now() + 60000);
  }
}
