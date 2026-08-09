import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_ROUTE_KIND,
  MEDIA_CONTROL_MESSAGE_TYPES,
  SFU_PROVIDER,
  createSFURoute,
} from "../src/protocol.js";
import { handleRoomMessage } from "../src/media-room-messages.ts";
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
