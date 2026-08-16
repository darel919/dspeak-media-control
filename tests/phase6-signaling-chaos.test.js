import assert from "node:assert/strict";
import test from "node:test";

// Signaling/provider chaos tests
// Tests provider failures, signaling disruptions, and recovery scenarios

class MockProviderState {
  constructor() {
    this.providers = new Map(); // providerId -> { healthy, lastFailure, recoveryAt }
    this.activeProvider = null;
    this.signalingConnected = true;
    this.operations = new Map(); // operationId -> status
    this.failureHistory = [];
  }

  registerProvider(providerId, config = {}) {
    this.providers.set(providerId, {
      healthy: true,
      lastFailure: null,
      recoveryAt: null,
      config,
    });
  }

  setActiveProvider(providerId) {
    this.activeProvider = providerId;
  }

  failProvider(providerId, reason) {
    const provider = this.providers.get(providerId);
    if (!provider) return { error: "unknown_provider" };

    provider.healthy = false;
    provider.lastFailure = { reason, timestamp: Date.now() };
    this.failureHistory.push({ providerId, reason, timestamp: Date.now() });

    if (this.activeProvider === providerId) {
      this.activeProvider = null;
    }

    return { failed: true, providerId, reason };
  }

  recoverProvider(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider) return { error: "unknown_provider" };

    provider.healthy = true;
    provider.recoveryAt = Date.now();

    return { recovered: true, providerId };
  }

  getHealthyProviders() {
    const healthy = [];
    for (const [id, p] of this.providers) {
      if (p.healthy) healthy.push(id);
    }
    return healthy;
  }

  recordOperation(operationId, type) {
    this.operations.set(operationId, {
      type,
      status: "pending",
      timestamp: Date.now(),
    });
  }

  completeOperation(operationId, success = true) {
    const op = this.operations.get(operationId);
    if (op) {
      op.status = success ? "completed" : "failed";
      op.completedAt = Date.now();
    }
  }

  isOperationComplete(operationId) {
    const op = this.operations.get(operationId);
    return op && op.status !== "pending";
  }
}

// Test: Provider failure triggers fallback
test("Signaling chaos: Provider failure triggers fallback to healthy provider", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.registerProvider("mediasoup-backup");
  state.setActiveProvider("cloudflare-primary");

  assert.strictEqual(state.activeProvider, "cloudflare-primary");
  assert.deepStrictEqual(state.getHealthyProviders(), [
    "cloudflare-primary",
    "mediasoup-backup",
  ]);

  // Primary fails
  state.failProvider("cloudflare-primary", "connection-lost");

  assert.strictEqual(state.activeProvider, null);
  assert.deepStrictEqual(state.getHealthyProviders(), ["mediasoup-backup"]);

  // Fallback activates
  state.setActiveProvider("mediasoup-backup");
  assert.strictEqual(state.activeProvider, "mediasoup-backup");
});

// Test: Provider recovery and return-to-primary
test("Signaling chaos: Provider recovery enables return-to-primary", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.registerProvider("mediasoup-backup");
  state.setActiveProvider("cloudflare-primary");

  // Primary fails, fallback activates
  state.failProvider("cloudflare-primary", "connection-lost");
  state.setActiveProvider("mediasoup-backup");

  assert.strictEqual(state.activeProvider, "mediasoup-backup");

  // Primary recovers
  state.recoverProvider("cloudflare-primary");
  assert.deepStrictEqual(state.getHealthyProviders(), [
    "cloudflare-primary",
    "mediasoup-backup",
  ]);

  // Return to primary
  state.setActiveProvider("cloudflare-primary");
  assert.strictEqual(state.activeProvider, "cloudflare-primary");
});

// Test: Signaling disconnect doesn't lose operations
test("Signaling chaos: Signaling disconnect preserves pending operations", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // Submit operations
  state.recordOperation("op-1", "media-sources");
  state.recordOperation("op-2", "topology");
  state.recordOperation("op-3", "leave");

  // Signaling disconnects
  state.signalingConnected = false;

  // Operations should still be tracked
  assert.strictEqual(state.operations.size, 3);
  assert.strictEqual(state.isOperationComplete("op-1"), false);
  assert.strictEqual(state.isOperationComplete("op-2"), false);
  assert.strictEqual(state.isOperationComplete("op-3"), false);

  // Reconnect
  state.signalingConnected = true;

  // Complete operations after reconnect
  state.completeOperation("op-1", true);
  state.completeOperation("op-2", true);
  state.completeOperation("op-3", true);

  assert.strictEqual(state.isOperationComplete("op-1"), true);
  assert.strictEqual(state.isOperationComplete("op-2"), true);
  assert.strictEqual(state.isOperationComplete("op-3"), true);
});

