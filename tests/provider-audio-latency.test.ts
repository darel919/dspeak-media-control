import assert from "node:assert/strict";
import test from "node:test";
import {
  getProviderAudioCapabilities,
  providerSupportsQuantum,
  providerEffectiveQuantumUs,
} from "../src/provider-audio-latency.ts";

test("uncertified providers are compatibility-only and unvalidated", () => {
  for (const provider of ["mediasoup", "cloudflare-realtime", "unknown"]) {
    const capabilities = getProviderAudioCapabilities(provider);
    assert.deepEqual([...capabilities.supportedQuantaUs], [10000]);
    assert.equal(capabilities.validated, false);
    assert.equal(providerSupportsQuantum(provider, 2500), false);
    assert.equal(providerSupportsQuantum(provider, 5000), false);
    assert.equal(providerSupportsQuantum(provider, 10000), true);
  }
});

test("capability is never inferred from provider name", () => {
  assert.equal(providerSupportsQuantum("cloudflare-realtime", 5000), false);
  assert.equal(providerSupportsQuantum("mediasoup", 2500), false);
});

test("effective quantum degrades to 10 ms compatibility", () => {
  assert.equal(providerEffectiveQuantumUs("mediasoup", "standard"), 10000);
  assert.equal(providerEffectiveQuantumUs("mediasoup", "ultra-low"), 10000);
  assert.equal(providerEffectiveQuantumUs("anything", "ultra-low"), 10000);
});
