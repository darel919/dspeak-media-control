import assert from "node:assert/strict";
import test from "node:test";
import {
  ULTRA_LOW_MESH_BUDGET,
  checkP2PEligibility,
  getP2PQualificationLimit,
} from "../src/protocol.ts";
import { qoeWouldImprove, rankQoeCandidates } from "../src/qoe.ts";

test("ultra-low audio-only mesh budget is conservative", () => {
  assert.equal(ULTRA_LOW_MESH_BUDGET, 4);
  assert.equal(getP2PQualificationLimit("auto", false, "ultra-low"), 4);
  assert.equal(getP2PQualificationLimit("direct", false, "ultra-low"), 4);
  assert.equal(getP2PQualificationLimit("auto", true, "ultra-low"), 4);
  assert.equal(
    getP2PQualificationLimit("auto", true, "ultra-low"),
    getP2PQualificationLimit("auto", true, "standard"),
  );
  assert.equal(getP2PQualificationLimit("auto", false, "standard"), 8);
});

test("ultra-low eligibility gates participant count and server sources", () => {
  assert.deepEqual(
    checkP2PEligibility({
      connectionMode: "auto",
      participantCount: 5,
      hasVideo: false,
      audioLatencyProfile: "ultra-low",
    }),
    { eligible: false, reason: "participant-count-5-exceeds-4" },
  );
  assert.deepEqual(
    checkP2PEligibility({
      connectionMode: "auto",
      participantCount: 4,
      hasVideo: false,
      audioLatencyProfile: "ultra-low",
    }),
    { eligible: true },
  );
  const blocked = checkP2PEligibility({
    connectionMode: "direct",
    participantCount: 2,
    hasVideo: false,
    requiredSources: ["server-dj"],
    audioLatencyProfile: "ultra-low",
  });
  assert.equal(blocked.eligible, false);
  if (!blocked.eligible)
    assert.equal(blocked.reason, "server-source-requires-auto-mode");
});

function candidate(
  overrides: Record<string, unknown> = {},
): Parameters<typeof rankQoeCandidates>[0][number] {
  return {
    provider: "p2p",
    paths: [{ rttMs: 40 }],
    viable: true,
    stableSince: Date.now() - 60_000,
    ...overrides,
  };
}

test("ultra-low objective ranks latency before the balanced score", () => {
  const fast = candidate({
    provider: "fast",
    paths: [{ rttMs: 10, packetLossPercent: 1 }],
  });
  const steady = candidate({
    provider: "steady",
    paths: [{ rttMs: 30 }],
  });
  const ultra = rankQoeCandidates([steady, fast], {
    objective: "ultra-low",
  }).map((entry) => entry.provider);
  assert.deepEqual(ultra, ["fast", "steady"]);
  const standard = rankQoeCandidates([fast, steady]).map(
    (entry) => entry.provider,
  );
  assert.deepEqual(standard, ["steady", "fast"]);
});

test("viability is a hard gate under both objectives", () => {
  const inviableFast = candidate({ provider: "inviable", viable: false });
  const viableSlow = candidate({
    provider: "viable",
    paths: [{ rttMs: 200 }],
  });
  for (const options of [
    { objective: "standard" as const },
    { objective: "ultra-low" as const },
  ]) {
    assert.deepEqual(
      rankQoeCandidates([inviableFast, viableSlow], options).map(
        (entry) => entry.provider,
      ),
      ["viable", "inviable"],
    );
  }
});

test("ultra-low hysteresis demands more stability and margin", () => {
  const [active] = rankQoeCandidates([
    candidate({ provider: "sfu", paths: [{ rttMs: 100 }] }),
  ]);
  const [challenger] = rankQoeCandidates([
    candidate({ provider: "p2p", paths: [{ rttMs: 20 }] }),
  ]);
  const now = Date.now();
  // 11 s of challenger stability clears the standard 10 s bar but not the
  // ultra-low 15 s bar.
  const fresh = { ...challenger, stableSince: now - 11_000 };
  assert.equal(qoeWouldImprove(active, fresh, now), true);
  assert.equal(
    qoeWouldImprove(active, fresh, now, { objective: "ultra-low" }),
    false,
  );
  const mature = { ...challenger, stableSince: now - 16_000 };
  assert.equal(
    qoeWouldImprove(active, mature, now, { objective: "ultra-low" }),
    true,
  );
});
