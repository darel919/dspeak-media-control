import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_QUANTUM_US,
  compatibilityAudioLatencyCapabilities,
  computeEffectiveAudioLatencyMode,
  effectiveAudioQuantumUs,
  normalizeAudioLatencyCapabilities,
  supportedAudioQuantaUs,
} from "../src/audio-latency-capabilities.ts";
import type { AudioLatencyCapabilitiesV1 } from "../src/domain-types.ts";

function ultraLowCapabilities(
  overrides: Partial<AudioLatencyCapabilitiesV1> = {},
): AudioLatencyCapabilitiesV1 {
  return {
    version: 1,
    nativeAudioEngine: true,
    restrictedLowDelayOpus: true,
    captureQuantaUs: [2500, 5000, 10000],
    encodeFrameDurationsUs: [2500, 5000, 10000],
    decodeFrameDurationsUs: [2500, 5000, 10000],
    renderQuantaUs: [2500, 5000, 10000],
    ...overrides,
  };
}

test("compatibility defaults describe old clients", () => {
  const caps = compatibilityAudioLatencyCapabilities();
  assert.equal(caps.nativeAudioEngine, false);
  assert.equal(caps.restrictedLowDelayOpus, false);
  assert.deepEqual(caps.captureQuantaUs, [10000]);
  assert.deepEqual(supportedAudioQuantaUs(caps), [10000]);
});

test("normalization is fail-closed on malformed input", () => {
  assert.deepEqual(
    normalizeAudioLatencyCapabilities(null),
    compatibilityAudioLatencyCapabilities(),
  );
  assert.deepEqual(
    normalizeAudioLatencyCapabilities("ultra"),
    compatibilityAudioLatencyCapabilities(),
  );
  assert.deepEqual(
    normalizeAudioLatencyCapabilities({ version: 2 }),
    compatibilityAudioLatencyCapabilities(),
  );
  assert.deepEqual(
    normalizeAudioLatencyCapabilities({
      version: 1,
      captureQuantaUs: [],
      encodeFrameDurationsUs: [10000],
      decodeFrameDurationsUs: [10000],
      renderQuantaUs: [10000],
    }),
    compatibilityAudioLatencyCapabilities(),
  );
  const normalized = normalizeAudioLatencyCapabilities({
    version: 1,
    nativeAudioEngine: "yes",
    restrictedLowDelayOpus: true,
    captureQuantaUs: [2500, 5000],
    encodeFrameDurationsUs: [2500],
    decodeFrameDurationsUs: [2500],
    renderQuantaUs: [10000],
  });
  assert.equal(normalized.nativeAudioEngine, false);
  assert.equal(normalized.restrictedLowDelayOpus, true);
  assert.deepEqual(normalized.captureQuantaUs, [2500, 5000]);
});

test("supported quanta are the intersection of all pipeline stages", () => {
  const caps = ultraLowCapabilities({ renderQuantaUs: [5000, 10000] });
  assert.deepEqual(supportedAudioQuantaUs(caps), [5000, 10000]);
  const broken = ultraLowCapabilities({
    captureQuantaUs: [2500],
    encodeFrameDurationsUs: [5000],
    decodeFrameDurationsUs: [5000],
    renderQuantaUs: [5000],
  });
  assert.deepEqual(supportedAudioQuantaUs(broken), [10000]);
});

test("effective quantum prefers the smallest supported", () => {
  assert.equal(effectiveAudioQuantumUs(ultraLowCapabilities()), 2500);
  assert.equal(
    effectiveAudioQuantumUs(
      ultraLowCapabilities({
        captureQuantaUs: [5000, 10000],
        encodeFrameDurationsUs: [5000, 10000],
        decodeFrameDurationsUs: [5000, 10000],
        renderQuantaUs: [5000, 10000],
      }),
    ),
    5000,
  );
  assert.equal(
    effectiveAudioQuantumUs(compatibilityAudioLatencyCapabilities()),
    10000,
  );
});

test("effective mode follows requested profile and quantum", () => {
  assert.equal(
    computeEffectiveAudioLatencyMode("standard", AUDIO_QUANTUM_US.MS_2_5),
    "standard-10ms",
  );
  assert.equal(
    computeEffectiveAudioLatencyMode("ultra-low", AUDIO_QUANTUM_US.MS_2_5),
    "ultra-low-2_5ms",
  );
  assert.equal(
    computeEffectiveAudioLatencyMode("ultra-low", AUDIO_QUANTUM_US.MS_5),
    "ultra-low-5ms",
  );
  assert.equal(
    computeEffectiveAudioLatencyMode("ultra-low", AUDIO_QUANTUM_US.MS_10),
    "ultra-low-10ms-compat",
  );
});
