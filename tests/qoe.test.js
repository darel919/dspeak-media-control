import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankQoeCandidates, scoreQoeCandidate } from "../src/qoe.ts";

describe("media-control QoE ranking", () => {
  it("normalizes WebRTC time and loss units", () => {
    const candidate = scoreQoeCandidate({
      provider: "cloudflare-realtime",
      paths: [{ rttMs: 0.08, jitterMs: 0.004, fractionLost: 0.01 }],
    });
    assert.equal(candidate.paths[0].rttMs, 80);
    assert.equal(candidate.paths[0].jitterMs, 4);
    assert.equal(candidate.paths[0].packetLossPercent, 1);
  });

  it("keeps absent metrics absent instead of converting null to zero", () => {
    const candidate = scoreQoeCandidate({
      provider: "cloudflare-realtime",
      paths: [{ rttMs: null, jitterMs: null, packetLossPercent: null }],
    });
    assert.equal(candidate.paths[0].rttMs, null);
    assert.equal(candidate.paths[0].jitterMs, null);
    assert.equal(candidate.paths[0].packetLossPercent, null);
    assert.equal(candidate.viable, true);
  });

  it("ranks by worst participant latency", () => {
    const ranked = rankQoeCandidates([
      {
        provider: "cloudflare-realtime",
        paths: [{ rttMs: 90, jitterMs: 4 }],
      },
      {
        provider: "mediasoup",
        paths: [
          { rttMs: 40, jitterMs: 4 },
          { rttMs: 140, jitterMs: 4 },
        ],
      },
    ]);
    assert.deepEqual(
      ranked.map((candidate) => candidate.provider),
      ["cloudflare-realtime", "mediasoup"],
    );
  });
});
