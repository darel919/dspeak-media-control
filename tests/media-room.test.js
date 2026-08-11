import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_ROUTE_KIND,
  MEDIA_CONTROL_MESSAGE_TYPES,
  SFU_PROVIDER,
  chooseAvailableProvider,
  createP2PRoute,
  createSFURoute,
} from "../src/protocol.js";
import { handleRoomMessage } from "../src/media-room-messages.ts";
import {
  beginTransition,
  getQoeCandidates,
  handleCloudflareRequest,
  handleProviderFailure,
  MAX_QOE_PROVIDER_ID_LENGTH,
  MAX_QOE_REPORTS_PER_PARTICIPANT,
  QOE_REPORT_MAX_AGE_MS,
} from "../src/media-room-provider.ts";
import { MediaRoomDO } from "../src/MediaRoomDO.ts";

function room() {
  const storage = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    setAlarm: async () => {},
  };
  const instance = new MediaRoomDO(
    { storage, getWebSockets: () => [] },
    {
      MEDIA_CONTROL_ADMIN_TOKEN: "admin",
      CLOUDFLARE_REALTIME_APP_ID: "app",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret",
    },
  );
  instance.stateLoaded = true;
  instance.participants.set("participant", {
    peerId: "peer-1",
    ws: null,
  });
  return instance;
}

test("Cloudflare transitions commit after topology readiness", async () => {
  const instance = room();
  const route = createSFURoute(SFU_PROVIDER.CLOUDFLARE_REALTIME, 2, 0, "test");
  let committed = null;
  instance.pendingRoute = route;
  instance.transitionReadiness.add("peer-1");
  instance.commitRoute = (nextRoute) => {
    committed = nextRoute;
  };

  await instance.maybeCommitPendingRoute();

  assert.equal(committed?.kind, MEDIA_ROUTE_KIND.SFU);
  assert.equal(committed?.provider, SFU_PROVIDER.CLOUDFLARE_REALTIME);
});

test("dormant room rehydration retires a persisted route with no live sockets", async () => {
  const values = new Map([
    [
      "route",
      createSFURoute(SFU_PROVIDER.CLOUDFLARE_REALTIME, 8, 3, "active-sfu"),
    ],
    ["epoch", 8],
    ["sourceRevision", 3],
    ["publishedSources", [{ peerId: "old-peer", source: "microphone" }]],
    [
      "providerHealth",
      { [SFU_PROVIDER.CLOUDFLARE_REALTIME]: { healthy: true } },
    ],
    ["providerConfig", { id: "cloudflare-primary" }],
  ]);
  const storage = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
  const instance = new MediaRoomDO(
    { storage, getWebSockets: () => [] },
    {
      CLOUDFLARE_REALTIME_APP_ID: "app",
      CLOUDFLARE_REALTIME_APP_SECRET: "secret",
    },
  );

  await instance.loadDurableState();

  assert.equal(instance.participants.size, 0);
  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.LOCAL);
  assert.equal(instance.route.reason, "room-rehydrated");
  assert.equal(instance.route.epoch, 9);
  assert.equal(instance.sourceRevision, 4);
  assert.deepEqual(values.get("publishedSources"), []);
  assert.equal(values.has("providerConfig"), false);
});

test("provider selection falls back to mediasoup when Cloudflare is unavailable", () => {
  assert.equal(
    chooseAvailableProvider({
      requestedProvider: SFU_PROVIDER.CLOUDFLARE_REALTIME,
      availableProviders: [SFU_PROVIDER.MEDIASOUP],
      allowDirectMediasoupFallback: true,
    }),
    SFU_PROVIDER.MEDIASOUP,
  );
});

test("duplicate media source announcements do not churn the source revision", async () => {
  const instance = room();
  const ws = { serializeAttachment() {}, send() {} };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: [],
  };
  instance.participants.clear();
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws,
    sources: new Set(),
  });
  instance.isCurrentParticipantSession = () => true;

  const message = {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_SOURCES,
    data: { sources: ["audio", "camera"] },
  };
  await handleRoomMessage(instance, ws, session, message);
  await handleRoomMessage(instance, ws, session, message);

  assert.equal(instance.sourceRevision, 1);
  assert.deepEqual(session.sources, ["audio", "camera"]);
});

test("mediasoup transitions still require provider readiness", async () => {
  const instance = room();
  const route = createSFURoute(SFU_PROVIDER.MEDIASOUP, 2, 0, "test");
  let committed = false;
  instance.pendingRoute = route;
  instance.transitionReadiness.add("peer-1");
  instance.commitRoute = () => {
    committed = true;
  };

  await instance.maybeCommitPendingRoute();
  assert.equal(committed, false);

  instance.providerReadiness.add("peer-1");
  await instance.maybeCommitPendingRoute();
  assert.equal(committed, true);
});

