import {
  MEDIA_CONTROL_PROTOCOL_VERSION,
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_CONTROL_SERVER_HELLO,
  MEDIA_CONTROL_CLIENT_HELLO,
  ROOM_STATE,
  MEDIA_ROUTE_KIND,
  P2P_PATH,
  SFU_PROVIDER,
  CONTROL_HEARTBEAT_INTERVAL_MS,
  CONTROL_HEARTBEAT_TIMEOUT_MS,
  MEDIA_PROVIDER_PROTOCOL_REVISION,
  createLocalRoute,
  createP2PRoute,
  createSFURoute,
  validateRouteForMode,
  compareRouteEpoch,
  chooseAvailableProvider,
  checkP2PEligibility,
} from "./protocol.js";
import { verifyMediaTicket } from "./tickets.js";
import { normalizeQoePath, qoeWouldImprove, rankQoeCandidates } from "./qoe.ts";

const P2P_QUALIFICATION_STABILITY_MS = 2_000;
const PROVIDER_FAILURE_COOLDOWN_MS = 30_000;
const MAX_CONTROL_MESSAGE_BYTES = 96 * 1024;
const MAX_MEDIA_SOURCES = 8;
const MAX_MEDIA_SOURCE_LENGTH = 32;

export function controlMessageByteLength(message) {
  if (typeof message === "string")
    return new TextEncoder().encode(message).byteLength;
  return Number(message?.byteLength) || 0;
}

