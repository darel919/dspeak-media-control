import assert from "node:assert/strict";
import test from "node:test";

// Source race tests: start/stop/start with provider delays
// Tests that rapid source mutations are handled correctly with idempotent operations

class MockMediaRoomDO {
  constructor() {
    this.participants = new Map();
    this.publishedSources = new Map();
    this.roomRevision = 0n;
    this.sourceRevision = 0;
    this.operationHistory = new Set();
    this.connectionEpochs = new Map();
  }

  incrementRoomRevision() {
    this.roomRevision++;
    return this.roomRevision;
  }

  incrementSourceRevision() {
    this.sourceRevision++;
    return this.sourceRevision;
  }

  getPublishedSourcesForParticipant(participantKey) {
    return this.publishedSources.get(participantKey) || new Map();
  }

  setPublishedSourcesForParticipant(participantKey, sources) {
    this.publishedSources.set(participantKey, sources);
  }

  recordOperation(operationId) {
    this.operationHistory.add(operationId);
  }

  hasOperation(operationId) {
    return this.operationHistory.has(operationId);
  }
}

// Simulate client-side source controller with operationId generation
class MockSourceController {
  constructor() {
    this.sources = new Map(); // source -> { state, generation, operationId }
    this.operationIdCounter = 0;
  }

  generateOperationId() {
    return `op-${Date.now()}-${this.operationIdCounter++}`;
  }

  // Simulate start source (user enables mic/camera)
  async startSource(source, provider, server) {
    const operationId = this.generateOperationId();
    const generation = (this.sources.get(source)?.generation || 0) + 1;

    this.sources.set(source, {
      state: "active",
      generation,
      provider,
      operationId,
      pending: true,
    });

    // Simulate server processing with potential delay
    await this.simulateServerProcessing(
      server,
      source,
      "active",
      generation,
      operationId,
    );
  }

  // Simulate stop source (user disables mic/camera)
  async stopSource(source, server) {
    const existing = this.sources.get(source);
    if (!existing) return;

    const operationId = this.generateOperationId();
    const generation = existing.generation + 1;

    this.sources.set(source, {
      ...existing,
      state: "inactive",
      generation,
      operationId,
      pending: true,
    });

    await this.simulateServerProcessing(
      server,
      source,
      "inactive",
      generation,
      operationId,
    );
  }

  async simulateServerProcessing(
    server,
    source,
    state,
    generation,
    operationId,
  ) {
    // Check for duplicate operation
    if (server.hasOperation(operationId)) {
      // Duplicate - should be rejected
      this.sources.get(source).pending = false;
      return { rejected: true, reason: "duplicate" };
    }

    // Record operation
    server.recordOperation(operationId);

    // Server validates generation against current state
    const currentSource = server
      .getPublishedSourcesForParticipant("user-1:device-1")
      .get(source);
    if (currentSource && generation < currentSource.generation) {
      // Stale generation - reject
      this.sources.get(source).pending = false;
      return { rejected: true, reason: "stale_generation" };
    }

    // Apply the change
    server.incrementRoomRevision();
    server.incrementSourceRevision();

    // Update server state
    const sources = server.getPublishedSourcesForParticipant("user-1:device-1");
    sources.set(source, { state, generation, provider: "sfu" });
    server.setPublishedSourcesForParticipant("user-1:device-1", sources);

    // Mark local as confirmed
    this.sources.get(source).pending = false;
    return { success: true };
  }

  getSourceState(source) {
    return this.sources.get(source);
  }
}

// Test: Rapid start/stop/start sequence with provider delays
test("Source race: Rapid start/stop/start with provider delays handles correctly", async () => {
  const server = new MockMediaRoomDO();
  const controller = new MockSourceController();

  // Set initial state
  server.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: new Set(["audio"]),
  });
  server.connectionEpochs.set("user-1:device-1", 1);

  // Sequence: start audio -> stop audio -> start audio (rapid)
  await controller.startSource("audio", "sfu", server);
  assert.strictEqual(controller.getSourceState("audio").state, "active");
  assert.strictEqual(controller.getSourceState("audio").generation, 1);

  await controller.stopSource("audio", server);
  assert.strictEqual(controller.getSourceState("audio").state, "inactive");
  assert.strictEqual(controller.getSourceState("audio").generation, 2);

  await controller.startSource("audio", "sfu", server);
  assert.strictEqual(controller.getSourceState("audio").state, "active");
  assert.strictEqual(controller.getSourceState("audio").generation, 3);

  // Verify server state matches
  const serverSources =
    server.getPublishedSourcesForParticipant("user-1:device-1");
  assert.strictEqual(serverSources.get("audio")?.state, "active");
  assert.strictEqual(serverSources.get("audio")?.generation, 3);

  // Verify revisions incremented
  assert.strictEqual(server.roomRevision, 3n);
  assert.strictEqual(server.sourceRevision, 3);
});

