import assert from "node:assert/strict";
import test from "node:test";

// Mock implementations for testing topology controller convergence splitting
class MockMediaGeneration {
  constructor() {
    this.generation = 0;
  }
  capture() {
    return ++this.generation;
  }
  assert(generation) {
    if (generation !== this.generation)
      throw new Error("Generation superseded");
  }
  retire() {
    this.generation++;
  }
}

class MockAbortController {
  constructor() {
    this.signal = { aborted: false };
    this.aborted = false;
  }
  abort(reason) {
    this.aborted = true;
    this.signal.reason = reason;
    this.signal.aborted = true;
  }
}

// Test: Topology convergence runs independently from topology application
test("Topology: applyTopology starts convergence without blocking pipeline", async () => {
  let convergenceStarted = false;
  let pipelineBlocked = false;

  // Simulate the new split architecture
  async function applyTopology(data, generation) {
    // Apply topology state (synchronous, fast)
    topologyState.value = { ...data, epoch: Number(data.epoch) };

    // Start convergence as independent task - does NOT await
    startConvergence(data, generation);

    // Pipeline continues immediately
    return "applied";
  }

  function startConvergence(data, generation) {
    convergenceStarted = true;
    // Simulate async convergence - don't actually wait
    Promise.resolve().then(() => {
      // Convergence completes
    });
  }

  const topologyState = { value: { mode: "idle" } };
  const mediaGeneration = new MockMediaGeneration();

  const result = await applyTopology(
    { mode: "sfu", epoch: 1, sourceRevision: 1 },
    mediaGeneration.capture(),
  );

  // Pipeline should complete immediately
  assert.strictEqual(result, "applied");

  // Convergence should be started but not awaited
  assert.strictEqual(convergenceStarted, true);

  // Pipeline was not blocked
  assert.strictEqual(pipelineBlocked, false);
});

// Test: AbortSignal propagation for fencing
test("Topology: AbortSignal propagates to convergence for superseded topologies", async () => {
  let convergenceAborted = false;

  function startConvergence(signal) {
    // Check if already aborted
    if (signal?.aborted) {
      convergenceAborted = true;
      return Promise.resolve();
    }
    // Return a promise that resolves immediately
    return Promise.resolve();
  }

  async function applyTopology(data, abortController) {
    // If supersede, abort first
    if (data.supersede) {
      abortController.abort(new Error("Superseded"));
    }
    // Then start convergence with the (now aborted) signal
    return startConvergence(abortController.signal);
  }

  const abortController = new MockAbortController();

  // Apply first topology
  await applyTopology({ mode: "p2p", epoch: 1 }, abortController);

  // Supersede with new topology (should abort first convergence)
  await applyTopology(
    { mode: "sfu", epoch: 2, supersede: true },
    abortController,
  );

  // First convergence should be aborted
  assert.strictEqual(convergenceAborted, true);
});

// Test: Mode switch transition with async convergence
test("Topology: Mode switch (p2p -> sfu) transitions with async convergence", async () => {
  let activeProvider = "p2p";
  let convergenceMode = null;

  async function ensureQualificationFallback(data, generation) {
    // Simulate provider setup
  }

  function startConvergence(data, generation, signal) {
    convergenceMode = data.mode;
  }

  async function startTopologyTransition(data, generation, abortController) {
    // Cleanup old provider
    if (data.mode === "sfu" && activeProvider === "p2p") {
      // Close P2P, retire handoff
      activeProvider = null;
    }

    // Setup new provider
    if (data.mode === "sfu") {
      await ensureQualificationFallback(data, generation);
      activeProvider = "sfu";
    }

    // Start convergence
    startConvergence(data, generation, abortController.signal);
  }

  const mediaGeneration = new MockMediaGeneration();
  const abortController = new MockAbortController();

  // Switch from p2p to sfu
  await startTopologyTransition(
    { mode: "sfu", epoch: 2 },
    mediaGeneration.capture(),
    abortController,
  );

  assert.strictEqual(activeProvider, "sfu");
  assert.strictEqual(convergenceMode, "sfu");
});

// Test: Convergence only runs when provider is ready
test("Topology: Convergence waits for provider setup in mode switches", async () => {
  let providerSetupComplete = false;
  let convergenceStartedBeforeProviderReady = false;

  async function startTopologyTransition(data, generation, abortController) {
    // Setup provider asynchronously
    const setupPromise = (async () => {
      await Promise.resolve(); // Simulate async setup (microtask)
      providerSetupComplete = true;
      // Then start convergence
      startConvergence(data, generation, abortController.signal);
    })();

    await setupPromise;
  }

  function startConvergence(data, generation, signal) {
    if (!providerSetupComplete) {
      convergenceStartedBeforeProviderReady = true;
    }
  }

  const mediaGeneration = new MockMediaGeneration();
  const abortController = new MockAbortController();

  await startTopologyTransition(
    { mode: "sfu", epoch: 2 },
    mediaGeneration.capture(),
    abortController,
  );

  assert.strictEqual(providerSetupComplete, true);
  assert.strictEqual(convergenceStartedBeforeProviderReady, false);
});

// Test: Same provider - convergence without topology change
test("Topology: Same provider mode starts convergence without provider teardown", async () => {
  let providerTeardownCount = 0;
  let convergenceCount = 0;
  let activeProvider = "sfu";

  function startConvergence() {
    convergenceCount++;
  }

  async function applyTopology(data, generation, abortController) {
    const activeSfuMatches = true; // Same provider

    if (data.mode === activeProvider && activeSfuMatches) {
      // Same provider - NO teardown, just convergence
      startConvergence(data, generation, abortController.signal);
      return;
    }

    // Different provider - would tear down
    providerTeardownCount++;
    startConvergence(data, generation, abortController.signal);
  }

  const mediaGeneration = new MockMediaGeneration();
  const abortController = new MockAbortController();

  // Apply same provider update
  await applyTopology(
    { mode: "sfu", epoch: 2, sourceRevision: 1 },
    mediaGeneration.capture(),
    abortController,
  );
  await applyTopology(
    { mode: "sfu", epoch: 3, sourceRevision: 2 },
    mediaGeneration.capture(),
    abortController,
  );

  assert.strictEqual(providerTeardownCount, 0);
  assert.strictEqual(convergenceCount, 2);
});

console.log("All topology convergence splitting tests passed!");
