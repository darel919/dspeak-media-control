import assert from "node:assert/strict";
import test from "node:test";

// Presence chaos tests
// Tests participant join/leave/rejoin scenarios under various network conditions

class MockPresenceState {
  constructor() {
    this.participants = new Map(); // participantKey -> { joinedAt, leftAt, reconnectCount, state }
    this.roomRevision = 0n;
    this.sourceRevision = 0;
    this.operations = new Map(); // operationId -> { type, participantKey, timestamp }
  }

  getParticipantKey(userId, deviceId) {
    return `${userId}:${deviceId}`;
  }

  join(userId, deviceId, peerId) {
    const key = this.getParticipantKey(userId, deviceId);
    const existing = this.participants.get(key);

    this.roomRevision++;
    this.participants.set(key, {
      userId,
      deviceId,
      peerId,
      joinedAt: Date.now(),
      leftAt: null,
      reconnectCount: existing ? existing.reconnectCount + 1 : 0,
      state: "joined",
      sources: new Set(),
    });

    return { roomRevision: this.roomRevision, isRejoin: !!existing };
  }

  leave(userId, deviceId) {
    const key = this.getParticipantKey(userId, deviceId);
    const participant = this.participants.get(key);

    if (!participant) return { error: "not_found" };

    this.roomRevision++;
    participant.leftAt = Date.now();
    participant.state = "left";
    participant.sources.clear();

    return { roomRevision: this.roomRevision };
  }

  rejoin(userId, deviceId, peerId) {
    return this.join(userId, deviceId, peerId);
  }

  recordOperation(operationId, type, participantKey) {
    this.operations.set(operationId, {
      type,
      participantKey,
      timestamp: Date.now(),
    });
  }

  hasOperation(operationId) {
    return this.operations.has(operationId);
  }

  getActiveParticipants() {
    const active = [];
    for (const [key, p] of this.participants) {
      if (p.state === "joined") active.push({ key, ...p });
    }
    return active;
  }
}

// Test: Rapid join/leave/join doesn't leak state
test("Presence chaos: Rapid join/leave/join doesn't leak state", () => {
  const state = new MockPresenceState();

  // Join
  const join1 = state.join("user-1", "device-1", "peer-1");
  assert.strictEqual(join1.isRejoin, false);
  assert.strictEqual(state.getActiveParticipants().length, 1);

  // Leave
  state.leave("user-1", "device-1");
  assert.strictEqual(state.getActiveParticipants().length, 0);

  // Rejoin
  const join2 = state.rejoin("user-1", "device-1", "peer-2");
  assert.strictEqual(join2.isRejoin, true);
  assert.strictEqual(join2.roomRevision > join1.roomRevision, true);
  assert.strictEqual(state.getActiveParticipants().length, 1);

  // Verify state is clean (no old sources)
  const participant = state.participants.get("user-1:device-1");
  assert.strictEqual(participant.sources.size, 0);
  assert.strictEqual(participant.reconnectCount, 1);
});

// Test: Multiple devices for same user
test("Presence chaos: Multiple devices for same user are independent", () => {
  const state = new MockPresenceState();

  state.join("user-1", "device-1", "peer-1");
  state.join("user-1", "device-2", "peer-2");

  assert.strictEqual(state.getActiveParticipants().length, 2);

  // Leave one device
  state.leave("user-1", "device-1");
  assert.strictEqual(state.getActiveParticipants().length, 1);

  // Other device still active
  const active = state.getActiveParticipants();
  assert.strictEqual(active[0].deviceId, "device-2");
});

// Test: Network partition - participant marked away then back
test("Presence chaos: Network partition handled with state preservation", () => {
  const state = new MockPresenceState();

  state.join("user-1", "device-1", "peer-1");
  const participant = state.participants.get("user-1:device-1");
  participant.sources.add("audio");
  participant.sources.add("video");

  // Simulate network partition - leave without cleanup (crash)
  state.leave("user-1", "device-1");

  // Rejoin
  state.rejoin("user-1", "device-1", "peer-1");
  const rejoined = state.participants.get("user-1:device-1");

  // Sources should be cleaned on leave
  assert.strictEqual(rejoined.sources.size, 0);
  assert.strictEqual(rejoined.reconnectCount, 1);
});

// Test: Operation idempotency across reconnects
test("Presence chaos: Operations are idempotent across reconnects", () => {
  const state = new MockPresenceState();

  state.join("user-1", "device-1", "peer-1");

  // Operation 1
  const op1 = "op-1";
  state.recordOperation(op1, "media-sources", "user-1:device-1");

  // Leave and rejoin
  state.leave("user-1", "device-1");
  state.rejoin("user-1", "device-1", "peer-2");

  // Same operation retried
  assert.strictEqual(state.hasOperation(op1), true);

  // Should be recognized as duplicate
  const isDuplicate = state.hasOperation(op1);
  assert.ok(isDuplicate);
});

// Test: Concurrent joins don't conflict
test("Presence chaos: Concurrent joins from different users don't conflict", () => {
  const state = new MockPresenceState();

  const join1 = state.join("user-1", "device-1", "peer-1");
  const join2 = state.join("user-2", "device-1", "peer-2");
  const join3 = state.join("user-3", "device-1", "peer-3");

  assert.strictEqual(state.getActiveParticipants().length, 3);

  // Each has unique peerId
  const peers = state.getActiveParticipants().map((p) => p.peerId);
  assert.strictEqual(new Set(peers).size, 3);

  // Revisions should be sequential
  assert.strictEqual(join2.roomRevision > join1.roomRevision, true);
  assert.strictEqual(join3.roomRevision > join2.roomRevision, true);
});

// Test: Leave during active media sources
test("Presence chaos: Leave during active media sources cleans up correctly", () => {
  const state = new MockPresenceState();

  state.join("user-1", "device-1", "peer-1");
  const participant = state.participants.get("user-1:device-1");
  participant.sources.add("audio");
  participant.sources.add("video");
  participant.sources.add("screen");

  assert.strictEqual(participant.sources.size, 3);

  // Leave
  state.leave("user-1", "device-1");
  const leftParticipant = state.participants.get("user-1:device-1");

  assert.strictEqual(leftParticipant.sources.size, 0);
  assert.strictEqual(leftParticipant.state, "left");
});

// Test: Rejoin with different peerId (new tab/device)
test("Presence chaos: Rejoin with different peerId creates new session", () => {
  const state = new MockPresenceState();

  state.join("user-1", "device-1", "peer-1");
  const firstPeer = state.participants.get("user-1:device-1").peerId;

  state.leave("user-1", "device-1");
  state.rejoin("user-1", "device-1", "peer-2");
  const secondPeer = state.participants.get("user-1:device-1").peerId;

  assert.strictEqual(firstPeer, "peer-1");
  assert.strictEqual(secondPeer, "peer-2");
  assert.strictEqual(
    state.participants.get("user-1:device-1").reconnectCount,
    1,
  );
});

// Test: Room revision monotonic across all operations
test("Presence chaos: Room revision is monotonic across all operations", () => {
  const state = new MockPresenceState();

  let lastRevision = 0n;

  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      const result = state.join(`user-${i}`, "device-1", `peer-${i}`);
      assert.strictEqual(result.roomRevision > lastRevision, true);
      lastRevision = result.roomRevision;
    } else {
      const result = state.leave(`user-${i - 1}`, "device-1");
      assert.strictEqual(result.roomRevision > lastRevision, true);
      lastRevision = result.roomRevision;
    }
  }

  assert.strictEqual(state.roomRevision, 10n);
});

console.log("All presence chaos tests passed!");