test("client SFU RTT is relayed without generating an error response", async () => {
  const instance = room();
  const sender = {
    messages: [],
    send(message) {
      this.messages.push(message);
    },
  };
  const recipient = {
    messages: [],
    send(message) {
      this.messages.push(message);
    },
  };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.participants.clear();
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: sender,
  });
  instance.participants.set("user-2:device-2", {
    userId: "user-2",
    deviceId: "device-2",
    peerId: "peer-2",
    ws: recipient,
  });

  await handleRoomMessage(instance, sender, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.CLIENT_SFU_RTT,
    data: { rttMs: 27 },
  });

  assert.equal(sender.messages.length, 0);
  assert.deepEqual(JSON.parse(recipient.messages[0]), {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PARTICIPANT_SFU_RTT,
    data: { userId: "user-1", rttMs: 27 },
  });
});

test("P2P signal relay preserves the browser envelope and rejects stale epochs", async () => {
  const instance = room();
  instance.epoch = 7;
  instance.route = createP2PRoute("direct", 7, 0, "test");
  instance.participants.clear();
  instance.sessions.clear();
  const sender = {
    messages: [],
    send(message) {
      this.messages.push(message);
    },
  };
  const recipient = {
    messages: [],
    send(message) {
      this.messages.push(message);
    },
  };
  const senderSession = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  const recipientSession = {
    authenticated: true,
    userId: "user-2",
    deviceId: "device-2",
    peerId: "peer-2",
  };
  instance.sessions.set(sender, senderSession);
  instance.sessions.set(recipient, recipientSession);
  instance.participants.set("user-1:device-1", {
    ...senderSession,
    ws: sender,
  });
  instance.participants.set("user-2:device-2", {
    ...recipientSession,
    ws: recipient,
  });

  await instance.relayP2PSignal(
    senderSession,
    {
      targetPeerId: "peer-2",
      epoch: 7,
      signal: { candidate: { candidate: "candidate" } },
    },
    sender,
  );

  assert.deepEqual(JSON.parse(recipient.messages[0]), {
    type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_SIGNAL,
    data: {
      fromPeerId: "peer-1",
      epoch: 7,
      signal: { candidate: { candidate: "candidate" } },
    },
  });

  await instance.relayP2PSignal(
    senderSession,
    {
      targetPeerId: "peer-2",
      epoch: 6,
      signal: { candidate: { candidate: "stale" } },
    },
    sender,
  );
  assert.equal(recipient.messages.length, 1);
});

test("replacing a participant session retires its old media state", () => {
  const instance = room();
  const oldSocket = {
    closeRequest: null,
    close(code, reason) {
      this.closeRequest = { code, reason };
    },
  };
  const newSocket = {};
  const recipientMessages = [];
  const recipient = {
    send(message) {
      recipientMessages.push(JSON.parse(message));
    },
  };
  const participant = {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "old-peer",
    ws: oldSocket,
  };
  instance.sessions.set(oldSocket, {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "old-peer",
  });
  instance.participants.set("user-1:device-1", participant);
  instance.participants.set("user-2:device-2", {
    userId: "user-2",
    deviceId: "device-2",
    peerId: "recipient-peer",
    ws: recipient,
  });
  instance.publishedSources.set("old-peer:audio", {
    peerId: "old-peer",
    source: "audio",
    trackName: "old-track",
  });
  instance.qualificationState.set("old-peer", { ready: true });
  instance.providerReadiness.add("old-peer");
  instance.transitionReadiness.add("old-peer");
  instance.qoeMetrics.set("old-peer", { provider: "p2p" });
  instance.sourceRevision = 4;

  instance.replaceParticipantSession("user-1:device-1", participant, newSocket);

  assert.equal(instance.sessions.has(oldSocket), false);
  assert.deepEqual(oldSocket.closeRequest, {
    code: 4000,
    reason: "Media session superseded",
  });
  assert.equal(instance.publishedSources.has("old-peer:audio"), false);
  assert.deepEqual(recipientMessages, [
    {
      type: MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION_AVAILABLE,
      data: {
        peerId: "old-peer",
        source: "audio",
        trackName: "old-track",
        closed: true,
      },
    },
  ]);
  assert.equal(instance.qualificationState.has("old-peer"), false);
  assert.equal(instance.providerReadiness.has("old-peer"), false);
  assert.equal(instance.transitionReadiness.has("old-peer"), false);
  assert.equal(instance.qoeMetrics.has("old-peer"), false);
  assert.equal(instance.sourceRevision, 5);
});