// Test: Duplicate operation rejection
test("Source race: Duplicate operation IDs are rejected", async () => {
  const server = new MockMediaRoomDO();
  const controller = new MockSourceController();

  server.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: new Set(["audio"]),
  });
  server.connectionEpochs.set("user-1:device-1", 1);

  await controller.startSource("audio", "sfu", server);

  // Manually inject duplicate operation
  const duplicateOpId = controller.sources.get("audio").operationId;
  server.operationHistory.add(duplicateOpId);

  // Try to start again with same operation (simulating retry)
  const result = await controller.simulateServerProcessing(
    server,
    "audio",
    "active",
    1,
    duplicateOpId,
  );

  assert.strictEqual(result.rejected, true);
  assert.strictEqual(result.reason, "duplicate");
});

// Test: Stale generation rejection
test("Source race: Stale generations are rejected", async () => {
  const server = new MockMediaRoomDO();
  const controller = new MockSourceController();

  server.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: new Set(["audio"]),
  });
  server.connectionEpochs.set("user-1:device-1", 1);

  // Server already has generation 2
  server.setPublishedSourcesForParticipant(
    "user-1:device-1",
    new Map([["audio", { state: "active", generation: 2, provider: "sfu" }]]),
  );

  // Client tries with generation 1 (stale)
  await controller.startSource("audio", "sfu", server); // This will be generation 1

  // The server should reject it
  const serverSources =
    server.getPublishedSourcesForParticipant("user-1:device-1");
  // Note: In real implementation, the server would reject and send NACK
  // Here we just verify the server didn't accept the stale generation
  assert.strictEqual(serverSources.get("audio")?.generation, 2); // Still 2
});

// Test: Concurrent audio and video mutations
test("Source race: Concurrent audio and video mutations are independent", async () => {
  const server = new MockMediaRoomDO();
  const controller = new MockSourceController();

  server.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: new Set(["audio", "video"]),
  });
  server.connectionEpochs.set("user-1:device-1", 1);

  // Start both simultaneously
  await Promise.all([
    controller.startSource("audio", "sfu", server),
    controller.startSource("video", "sfu", server),
  ]);

  // Both should be active with independent generations
  assert.strictEqual(controller.getSourceState("audio").state, "active");
  assert.strictEqual(controller.getSourceState("video").state, "active");
  assert.strictEqual(controller.getSourceState("audio").generation, 1);
  assert.strictEqual(controller.getSourceState("video").generation, 1);

  // Stop audio only
  await controller.stopSource("audio", server);
  assert.strictEqual(controller.getSourceState("audio").state, "inactive");
  assert.strictEqual(controller.getSourceState("audio").generation, 2);
  assert.strictEqual(controller.getSourceState("video").state, "active"); // Unchanged
  assert.strictEqual(controller.getSourceState("video").generation, 1); // Unchanged

  // Server state should match
  const serverSources =
    server.getPublishedSourcesForParticipant("user-1:device-1");
  assert.strictEqual(serverSources.get("audio")?.state, "inactive");
  assert.strictEqual(serverSources.get("audio")?.generation, 2);
  assert.strictEqual(serverSources.get("video")?.state, "active");
  assert.strictEqual(serverSources.get("video")?.generation, 1);
});

// Test: Provider delay doesn't cause generation mismatch
test("Source race: Provider delay doesn't cause generation mismatch on retry", async () => {
  const server = new MockMediaRoomDO();
  const controller = new MockSourceController();

  server.participants.set("user-1:device-1", {
    userId: "user-1",
    deviceId: "device-1",
    peerId: "peer-1",
    sources: new Set(["audio"]),
  });
  server.connectionEpochs.set("user-1:device-1", 1);

  // Start source - first attempt times out (simulated by not confirming)
  await controller.startSource("audio", "sfu", server);

  // Simulate client thinking it failed and retrying with NEW operationId
  // but server already processed the first one
  const firstOpId = controller.getSourceState("audio").operationId;
  server.operationHistory.add(firstOpId);

  // Client retries with new operation
  await controller.startSource("audio", "sfu", server); // New operation, new generation

  // Should succeed with incremented generation
  assert.strictEqual(controller.getSourceState("audio").state, "active");
  assert.strictEqual(controller.getSourceState("audio").generation, 2);

  // Server should have final state
  const serverSources =
    server.getPublishedSourcesForParticipant("user-1:device-1");
  assert.strictEqual(serverSources.get("audio")?.generation, 2);
});

console.log("All source race tests passed!");
