import { SFU_PROVIDER, MEDIA_ROUTE_KIND } from "./protocol.ts";
import { rankQoeCandidates } from "./qoe.ts";
import { isSelfHostedMediasoupConfigured } from "./provider-config.ts";
import { mediaDebug } from "./debug.ts";

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

    if (url.pathname === "/report-success" && request.method === "POST") {
      return this.handleReportSuccess(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async handleRegister(request) {
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
    if (!isSelfHostedMediasoupConfigured(this.env))
      return new Response(
        JSON.stringify({
          error: "Self-hosted mediasoup is disabled or unconfigured",
        }),
        { status: 503 },
      );
    const data = await request.json();
    const {
      providerId,
      signalingUrl,
      healthUrl,
      provider = SFU_PROVIDER.MEDIASOUP,
      region,
      priority = 10,
    } = data;

    if (
      !providerId ||
      !signalingUrl ||
      !healthUrl ||
      ![SFU_PROVIDER.CLOUDFLARE_REALTIME, SFU_PROVIDER.MEDIASOUP].includes(
        provider,
      )
    ) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400 },
      );
    }

    this.providers.set(providerId, {
      id: providerId,
      provider,
      signalingUrl,
      healthUrl,
      region: region || "unknown",
      priority: normalizePriority(priority),
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
    await this.state.storage.setAlarm?.(Date.now() + 60_000);
    mediaDebug(this.env, "registry.provider-registered", { providerId });
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
    if (!isSelfHostedMediasoupConfigured(this.env))
      return new Response(
        JSON.stringify({
          error: "Self-hosted mediasoup is disabled or unconfigured",
        }),
        { status: 503 },
      );
    const data = await request.json();
    const {
      roomId,
      connectionMode,
      participantCount,
      hasVideo,
      requiredSources,
      excludedProvider,
      qoeCandidates = [],
      preferredRegion,
      excludedProviderId,
    } = data;

    let candidates = [...this.providers.values()].filter(
      (provider) => provider.healthy,
    );
    if (excludedProvider)
      candidates = candidates.filter(
        (provider) => getProviderFamily(provider) !== excludedProvider,
      );
    if (excludedProviderId)
      candidates = candidates.filter(
        (provider) => provider.id !== excludedProviderId,
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
          candidates.some(
            (provider) =>
              getProviderFamily(provider) === candidate.provider &&
              (!candidate.providerId || provider.id === candidate.providerId),
          ),
      ),
    );
    const qoeProvider = rankedQoe[0]?.provider;
    if (qoeProvider) {
      const provider = selectProviderInstance(
        candidates,
        qoeProvider,
        rankedQoe[0],
        preferredRegion,
      );
      if (provider)
        return new Response(
          JSON.stringify({
            route: {
              kind: MEDIA_ROUTE_KIND.SFU,
              provider: qoeProvider,
              providerId: provider.id,
            },
            provider,
          }),
        );
    }

    const cfProvider = selectProviderInstance(
      candidates,
      SFU_PROVIDER.CLOUDFLARE_REALTIME,
      null,
      preferredRegion,
    );
    if (cfProvider) {
      return new Response(
        JSON.stringify({
          route: {
            kind: MEDIA_ROUTE_KIND.SFU,
            provider: SFU_PROVIDER.CLOUDFLARE_REALTIME,
            providerId: cfProvider.id,
          },
          provider: cfProvider,
        }),
      );
    }

    const msProvider = selectProviderInstance(
      candidates,
      SFU_PROVIDER.MEDIASOUP,
      null,
      preferredRegion,
    );
    if (msProvider) {
      return new Response(
        JSON.stringify({
          route: {
            kind: MEDIA_ROUTE_KIND.SFU,
            provider: SFU_PROVIDER.MEDIASOUP,
            providerId: msProvider.id,
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

  async handleReportSuccess(request) {
    if (!this.isAuthorized(request))
      return new Response("Unauthorized", { status: 401 });
    const data = await request.json();
    const providerId = String(data.providerId || "");
    const cb = this.circuitBreakers.get(providerId);
    const provider = this.providers.get(providerId);
    if (!cb || !provider)
      return new Response(JSON.stringify({ error: "Provider not found" }), {
        status: 404,
      });

    const now = Date.now();
    cb.state = "closed";
    cb.failureCount = 0;
    cb.lastFailure = 0;
    cb.nextAttempt = 0;
    provider.healthy = true;
    provider.failures = 0;
    provider.recoveringSince = null;
    provider.lastCheck = now;
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
    await this.loadDurableState();

    if (!isSelfHostedMediasoupConfigured(this.env)) {
      await this.state.storage.deleteAlarm?.();
      mediaDebug(this.env, "registry.probe-skipped", {
        reason: "self-hosted-mediasoup-disabled",
      });
      return;
    }
    for (const [id, provider] of this.providers) {
      try {
        const response = await fetch(provider.healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        const healthy = response.ok;
        const wasHealthy = provider.healthy;
        const wasOpen = this.circuitBreakers.get(id)?.state === "open";
        provider.healthy = healthy;
        provider.lastCheck = Date.now();
        if (healthy && (!wasHealthy || wasOpen))
          provider.recoveringSince = Date.now();

        const cb = this.circuitBreakers.get(id);
        if (healthy && cb && cb.state === "open") {
          cb.state = "half-open";
          cb.nextAttempt = Date.now();
        } else if (healthy && cb && cb.state === "half-open") {
          cb.state = "closed";
          cb.failureCount = 0;
          cb.lastFailure = 0;
          cb.nextAttempt = 0;
          provider.failures = 0;
        }
      } catch {
        provider.healthy = false;
        provider.recoveringSince = null;
      }
    }
    mediaDebug(this.env, "registry.probe-complete", {
      providers: this.providers.size,
    });
    await this.persist();

    await this.state.storage.setAlarm?.(Date.now() + 60000);
  }
}

function getProviderFamily(provider) {
  if (provider.provider === SFU_PROVIDER.CLOUDFLARE_REALTIME)
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  if (provider.provider === SFU_PROVIDER.MEDIASOUP)
    return SFU_PROVIDER.MEDIASOUP;
  if (provider.id?.includes("cloudflare"))
    return SFU_PROVIDER.CLOUDFLARE_REALTIME;
  return SFU_PROVIDER.MEDIASOUP;
}

function selectProviderInstance(
  candidates,
  family,
  qoeCandidate,
  preferredRegion,
) {
  const familyCandidates = candidates.filter(
    (candidate) => getProviderFamily(candidate) === family,
  );
  if (!familyCandidates.length) return null;
  const qoeProviderId = qoeCandidate?.providerId;
  const qoeCandidates = qoeProviderId
    ? familyCandidates.filter((candidate) => candidate.id === qoeProviderId)
    : familyCandidates;
  if (qoeProviderId && !qoeCandidates.length) return null;
  const ranked = (qoeCandidates.length ? qoeCandidates : familyCandidates).sort(
    (left, right) => {
      const leftRegion = preferredRegion && left.region === preferredRegion;
      const rightRegion = preferredRegion && right.region === preferredRegion;
      if (leftRegion !== rightRegion) return leftRegion ? -1 : 1;
      if (left.priority !== right.priority)
        return left.priority - right.priority;
      return left.id.localeCompare(right.id);
    },
  );
  return ranked[0] || null;
}

function normalizePriority(value) {
  const priority = Number(value);
  return Number.isFinite(priority) ? priority : 10;
}
