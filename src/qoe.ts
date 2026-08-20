type QoePath = {
  rttMs?: unknown;
  rtt?: unknown;
  jitterMs?: unknown;
  jitter?: unknown;
  packetLossFraction?: unknown;
  fractionLost?: unknown;
  packetLossPercent?: unknown;
  packetLoss?: unknown;
  jitterBufferDelayMs?: unknown;
  jitterBufferDelay?: unknown;
  concealedAudioRatio?: unknown;
  candidateType?: unknown;
  protocol?: unknown;
  availableBitrateBps?: unknown;
  [key: string]: unknown;
};

type NormalizedQoePath = {
  rttMs: number | null;
  jitterMs: number | null;
  packetLossPercent: number | null;
  jitterBufferDelayMs: number | null;
  concealedAudioRatio: number | null;
  candidateType: string | null;
  protocol: string | null;
  availableBitrateBps: number | null;
};

type QoeCandidate = {
  paths?: QoePath[];
  viable?: boolean;
  requiredParticipants?: unknown;
  readyParticipants?: unknown;
  infrastructureCost?: unknown;
  failed?: boolean;
  stableSince?: unknown;
  qoeScore?: unknown;
  worstLatencyMs?: unknown;
  [key: string]: unknown;
};

type ScoredQoeCandidate = Omit<
  QoeCandidate,
  | "paths"
  | "viable"
  | "worstLatencyMs"
  | "worstLossPercent"
  | "worstJitterMs"
  | "p95QoeScore"
  | "qoeScore"
> & {
  paths: NormalizedQoePath[];
  viable: boolean;
  worstLatencyMs: number;
  worstLossPercent: number;
  worstJitterMs: number;
  p95QoeScore: number;
  qoeScore: number;
};

function isRecord(value: unknown): value is QoePath {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeQoePath(path: unknown): NormalizedQoePath {
  const record = isRecord(path) ? path : {};
  const normalizeMilliseconds = (value: unknown) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  };
  const normalizeSecondsToMilliseconds = (value: unknown) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number * 1000) : null;
  };
  const normalizePercent = (value: unknown) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const packetLossFraction = record.packetLossFraction ?? record.fractionLost;
  const packetLossPercent =
    packetLossFraction == null
      ? normalizePercent(record.packetLossPercent ?? record.packetLoss)
      : Number(packetLossFraction) * 100;
  return {
    rttMs:
      record.rttMs == null
        ? normalizeSecondsToMilliseconds(record.rtt)
        : normalizeMilliseconds(record.rttMs),
    jitterMs:
      record.jitterMs == null
        ? normalizeSecondsToMilliseconds(record.jitter)
        : normalizeMilliseconds(record.jitterMs),
    packetLossPercent,
    jitterBufferDelayMs:
      record.jitterBufferDelayMs == null
        ? normalizeSecondsToMilliseconds(record.jitterBufferDelay)
        : normalizeMilliseconds(record.jitterBufferDelayMs),
    concealedAudioRatio:
      record.concealedAudioRatio == null || record.concealedAudioRatio === ""
        ? null
        : Number.isFinite(Number(record.concealedAudioRatio))
          ? Number(record.concealedAudioRatio)
          : null,
    candidateType:
      typeof record.candidateType === "string" ? record.candidateType : null,
    protocol: typeof record.protocol === "string" ? record.protocol : null,
    availableBitrateBps:
      record.availableBitrateBps == null || record.availableBitrateBps === ""
        ? null
        : Number.isFinite(Number(record.availableBitrateBps))
          ? Math.max(0, Number(record.availableBitrateBps))
          : null,
  };
}

function scorePath(path: NormalizedQoePath) {
  if (path.rttMs == null) return Number.POSITIVE_INFINITY;
  return (
    path.rttMs / 2 +
    (path.jitterMs || 0) * 2 +
    (path.jitterBufferDelayMs || 0) +
    20 +
    (path.packetLossPercent || 0) * 100
  );
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

export function scoreQoeCandidate(candidate: QoeCandidate): ScoredQoeCandidate {
  const paths = (Array.isArray(candidate.paths) ? candidate.paths : []).map(
    normalizeQoePath,
  );
  const latency = paths.map((path) => {
    if (path.rttMs == null) return Number.POSITIVE_INFINITY;
    return (
      path.rttMs / 2 +
      (path.jitterMs || 0) * 2 +
      (path.jitterBufferDelayMs || 0) +
      20
    );
  });
  const finite = (values: number[]) => values.filter(Number.isFinite);
  const qualityScores = paths.map(scorePath);
  const finiteQualityScores = finite(qualityScores);
  const worstQoeScore = qualityScores.length
    ? Math.max(...qualityScores)
    : Number.POSITIVE_INFINITY;
  return {
    ...candidate,
    paths,
    viable:
      candidate?.viable !== false &&
      (!Number.isFinite(Number(candidate.requiredParticipants)) ||
        Number(candidate.readyParticipants) >=
          Number(candidate.requiredParticipants)),
    worstLatencyMs: latency.length
      ? Math.max(...latency)
      : Number.POSITIVE_INFINITY,
    worstLossPercent: Math.max(
      0,
      ...finite(paths.map((path) => path.packetLossPercent ?? 0)),
    ),
    worstJitterMs: Math.max(
      0,
      ...finite(paths.map((path) => path.jitterMs ?? 0)),
    ),
    p95QoeScore: percentile(finiteQualityScores, 0.95),
    qoeScore: worstQoeScore,
  };
}

export function rankQoeCandidates(candidates: QoeCandidate[]) {
  return candidates.map(scoreQoeCandidate).sort((left, right) => {
    const leftTuple = [
      left.viable ? 0 : 1,
      left.qoeScore,
      left.p95QoeScore,
      left.worstLossPercent,
      left.worstJitterMs,
      Number(left.infrastructureCost) || Number.POSITIVE_INFINITY,
    ];
    const rightTuple = [
      right.viable ? 0 : 1,
      right.qoeScore,
      right.p95QoeScore,
      right.worstLossPercent,
      right.worstJitterMs,
      Number(right.infrastructureCost) || Number.POSITIVE_INFINITY,
    ];
    for (let index = 0; index < leftTuple.length; index += 1) {
      if (leftTuple[index] !== rightTuple[index])
        return leftTuple[index] - rightTuple[index];
    }
    return 0;
  });
}

export function qoeWouldImprove(
  active: QoeCandidate | null | undefined,
  candidate: QoeCandidate,
  now = Date.now(),
) {
  if (!candidate?.viable) return false;
  if (!active) return false;
  if (active?.failed) return true;
  if (
    active?.viable === false &&
    !Number.isFinite(Number(active.requiredParticipants))
  )
    return true;
  if (
    active?.viable === false &&
    Number(active.readyParticipants) < Number(active.requiredParticipants)
  )
    return false;
  if (!Number.isFinite(Number(candidate.stableSince))) return false;
  if (now - Number(candidate.stableSince) < 10_000) return false;
  const activeScore = Number(active.qoeScore ?? active.worstLatencyMs);
  const candidateScore = Number(candidate.qoeScore ?? candidate.worstLatencyMs);
  return activeScore - candidateScore >= 20;
}