export function normalizeMediaSources(value) {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_SOURCES) return null;
  const sources = [];
  const seen = new Set();
  for (const source of value) {
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > MAX_MEDIA_SOURCE_LENGTH ||
      !/^[a-z][a-z0-9-]*$/.test(source)
    )
      return null;
    if (!seen.has(source)) {
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}

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
    this.controlLeaseTimer = null;
    this.stateLoaded = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const forwardedChannelId = request.headers.get("X-dSpeak-Channel-Id");
    if (forwardedChannelId) this.channelId ||= forwardedChannelId;
    await this.loadDurableState();

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.isAllowedWebSocketOrigin(request))
        return new Response("WebSocket origin is not allowed", { status: 403 });
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
      providerCapabilities: [
        SFU_PROVIDER.CLOUDFLARE_REALTIME,
        SFU_PROVIDER.MEDIASOUP,
      ],
      sources: [],
      joinedAt: Date.now(),
    };

    this.state.acceptWebSocket(ws);
    ws.serializeAttachment(session);
    this.sessions.set(ws, session);
    void this.state.storage.setAlarm?.(
      Date.now() + CONTROL_HEARTBEAT_INTERVAL_MS,
    );
    ws.send(
      JSON.stringify({
        type: MEDIA_CONTROL_SERVER_HELLO,
        data: {
          protocolVersion: MEDIA_CONTROL_PROTOCOL_VERSION,
          contractRevision: 2,
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
      await this.handleMessage(ws, session, data);
    } catch (error) {
      console.error("[MediaRoomDO] Message parse error:", error);
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
        this.finalizeParticipantDisconnect(participantKey, participant);
    if (sockets.length > 0 || this.participants.size > 0)
      await this.state.storage.setAlarm?.(now + CONTROL_HEARTBEAT_INTERVAL_MS);
    if (
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.reason === "qualifying-direct"
    )
      this.checkQualificationComplete();
    if (this.pendingRoute && now - this.pendingStartedAt > 15_000)
      await this.handleProviderFailure(
        this.pendingRoute.provider,
        "provider-prepare-timeout",
      );
  }

  async handleMessage(ws, session, envelope) {
    const data =
      envelope?.data && typeof envelope.data === "object"
        ? envelope.data
        : envelope;
    const type = envelope?.type;
    const now = Date.now();
    session.lastHeartbeat = now;

    if (!session.authenticated) {
      if (type !== MEDIA_CONTROL_CLIENT_HELLO) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          error: "Authentication required",
        });
        ws.close(1008, "Authentication required");
        return;
      }

      const verified = await this.verifyMediaTicket(data.ticket);
      if (!verified.valid) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          error: verified.error,
        });
        ws.close(1008, verified.error);
        return;
      }

      if (
        Number(data.protocolVersion) !== MEDIA_CONTROL_PROTOCOL_VERSION ||
        Number(data.contractRevision) !== 2 ||
        data.mediaSessionId !== session.mediaSessionId
      ) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          error: "Media control protocol mismatch",
        });
        ws.close(4002, "Media client update required");
        return;
      }

      const claims = verified.claims;
      if (this.channelId && claims.channelId !== this.channelId) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          error: "Media ticket channel mismatch",
        });
        ws.close(4003, "Media ticket channel mismatch");
        return;
      }
      session.authenticated = true;
      session.userId = claims.sub;
      session.deviceId = claims.deviceId;
      session.channelId = claims.channelId;
      session.connectionMode = claims.connectionMode || "auto";
      session.routeEpoch = claims.routeEpoch || 0;
      session.providerCapabilities = Array.isArray(data.providerCapabilities)
        ? data.providerCapabilities.filter((provider) =>
            [SFU_PROVIDER.CLOUDFLARE_REALTIME, SFU_PROVIDER.MEDIASOUP].includes(
              provider,
            ),
          )
        : [SFU_PROVIDER.MEDIASOUP];
      ws.serializeAttachment(session);

      const participantKey = `${claims.sub}:${claims.deviceId}`;
      if (this.participants.size === 0 && this.epoch === 0)
        this.commitRoute(
          createLocalRoute(1, this.sourceRevision, "room-ready"),
        );
      const resumedParticipant = this.participants.get(participantKey);
      this.participants.set(participantKey, {
        userId: claims.sub,
        deviceId: claims.deviceId,
        channelId: claims.channelId,
        peerId: session.peerId,
        ws,
        sources: new Set(resumedParticipant?.sources || []),
        providerCapabilities: new Set(session.providerCapabilities),
        joinedAt: resumedParticipant?.joinedAt || now,
        disconnectedAt: null,
      });

      this.sendMessage(ws, "connected", { peerId: session.peerId });
      if (this.participants.size === 1 && this.epoch === 0)
        await this.commitRoute(
          createLocalRoute(1, this.sourceRevision, "single-participant"),
        );
      else this.sendTopology(ws);
      for (const publication of this.publishedSources.values())
        if (publication.peerId !== session.peerId)
          this.sendMessage(
            ws,
            MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
            publication,
          );
      if (this.pendingRoute)
        await this.issueProviderTicket(
          this.participants.get(participantKey),
          this.pendingRoute,
        );

      this.maybeStartQualification();
      return;
    }

    switch (type) {
      case MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT: {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK, {
          sequence: data.sequence,
          timestamp: now,
        });
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL: {
        await this.relayP2PSignal(session, data);
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY:
      case MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_VOICE_STATE:
        break;

      case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES: {
        const participantKey = `${session.userId}:${session.deviceId}`;
        const participant = this.participants.get(participantKey);
        if (participant) {
          const sources = normalizeMediaSources(data.sources);
          if (!sources) {
            this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
              code: "INVALID_MEDIA_SOURCES",
              error: "Media source identifiers are invalid",
            });
            break;
          }
          participant.sources = new Set(sources);
          session.sources = [...participant.sources];
          ws.serializeAttachment(session);
          this.maybeStartQualification();
          this.sourceRevision++;
          this.broadcastTopology();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED: {
        if (Number(data.epoch) !== this.epoch) break;
        const participantKey = `${session.userId}:${session.deviceId}`;
        const participant = this.participants.get(participantKey);
        if (participant) {
          this.qualificationState.set(session.peerId, {
            qualifiedPeers: new Set(
              data.qualifiedPeerIds || data.qualifiedPeers || [],
            ),
            candidateReports: Array.isArray(data.candidateReports)
              ? data.candidateReports
              : [],
            ready: true,
          });
          session.qualifiedPeerIds = [
            ...(data.qualifiedPeerIds || data.qualifiedPeers || []),
          ];
          ws.serializeAttachment(session);
          this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED, {
            epoch: this.epoch,
            acknowledged: true,
            qualifiedPeerIds: [
              ...this.qualificationState.get(session.peerId).qualifiedPeers,
            ],
          });
          this.checkQualificationComplete();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED: {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED, {
          epoch: Number(data.epoch) || this.epoch,
          acknowledged: true,
          failed: true,
          reason: data.reason || "p2p-failed",
        });
        this.handleP2PFailure(session, data.reason);
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE: {
        const participant = this.participants.get(
          `${session.userId}:${session.deviceId}`,
        );
        if (participant && Array.isArray(data.paths)) {
          const provider = String(data.provider || "");
          const key = participant.peerId;
          const previous = this.qoeMetrics.get(key);
          this.qoeMetrics.set(key, {
            provider,
            paths: data.paths
              .slice(0, 32)
              .map((path) => normalizeQoePath(path)),
            sampledAt: Number(data.sampledAt) || Date.now(),
            stableSince:
              previous?.provider === provider
                ? previous.stableSince
                : Date.now(),
          });
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_READY: {
        if (
          this.pendingRoute &&
          Number(data.epoch) === this.pendingRoute.epoch &&
          data.provider === this.pendingRoute.provider
        ) {
          this.providerReadiness.add(session.peerId);
          session.providerReadyEpoch = Number(data.epoch);
          ws.serializeAttachment(session);
          this.providerHealth.set(data.provider, {
            healthy: true,
            epoch: Number(data.epoch),
            unhealthyUntil: 0,
            updatedAt: Date.now(),
          });
          void this.state.storage.put(
            "providerHealth",
            Object.fromEntries(this.providerHealth),
          );
          const expected = new Set(
            [...this.participants.values()].map((entry) => entry.peerId),
          );
          if (
            this.providerReadiness.size === expected.size &&
            [...this.providerReadiness].every((peerId) => expected.has(peerId))
          )
            await this.maybeCommitPendingRoute();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_READY: {
        if (
          this.pendingRoute &&
          Number(data.epoch) === this.pendingRoute.epoch
        ) {
          this.transitionReadiness.add(session.peerId);
          await this.maybeCommitPendingRoute();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_FAILED: {
        if (this.pendingRoute && Number(data.epoch) === this.pendingRoute.epoch)
          await this.handleProviderFailure(
            this.pendingRoute.provider,
            data.reason || "provider-transition-failed",
          );
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE: {
        const failedPending =
          this.pendingRoute && Number(data.epoch) === this.pendingRoute.epoch;
        const failedActive =
          this.route.kind === MEDIA_ROUTE_KIND.SFU &&
          this.route.provider === data.provider &&
          Number(data.epoch) === this.route.epoch;
        if (failedPending || failedActive) {
          this.providerReadiness.clear();
          this.transitionReadiness.clear();
          await this.handleProviderFailure(
            data.provider,
            data.reason || "client-provider-failure",
          );
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_REQUEST: {
        await this.handleCloudflareRequest(ws, session, data);
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION: {
        if (session.cloudflareSessionId && data.trackName && data.source) {
          const publication = {
            sessionId: session.cloudflareSessionId,
            trackName: data.trackName,
            source: data.source,
            userId: session.userId,
            peerId: session.peerId,
            closed: data.closed === true,
          };
          const publicationKey = `${session.peerId}:${data.source}`;
          if (publication.closed) this.publishedSources.delete(publicationKey);
          else this.publishedSources.set(publicationKey, publication);
          void this.state.storage.put("publishedSources", [
            ...this.publishedSources.values(),
          ]);
          for (const participant of this.participants.values())
            if (participant.ws !== ws)
              this.sendMessage(
                participant.ws,
                MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
                publication,
              );
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.RESUME: {
        this.sendTopology(ws, { resumed: true });
        break;
      }

      default: {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          error: `Unknown message type: ${type}`,
        });
      }
    }
  }

  async verifyMediaTicket(ticket) {
    if (!ticket || typeof ticket !== "string") {
      return { valid: false, error: "Missing ticket" };
    }
    try {
      const claims = await verifyMediaTicket(ticket, this.env);
      if (!claims.sub || !claims.deviceId || !claims.channelId)
        return {
          valid: false,
          error: "Media ticket is missing required claims",
        };
      if (!["auto", "direct"].includes(claims.connectionMode || "auto"))
        return {
          valid: false,
          error: "Media ticket has an invalid connection mode",
        };
      return { valid: true, claims };
    } catch (error) {
      return { valid: false, error: error.message || "Invalid media ticket" };
    }
  }

  async handleCloudflareRequest(ws, session, data) {
    const requestId = data.requestId;
    const operation = data.operation;
    const appId = this.env.CLOUDFLARE_REALTIME_APP_ID;
    const appSecret = this.env.CLOUDFLARE_REALTIME_APP_SECRET;
    const sendResult = (result) =>
      this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_RESPONSE, {
        requestId,
        ...result,
      });
    const selectedProvider = this.pendingRoute?.provider || this.route.provider;
    if (selectedProvider !== SFU_PROVIDER.CLOUDFLARE_REALTIME) {
      sendResult({ error: "Cloudflare Realtime is not the active route" });
      return;
    }
    if (!requestId || !appId || !appSecret) {
      sendResult({ error: "Cloudflare Realtime is unavailable" });
      return;
    }
    const allowed = new Map([
      ["new-session", { method: "POST", suffix: "sessions/new" }],
      ["tracks-new", { method: "POST", suffix: "tracks/new" }],
      ["tracks-update", { method: "PUT", suffix: "tracks/update" }],
      ["tracks-close", { method: "PUT", suffix: "tracks/close" }],
      ["renegotiate", { method: "PUT", suffix: "renegotiate" }],
    ]);
    const selected = allowed.get(operation);
    if (!selected) {
      sendResult({ error: "Unsupported Cloudflare operation" });
      return;
    }
    if (operation !== "new-session" && !session.cloudflareSessionId) {
      sendResult({ error: "Cloudflare session is not initialized" });
      return;
    }
    if (operation === "tracks-new") {
      const remoteTracks = (data.body?.tracks || []).filter(
        (track) => track?.location === "remote",
      );
      const knownTracks = new Set(
        [...this.publishedSources.values()].map(
          (publication) => `${publication.sessionId}:${publication.trackName}`,
        ),
      );
      if (
        remoteTracks.some(
          (track) => !knownTracks.has(`${track.sessionId}:${track.trackName}`),
        )
      ) {
        sendResult({ error: "Cloudflare track is not published in this room" });
        return;
      }
    }
    const sessionPrefix =
      operation === "new-session"
        ? ""
        : `sessions/${encodeURIComponent(session.cloudflareSessionId)}/`;
    let response;
    try {
      response = await fetch(
        `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(appId)}/${sessionPrefix}${selected.suffix}`,
        {
          method: selected.method,
          headers: {
            Authorization: `Bearer ${appSecret}`,
            "Content-Type": "application/json",
          },
          body:
            operation === "new-session"
              ? undefined
              : JSON.stringify(data.body || {}),
        },
      );
    } catch {
      sendResult({ error: "Cloudflare Realtime request failed" });
      return;
    }
    const result = await response.json().catch(() => ({}));
    if (response.ok && operation === "new-session" && result.sessionId) {
      session.cloudflareSessionId = result.sessionId;
      ws.serializeAttachment(session);
    }
    sendResult(
      response.ok
        ? { result }
        : {
            error:
              result.errorDescription || `Cloudflare error ${response.status}`,
          },
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
    this.stateLoaded = true;
    for (const ws of this.state.getWebSockets?.() || []) this.getSession(ws);
  }

  getSession(ws) {
    const current = this.sessions.get(ws);
    if (current) return current;
    const restored = ws.deserializeAttachment?.();
    if (restored) {
      this.sessions.set(ws, restored);
      if (restored.authenticated) {
        const participantKey = `${restored.userId}:${restored.deviceId}`;
        this.participants.set(participantKey, {
          userId: restored.userId,
          deviceId: restored.deviceId,
          channelId: restored.channelId,
          peerId: restored.peerId,
          ws,
          sources: new Set(restored.sources || []),
          providerCapabilities: new Set(restored.providerCapabilities || []),
          joinedAt: restored.joinedAt || Date.now(),
        });
        if (Array.isArray(restored.qualifiedPeerIds))
          this.qualificationState.set(restored.peerId, {
            qualifiedPeers: new Set(restored.qualifiedPeerIds),
            ready: true,
          });
        if (restored.providerReadyEpoch === this.pendingRoute?.epoch)
          this.providerReadiness.add(restored.peerId);
      }
    }
    return restored;
  }

  sendMessage(ws, type, data = {}) {
    if (
      !ws ||
      (ws.readyState !== undefined && ws.readyState !== WebSocket.OPEN)
    )
      return;
    ws.send(JSON.stringify({ type, data }));
  }

  sendTopology(ws, extra = {}) {
    const pending = this.pendingRoute;
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
      provider: pending?.provider || this.route.provider,
      reason: pending?.reason || this.route.reason,
      target: pending ? "sfu" : undefined,
      targetProvider: pending?.provider,
      targetRoute: pending || undefined,
      sourceRevision: this.sourceRevision,
      participants: this.getParticipantList(),
      peers: this.getParticipantList(),
      ...extra,
    });
  }

  async relayP2PSignal(fromSession, data) {
    const targetPeerId = data.targetPeerId;
    if (!targetPeerId) return;

    for (const [ws, session] of this.sessions) {
      if (session.peerId === targetPeerId && session.authenticated) {
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL, {
          peerId: fromSession.peerId,
          ...data.signal,
        });
        break;
      }
    }
  }

  handleP2PFailure(session, reason) {
    if (
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.path === P2P_PATH.DIRECT
    ) {
      if (this.getConnectionMode() === "direct") {
        this.sendMessage(session.ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "DIRECT_MEDIA_UNAVAILABLE",
          error: "Direct media connection failed",
        });
        return;
      }
      void this.beginTransition(SFU_PROVIDER.MEDIASOUP, `p2p-failed-${reason}`);
    }
  }

  async handleProviderFailure(provider, reason) {
    const epoch = this.pendingRoute?.epoch || this.route.epoch;
    this.providerHealth.set(provider, {
      healthy: false,
      reason,
      epoch,
      unhealthyUntil: Date.now() + PROVIDER_FAILURE_COOLDOWN_MS,
      updatedAt: Date.now(),
    });
    await this.state.storage.put(
      "providerHealth",
      Object.fromEntries(this.providerHealth),
    );
    for (const participant of this.participants.values())
      this.sendMessage(
        participant.ws,
        MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE,
        {
          provider,
          epoch,
          reason,
        },
      );
    const registryNamespace = this.env.PROVIDER_REGISTRY_DO;
    if (registryNamespace) {
      const registryId = registryNamespace.idFromName("global");
      const registry = registryNamespace.get(registryId);
      await registry.fetch(
        new Request("https://registry/report-failure", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.MEDIA_CONTROL_ADMIN_TOKEN || ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            providerId:
              provider === SFU_PROVIDER.CLOUDFLARE_REALTIME
                ? "cloudflare-realtime-primary"
                : "selfhost-primary",
            error: reason,
          }),
        }),
      );
    }
    const alternate =
      provider === SFU_PROVIDER.CLOUDFLARE_REALTIME
        ? SFU_PROVIDER.MEDIASOUP
        : SFU_PROVIDER.CLOUDFLARE_REALTIME;
    if (this.pendingRoute?.provider === provider) {
      this.pendingRoute = null;
      this.pendingStartedAt = 0;
      this.providerReadiness.clear();
      this.transitionReadiness.clear();
      void Promise.all([
        this.state.storage.delete("pendingRoute"),
        this.state.storage.delete("pendingStartedAt"),
      ]);
    }
    await this.beginTransition(
      alternate,
      `provider-failed-${reason}`,
      provider,
    );
  }

  maybeStartQualification() {
    const participantCount = this.participants.size;
    if (participantCount === 0) return;
    const hasVideo = [...this.participants.values()].some((participant) =>
      [...participant.sources].some((source) =>
        ["camera", "screen"].includes(String(source)),
      ),
    );
    const connectionMode = this.getConnectionMode();
    const eligibility = checkP2PEligibility({
      connectionMode,
      participantCount,
      hasVideo,
      requiredSources: [...this.publishedSources.values()].map(
        (source) => source.source,
      ),
    });
    if (!eligibility.eligible) {
      if (connectionMode === "direct") {
        const latest = [...this.sessions.values()].find(
          (session) => session.authenticated,
        );
        this.sendMessage(latest?.ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code:
            eligibility.reason === "server-source-requires-auto-mode"
              ? "DIRECT_MEDIA_UNAVAILABLE"
              : "DIRECT_PARTICIPANT_LIMIT_EXCEEDED",
          error: "Direct mode supports fewer participants for this media mix",
        });
        return;
      }
      if (
        !this.pendingRoute &&
        (this.route.kind !== MEDIA_ROUTE_KIND.SFU ||
          this.route.provider !== SFU_PROVIDER.CLOUDFLARE_REALTIME)
      )
        void this.beginTransition(SFU_PROVIDER.CLOUDFLARE_REALTIME);
      return;
    }
    if (participantCount === 1) {
      if (
        connectionMode === "auto" &&
        !this.pendingRoute &&
        this.route.kind === MEDIA_ROUTE_KIND.LOCAL
      )
        void this.beginTransition(SFU_PROVIDER.CLOUDFLARE_REALTIME);
      return;
    }

    if (
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.reason === "qualified-direct-mesh" &&
      this.qualifiedParticipantSignature === this.getParticipantSignature()
    )
      return;

    if (this.pendingRoute) {
      this.pendingRoute = null;
      this.pendingStartedAt = 0;
      this.epoch += 1;
      this.providerReadiness.clear();
      this.transitionReadiness.clear();
      void Promise.all([
        this.state.storage.put("epoch", this.epoch),
        this.state.storage.delete("pendingRoute"),
        this.state.storage.delete("pendingStartedAt"),
      ]);
    }

    const allReady = [...this.participants.values()].every(
      (p) => p.ws?.readyState === WebSocket.OPEN,
    );
    if (!allReady) return;

    this.route = createP2PRoute(
      P2P_PATH.DIRECT,
      ++this.epoch,
      this.sourceRevision,
      "qualifying-direct",
    );
    this.qualificationStartedAt = Date.now();
    void this.state.storage.put(
      "qualificationStartedAt",
      this.qualificationStartedAt,
    );
    this.transitionGeneration++;

    for (const participant of this.participants.values()) {
      this.sendMessage(
        participant.ws,
        MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_STATE,
        {
          route: this.route,
          epoch: this.epoch,
          sourceRevision: this.sourceRevision,
          action: "qualify-p2p",
        },
      );
    }
  }

  async maybeCommitPendingRoute() {
    if (!this.pendingRoute) return;
    const expected = new Set(
      [...this.participants.values()].map((participant) => participant.peerId),
    );
    if (
      this.providerReadiness.size === expected.size &&
      [...this.providerReadiness].every((peerId) => expected.has(peerId)) &&
      this.transitionReadiness.size === expected.size &&
      [...this.transitionReadiness].every((peerId) => expected.has(peerId))
    )
      await this.commitRoute(this.pendingRoute);
  }

  checkQualificationComplete() {
    const expectedPeers = new Set(
      [...this.participants.values()].map((p) => p.peerId),
    );
    let allQualified = this.qualificationState.size === expectedPeers.size;

    for (const [peerId, state] of this.qualificationState) {
      if (!expectedPeers.has(peerId)) {
        allQualified = false;
        break;
      }
      if (!state.ready) {
        allQualified = false;
        break;
      }
      const qualified = state.qualifiedPeers;
      const expectedForPeer = new Set(expectedPeers);
      expectedForPeer.delete(peerId);
      if (qualified.size !== expectedForPeer.size) {
        allQualified = false;
        break;
      }
      for (const qualifiedPeerId of qualified)
        if (!expectedForPeer.has(qualifiedPeerId)) {
          allQualified = false;
          break;
        }
      if (!allQualified) break;
    }

    if (allQualified && this.participants.size >= 2) {
      if (
        Date.now() - this.qualificationStartedAt <
        P2P_QUALIFICATION_STABILITY_MS
      ) {
        void this.state.storage.setAlarm?.(
          this.qualificationStartedAt + P2P_QUALIFICATION_STABILITY_MS,
        );
        return;
      }
      const candidateReports = [...this.qualificationState.values()].flatMap(
        (state) => state.candidateReports || [],
      );
      const p2pCandidate = rankQoeCandidates([
        {
          provider: "p2p",
          paths: candidateReports,
          stableSince: this.qualificationStartedAt,
        },
      ])[0];
      const activeProvider =
        this.route.kind === MEDIA_ROUTE_KIND.SFU ? this.route.provider : null;
      const activeCandidate = rankQoeCandidates(this.getQoeCandidates()).find(
        (candidate) => candidate.provider === activeProvider,
      );
      if (
        activeCandidate &&
        (!p2pCandidate.paths.every((path) => path.rttMs != null) ||
          !qoeWouldImprove(activeCandidate, p2pCandidate, Date.now()))
      ) {
        void this.state.storage.setAlarm?.(Date.now() + 1_000);
        return;
      }
      this.commitRoute(
        createP2PRoute(
          P2P_PATH.DIRECT,
          this.epoch,
          this.sourceRevision,
          "qualified-direct-mesh",
        ),
      );
    }
  }

  async beginTransition(targetProvider, reason, excludedProvider = null) {
    if (this.pendingRoute || this.transitionInFlight) return;
    this.transitionInFlight = true;
    let selectedProvider = targetProvider;
    let selectedProviderConfig = null;
    let registrySelectionSucceeded = false;
    const registryNamespace = this.env.PROVIDER_REGISTRY_DO;
    if (registryNamespace) {
      try {
        const registryId = registryNamespace.idFromName("global");
        const registry = registryNamespace.get(registryId);
        const response = await registry.fetch(
          new Request("https://registry/select", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.MEDIA_CONTROL_ADMIN_TOKEN || ""}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              roomId: this.getRoomId(),
              connectionMode: this.getConnectionMode(),
              participantCount: this.participants.size,
              hasVideo: [...this.participants.values()].some((participant) =>
                [...participant.sources].some((source) =>
                  String(source).includes("video"),
                ),
              ),
              requiredSources: [],
              excludedProvider,
              qoeCandidates: this.getQoeCandidates(),
            }),
          }),
        );
        if (response.ok) {
          const selection = await response.json();
          selectedProvider = selection.route?.provider || selectedProvider;
          selectedProviderConfig = selection.provider || null;
          registrySelectionSucceeded = true;
        }
      } catch {}
    }
    const availableProviders = this.getAvailableProviderCapabilities();
    if (
      !registrySelectionSucceeded &&
      selectedProvider === SFU_PROVIDER.MEDIASOUP
    )
      availableProviders.delete(SFU_PROVIDER.MEDIASOUP);
    selectedProvider = chooseAvailableProvider({
      requestedProvider: selectedProvider,
      availableProviders,
      excludedProvider,
      registrySelectionSucceeded,
    });
    if (!selectedProvider) {
      this.transitionInFlight = false;
      for (const participant of this.participants.values())
        this.sendMessage(participant.ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
          code: "MEDIA_PROVIDER_UNAVAILABLE",
          error: "No eligible media provider is available; recovering media",
          reason,
        });
      return;
    }
    this.providerConfig = selectedProviderConfig;
    void this.state.storage.put("providerConfig", this.providerConfig);
    const targetRoute =
      selectedProvider === SFU_PROVIDER.MEDIASOUP
        ? createSFURoute(
            SFU_PROVIDER.MEDIASOUP,
            this.epoch + 1,
            this.sourceRevision,
            reason,
          )
        : createSFURoute(
            SFU_PROVIDER.CLOUDFLARE_REALTIME,
            this.epoch + 1,
            this.sourceRevision,
            reason,
          );

    this.pendingRoute = targetRoute;
    this.pendingStartedAt = Date.now();
    void Promise.all([
      this.state.storage.put("pendingRoute", targetRoute),
      this.state.storage.put("pendingStartedAt", this.pendingStartedAt),
    ]);
    this.providerReadiness.clear();
    this.transitionReadiness.clear();
    this.route = {
      ...this.route,
      reason: `transitioning-to-${selectedProvider}`,
    };

    this.broadcastTopology();

    try {
      await this.issueProviderTickets(targetRoute);
    } catch (error) {
      this.transitionInFlight = false;
      await this.handleProviderFailure(
        selectedProvider,
        `provider-ticket-${error?.message || "failed"}`,
      );
      return;
    }
    this.transitionInFlight = false;
  }

  getCommonProviderCapabilities() {
    const participants = [...this.participants.values()];
    if (!participants.length)
      return new Set([
        SFU_PROVIDER.CLOUDFLARE_REALTIME,
        SFU_PROVIDER.MEDIASOUP,
      ]);
    return new Set(
      [SFU_PROVIDER.CLOUDFLARE_REALTIME, SFU_PROVIDER.MEDIASOUP].filter(
        (provider) =>
          participants.every((participant) =>
            participant.providerCapabilities?.has(provider),
          ),
      ),
    );
  }

  getAvailableProviderCapabilities() {
    const available = this.getCommonProviderCapabilities();
    const now = Date.now();
    for (const provider of available) {
      const health = this.providerHealth.get(provider);
      if (health?.healthy === false && Number(health.unhealthyUntil) > now)
        available.delete(provider);
    }
    return available;
  }

  getQoeCandidates() {
    const grouped = new Map();
    for (const report of this.qoeMetrics.values()) {
      const provider =
        report.provider === "sfu"
          ? this.route.provider || SFU_PROVIDER.CLOUDFLARE_REALTIME
          : report.provider;
      if (
        ![
          "p2p",
          SFU_PROVIDER.CLOUDFLARE_REALTIME,
          SFU_PROVIDER.MEDIASOUP,
        ].includes(provider)
      )
        continue;
      const candidate = grouped.get(provider) || {
        id: provider,
        provider,
        paths: [],
        readyParticipants: 0,
        requiredParticipants: this.participants.size,
        stableSince: report.stableSince,
      };
      candidate.paths.push(...report.paths);
      candidate.readyParticipants += 1;
      candidate.stableSince = Math.min(
        candidate.stableSince || report.stableSince,
        report.stableSince,
      );
      grouped.set(provider, candidate);
    }
    return [...grouped.values()];
  }

  async issueProviderTickets(route) {
    await Promise.all(
      [...this.participants.values()]
        .filter((participant) => participant.ws)
        .map((participant) => this.issueProviderTicket(participant, route)),
    );
  }

  async issueProviderTicket(participant, route) {
    if (route.provider !== SFU_PROVIDER.MEDIASOUP) return;
    const ticket = await this.createProviderTicket(
      participant,
      route,
      this.providerConfig,
    );
    this.sendMessage(
      participant.ws,
      MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_TICKET,
      {
        route,
        provider: route.provider,
        epoch: route.epoch,
        signalingUrl:
          this.providerConfig?.signalingUrl ||
          this.env.DSPEAK_SFU_SIGNALING_URL,
        ticket,
      },
    );
  }

  async createProviderTicket(participant, route, providerConfig = null) {
    const { signProviderTicket } = await import("./tickets.js");
    const claims = {
      iss: this.env.MEDIA_CONTROL_ISSUER,
      aud: "dspeak-sfu",
      sub: participant.userId,
      deviceId: participant.deviceId,
      roomId: participant.channelId,
      routeEpoch: route.epoch,
      providerId:
        providerConfig?.id ||
        this.env.DSPEAK_SFU_PROVIDER_ID ||
        "selfhost-primary",
      generation: 1,
      permissions: { produce: true, consume: true },
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: crypto.randomUUID(),
      protocolRevision: MEDIA_PROVIDER_PROTOCOL_REVISION,
    };
    return signProviderTicket(claims, this.env);
  }

  commitRoute(route) {
    const connectionMode = this.getConnectionMode();
    const validation = validateRouteForMode(route, connectionMode);
    if (!validation.valid) {
      console.warn("[MediaRoomDO] Route rejected:", validation.error);
      return;
    }

    this.route = route;
    this.epoch = route.epoch;
    this.qualifiedParticipantSignature =
      route.kind === MEDIA_ROUTE_KIND.P2P
        ? this.getParticipantSignature()
        : null;
    this.pendingRoute = null;
    this.pendingStartedAt = 0;
    this.qualificationState.clear();
    this.transitionReadiness.clear();
    void Promise.all([
      this.state.storage.put("route", route),
      this.state.storage.put("epoch", this.epoch),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put(
        "qualifiedParticipantSignature",
        this.qualifiedParticipantSignature,
      ),
      this.state.storage.put(
        "qualificationStartedAt",
        this.qualificationStartedAt,
      ),
      this.state.storage.delete("pendingRoute"),
      this.state.storage.delete("pendingStartedAt"),
    ]);

    this.broadcastTopology();
    for (const [ws, session] of this.sessions)
      if (session.authenticated && ws.readyState === WebSocket.OPEN)
        this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ROUTE_COMMIT, {
          route,
          mode:
            route.kind === MEDIA_ROUTE_KIND.P2P
              ? "p2p"
              : route.kind === MEDIA_ROUTE_KIND.SFU
                ? "sfu"
                : "idle",
          provider: route.provider,
          epoch: route.epoch,
          sourceRevision: route.sourceRevision,
          participants: this.getParticipantList(),
          peers: this.getParticipantList(),
        });
  }

  broadcastTopology() {
    for (const [ws, session] of this.sessions) {
      if (session.authenticated && ws.readyState === WebSocket.OPEN) {
        this.sendTopology(ws);
      }
    }
  }

  getParticipantSignature() {
    return [...this.participants.values()]
      .map((participant) => participant.peerId)
      .sort()
      .join(",");
  }

  getParticipantList() {
    return [...this.participants.values()].map((p) => ({
      peerId: p.peerId,
      userId: p.userId,
      deviceId: p.deviceId,
      sources: [...p.sources],
    }));
  }

  getConnectionMode() {
    for (const session of this.sessions.values()) {
      if (session.authenticated) return session.connectionMode;
    }
    return "auto";
  }

  getRoomId() {
    for (const session of this.sessions.values()) {
      if (session.authenticated && session.channelId) return session.channelId;
    }
    return "unknown";
  }

  handleDisconnect(ws, session) {
    this.sessions.delete(ws);
    if (session.authenticated) {
      const participantKey = `${session.userId}:${session.deviceId}`;
      const participant = this.participants.get(participantKey);
      if (participant?.ws === ws) {
        participant.ws = null;
        participant.disconnectedAt = Date.now();
        this.startControlLeaseTimer();
      }
    }
    if (this.sessions.size === 0 && this.participants.size === 0)
      this.stopControlLeaseTimer();
  }

  finalizeParticipantDisconnect(participantKey, participant) {
    if (!this.participants.delete(participantKey)) return;
    this.sourceRevision++;
    this.qualificationState.delete(participant.peerId);
    this.providerReadiness.delete(participant.peerId);
    this.transitionReadiness.delete(participant.peerId);
    for (const key of this.publishedSources.keys())
      if (key.startsWith(`${participant.peerId}:`))
        this.publishedSources.delete(key);
    void this.state.storage.put("publishedSources", [
      ...this.publishedSources.values(),
    ]);
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
    } else if (this.pendingRoute) {
      void this.maybeCommitPendingRoute();
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