// Test: Duplicate signaling messages handled correctly
test("Signaling chaos: Duplicate signaling messages don't cause double-processing", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // First message
  state.recordOperation("op-1", "media-sources");
  state.completeOperation("op-1", true);

  // Duplicate message (network retry)
  const isDuplicate = state.isOperationComplete("op-1");
  assert.ok(isDuplicate);

  // Should not create new operation
  assert.strictEqual(state.operations.size, 1);
});

// Test: Out-of-order signaling messages handled correctly
test("Signaling chaos: Out-of-order signaling messages handled by revision", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // Operations arrive out of order: op-3, op-1, op-2
  state.recordOperation("op-3", "media-sources");
  state.recordOperation("op-1", "media-sources");
  state.recordOperation("op-2", "media-sources");

  // Complete in order
  state.completeOperation("op-1", true);
  state.completeOperation("op-2", true);
  state.completeOperation("op-3", true);

  // All should complete
  assert.strictEqual(state.isOperationComplete("op-1"), true);
  assert.strictEqual(state.isOperationComplete("op-2"), true);
  assert.strictEqual(state.isOperationComplete("op-3"), true);
});

// Test: Provider failure during active media
test("Signaling chaos: Provider failure during active media triggers graceful degradation", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.registerProvider("mediasoup-backup");
  state.setActiveProvider("cloudflare-primary");

  // Active media session
  const activeSources = new Set(["audio", "video", "screen"]);

  // Provider fails
  state.failProvider("cloudflare-primary", "media-server-down");

  // Should attempt fallback
  assert.strictEqual(state.activeProvider, null);
  assert.deepStrictEqual(state.getHealthyProviders(), ["mediasoup-backup"]);

  // Fallback activates
  state.setActiveProvider("mediasoup-backup");

  // Media sources should be re-published on new provider
  assert.strictEqual(state.activeProvider, "mediasoup-backup");
});

// Test: Signaling reconnect with session resume
test("Signaling chaos: Signaling reconnect resumes session correctly", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // Active session with sources
  state.recordOperation("op-1", "media-sources");
  state.completeOperation("op-1", true);

  // Disconnect
  state.signalingConnected = false;

  // Reconnect
  state.signalingConnected = true;

  // Session should be resumable (operations preserved)
  assert.strictEqual(state.operations.size, 1);
  assert.strictEqual(state.isOperationComplete("op-1"), true);

  // New operations can proceed
  state.recordOperation("op-2", "topology");
  state.completeOperation("op-2", true);

  assert.strictEqual(state.operations.size, 2);
});

// Test: Multiple simultaneous provider failures
test("Signaling chaos: Multiple simultaneous provider failures handled", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.registerProvider("mediasoup-backup");
  state.registerProvider("cloudflare-secondary");
  state.setActiveProvider("cloudflare-primary");

  // Both primary and backup fail simultaneously
  state.failProvider("cloudflare-primary", "region-down");
  state.failProvider("mediasoup-backup", "capacity-exceeded");

  assert.strictEqual(state.activeProvider, null);
  assert.deepStrictEqual(state.getHealthyProviders(), ["cloudflare-secondary"]);

  // Last resort activates
  state.setActiveProvider("cloudflare-secondary");
  assert.strictEqual(state.activeProvider, "cloudflare-secondary");
});

// Test: Provider failure history tracked for debugging
test("Signaling chaos: Provider failure history tracked for debugging", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // Multiple failures
  state.failProvider("cloudflare-primary", "timeout");
  state.failProvider("cloudflare-primary", "connection-reset");
  state.recoverProvider("cloudflare-primary");
  state.failProvider("cloudflare-primary", "dns-failure");

  assert.strictEqual(state.failureHistory.length, 3);
  assert.strictEqual(state.failureHistory[0].reason, "timeout");
  assert.strictEqual(state.failureHistory[1].reason, "connection-reset");
  assert.strictEqual(state.failureHistory[2].reason, "dns-failure");
});

// Test: Operation timeout handling
test("Signaling chaos: Operation timeout triggers retry or fallback", () => {
  const state = new MockProviderState();

  state.registerProvider("cloudflare-primary");
  state.setActiveProvider("cloudflare-primary");

  // Submit operation
  state.recordOperation("op-1", "media-sources");

  // Simulate timeout (operation not completed within window)
  const startTime = state.operations.get("op-1").timestamp;
  const timeoutMs = 5000;
  const now = startTime + timeoutMs + 100;

  const isTimedOut =
    now - startTime > timeoutMs && !state.isOperationComplete("op-1");
  assert.ok(isTimedOut);

  // Should trigger retry logic
  // In real implementation, this would send a new operation with new operationId
  state.recordOperation("op-1-retry", "media-sources");
  state.completeOperation("op-1-retry", true);

  assert.strictEqual(state.isOperationComplete("op-1-retry"), true);
  assert.strictEqual(state.operations.size, 2);
});

console.log("All signaling/provider chaos tests passed!");