test("native P2P readiness uses the shared qualification protocol", async () => {
  const instance = room();
  const messages = [];
  const ws = {
    messages,
    send(message) {
      messages.push(JSON.parse(message));
    },
    serializeAttachment() {},
  };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.sessions.clear();
  instance.participants.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", {
    ...session,
    ws,
    sources: new Set(),
  });
  instance.epoch = 2;
  instance.route = createP2PRoute("direct", 2, 0, "qualifying-direct");
  instance.checkQualificationComplete = () => {};

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_READY,
    data: { epoch: 2, qualifiedPeerIds: ["peer-2"] },
  });

  assert.equal(instance.qualificationState.get("peer-1").ready, true);
  assert.deepEqual(messages[0], {
    type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED,
    data: {
      epoch: 2,
      acknowledged: true,
      qualifiedPeerIds: ["peer-2"],
    },
  });
});

test("provider failure reports the selected registry provider identity", async () => {
  const instance = room();
  let report = null;
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://media.test/socket";
  instance.env.PROVIDER_REGISTRY_DO = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (request) => {
        report = await request.json();
        return new Response(null, { status: 200 });
      },
    }),
  };
  instance.providerConfig = { id: "provider-7" };
  instance.beginTransition = async () => {};

  await handleProviderFailure(
    instance,
    SFU_PROVIDER.MEDIASOUP,
    "transport-down",
  );

  assert.deepEqual(report, {
    providerId: "provider-7",
    error: "transport-down",
  });
});

test("a concrete mediasoup failure fails over to another instance", async () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  const requests = [];
  instance.env.PROVIDER_REGISTRY_DO = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        requests.push({ path, body });
        if (path === "/report-failure")
          return new Response(null, { status: 200 });
        return new Response(
          JSON.stringify({
            route: {
              kind: MEDIA_ROUTE_KIND.SFU,
              provider: SFU_PROVIDER.MEDIASOUP,
              providerId: "sfu-tokyo",
            },
            provider: {
              id: "sfu-tokyo",
              provider: SFU_PROVIDER.MEDIASOUP,
              signalingUrl: "wss://tokyo.example",
            },
          }),
          { status: 200 },
        );
      },
    }),
  };
  const participant = instance.participants.get("participant");
  participant.sources = new Set();
  participant.providerCapabilities = new Set([
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    SFU_PROVIDER.MEDIASOUP,
  ]);
  instance.route = createSFURoute(
    SFU_PROVIDER.MEDIASOUP,
    4,
    0,
    "active-sfu",
    "sfu-singapore",
  );
  instance.epoch = 4;
  instance.providerConfig = {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
  };

  await handleProviderFailure(
    instance,
    SFU_PROVIDER.MEDIASOUP,
    "transport-down",
  );

  const selection = requests.find(({ path }) => path === "/select");
  const health = instance.providerHealth.get("mediasoup:sfu-singapore");
  assert.equal(health.healthy, false);
  assert.equal(health.provider, SFU_PROVIDER.MEDIASOUP);
  assert.equal(health.providerId, "sfu-singapore");
  assert.equal(health.reason, "transport-down");
  assert.equal(health.epoch, 4);
  assert.ok(health.unhealthyUntil > Date.now());
  assert.equal(selection.body.excludedProvider, null);
  assert.equal(selection.body.excludedProviderId, "sfu-singapore");
  assert.equal(instance.pendingRoute.providerId, "sfu-tokyo");
});

