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
  createLocalRoute,
  createP2PRoute,
  createSFURoute,
  validateRouteForMode,
  compareRouteEpoch,
} from "./protocol.js";

export class MediaRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { userId, deviceId, peerId, authenticated, lastHeartbeat }
    this.participants = new Map(); // userId -> { deviceId, peerId, ws, sources, joinedAt }
    this.route = createLocalRoute(0, 0, "waiting-for-peer");
    this.pendingRoute = null;
    this.qualificationState = new Map(); // peerId -> { qualifiedPeers: Set, ready: boolean }
    this.providerHealth = new Map(); // providerId -> { healthy: boolean, lastCheck, failures }
    this.sourceRevision = 0;
    this.epoch = 0;
    this.transitionGeneration = 0;
    this.controlLeaseTimer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.handleWebSocket(server, request);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("WebSocket upgrade required", { status: 426 });
  }

  handleWebSocket(ws, request) {
    ws.accept();

    const session = {
      authenticated: false,
      userId: null,
      deviceId: null,
      peerId: crypto.randomUUID(),
      lastHeartbeat: Date.now(),
    };

    this.sessions.set(ws, session);
    this.startControlLeaseTimer();

    ws.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(ws, session, data);
      } catch (error) {
        console.error("[MediaRoomDO] Message parse error:", error);
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
            error: "Invalid message",
          }),
        );
      }
    });

    ws.addEventListener("close", () => {
      this.handleDisconnect(ws, session);
    });
  }

  async handleMessage(ws, session, data) {
    const now = Date.now();
    session.lastHeartbeat = now;

    if (!session.authenticated) {
      if (data.type !== MEDIA_CONTROL_CLIENT_HELLO) {
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
            error: "Authentication required",
          }),
        );
        ws.close(1008, "Authentication required");
        return;
      }

      const verified = await this.verifyMediaTicket(data.ticket);
      if (!verified.valid) {
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
            error: verified.error,
          }),
        );
        ws.close(1008, verified.error);
        return;
      }

      const claims = verified.claims;
      session.authenticated = true;
      session.userId = claims.sub;
      session.deviceId = claims.deviceId;
      session.channelId = claims.channelId;
      session.connectionMode = claims.connectionMode || "auto";
      session.routeEpoch = claims.routeEpoch || 0;

      // Register participant
      const participantKey = `${claims.sub}:${claims.deviceId}`;
      this.participants.set(participantKey, {
        userId: claims.sub,
        deviceId: claims.deviceId,
        peerId: session.peerId,
        ws,
        sources: new Set(),
        joinedAt: now,
      });

      // Send welcome with current topology
      ws.send(
        JSON.stringify({
          type: MEDIA_CONTROL_SERVER_HELLO,
          protocolVersion: MEDIA_CONTROL_PROTOCOL_VERSION,
          route: this.route,
          epoch: this.epoch,
          sourceRevision: this.sourceRevision,
          participants: this.getParticipantList(),
        }),
      );

      this.maybeStartQualification();
      return;
    }

    switch (data.type) {
      case MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT: {
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.HEARTBEAT_ACK,
            timestamp: now,
          }),
        );
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL: {
        // Relay P2P signaling to target peer
        await this.relayP2PSignal(session, data);
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES: {
        // Update participant sources
        const participantKey = `${session.userId}:${session.deviceId}`;
        const participant = this.participants.get(participantKey);
        if (participant) {
          participant.sources = new Set(data.sources || []);
          this.sourceRevision++;
          this.broadcastTopology();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED: {
        // Peer reports qualified connections
        const participantKey = `${session.userId}:${session.deviceId}`;
        const participant = this.participants.get(participantKey);
        if (participant) {
          this.qualificationState.set(session.peerId, {
            qualifiedPeers: new Set(data.qualifiedPeerIds || []),
            ready: true,
          });
          this.checkQualificationComplete();
        }
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED: {
        // Peer reports P2P failure
        this.handleP2PFailure(session, data.reason);
        break;
      }

      case MEDIA_CONTROL_MESSAGE_TYPES.RESUME: {
        // Resume after control reconnect
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.WELCOME,
            protocolVersion: MEDIA_CONTROL_PROTOCOL_VERSION,
            route: this.route,
            epoch: this.epoch,
            sourceRevision: this.sourceRevision,
            participants: this.getParticipantList(),
            resumed: true,
          }),
        );
        break;
      }

      default: {
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.ERROR,
            error: `Unknown message type: ${data.type}`,
          }),
        );
      }
    }
  }

  async verifyMediaTicket(ticket) {
    // In production, verify against Supabase JWKS or local public key
    // For now, basic validation
    if (!ticket || typeof ticket !== "string") {
      return { valid: false, error: "Missing ticket" };
    }
    // TODO: Actual JWT verification with jose
    return {
      valid: true,
      claims: {
        sub: "test-user",
        deviceId: "test-device",
        channelId: "test-channel",
        connectionMode: "auto",
        routeEpoch: 0,
      },
    };
  }

  async relayP2PSignal(fromSession, data) {
    const targetPeerId = data.targetPeerId;
    if (!targetPeerId) return;

    for (const [ws, session] of this.sessions) {
      if (session.peerId === targetPeerId && session.authenticated) {
        ws.send(
          JSON.stringify({
            type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL_RELAY,
            fromPeerId: fromSession.peerId,
            signal: data.signal,
          }),
        );
        break;
      }
    }
  }

  handleP2PFailure(session, reason) {
    if (
      this.route.kind === MEDIA_ROUTE_KIND.P2P &&
      this.route.path === P2P_PATH.DIRECT
    ) {
      // Trigger fallback to SFU
      this.beginTransition(SFU_PROVIDER.MEDIASOUP, `p2p-failed-${reason}`);
    }
  }

  maybeStartQualification() {
    const participantCount = this.participants.size;
    if (participantCount < 2) return;

    // Check if all participants are ready for qualification
    const allReady = [...this.participants.values()].every(
      (p) => p.ws.readyState === WebSocket.OPEN,
    );
    if (!allReady) return;

    // Start qualification phase
    this.route = createP2PRoute(
      P2P_PATH.DIRECT,
      ++this.epoch,
      this.sourceRevision,
      "qualifying-direct",
    );
    this.transitionGeneration++;

    for (const participant of this.participants.values()) {
      participant.ws.send(
        JSON.stringify({
          type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_STATE,
          route: this.route,
          epoch: this.epoch,
          sourceRevision: this.sourceRevision,
          action: "qualify-p2p",
        }),
      );
    }
  }

  checkQualificationComplete() {
    const expectedPeers = new Set(
      [...this.participants.values()].map((p) => p.peerId),
    );
    let allQualified = true;

    for (const [peerId, state] of this.qualificationState) {
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
    }

    if (allQualified && this.participants.size >= 2) {
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

  beginTransition(targetProvider, reason) {
    const targetRoute =
      targetProvider === SFU_PROVIDER.MEDIASOUP
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
    this.route = {
      ...this.route,
      reason: `transitioning-to-${targetProvider}`,
    };

    this.broadcastTopology();

    // Request provider tickets for participants
    this.issueProviderTickets(targetRoute);
  }

  async issueProviderTickets(route) {
    for (const participant of this.participants.values()) {
      const ticket = await this.createProviderTicket(participant, route);
      participant.ws.send(
        JSON.stringify({
          type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_TICKET,
          route,
          ticket,
        }),
      );
    }
  }

  async createProviderTicket(participant, route) {
    const { signProviderTicket } = await import("./tickets.js");
    const claims = {
      iss: this.env.MEDIA_CONTROL_ISSUER,
      aud: "dspeak-sfu",
      sub: participant.userId,
      deviceId: participant.deviceId,
      roomId: participant.userId, // channelId = roomId for media
      routeEpoch: route.epoch,
      providerId: "selfhost-primary",
      generation: 1,
      permissions: { produce: true, consume: true },
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: crypto.randomUUID(),
      protocolRevision: 1,
    };
    return signProviderTicket(claims, this.env);
  }

  commitRoute(route) {
    // Validate route for connection mode
    const connectionMode = this.getConnectionMode();
    const validation = validateRouteForMode(route, connectionMode);
    if (!validation.valid) {
      console.warn("[MediaRoomDO] Route rejected:", validation.error);
      return;
    }

    this.route = route;
    this.epoch = route.epoch;
    this.pendingRoute = null;
    this.qualificationState.clear();

    this.broadcastTopology();
  }

  broadcastTopology() {
    const data = {
      type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_STATE,
      route: this.route,
      epoch: this.epoch,
      sourceRevision: this.sourceRevision,
      participants: this.getParticipantList(),
    };

    for (const [ws, session] of this.sessions) {
      if (session.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }
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
    // Get from first authenticated session
    for (const session of this.sessions.values()) {
      if (session.authenticated) return session.connectionMode;
    }
    return "auto";
  }

  handleDisconnect(ws, session) {
    this.sessions.delete(ws);

    if (session.authenticated) {
      const participantKey = `${session.userId}:${session.deviceId}`;
      this.participants.delete(participantKey);
      this.sourceRevision++;

      // Clean up qualification state
      this.qualificationState.delete(session.peerId);

      // Re-evaluate topology
      if (this.participants.size < 2) {
        this.route = createLocalRoute(
          this.epoch,
          this.sourceRevision,
          "waiting-for-peer",
        );
      } else if (this.route.kind === MEDIA_ROUTE_KIND.P2P) {
        // Check if mesh is still complete
        this.maybeStartQualification();
      }

      this.broadcastTopology();
    }

    if (this.sessions.size === 0) {
      this.stopControlLeaseTimer();
    }
  }

  startControlLeaseTimer() {
    if (this.controlLeaseTimer) return;
    this.controlLeaseTimer = setInterval(() => {
      const now = Date.now();
      for (const [ws, session] of this.sessions) {
        if (
          session.authenticated &&
          now - session.lastHeartbeat > CONTROL_HEARTBEAT_TIMEOUT_MS
        ) {
          console.warn(
            "[MediaRoomDO] Control lease expired for",
            session.userId,
          );
          ws.close(1008, "Control lease expired");
        }
      }
    }, CONTROL_HEARTBEAT_INTERVAL_MS);
  }

  stopControlLeaseTimer() {
    if (this.controlLeaseTimer) {
      clearInterval(this.controlLeaseTimer);
      this.controlLeaseTimer = null;
    }
  }
}
