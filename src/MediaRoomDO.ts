import {
  CONTROL_HEARTBEAT_INTERVAL_MS,
  CONTROL_HEARTBEAT_TIMEOUT_MS,
  MEDIA_CONTROL_CONTRACT_REVISION,
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_CONTROL_PROTOCOL_VERSION,
  MEDIA_CONTROL_SERVER_HELLO,
  MEDIA_ROUTE_KIND,
  SFU_PROVIDER,
  createLocalRoute,
  validateRouteForMode,
} from "./protocol.js";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  controlMessageByteLength,
  normalizeMediaSources,
} from "./media-room-contracts.ts";
import { handleRoomMessage, verifyRoomTicket } from "./media-room-messages.ts";
import {
  beginTransition,
  createProviderTicket,
  getAvailableProviderCapabilities,
  getCommonProviderCapabilities,
  getConfiguredProviderCapabilities,
  getNextProviderRecoveryAt,
  getProviderHealth,
  getProviderRecoveryTarget,
  getQoeCandidates,
  handleCloudflareRequest,
  handleP2PFailure,
  handleProviderFailure,
  issueProviderTicket,
  issueProviderTickets,
  scheduleProviderRecovery,
} from "./media-room-provider.ts";
import {
  checkQualificationComplete,
  commitRoute,
  maybeCommitPendingRoute,
  maybeStartQualification,
  restoreQualificationRoute,
} from "./media-room-topology.ts";
import { mediaDebug } from "./debug.ts";

export {
  controlMessageByteLength,
  normalizeMediaSources,
} from "./media-room-contracts.ts";