test("a late active-instance failure does not cancel a same-family failover", async () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  const requests = [];
  instance.env.PROVIDER_REGISTRY_DO = {
    idFromName: () => "global",
    get: () => ({
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const body = await request.json();
        requests.push({ path, body });
        if (path === "/report-failure")
          return new Response(null, { status: 200 });
        return new Response(
          JSON.stringify({
            route: {
              kind: MEDIA_ROUTE_KIND.SFU,
              provider: SFU_PROVIDER.MEDIASOUP,
              providerId: "sfu-tokyo",
            },
            provider: {
              id: "sfu-tokyo",
              provider: SFU_PROVIDER.MEDIASOUP,
              signalingUrl: "wss://tokyo.example",
            },
          }),
          { status: 200 },
        );
      },
    }),
  };
  instance.route = createSFURoute(
    SFU_PROVIDER.MEDIASOUP,
    4,
    0,
    "active-sfu",
    "sfu-singapore",
  );
  instance.epoch = 4;
  instance.providerConfig = {
    id: "sfu-singapore",
    provider: SFU_PROVIDER.MEDIASOUP,
  };
  instance.participants.clear();
  instance.sessions.clear();
  const sockets = [];
  for (const [index, userId] of ["user-1", "user-2"].entries()) {
    const ws = {
      readyState: 1,
      send() {},
      serializeAttachment() {},
    };
    const session = {
      authenticated: true,
      userId,
      deviceId: `${userId}-device`,
      channelId: "channel-1",
      peerId: `peer-${index + 1}`,
    };
    sockets.push({ session, ws });
    instance.sessions.set(ws, session);
    instance.participants.set(`${userId}:${session.deviceId}`, {
      ...session,
      ws: null,
      sources: new Set(),
      providerCapabilities: new Set([
        SFU_PROVIDER.CLOUDFLARE_REALTIME,
        SFU_PROVIDER.MEDIASOUP,
      ]),
    });
  }
  instance.isCurrentParticipantSession = () => true;
  const failure = {
    provider: SFU_PROVIDER.MEDIASOUP,
    providerId: "sfu-singapore",
    epoch: 4,
    sourceRevision: 0,
    reason: "transport-down",
  };

  await handleRoomMessage(instance, sockets[0].ws, sockets[0].session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE,
    data: failure,
  });

  const pendingRoute = instance.pendingRoute;
  assert.equal(pendingRoute.providerId, "sfu-tokyo");
  instance.providerReadiness.add("peer-2");
  instance.transitionReadiness.add("peer-2");

  await handleRoomMessage(instance, sockets[1].ws, sockets[1].session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE,
    data: { ...failure, reason: "late-duplicate-failure" },
  });

  assert.equal(instance.pendingRoute, pendingRoute);
  assert.equal(
    instance.providerHealth.get("mediasoup:sfu-singapore")?.healthy,
    false,
  );
  assert.equal(instance.providerHealth.has("mediasoup:sfu-tokyo"), false);
  assert.equal(instance.providerReadiness.has("peer-2"), true);
  assert.equal(instance.transitionReadiness.has("peer-2"), true);
  assert.deepEqual(
    requests
      .filter(({ path }) => path === "/report-failure")
      .map(({ body }) => body.providerId),
    ["sfu-singapore", "sfu-singapore"],
  );
});

test("P2P qualification sends a complete topology state", () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const instance = room();
  const messages = [];
  instance.route = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    1,
    0,
    "active-sfu",
  );
  instance.epoch = 1;
  const participants = [
    { userId: "user-1", deviceId: "device-1", peerId: "peer-1" },
    { userId: "user-2", deviceId: "device-2", peerId: "peer-2" },
  ];
  instance.participants.clear();
  instance.sessions.clear();
  for (const participant of participants) {
    const ws = {
      readyState: 1,
      send(message) {
        messages.push(JSON.parse(message));
      },
    };
    instance.participants.set(`${participant.userId}:${participant.deviceId}`, {
      ...participant,
      ws,
      sources: new Set(),
      providerCapabilities: new Set(),
    });
    instance.sessions.set(ws, {
      ...participant,
      authenticated: true,
      connectionMode: "auto",
    });
  }

  try {
    instance.maybeStartQualification();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  assert.equal(messages.length, 2);
  assert.equal(messages[0].data.mode, "probing");
  assert.equal(messages[0].data.action, "qualify-p2p");
  assert.equal(messages[0].data.epoch, instance.epoch);
  assert.equal(messages[0].data.peers.length, 2);
  assert.equal(messages[0].data.participants.length, 2);
});

test("auto mode establishes an SFU fallback before P2P qualification", () => {
  const instance = room();
  const calls = [];
  instance.participants.clear();
  instance.route = {
    kind: MEDIA_ROUTE_KIND.LOCAL,
    epoch: 1,
    sourceRevision: 0,
    reason: "single-participant",
  };
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: null,
    sources: new Set(),
    providerCapabilities: new Set(),
  });
  instance.participants.set("user-2:device-2", {
    userId: "user-2",
    deviceId: "device-2",
    peerId: "peer-2",
    ws: null,
    sources: new Set(),
    providerCapabilities: new Set(),
  });
  instance.beginTransition = (...args) => calls.push(args);

  instance.maybeStartQualification();

  assert.deepEqual(calls, [
    [SFU_PROVIDER.CLOUDFLARE_REALTIME, "qualification-fallback"],
  ]);
  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.LOCAL);
});

