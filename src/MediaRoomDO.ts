import {
  CONTROL_HEARTBEAT_INTERVAL_MS,
  CONTROL_HEARTBEAT_TIMEOUT_MS,
  CONTROL_GRACE_PERIOD_MS,
  MEDIA_CONTROL_CLIENT_HELLO,
  MEDIA_CONTROL_MESSAGE_TYPES,
  MEDIA_CONTROL_SERVER_HELLO,
  buildServerHello,
  MEDIA_OPERATION_ACK_TIMEOUT_MS,
  MEDIA_ROUTE_KIND,
  OPERATION_ID,
  ROOM_REVISION,
  SFU_PROVIDER,
  createLocalRoute,
  validateRouteForMode,
} from "./protocol.ts";
import {
  MAX_CONTROL_MESSAGE_BYTES,
  controlMessageByteLength,
  mediaPublicationKey,
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
import type {
  DurableObjectState,
  WebSocket as CloudflareWebSocket,
} from "@cloudflare/workers-types";
import type {
  DynamicRecord,
  MediaControlEnv,
  OperationResult,
  RoomParticipant,
  RoomProviderConfig,
  RoomProviderHealth,
  RoomPublication,
  RoomQoeMetrics,
  RoomRoute,
  RoomSession,
} from "./domain-types.ts";

export {
  controlMessageByteLength,
  normalizeMediaSources,
} from "./media-room-contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRoomRoute(value: unknown): value is RoomRoute {
  if (!isRecord(value)) return false;
  return (
    (value.kind === MEDIA_ROUTE_KIND.LOCAL ||
      value.kind === MEDIA_ROUTE_KIND.P2P ||
      value.kind === MEDIA_ROUTE_KIND.SFU) &&
    Number.isSafeInteger(value.epoch) &&
    Number.isSafeInteger(value.sourceRevision) &&
    typeof value.reason === "string"
  );
}

export class MediaRoomDO {
  state: DurableObjectState;
  env: MediaControlEnv;
  channelId: string | null;
  sessions: Map<CloudflareWebSocket, RoomSession>;
  participants: Map<string, RoomParticipant>;
  route: RoomRoute;
  pendingRoute: RoomRoute | null;
  pendingStartedAt: number;
  qualificationState: Map<string, DynamicRecord>;
  providerReadiness: Set<string>;
  transitionReadiness: Set<string>;
  publishedSources: Map<string, RoomPublication>;
  providerHealth: Map<string, RoomProviderHealth>;
  qoeMetrics: Map<string, RoomQoeMetrics>;
  providerConfig: RoomProviderConfig | null;
  sourceRevision: number;
  publicationRevision: number;
  epoch: number;
  roomRevision: bigint;
  transitionGeneration: number;
  transitionInFlight: boolean;
  qualifiedParticipantSignature: string | null;
  qualificationStartedAt: number;
  qualificationFallbackRoute: RoomRoute | null;
  qualificationParticipantSignature: string | null;
  pendingRouteRefresh: DynamicRecord | null;
  stateLoaded: boolean;
  operationHistory: Set<string>;
  operationResults: Map<string, OperationResult>;
  maxOperationHistory: number;
  operationResultsTTL: number;
  leavePending: Set<string>;
  participantConnectionEpochs: Map<string, number>;

