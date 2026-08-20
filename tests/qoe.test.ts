import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankQoeCandidates, scoreQoeCandidate } from "../src/qoe.ts";

describe("media-control QoE ranking", () => {
  it("normalizes WebRTC time and loss units", () => {
    const candidate = scoreQoeCandidate({
      provider: "cloudflare-realtime",
      paths: [{ rttMs: 80, jitterMs: 4, fractionLost: 0.01 }],
    });
    assert.equal(candidate.paths[0].rttMs, 80);
    assert.equal(candidate.paths[0].jitterMs, 4);
    assert.equal(candidate.paths[0].packetLossPercent, 1);
  });

  it("converts only legacy second aliases and preserves explicit milliseconds", () => {
    const candidate = scoreQoeCandidate({
      provider: "cloudflare-realtime",
      paths: [
        { rtt: 0.08, jitter: 0.004, jitterBufferDelay: 0.01 },
        { rttMs: 0.5, jitterMs: 0.25, jitterBufferDelayMs: 0.75 },
      ],
    });

    assert.equal(candidate.paths[0].rttMs, 80);
    assert.equal(candidate.paths[0].jitterMs, 4);
    assert.equal(candidate.paths[0].jitterBufferDelayMs, 10);
    assert.equal(candidate.paths[1].rttMs, 0.5);
    assert.equal(candidate.paths[1].jitterMs, 0.25);
    assert.equal(candidate.paths[1].jitterBufferDelayMs, 0.75);
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

  it("ranks stable media quality above lower latency with loss and jitter", () => {
    const ranked = rankQoeCandidates([
      {
        provider: "mediasoup",
        providerId: "sfu-singapore",
        paths: [{ rttMs: 31, jitterMs: 18, fractionLost: 0.032 }],
      },
      {
        provider: "mediasoup",
        providerId: "sfu-tokyo",
        paths: [{ rttMs: 42, jitterMs: 3, fractionLost: 0.001 }],
      },
    ]);

    assert.deepEqual(
      ranked.map((candidate) => candidate.providerId),
      ["sfu-tokyo", "sfu-singapore"],
    );
    assert.ok(ranked[0].qoeScore < ranked[1].qoeScore);
  });
});