test("source updates cannot cancel a pending SFU transition", () => {
  const instance = room();
  const pending = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    3,
    0,
    "qualification-fallback",
  );
  instance.pendingRoute = pending;
  instance.route = {
    kind: MEDIA_ROUTE_KIND.LOCAL,
    epoch: 1,
    sourceRevision: 0,
    reason: "single-participant",
  };
  instance.participants.clear();
  for (const userId of ["user-1", "user-2"]) {
    const deviceId = `${userId}-device`;
    instance.participants.set(`${userId}:${deviceId}`, {
      userId,
      deviceId,
      peerId: `${userId}-peer`,
      ws: null,
      sources: new Set(),
      providerCapabilities: new Set(),
    });
  }

  instance.maybeStartQualification();

  assert.equal(instance.pendingRoute, pending);
  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.LOCAL);
});

test("pending transitions refresh their source revision before readiness", async () => {
  const instance = room();
  instance.pendingRoute = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    3,
    0,
    "qualification-fallback",
  );
  instance.sourceRevision = 2;
  instance.providerReadiness.add("peer-1");
  instance.transitionReadiness.add("peer-1");

  await instance.refreshPendingRouteSourceRevision();

  assert.equal(instance.pendingRoute.epoch, 3);
  assert.equal(instance.pendingRoute.sourceRevision, 2);
  assert.equal(instance.providerReadiness.size, 0);
  assert.equal(instance.transitionReadiness.size, 0);
});

test("stale topology failures cannot cancel a refreshed transition", async () => {
  const instance = room();
  const ws = { readyState: 1, send() {} };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.sessions.clear();
  instance.participants.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", { ...session, ws });
  instance.pendingRoute = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    9,
    4,
    "provider-transition",
  );
  instance.sourceRevision = 4;
  const originalRoute = instance.pendingRoute;

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_FAILED,
    data: { epoch: 9, target: "sfu", sourceRevision: 3 },
  });

  assert.equal(instance.pendingRoute, originalRoute);
});

test("readiness and failures must identify the concrete pending provider", async () => {
  const instance = room();
  const ws = {
    readyState: 1,
    send() {},
    serializeAttachment() {},
  };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.sessions.clear();
  instance.participants.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", {
    ...session,
    ws,
    sources: new Set(),
  });
  instance.pendingRoute = createSFURoute(
    SFU_PROVIDER.MEDIASOUP,
    12,
    6,
    "provider-transition",
    "sfu-singapore",
  );

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_READY,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-tokyo",
      epoch: 12,
      sourceRevision: 6,
    },
  });
  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_FAILURE,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-tokyo",
      epoch: 12,
      sourceRevision: 6,
      reason: "wrong-instance",
    },
  });

  assert.equal(instance.providerReadiness.size, 0);
  assert.equal(instance.providerHealth.has("mediasoup:sfu-tokyo"), false);

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_READY,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-singapore",
      epoch: 12,
      sourceRevision: 6,
    },
  });
  assert.equal(instance.providerReadiness.has("peer-1"), true);
  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_READY,
    data: {
      target: "sfu",
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-tokyo",
      epoch: 12,
      sourceRevision: 6,
    },
  });

  assert.equal(instance.transitionReadiness.size, 0);

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_READY,
    data: {
      target: "sfu",
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-singapore",
      epoch: 12,
      sourceRevision: 6,
    },
  });

  assert.equal(instance.route.providerId, "sfu-singapore");
});

test("P2P qualification retains the active SFU as its fallback route", () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const instance = room();
  instance.route = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    4,
    2,
    "active-sfu",
  );
  instance.epoch = 4;
  instance.sourceRevision = 3;
  instance.participants.clear();
  instance.sessions.clear();
  for (const [index, userId] of ["user-1", "user-2"].entries()) {
    const ws = {
      readyState: 1,
      send() {},
    };
    const participant = {
      userId,
      deviceId: `device-${index}`,
      peerId: `peer-${index}`,
      ws,
      sources: new Set(),
      providerCapabilities: new Set([SFU_PROVIDER.CLOUDFLARE_REALTIME]),
    };
    instance.participants.set(`${userId}:${participant.deviceId}`, participant);
    instance.sessions.set(ws, {
      ...participant,
      authenticated: true,
      connectionMode: "auto",
    });
  }

  try {
    instance.maybeStartQualification();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.P2P);
  assert.equal(instance.route.reason, "qualifying-direct");
  assert.deepEqual(instance.qualificationFallbackRoute, {
    kind: MEDIA_ROUTE_KIND.SFU,
    provider: SFU_PROVIDER.CLOUDFLARE_REALTIME,
    epoch: 4,
    sourceRevision: 2,
    reason: "active-sfu",
  });
});