export class MediaRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.channelId = null;
    this.sessions = new Map();
    this.participants = new Map();
    this.route = createLocalRoute(0, 0, "waiting-for-peer");
    this.pendingRoute = null;
    this.pendingStartedAt = 0;
    this.qualificationState = new Map();
    this.providerReadiness = new Set();
    this.transitionReadiness = new Set();
    this.publishedSources = new Map();
    this.providerHealth = new Map();
    this.qoeMetrics = new Map();
    this.providerConfig = null;
    this.sourceRevision = 0;
    this.epoch = 0;
    this.transitionGeneration = 0;
    this.transitionInFlight = false;
    this.qualifiedParticipantSignature = null;
    this.qualificationStartedAt = 0;
    this.qualificationFallbackRoute = null;
    this.qualificationParticipantSignature = null;
    this.pendingRouteRefresh = null;
    this.stateLoaded = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const forwardedChannelId = request.headers.get("X-dSpeak-Channel-Id");
    if (forwardedChannelId) this.channelId ||= forwardedChannelId;
    await this.loadDurableState();

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.isAllowedWebSocketOrigin(request)) {
        mediaDebug(this.env, "room.websocket-rejected", { reason: "origin" });
        return new Response("WebSocket origin is not allowed", { status: 403 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.isAdminRequest(request))
      return new Response("Unauthorized", { status: 401 });
    if (url.pathname.endsWith("/participants") && request.method === "GET")
      return Response.json({ participants: this.getParticipantList() });
    if (url.pathname.endsWith("/moderate") && request.method === "POST") {
      const data = await request.json();
      const matches = [...this.participants.values()].filter(
        (participant) => participant.userId === String(data.userId || ""),
      );
      for (const participant of matches) {
        if (!participant.ws) continue;
        this.sendMessage(participant.ws, "voice-moderation", {
          action: data.targetChannelId ? "move" : "disconnect",
          targetChannelId: data.targetChannelId || null,
        });
        participant.ws.close(4001, "Voice moderation");
      }
      return Response.json({ affected: matches.length });
    }
    return new Response("WebSocket upgrade required", { status: 426 });
  }

  isAdminRequest(request) {
    const expected = this.env.MEDIA_CONTROL_ADMIN_TOKEN;
    return Boolean(
      expected && request.headers.get("authorization") === `Bearer ${expected}`,
    );
  }

  isAllowedWebSocketOrigin(request) {
    const origin = request.headers.get("Origin");
    if (!origin) return true;
    const configured = String(this.env.MEDIA_CONTROL_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!configured.length) return true;
    return configured.includes(origin);
  }

  handleWebSocket(ws) {
    const session = {
      authenticated: false,
      userId: null,
      deviceId: null,
      peerId: crypto.randomUUID(),
      lastHeartbeat: Date.now(),
      mediaSessionId: crypto.randomUUID(),
      providerCapabilities: [...this.getConfiguredProviderCapabilities()],
      sources: [],
      muted: true,
      deafened: false,
      joinedAt: Date.now(),
    };
    this.state.acceptWebSocket(ws);
    ws.serializeAttachment(session);
    this.sessions.set(ws, session);
    mediaDebug(this.env, "room.websocket-accepted", {
      peerId: session.peerId,
      capabilities: session.providerCapabilities,
    });
    void this.state.storage.setAlarm?.(
      Date.now() + CONTROL_HEARTBEAT_INTERVAL_MS,
    );
    ws.send(
      JSON.stringify({
        type: MEDIA_CONTROL_SERVER_HELLO,
        data: {
          protocolVersion: MEDIA_CONTROL_PROTOCOL_VERSION,
          contractRevision: MEDIA_CONTROL_CONTRACT_REVISION,
          mediaSessionId: session.mediaSessionId,
          heartbeatIntervalMs: CONTROL_HEARTBEAT_INTERVAL_MS,
          heartbeatTimeoutMs: CONTROL_HEARTBEAT_TIMEOUT_MS,
          serverTime: Date.now(),
        },
      }),
    );
  }

  async webSocketMessage(ws, message) {
    if (controlMessageByteLength(message) > MAX_CONTROL_MESSAGE_BYTES) {
      this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        code: "MEDIA_MESSAGE_TOO_LARGE",
        error: "Media control message exceeds the allowed size",
      });
      ws.close(1009, "Media control message too large");
      return;
    }
    await this.loadDurableState();
    const session = this.getSession(ws);
    try {
      const data = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      );
      mediaDebug(this.env, "room.message", {
        type: data?.type,
        authenticated: session?.authenticated === true,
      });
      await handleRoomMessage(this, ws, session, data);
    } catch (error) {
      console.error("[MediaRoomDO] Message parse error:", error);
      mediaDebug(this.env, "room.message-invalid", { error });
      this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        error: "Invalid message",
      });
    }
  }

  webSocketClose(ws) {
    const session = this.getSession(ws);
    if (session) this.handleDisconnect(ws, session);
  }

  webSocketError(ws) {
    const session = this.getSession(ws);
    if (session) this.handleDisconnect(ws, session);
  }

  async alarm() {
    await this.loadDurableState();
    const sockets = this.state.getWebSockets?.() || [...this.sessions.keys()];
    const now = Date.now();
    for (const ws of sockets) {
      const session = this.getSession(ws);
      if (
        session?.authenticated &&
        now - session.lastHeartbeat > CONTROL_HEARTBEAT_TIMEOUT_MS
      )
        ws.close(1008, "Control lease expired");
    }
    for (const [participantKey, participant] of this.participants)
      if (
        participant.disconnectedAt &&
        now - participant.disconnectedAt >= 10_000
      )
        await this.finalizeParticipantDisconnect(participantKey, participant);
    if (sockets.length > 0 || this.participants.size > 0)
      await this.state.storage.setAlarm?.(now + CONTROL_HEARTBEAT_INTERVAL_MS);
    if (
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.reason === "qualifying-direct"
    )
      this.checkQualificationComplete();
    const recoveryProvider = this.getProviderRecoveryTarget(now);
    const activeProvider =
      this.route.kind === MEDIA_ROUTE_KIND.SFU ? this.route.provider : null;
    const activeProviderHealth = activeProvider
      ? getProviderHealth(this, activeProvider, this.route.providerId)
      : null;
    const retryActiveProvider = Boolean(
      activeProvider &&
      activeProviderHealth?.healthy === false &&
      Number(activeProviderHealth.unhealthyUntil) <= now,
    );
    if (
      recoveryProvider &&
      this.participants.size > 0 &&
      this.getConnectionMode() === "auto" &&
      !this.pendingRoute &&
      !this.transitionInFlight &&
      (this.route.kind !== MEDIA_ROUTE_KIND.SFU || retryActiveProvider)
    )
      void this.beginTransition(recoveryProvider, "provider-cooldown-expired");
    this.scheduleProviderRecovery(now);
    if (this.pendingRoute && now - this.pendingStartedAt > 15_000)
      await this.handleProviderFailure(
        this.pendingRoute.provider,
        "provider-prepare-timeout",
        this.pendingRoute.providerId,
        this.pendingRoute.epoch,
        this.pendingRoute.sourceRevision,
        this.pendingRoute,
      );
  }

  async loadDurableState() {
    if (this.stateLoaded) return;
    const [
      route,
      epoch,
      sourceRevision,
      pendingRoute,
      pendingStartedAt,
      publishedSources,
      qualifiedParticipantSignature,
      qualificationStartedAt,
      providerConfig,
      providerHealth,
      qualificationFallbackRoute,
      qualificationParticipantSignature,
    ] = await Promise.all([
      this.state.storage.get("route"),
      this.state.storage.get("epoch"),
      this.state.storage.get("sourceRevision"),
      this.state.storage.get("pendingRoute"),
      this.state.storage.get("pendingStartedAt"),
      this.state.storage.get("publishedSources"),
      this.state.storage.get("qualifiedParticipantSignature"),
      this.state.storage.get("qualificationStartedAt"),
      this.state.storage.get("providerConfig"),
      this.state.storage.get("providerHealth"),
      this.state.storage.get("qualificationFallbackRoute"),
      this.state.storage.get("qualificationParticipantSignature"),
    ]);
    if (route) this.route = route;
    if (Number.isSafeInteger(epoch)) this.epoch = epoch;
    if (Number.isSafeInteger(sourceRevision))
      this.sourceRevision = sourceRevision;
    if (pendingRoute) this.pendingRoute = pendingRoute;
    if (Number.isSafeInteger(pendingStartedAt))
      this.pendingStartedAt = pendingStartedAt;
    if (Array.isArray(publishedSources))
      this.publishedSources = new Map(
        publishedSources.map((publication) => [
          `${publication.peerId}:${publication.source}`,
          publication,
        ]),
      );
    if (typeof qualifiedParticipantSignature === "string")
      this.qualifiedParticipantSignature = qualifiedParticipantSignature;
    if (Number.isSafeInteger(qualificationStartedAt))
      this.qualificationStartedAt = qualificationStartedAt;
    if (providerConfig && typeof providerConfig === "object")
      this.providerConfig = providerConfig;
    if (providerHealth && typeof providerHealth === "object")
      this.providerHealth = new Map(Object.entries(providerHealth));
    if (
      qualificationFallbackRoute?.kind === MEDIA_ROUTE_KIND.SFU &&
      qualificationFallbackRoute.provider
    )
      this.qualificationFallbackRoute = qualificationFallbackRoute;
    if (typeof qualificationParticipantSignature === "string")
      this.qualificationParticipantSignature =
        qualificationParticipantSignature;
    const hasPersistedRoomState = Boolean(
      route ||
      (Number.isSafeInteger(epoch) && epoch > 0) ||
      (Number.isSafeInteger(sourceRevision) && sourceRevision > 0) ||
      pendingRoute ||
      pendingStartedAt ||
      publishedSources?.length ||
      providerConfig ||
      providerHealth,
    );
    const sockets = this.state.getWebSockets?.() || [];
    for (const ws of sockets) this.getSession(ws);
    if (
      hasPersistedRoomState &&
      !sockets.length &&
      this.participants.size === 0
    )
      await this.resetDormantRoomState();
    this.stateLoaded = true;
  }

  async resetDormantRoomState() {
    this.sourceRevision++;
    this.epoch = Math.max(this.epoch, Number(this.route.epoch) || 0) + 1;
    this.route = createLocalRoute(
      this.epoch,
      this.sourceRevision,
      "room-rehydrated",
    );
    this.pendingRoute = null;
    this.pendingStartedAt = 0;
    this.publishedSources.clear();
    this.providerHealth.clear();
    this.providerConfig = null;
    this.qualifiedParticipantSignature = null;
    this.qualificationStartedAt = 0;
    this.qualificationFallbackRoute = null;
    this.qualificationParticipantSignature = null;
    this.qoeMetrics.clear();
    await Promise.all([
      this.state.storage.put("route", this.route),
      this.state.storage.put("epoch", this.epoch),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put("publishedSources", []),
      this.state.storage.put("providerHealth", {}),
      this.state.storage.put("qualifiedParticipantSignature", null),
      this.state.storage.put("qualificationStartedAt", 0),
      this.state.storage.delete("pendingRoute"),
      this.state.storage.delete("pendingStartedAt"),
      this.state.storage.delete("providerConfig"),
      this.state.storage.delete("qualificationFallbackRoute"),
      this.state.storage.delete("qualificationParticipantSignature"),
    ]);
  }

  getSession(ws) {
    const current = this.sessions.get(ws);
    if (current) return current;
    const restored = ws.deserializeAttachment?.();
    if (!restored) return restored;
    if (restored.authenticated) {
      const participantKey = `${restored.userId}:${restored.deviceId}`;
      const previousParticipant = this.participants.get(participantKey);
      if (!previousParticipant?.ws || previousParticipant.ws === ws) {
        this.participants.set(participantKey, {
          userId: restored.userId,
          deviceId: restored.deviceId,
          channelId: restored.channelId,
          peerId: restored.peerId,
          ws,
          sources: new Set(restored.sources || []),
          providerCapabilities: new Set(restored.providerCapabilities || []),
          muted: restored.muted !== false,
          deafened: restored.deafened === true,
          joinedAt: restored.joinedAt || Date.now(),
        });
        if (Array.isArray(restored.qualifiedPeerIds))
          this.qualificationState.set(restored.peerId, {
            qualifiedPeers: new Set(restored.qualifiedPeerIds),
            ready: true,
          });
        if (
          restored.providerReadyEpoch === this.pendingRoute?.epoch &&
          restored.providerReadySourceRevision ===
            this.pendingRoute?.sourceRevision
        )
          this.providerReadiness.add(restored.peerId);
      }
    }
    this.sessions.set(ws, restored);
    return restored;
  }

  sendMessage(ws, type, data = {}) {
    if (
      !ws ||
      (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN)
    )
      return false;
    try {
      ws.send(JSON.stringify({ type, data }));
      return true;
    } catch (error) {
      mediaDebug(this.env, "room.send-failed", { type, error });
      return false;
    }
  }

  sendTopology(ws, extra = {}) {
    const pending = this.pendingRoute;
    const qualificationFallbackProvider =
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.reason === "qualifying-direct"
        ? this.qualificationFallbackRoute?.provider
        : undefined;
    const qualificationFallbackProviderId =
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.reason === "qualifying-direct"
        ? this.qualificationFallbackRoute?.providerId
        : undefined;
    const mode = pending
      ? "switching"
      : this.route.kind === MEDIA_ROUTE_KIND.LOCAL
        ? "idle"
        : this.route.kind === MEDIA_ROUTE_KIND.P2P
          ? this.route.reason === "qualifying-direct"
            ? "probing"
            : "p2p"
          : "sfu";
    this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_STATE, {
      route: this.route,
      mode,
      epoch: pending?.epoch || this.epoch,
      preparedEpoch: pending?.epoch || this.epoch,
      provider:
        pending?.provider ||
        this.route.provider ||
        qualificationFallbackProvider,
      providerId:
        pending?.providerId ||
        this.route.providerId ||
        qualificationFallbackProviderId,
      reason: pending?.reason || this.route.reason,
      target: pending ? "sfu" : undefined,
      targetProvider: pending?.provider,
      targetProviderId: pending?.providerId,
      targetRoute: pending || undefined,
      sourceRevision: this.sourceRevision,
      participants: this.getParticipantList(),
      peers: this.getParticipantList(),
      ...extra,
    });
  }

  broadcastTopology() {
    for (const [ws, session] of this.sessions)
      if (session.authenticated && ws.readyState === WebSocket.OPEN)
        this.sendTopology(ws);
  }

  async relayP2PSignal(fromSession, data, ws) {
    const sender = this.participants.get(
      `${fromSession.userId}:${fromSession.deviceId}`,
    );
    const epoch = Number(data?.epoch);
    const targetPeerId = String(data?.targetPeerId || "");
    if (
      !sender ||
      sender.ws !== ws ||
      !Number.isSafeInteger(epoch) ||
      epoch !== this.epoch ||
      this.route.kind !== MEDIA_ROUTE_KIND.P2P ||
      this.route.path !== "direct" ||
      !targetPeerId ||
      !data.signal ||
      typeof data.signal !== "object"
    )
      return;
    for (const [ws, session] of this.sessions) {
      if (
        String(session.peerId) === targetPeerId &&
        session.authenticated &&
        this.isCurrentParticipantSession(ws, session)
      ) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL, {
          fromPeerId: fromSession.peerId,
          epoch,
          signal: data.signal,
        });
        break;
      }
    }
  }

  isCurrentParticipantSession(ws, session) {
    if (!session?.authenticated) return false;
    const participant = this.participants.get(
      `${session.userId}:${session.deviceId}`,
    );
    const registered = this.sessions.get(ws);
    return (
      participant?.ws === ws &&
      participant.peerId === session.peerId &&
      (!registered || registered === session)
    );
  }

  replaceParticipantSession(participantKey, previousParticipant, nextWs) {
    if (!previousParticipant || previousParticipant.ws === nextWs) return;
    const previousWs = previousParticipant.ws;
    const previousSession = previousWs
      ? this.sessions.get(previousWs) || previousWs.deserializeAttachment?.()
      : null;
    const previousPeerId =
      previousParticipant.peerId || previousSession?.peerId || null;
    if (previousWs) this.sessions.delete(previousWs);
    if (previousPeerId) {
      this.qualificationState.delete(previousPeerId);
      this.providerReadiness.delete(previousPeerId);
      this.transitionReadiness.delete(previousPeerId);
      this.qoeMetrics.delete(previousPeerId);
      this.retireParticipantPublications(previousPeerId);
    }
    this.qualifiedParticipantSignature = null;
    this.sourceRevision++;
    void Promise.all([
      this.state.storage.put("publishedSources", [
        ...this.publishedSources.values(),
      ]),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put(
        "qualifiedParticipantSignature",
        this.qualifiedParticipantSignature,
      ),
    ]);
    try {
      previousWs?.close(4000, "Media session superseded");
    } catch {}
    mediaDebug(this.env, "room.participant-session-replaced", {
      participantKey,
      previousPeerId,
      sourceRevision: this.sourceRevision,
    });
    void this.refreshPendingRouteSourceRevision();
  }

  retireParticipantPublications(peerId) {
    const retired = [];
    for (const [key, publication] of this.publishedSources) {
      if (publication.peerId !== peerId) continue;
      this.publishedSources.delete(key);
      retired.push({ ...publication, closed: true });
    }
    for (const publication of retired)
      for (const participant of this.participants.values())
        if (participant.peerId !== peerId && participant.ws)
          this.sendMessage(
            participant.ws,
            MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
            publication,
          );
    return retired;
  }

  getConfiguredProviderCapabilities() {
    return getConfiguredProviderCapabilities(this);
  }

  getCommonProviderCapabilities() {
    return getCommonProviderCapabilities(this);
  }

  getAvailableProviderCapabilities() {
    return getAvailableProviderCapabilities(this);
  }

  getNextProviderRecoveryAt(now = Date.now()) {
    return getNextProviderRecoveryAt(this, now);
  }

  getProviderRecoveryTarget(now = Date.now()) {
    return getProviderRecoveryTarget(this, now);
  }

  scheduleProviderRecovery(now = Date.now()) {
    return scheduleProviderRecovery(this, now);
  }

  getQoeCandidates() {
    return getQoeCandidates(this);
  }

  beginTransition(...args) {
    return beginTransition(this, ...args);
  }

  handleProviderFailure(...args) {
    return handleProviderFailure(this, ...args);
  }

  handleP2PFailure(...args) {
    return handleP2PFailure(this, ...args);
  }

  handleCloudflareRequest(...args) {
    return handleCloudflareRequest(this, ...args);
  }

  issueProviderTickets(...args) {
    return issueProviderTickets(this, ...args);
  }

  issueProviderTicket(...args) {
    return issueProviderTicket(this, ...args);
  }

  refreshPendingRouteSourceRevision() {
    const refresh = async () => {
      let refreshed = false;
      while (
        this.pendingRoute &&
        Number(this.pendingRoute.sourceRevision) !== this.sourceRevision
      ) {
        const previousRoute = this.pendingRoute;
        const nextRoute = {
          ...previousRoute,
          sourceRevision: this.sourceRevision,
        };
        this.pendingRoute = nextRoute;
        this.pendingStartedAt = Date.now();
        this.providerReadiness.clear();
        this.transitionReadiness.clear();
        for (const [ws, session] of this.sessions) {
          session.providerReadyEpoch = null;
          session.providerReadySourceRevision = null;
          ws.serializeAttachment?.(session);
        }
        await Promise.all([
          this.state.storage.put("pendingRoute", nextRoute),
          this.state.storage.put("pendingStartedAt", this.pendingStartedAt),
        ]);
        this.broadcastTopology();
        if (
          nextRoute.provider === SFU_PROVIDER.MEDIASOUP &&
          this.pendingRoute === nextRoute
        )
          try {
            await this.issueProviderTickets(nextRoute);
          } catch (error) {
            mediaDebug(this.env, "room.pending-route-refresh-failed", {
              provider: nextRoute.provider,
              epoch: nextRoute.epoch,
              sourceRevision: nextRoute.sourceRevision,
              error,
            });
            void this.state.storage.setAlarm?.(Date.now() + 1_000);
          }
        refreshed = true;
      }
      return refreshed;
    };
    const task = (this.pendingRouteRefresh || Promise.resolve())
      .catch(() => {})
      .then(refresh);
    const tracked = task.finally(() => {
      if (this.pendingRouteRefresh === tracked) this.pendingRouteRefresh = null;
    });
    this.pendingRouteRefresh = tracked;
    tracked.catch(() => {});
    return tracked;
  }

  createProviderTicket(...args) {
    return createProviderTicket(this, ...args);
  }

  maybeStartQualification() {
    return maybeStartQualification(this);
  }

  maybeCommitPendingRoute() {
    return maybeCommitPendingRoute(this);
  }

  checkQualificationComplete() {
    return checkQualificationComplete(this);
  }

  restoreQualificationRoute(...args) {
    return restoreQualificationRoute(this, ...args);
  }

  commitRoute(route) {
    return commitRoute(this, route);
  }

  validateRoute(route, mode) {
    return validateRouteForMode(route, mode);
  }

  createInitialRoute(reason) {
    return createLocalRoute(1, this.sourceRevision, reason);
  }

  getParticipantSignature() {
    return [...this.participants.values()]
      .map((participant) => participant.peerId)
      .sort()
      .join(",");
  }

  getParticipantList() {
    return [...this.participants.values()].map((participant) => ({
      peerId: participant.peerId,
      userId: participant.userId,
      deviceId: participant.deviceId,
      sources: [...participant.sources],
      muted: participant.muted !== false,
      deafened: participant.deafened === true,
    }));
  }

  getConnectionMode() {
    for (const session of this.sessions.values())
      if (session.authenticated) return session.connectionMode;
    return "auto";
  }

  getRoomId() {
    for (const session of this.sessions.values())
      if (session.authenticated && session.channelId) return session.channelId;
    return "unknown";
  }

  async verifyMediaTicket(ticket) {
    return verifyRoomTicket(this, ticket);
  }

  async handleMessage(ws, session, envelope) {
    return handleRoomMessage(this, ws, session, envelope);
  }

  handleDisconnect(ws, session) {
    this.sessions.delete(ws);
    if (session.authenticated) {
      const participant = this.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      if (participant?.ws === ws) {
        participant.ws = null;
        participant.disconnectedAt = Date.now();
        this.startControlLeaseTimer();
      }
    }
    if (this.sessions.size === 0 && this.participants.size === 0)
      this.stopControlLeaseTimer();
  }

  async finalizeParticipantDisconnect(participantKey, participant) {
    if (!this.participants.delete(participantKey)) return;
    this.sourceRevision++;
    this.qualifiedParticipantSignature = null;
    this.qualificationState.delete(participant.peerId);
    this.providerReadiness.delete(participant.peerId);
    this.transitionReadiness.delete(participant.peerId);
    this.retireParticipantPublications(participant.peerId);
    void Promise.all([
      this.state.storage.put("publishedSources", [
        ...this.publishedSources.values(),
      ]),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put(
        "qualifiedParticipantSignature",
        this.qualifiedParticipantSignature,
      ),
    ]);
    await this.refreshPendingRouteSourceRevision();
    if (this.participants.size < 2) {
      void this.commitRoute(
        createLocalRoute(
          this.epoch + 1,
          this.sourceRevision,
          "participant-left",
        ),
      ).then(() => this.maybeStartQualification());
    } else if (this.route.kind === MEDIA_ROUTE_KIND.P2P) {
      this.maybeStartQualification();
    } else {
      this.maybeStartQualification();
      if (this.pendingRoute) void this.maybeCommitPendingRoute();
    }
  }

  startControlLeaseTimer() {
    void this.state.storage.setAlarm?.(
      Date.now() + CONTROL_HEARTBEAT_INTERVAL_MS,
    );
  }

  stopControlLeaseTimer() {
    void this.state.storage.deleteAlarm?.();
  }
}