  constructor(state: DurableObjectState, env: MediaControlEnv) {
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
    this.publicationRevision = 0;
    this.epoch = 0;
    this.roomRevision = 0n;
    this.transitionGeneration = 0;
    this.transitionInFlight = false;
    this.qualifiedParticipantSignature = null;
    this.qualificationStartedAt = 0;
    this.qualificationFallbackRoute = null;
    this.qualificationParticipantSignature = null;
    this.pendingRouteRefresh = null;
    this.stateLoaded = false;
    this.operationHistory = new Set();
    this.operationResults = new Map();
    this.maxOperationHistory = 1000;
    this.operationResultsTTL = 5 * 60 * 1000;
    this.leavePending = new Set();
    this.participantConnectionEpochs = new Map();
    this.state.blockConcurrencyWhile?.(() => this.loadDurableState());
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const forwardedChannelId = request.headers.get("X-dSpeak-Channel-Id");
    if (forwardedChannelId) this.channelId ||= forwardedChannelId;
    await this.loadDurableState();

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.isAllowedWebSocketOrigin(request)) {
        mediaDebug(this.env, "room.websocket-rejected", { reason: "origin" });
        return new Response("WebSocket origin is not allowed", { status: 403 });
      }
      const [client, server] = Object.values(
        new WebSocketPair(),
      ) as unknown as [WebSocket, CloudflareWebSocket];
      this.handleWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.isAdminRequest(request))
      return new Response("Unauthorized", { status: 401 });
    if (url.pathname.endsWith("/participants") && request.method === "GET")
      return Response.json({ participants: this.getParticipantList() });
    if (url.pathname.endsWith("/moderate") && request.method === "POST") {
      const parsed: unknown = await request.json();
      const data: DynamicRecord = isRecord(parsed) ? parsed : {};
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

  isAdminRequest(request: Request) {
    const expected = this.env.MEDIA_CONTROL_ADMIN_TOKEN;
    return Boolean(
      expected && request.headers.get("authorization") === `Bearer ${expected}`,
    );
  }

  isAllowedWebSocketOrigin(request: Request) {
    const origin = request.headers.get("Origin");
    if (!origin) return true;
    const configured = String(this.env.MEDIA_CONTROL_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!configured.length) return true;
    return configured.includes(origin);
  }

  handleWebSocket(ws: CloudflareWebSocket) {
    const session = {
      authenticated: false,
      userId: null,
      deviceId: null,
      peerId: crypto.randomUUID(),
      lastHeartbeat: Date.now(),
      mediaSessionId: crypto.randomUUID(),
      providerCapabilities: [...this.getConfiguredProviderCapabilities()],
      mediaCapabilities: null,
      capabilityProtocol: "video-codec-matrix-v1",
      sources: [],
      sourceStates: {},
      muted: true,
      deafened: false,
      joinedAt: Date.now(),
      connectionEpoch: null,
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
        data: buildServerHello({
          mediaSessionId: session.mediaSessionId,
          roomRevision: this.roomRevision,
          epoch: this.epoch,
          sourceRevision: this.sourceRevision,
        }),
      }),
    );
  }

  async webSocketMessage(
    ws: CloudflareWebSocket,
    message: string | ArrayBuffer,
  ) {
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
    if (!session) return;
    try {
      const parsed: unknown = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      );
      if (!isRecord(parsed))
        throw new Error("Message envelope must be an object");
      const data: DynamicRecord = parsed;
      mediaDebug(this.env, "room.message", {
        type: data?.type,
        authenticated: session?.authenticated === true,
      });
      await handleRoomMessage(this, ws, session, data);
      if (
        data?.type === MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT &&
        session?.authenticated
      ) {
        ws.serializeAttachment(session);
      }
    } catch (error) {
      console.error("[MediaRoomDO] Message parse error:", error);
      mediaDebug(this.env, "room.message-invalid", { error });
      this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.ERROR, {
        error: "Invalid message",
      });
    }
  }

  webSocketClose(
    ws: CloudflareWebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ) {
    try {
      const session = this.getSession(ws);
      if (session) this.handleDisconnect(ws, session);
    } finally {
      try {
        ws.close(code, reason);
      } catch {
        try {
          ws.close();
        } catch {}
      }
    }
  }

  webSocketError(ws: CloudflareWebSocket) {
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
        now - participant.disconnectedAt >= CONTROL_GRACE_PERIOD_MS
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
      await this.handleProviderFailure({
        provider: this.pendingRoute.provider,
        reason: "provider-prepare-timeout",
        providerId: this.pendingRoute.providerId,
        eventEpoch: this.pendingRoute.epoch,
        sourceRevision: this.pendingRoute.sourceRevision,
        failedRoute: this.pendingRoute,
      });
  }

  async loadDurableState() {
    if (this.stateLoaded) return;
    const [
      route,
      epoch,
      sourceRevision,
      publicationRevision,
      roomRevision,
      pendingRoute,
      pendingStartedAt,
      publishedSources,
      qualifiedParticipantSignature,
      qualificationStartedAt,
      providerConfig,
      providerHealth,
      qualificationFallbackRoute,
      qualificationParticipantSignature,
      participantConnectionEpochs,
      operationResults,
    ] = await Promise.all([
      this.state.storage.get("route"),
      this.state.storage.get("epoch"),
      this.state.storage.get("sourceRevision"),
      this.state.storage.get("publicationRevision"),
      this.state.storage.get("roomRevision"),
      this.state.storage.get("pendingRoute"),
      this.state.storage.get("pendingStartedAt"),
      this.state.storage.get("publishedSources"),
      this.state.storage.get("qualifiedParticipantSignature"),
      this.state.storage.get("qualificationStartedAt"),
      this.state.storage.get("providerConfig"),
      this.state.storage.get("providerHealth"),
      this.state.storage.get("qualificationFallbackRoute"),
      this.state.storage.get("qualificationParticipantSignature"),
      this.state.storage.get("participantConnectionEpochs"),
      this.state.storage.get("operationResults"),
    ]);
    if (isRoomRoute(route)) this.route = route;
    if (typeof epoch === "number" && Number.isSafeInteger(epoch))
      this.epoch = epoch;
    if (
      typeof sourceRevision === "number" &&
      Number.isSafeInteger(sourceRevision)
    )
      this.sourceRevision = sourceRevision;
    if (
      typeof publicationRevision === "number" &&
      Number.isSafeInteger(publicationRevision)
    )
      this.publicationRevision = publicationRevision;
    if (typeof roomRevision === "bigint" || typeof roomRevision === "number")
      this.roomRevision = BigInt(roomRevision);
    if (isRoomRoute(pendingRoute)) this.pendingRoute = pendingRoute;
    if (
      typeof pendingStartedAt === "number" &&
      Number.isSafeInteger(pendingStartedAt)
    )
      this.pendingStartedAt = pendingStartedAt;
    if (Array.isArray(publishedSources))
      this.publishedSources = new Map(
        publishedSources
          .filter(isRecord)
          .map((publication) => [
            mediaPublicationKey(publication),
            publication,
          ]),
      );
    if (typeof qualifiedParticipantSignature === "string")
      this.qualifiedParticipantSignature = qualifiedParticipantSignature;
    if (
      typeof qualificationStartedAt === "number" &&
      Number.isSafeInteger(qualificationStartedAt)
    )
      this.qualificationStartedAt = qualificationStartedAt;
    if (isRecord(providerConfig)) this.providerConfig = providerConfig;
    if (isRecord(providerHealth))
      this.providerHealth = new Map(
        Object.entries(providerHealth) as [string, RoomProviderHealth][],
      );
    if (
      isRoomRoute(qualificationFallbackRoute) &&
      qualificationFallbackRoute.kind === MEDIA_ROUTE_KIND.SFU &&
      qualificationFallbackRoute.provider
    )
      this.qualificationFallbackRoute = qualificationFallbackRoute;
    if (typeof qualificationParticipantSignature === "string")
      this.qualificationParticipantSignature =
        qualificationParticipantSignature;
    if (isRecord(participantConnectionEpochs)) {
      this.participantConnectionEpochs = new Map(
        Object.entries(participantConnectionEpochs).flatMap(([key, value]) => {
          const epoch = Number(value);
          return isPositiveSafeInteger(epoch) ? [[key, epoch]] : [];
        }),
      );
    } else {
      this.participantConnectionEpochs = new Map();
    }
    if (Array.isArray(operationResults)) {
      this.operationResults = new Map(
        operationResults.map((entry) => [
          String(entry?.key || ""),
          { ...(entry?.value || {}), createdAt: Number(entry?.createdAt) || 0 },
        ]),
      );
      this.cleanupOperationResults();
    }
    const hasPersistedRoomState = Boolean(
      route ||
      (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch > 0) ||
      (typeof sourceRevision === "number" &&
        Number.isSafeInteger(sourceRevision) &&
        sourceRevision > 0) ||
      isRoomRoute(pendingRoute) ||
      (typeof pendingStartedAt === "number" && pendingStartedAt > 0) ||
      (Array.isArray(publishedSources) && publishedSources.length > 0) ||
      isRecord(providerConfig) ||
      isRecord(providerHealth),
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
    this.roomRevision++;
    // Publication-set invariant: any publishedSources clear also advances and
    // persists publicationRevision so a reconstructed DO never rolls back.
    this.publicationRevision++;
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
      this.state.storage.put("publicationRevision", this.publicationRevision),
      this.state.storage.put("roomRevision", this.roomRevision),
      this.state.storage.put("publishedSources", []),
      this.state.storage.put("providerHealth", {}),
      this.state.storage.put("qualifiedParticipantSignature", null),
      this.state.storage.put("qualificationStartedAt", 0),
      this.state.storage.delete("pendingRoute"),
      this.state.storage.delete("pendingStartedAt"),
      this.state.storage.delete("providerConfig"),
      this.state.storage.delete("qualificationFallbackRoute"),
      this.state.storage.delete("qualificationParticipantSignature"),
      this.state.storage.put(
        "participantConnectionEpochs",
        Object.fromEntries(this.participantConnectionEpochs),
      ),
    ]);
    this.cleanupOperationResults();
  }

  cleanupOperationResults() {
    const maxSize = 1000;
    const now = Date.now();
    if (this.operationResults.size > maxSize) {
      const entriesToDelete = this.operationResults.size - maxSize;
      const keys = [...this.operationResults.keys()].slice(0, entriesToDelete);
      for (const key of keys) {
        this.operationResults.delete(key);
      }
    }
    for (const [key, value] of this.operationResults.entries()) {
      if (value.createdAt && now - value.createdAt > this.operationResultsTTL) {
        this.operationResults.delete(key);
      }
    }
  }

  async storeOperationResult(key: string, payload: OperationResult) {
    if (!key) return false;
    this.operationResults.set(key, {
      ...payload,
      createdAt: Date.now(),
    });
    this.cleanupOperationResults();
    await this.state.storage.put(
      "operationResults",
      [...this.operationResults.entries()].map(([k, value]) => ({
        key: k,
        value,
        createdAt: value.createdAt,
      })),
    );
    return true;
  }

  getSession(ws: CloudflareWebSocket): RoomSession | undefined {
    const current = this.sessions.get(ws);
    if (current) return current;
    const restored = ws.deserializeAttachment?.();
    if (!restored) return restored;
    if (restored.authenticated) {
      const participantKey = `${restored.userId}:${restored.deviceId}`;
      const previousParticipant = this.participants.get(participantKey);
      const restoredEpoch = Number(restored.connectionEpoch);
      const canonicalEpochValue =
        this.participantConnectionEpochs.get(participantKey);
      const canonicalEpoch = isPositiveSafeInteger(canonicalEpochValue)
        ? canonicalEpochValue
        : undefined;
      const hasRestoredEpoch = isPositiveSafeInteger(restoredEpoch);
      const staleRestoredEpoch =
        canonicalEpoch !== undefined &&
        (!hasRestoredEpoch || restoredEpoch !== canonicalEpoch);
      if (
        !staleRestoredEpoch &&
        (!previousParticipant?.ws || previousParticipant.ws === ws)
      ) {
        const connectionEpoch =
          canonicalEpoch ?? (hasRestoredEpoch ? restoredEpoch : 1);
        if (canonicalEpoch === undefined) {
          this.participantConnectionEpochs.set(participantKey, connectionEpoch);
          void this.state.storage.put(
            "participantConnectionEpochs",
            Object.fromEntries(this.participantConnectionEpochs),
          );
        }
        this.participants.set(participantKey, {
          userId: restored.userId,
          deviceId: restored.deviceId,
          channelId: restored.channelId,
          peerId: restored.peerId,
          ws,
          sources: new Set(restored.sources || []),
          sourceStates: restored.sourceStates || {},
          providerCapabilities: new Set(restored.providerCapabilities || []),
          mediaCapabilities: restored.mediaCapabilities || null,
          capabilityProtocol:
            restored.capabilityProtocol || "video-codec-matrix-v1",
          muted: restored.muted !== false,
          deafened: restored.deafened === true,
          joinedAt: restored.joinedAt || Date.now(),
          connectionEpoch,
          cloudflareSessionId: restored.cloudflareSessionId ?? null,
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

  sendMessage(
    ws: CloudflareWebSocket | null | undefined,
    type: string,
    data: DynamicRecord = {},
  ) {
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

  sendTopology(
    ws: CloudflareWebSocket | null | undefined,
    extra: DynamicRecord = {},
  ) {
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
      publicationRevision: this.publicationRevision,
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

  async relayP2PSignal(
    fromSession: RoomSession,
    data: DynamicRecord,
    ws: CloudflareWebSocket,
  ) {
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

  isCurrentParticipantSession(ws: CloudflareWebSocket, session: RoomSession) {
    if (!session?.authenticated) return false;
    const participantKey = `${session.userId}:${session.deviceId}`;
    const participant = this.participants.get(participantKey);
    if (!participant) return false;
    const registered = this.sessions.get(ws);
    const canonicalEpoch = this.participantConnectionEpochs.get(participantKey);
    const sessionEpoch = Number(session.connectionEpoch);
    const participantEpoch = Number(participant.connectionEpoch);
    const hasCurrentEpoch =
      isPositiveSafeInteger(canonicalEpoch) &&
      isPositiveSafeInteger(sessionEpoch) &&
      isPositiveSafeInteger(participantEpoch) &&
      sessionEpoch === participantEpoch &&
      participantEpoch === canonicalEpoch;
    return (
      participant?.ws === ws &&
      participant.peerId === session.peerId &&
      hasCurrentEpoch &&
      (!registered || registered === session)
    );
  }

  replaceParticipantSession(
    participantKey: string,
    previousParticipant: RoomParticipant | undefined,
    nextWs: CloudflareWebSocket,
  ) {
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
    this.roomRevision++;
    void Promise.all([
      this.state.storage.put("publishedSources", [
        ...this.publishedSources.values(),
      ]),
      this.state.storage.put("publicationRevision", this.publicationRevision),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put("roomRevision", this.roomRevision),
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

  retireParticipantPublications(peerId: string) {
    const retired: RoomPublication[] = [];
    for (const [key, publication] of this.publishedSources) {
      if (publication.peerId !== peerId) continue;
      this.publishedSources.delete(key);
      retired.push({ ...publication, closed: true });
    }
    this.commitPublicationMutation({ removed: retired });
    return retired;
  }

  // Single entry point for the publication-revision domain. Callers mutate
  // publishedSources first, then commit the mutation here: revision bump,
  // durable persistence (publishedSources + publicationRevision + roomRevision
  // as one logical commit), and receiver pushes carrying the new revision.
  commitPublicationMutation({
    removed = [],
    upserted = [],
    broadcast = true,
    excludedWs = null,
    sourceRevision = null,
  }: {
    removed?: RoomPublication[];
    upserted?: RoomPublication[];
    broadcast?: boolean;
    excludedWs?: CloudflareWebSocket | null;
    sourceRevision?: number | null;
  } = {}) {
    const changed = removed.length > 0 || upserted.length > 0;
    if (!changed)
      return {
        changed: false,
        publicationRevision: this.publicationRevision,
      };
    this.publicationRevision = (this.publicationRevision || 0) + 1;
    this.roomRevision = (this.roomRevision || 0n) + 1n;
    void Promise.all([
      this.state.storage.put("publicationRevision", this.publicationRevision),
      this.state.storage.put("roomRevision", this.roomRevision),
      this.state.storage.put(
        "sourceRevision",
        sourceRevision ?? this.sourceRevision,
      ),
      this.state.storage.put("publishedSources", [
        ...this.publishedSources.values(),
      ]),
    ]);
    if (broadcast) {
      for (const publication of removed)
        this.broadcastPublicationPush(publication, excludedWs);
      for (const publication of upserted)
        this.broadcastPublicationPush(publication, excludedWs);
    }
    return {
      changed: true,
      publicationRevision: this.publicationRevision,
    };
  }

  broadcastPublicationPush(
    publication: RoomPublication,
    excludedWs: CloudflareWebSocket | null = null,
  ) {
    const push = {
      ...publication,
      publicationRevision: this.publicationRevision,
      roomRevision: this.roomRevision.toString(),
      sourceRevision: this.sourceRevision,
    };
    for (const participant of this.participants.values()) {
      const ws = participant.ws;
      if (
        ws &&
        ws !== excludedWs &&
        (ws.readyState === undefined || ws.readyState === WebSocket.OPEN)
      )
        this.sendMessage(
          ws,
          MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
          push,
        );
    }
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

  beginTransition(
    targetProvider: string | null,
    reason?: string,
    excludedProvider?: string | null,
    excludedProviderId?: string | null,
  ) {
    return beginTransition(
      this,
      targetProvider,
      reason,
      excludedProvider,
      excludedProviderId,
    );
  }

  handleProviderFailure(details: Parameters<typeof handleProviderFailure>[1]) {
    return handleProviderFailure(this, details);
  }

  handleP2PFailure(session: RoomSession, reason: string) {
    return handleP2PFailure(this, session, reason);
  }

  handleCloudflareRequest(
    ws: CloudflareWebSocket,
    session: RoomSession,
    data: DynamicRecord,
  ) {
    return handleCloudflareRequest(this, ws, session, data);
  }

  issueProviderTickets(route: RoomRoute) {
    return issueProviderTickets(this, route);
  }

  issueProviderTicket(participant: RoomParticipant, route: RoomRoute) {
    return issueProviderTicket(this, participant, route);
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

  createProviderTicket(
    participant: RoomParticipant,
    route: RoomRoute,
    providerConfig?: RoomProviderConfig | null,
  ) {
    return createProviderTicket(this, participant, route, providerConfig);
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

  restoreQualificationRoute(reason?: string) {
    return restoreQualificationRoute(this, reason);
  }

  commitRoute(route: RoomRoute) {
    return commitRoute(this, route);
  }

  validateRoute(route: RoomRoute, mode: string) {
    return validateRouteForMode(route, mode);
  }

  createInitialRoute(reason: string) {
    return createLocalRoute(1, this.sourceRevision, reason);
  }

  getParticipantSignature() {
    return [...this.participants.values()]
      .map((participant) => participant.peerId)
      .sort()
      .join(",");
  }

  getParticipantList() {
    const now = Date.now();
    return [...this.participants.values()].map((participant) => {
      const disconnectedFor =
        participant.status === "disconnected" && participant.disconnectedAt
          ? now - participant.disconnectedAt
          : null;
      const inGrace =
        disconnectedFor !== null && disconnectedFor <= CONTROL_GRACE_PERIOD_MS;
      return {
        peerId: participant.peerId,
        userId: participant.userId,
        deviceId: participant.deviceId,
        sources: [...participant.sources],
        sourceStates: participant.sourceStates || {},
        muted: participant.muted !== false,
        deafened: participant.deafened === true,
        mediaCapabilities: participant.mediaCapabilities || null,
        capabilityProtocol:
          participant.capabilityProtocol || "video-codec-matrix-v1",
        connectionEpoch: participant.connectionEpoch || 1,
        status: inGrace
          ? "grace"
          : participant.status === "disconnected"
            ? "left"
            : participant.status || "connected",
        lastSeenAt: participant.lastSeenAt || null,
      };
    });
  }

  buildTopologySnapshot() {
    const pending = this.pendingRoute;
    const participantList = this.getParticipantList();
    return {
      route: this.route,
      mode: pending
        ? "switching"
        : this.route.kind === MEDIA_ROUTE_KIND.LOCAL
          ? "idle"
          : this.route.kind === MEDIA_ROUTE_KIND.P2P
            ? this.route.reason === "qualifying-direct"
              ? "probing"
              : "p2p"
            : "sfu",
      epoch: String(pending?.epoch || this.epoch),
      sourceRevision: String(this.sourceRevision),
      roomRevision: this.roomRevision.toString(),
      publicationRevision: this.publicationRevision,
      participants: participantList,
      peers: participantList,
      provider: pending?.provider || this.route.provider,
      providerId: pending?.providerId || this.route.providerId,
      reason: pending?.reason || this.route.reason,
      target: pending ? "sfu" : undefined,
      targetProvider: pending?.provider,
      targetProviderId: pending?.providerId,
      targetRoute: pending,
      publishedSources: [...this.publishedSources.values()],
      sourceStates: Object.fromEntries(
        [...this.participants.values()].map((p) => [
          `${p.userId}:${p.deviceId}`,
          p.sourceStates || {},
        ]),
      ),
    };
  }

  applyCanonicalSnapshot(
    ws: CloudflareWebSocket,
    operationId: string,
    accepted: boolean,
    code: string | null | undefined,
    retryable: boolean,
    extra: DynamicRecord = {},
  ) {
    const snapshot = this.buildTopologySnapshot();
    const payload: DynamicRecord = {
      operationId,
      accepted,
      roomRevision: this.roomRevision.toString(),
      sourceRevision: Number(this.sourceRevision),
      publicationRevision: this.publicationRevision,
      connectionEpoch: extra.connectionEpoch,
      canonicalState: snapshot,
      ...extra,
    };
    if (code) {
      payload.code = code;
      payload.retryable = retryable;
    }
    this.operationResults.set(operationId, payload);
    this.sendMessage(ws, MEDIA_CONTROL_MESSAGE_TYPES.OPERATION_ACK, payload);
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

  async verifyMediaTicket(ticket: string) {
    return verifyRoomTicket(this, ticket);
  }

  async handleMessage(
    ws: CloudflareWebSocket,
    session: RoomSession,
    envelope: DynamicRecord,
  ) {
    return handleRoomMessage(this, ws, session, envelope);
  }

  handleDisconnect(ws: CloudflareWebSocket, session: RoomSession) {
    this.sessions.delete(ws);
    if (session.authenticated) {
      const participant = this.participants.get(
        `${session.userId}:${session.deviceId}`,
      );
      if (participant && participant.ws === ws) {
        participant.ws = null;
        participant.status = "disconnected";
        participant.disconnectedAt = Date.now();
        this.startControlLeaseTimer();
      }
    }
    if (this.sessions.size === 0 && this.participants.size === 0)
      this.stopControlLeaseTimer();
  }

  async finalizeParticipantDisconnect(
    participantKey: string,
    participant: RoomParticipant,
  ) {
    if (!this.participants.delete(participantKey)) return;
    this.sourceRevision++;
    this.roomRevision++;
    this.qualifiedParticipantSignature = null;
    const peerId = String(participant.peerId || "");
    this.qualificationState.delete(peerId);
    this.providerReadiness.delete(peerId);
    this.transitionReadiness.delete(peerId);
    this.retireParticipantPublications(peerId);
    void Promise.all([
      this.state.storage.put("publishedSources", [
        ...this.publishedSources.values(),
      ]),
      this.state.storage.put("publicationRevision", this.publicationRevision),
      this.state.storage.put("sourceRevision", this.sourceRevision),
      this.state.storage.put("roomRevision", this.roomRevision),
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