test("P2P qualification preserves the active fallback across source revisions", () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const instance = room();
  instance.route = createP2PRoute("direct", 4, 2, "qualifying-direct");
  instance.epoch = 4;
  instance.sourceRevision = 3;
  instance.qualificationFallbackRoute = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    3,
    2,
    "active-sfu",
  );
  instance.participants.clear();
  instance.sessions.clear();
  for (const [index, userId] of ["user-1", "user-2"].entries()) {
    const ws = { readyState: 1, send() {} };
    const participant = {
      userId,
      deviceId: `device-${index}`,
      peerId: `peer-${index}`,
      ws,
      sources: new Set(),
      providerCapabilities: new Set([SFU_PROVIDER.CLOUDFLARE_REALTIME]),
    };
    instance.participants.set(`${userId}:${participant.deviceId}`, participant);
    instance.sessions.set(ws, {
      ...participant,
      authenticated: true,
      connectionMode: "auto",
    });
  }
  instance.qualificationParticipantSignature =
    instance.getParticipantSignature();

  try {
    instance.maybeStartQualification();
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }

  assert.equal(instance.route.sourceRevision, 3);
  assert.equal(
    instance.qualificationFallbackRoute.provider,
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
  );
  assert.equal(
    instance.qualificationParticipantSignature,
    instance.getParticipantSignature(),
  );
});

test("a participant joining during qualification starts a new direct epoch", () => {
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const instance = room();
  instance.route = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    1,
    0,
    "active-sfu",
  );
  instance.epoch = 1;
  instance.participants.clear();
  instance.sessions.clear();
  const addParticipant = (index) => {
    const userId = `user-${index}`;
    const ws = { readyState: 1, send() {} };
    const participant = {
      userId,
      deviceId: `device-${index}`,
      peerId: `peer-${index}`,
      ws,
      sources: new Set(),
      providerCapabilities: new Set(),
    };
    instance.participants.set(`${userId}:${participant.deviceId}`, participant);
    instance.sessions.set(ws, {
      ...participant,
      authenticated: true,
      connectionMode: "auto",
    });
  };
  addParticipant(1);
  addParticipant(2);
  try {
    instance.maybeStartQualification();
    const firstEpoch = instance.epoch;
    addParticipant(3);
    instance.maybeStartQualification();
    assert.ok(instance.epoch > firstEpoch);
    assert.match(instance.qualificationParticipantSignature, /peer-3/);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("SFU QoE reports retain the fallback provider during P2P qualification", () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  instance.route = createP2PRoute("direct", 4, 2, "qualifying-direct");
  instance.qualificationFallbackRoute = createSFURoute(
    SFU_PROVIDER.MEDIASOUP,
    3,
    2,
    "active-sfu",
  );
  instance.qoeMetrics.set("peer-1", {
    provider: "sfu",
    paths: [{ rttMs: 30 }],
    stableSince: Date.now() - 20_000,
  });

  assert.equal(getQoeCandidates(instance)[0]?.provider, SFU_PROVIDER.MEDIASOUP);
});

test("room QoE aggregation keeps concrete provider instances separate", () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  instance.participants.set("participant-2", {
    peerId: "peer-2",
    ws: null,
  });
  instance.qoeMetrics.set("peer-1", {
    provider: SFU_PROVIDER.MEDIASOUP,
    providerId: "sfu-singapore",
    paths: [{ rttMs: 31, jitterMs: 18, packetLossPercent: 3.2 }],
    stableSince: Date.now() - 20_000,
  });
  instance.qoeMetrics.set("peer-2", {
    provider: SFU_PROVIDER.MEDIASOUP,
    providerId: "sfu-tokyo",
    paths: [{ rttMs: 42, jitterMs: 3, packetLossPercent: 0.1 }],
    stableSince: Date.now() - 20_000,
  });

  const candidates = getQoeCandidates(instance);

  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.providerId,
      candidate.readyParticipants,
      candidate.requiredParticipants,
    ]),
    [
      ["sfu-singapore", 1, 2],
      ["sfu-tokyo", 1, 2],
    ],
  );
});

test("room QoE aggregation ignores expired instance reports", () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  const now = Date.now();
  instance.qoeMetrics.set(
    "peer-1",
    new Map([
      [
        "mediasoup:sfu-singapore",
        {
          provider: SFU_PROVIDER.MEDIASOUP,
          providerId: "sfu-singapore",
          paths: [{ rttMs: 31 }],
          sampledAt: now + 120_000,
          receivedAt: now - QOE_REPORT_MAX_AGE_MS - 1,
          stableSince: now - 60_000,
        },
      ],
      [
        "mediasoup:sfu-tokyo",
        {
          provider: SFU_PROVIDER.MEDIASOUP,
          providerId: "sfu-tokyo",
          paths: [{ rttMs: 42 }],
          sampledAt: now,
          receivedAt: now,
          stableSince: now - 20_000,
        },
      ],
    ]),
  );

  assert.deepEqual(
    getQoeCandidates(instance).map((candidate) => candidate.providerId),
    ["sfu-tokyo"],
  );
});

test("room forwards concrete QoE identity to registry selection", async () => {
  const instance = room();
  instance.env.DSPEAK_SFU_ENABLED = "true";
  instance.env.DSPEAK_SFU_SIGNALING_URL = "wss://sfu.test/socket";
  let selectionRequest = null;
  let registryCalls = 0;
  instance.env.PROVIDER_REGISTRY_DO = {
    idFromName: () => {
      registryCalls += 1;
      return "global";
    },
    get: () => ({
      fetch: async (request) => {
        selectionRequest = await request.json();
        return new Response(
          JSON.stringify({
            route: {
              kind: MEDIA_ROUTE_KIND.SFU,
              provider: SFU_PROVIDER.MEDIASOUP,
              providerId: "sfu-tokyo",
            },
            provider: {
              id: "sfu-tokyo",
              provider: SFU_PROVIDER.MEDIASOUP,
              signalingUrl: "wss://tokyo.example",
            },
          }),
          { status: 200 },
        );
      },
    }),
  };
  const ws = { readyState: 1, send() {}, serializeAttachment() {} };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    channelId: "channel-1",
    peerId: "peer-1",
    connectionMode: "auto",
  };
  instance.participants.clear();
  instance.sessions.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", {
    ...session,
    ws,
    sources: new Set(),
    providerCapabilities: new Set([
      SFU_PROVIDER.CLOUDFLARE_REALTIME,
      SFU_PROVIDER.MEDIASOUP,
    ]),
  });

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-tokyo",
      paths: [{ rttMs: 42, jitterMs: 3, fractionLost: 0.001 }],
    },
  });
  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "sfu-singapore",
      paths: [{ rttMs: 31, jitterMs: 18, fractionLost: 0.032 }],
    },
  });
  assert.equal(instance.qoeMetrics.get("peer-1") instanceof Map, true);
  instance.participants.get("user-1:device-1").ws = null;
  instance.sessions.clear();
  await beginTransition(instance, SFU_PROVIDER.MEDIASOUP);

  assert.equal(registryCalls, 1);
  assert.deepEqual(
    selectionRequest.qoeCandidates.map((candidate) => candidate.providerId),
    ["sfu-tokyo", "sfu-singapore"],
  );
  assert.equal(instance.pendingRoute.providerId, "sfu-tokyo");
});

test("room bounds per-participant QoE instance reports", async () => {
  const instance = room();
  const ws = { readyState: 1, send() {}, serializeAttachment() {} };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    channelId: "channel-1",
    peerId: "peer-1",
  };
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", {
    ...session,
    ws,
    sources: new Set(),
  });

  for (let index = 0; index < MAX_QOE_REPORTS_PER_PARTICIPANT + 1; index++)
    await handleRoomMessage(instance, ws, session, {
      type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE,
      data: {
        provider: SFU_PROVIDER.MEDIASOUP,
        providerId: `sfu-${index}`,
        paths: [{ rttMs: 20 + index }],
      },
    });

  const reports = instance.qoeMetrics.get("peer-1");
  assert.equal(reports.size, MAX_QOE_REPORTS_PER_PARTICIPANT);
  assert.equal(reports.has("mediasoup:sfu-0"), false);
  assert.equal(
    reports.has(`mediasoup:sfu-${MAX_QOE_REPORTS_PER_PARTICIPANT}`),
    true,
  );

  await handleRoomMessage(instance, ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.MEDIA_QOE,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      providerId: "x".repeat(MAX_QOE_PROVIDER_ID_LENGTH + 1),
      paths: [{ rttMs: 10 }],
    },
  });
  assert.equal(reports.size, MAX_QOE_REPORTS_PER_PARTICIPANT);
});

test("Cloudflare control remains available through the active qualification fallback", async () => {
  const previousFetch = globalThis.fetch;
  const instance = room();
  instance.route = createP2PRoute("direct", 4, 2, "qualifying-direct");
  instance.qualificationFallbackRoute = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    3,
    2,
    "active-sfu",
  );
  const messages = [];
  const ws = {
    send(message) {
      messages.push(JSON.parse(message));
    },
    serializeAttachment() {},
  };
  const session = {
    cloudflareSessionId: null,
    userId: "user-1",
    peerId: "peer-1",
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sessionId: "cloudflare-session" }),
  });

  try {
    await handleCloudflareRequest(instance, ws, session, {
      requestId: "request-1",
      operation: "new-session",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(session.cloudflareSessionId, "cloudflare-session");
  assert.equal(messages[0]?.data.result.sessionId, "cloudflare-session");
});

test("Cloudflare publications retain safe screen audio ownership", async () => {
  const instance = room();
  const sender = {
    serializeAttachment() {},
    send() {},
  };
  const recipientMessages = [];
  const recipient = {
    send(message) {
      recipientMessages.push(JSON.parse(message));
    },
  };
  const session = {
    authenticated: true,
    cloudflareSessionId: "cloudflare-session",
    deviceId: "device-1",
    userId: "user-1",
    peerId: "peer-1",
  };
  instance.participants.clear();
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: sender,
  });
  instance.participants.set("user-2:device-2", {
    userId: "user-2",
    deviceId: "device-2",
    peerId: "peer-2",
    ws: recipient,
  });
  instance.isCurrentParticipantSession = () => true;

  await handleRoomMessage(instance, sender, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION,
    data: {
      trackName: "track-paired",
      source: "screen-audio",
    },
  });
  await handleRoomMessage(instance, sender, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.CLOUDFLARE_PUBLICATION,
    data: {
      trackName: "track-system",
      source: "screen-audio",
      ownerSource: "system-audio",
    },
  });

  assert.equal(recipientMessages[0].data.ownerSource, "screen");
  assert.equal(recipientMessages[1].data.ownerSource, "system-audio");
  assert.equal(
    instance.publishedSources.get("peer-1:screen-audio").ownerSource,
    "system-audio",
  );
});

test("a failed P2P qualification restores a healthy fallback SFU", async () => {
  const instance = room();
  instance.route = createP2PRoute("direct", 5, 7, "qualifying-direct");
  instance.epoch = 5;
  instance.sourceRevision = 8;
  instance.qualificationFallbackRoute = createSFURoute(
    SFU_PROVIDER.CLOUDFLARE_REALTIME,
    4,
    7,
    "active-sfu",
  );
  instance.participants.clear();
  instance.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    ws: null,
    sources: new Set(),
    providerCapabilities: new Set([SFU_PROVIDER.CLOUDFLARE_REALTIME]),
  });

  await instance.handleP2PFailure(
    { userId: "user-1", deviceId: "device-1" },
    "ice-timeout",
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(instance.route.kind, MEDIA_ROUTE_KIND.SFU);
  assert.equal(instance.route.provider, SFU_PROVIDER.CLOUDFLARE_REALTIME);
  assert.equal(instance.route.sourceRevision, 8);
  assert.equal(instance.route.reason, "p2p-failed-ice-timeout");
  assert.equal(instance.qualificationFallbackRoute, null);
});

test("stale P2P failure and qualification messages cannot change the active route", async () => {
  const instance = room();
  const ws = {
    readyState: 1,
    messages: [],
    send(message) {
      this.messages.push(JSON.parse(message));
    },
  };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.sessions.clear();
  instance.participants.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", {
    ...session,
    ws,
    sources: new Set(),
  });
  instance.route = createP2PRoute("direct", 9, 1, "qualified-direct-mesh");
  instance.epoch = 9;

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_FAILED,
    data: { epoch: 8, reason: "late" },
  });
  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.P2P_QUALIFIED,
    data: { epoch: 9, qualifiedPeerIds: [] },
  });

  assert.equal(instance.route.reason, "qualified-direct-mesh");
  assert.equal(ws.messages.length, 0);
});

test("provider and topology readiness reject stale source revisions", async () => {
  const instance = room();
  const ws = {
    readyState: 1,
    send() {},
    serializeAttachment() {},
  };
  const session = {
    authenticated: true,
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
  };
  instance.sessions.clear();
  instance.participants.clear();
  instance.sessions.set(ws, session);
  instance.participants.set("user-1:device-1", { ...session, ws });
  instance.pendingRoute = createSFURoute(
    SFU_PROVIDER.MEDIASOUP,
    12,
    6,
    "provider-transition",
  );

  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.PROVIDER_READY,
    data: {
      provider: SFU_PROVIDER.MEDIASOUP,
      epoch: 12,
      sourceRevision: 5,
    },
  });
  await instance.handleMessage(ws, session, {
    type: MEDIA_CONTROL_MESSAGE_TYPES.TOPOLOGY_READY,
    data: { target: "sfu", epoch: 12, sourceRevision: 5 },
  });

  assert.equal(instance.providerReadiness.size, 0);
  assert.equal(instance.transitionReadiness.size, 0);
});
