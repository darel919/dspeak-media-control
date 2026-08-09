export function normalizeQoePath(path: any) {
  const normalizeTime = (value: unknown) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.abs(number) < 1 ? number * 1000 : number;
  };
  const normalizePercent = (value: unknown) => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const packetLossFraction = path?.packetLossFraction ?? path?.fractionLost;
  const packetLossPercent =
    packetLossFraction == null
      ? normalizePercent(path?.packetLossPercent ?? path?.packetLoss)
      : Number(packetLossFraction) * 100;
  return {
    rttMs: normalizeTime(path?.rttMs ?? path?.rtt),
    jitterMs: normalizeTime(path?.jitterMs ?? path?.jitter),
    packetLossPercent,
    jitterBufferDelayMs: normalizeTime(
      path?.jitterBufferDelayMs ?? path?.jitterBufferDelay,
    ),
    concealedAudioRatio:
      path?.concealedAudioRatio == null || path?.concealedAudioRatio === ""
        ? null
        : Number.isFinite(Number(path.concealedAudioRatio))
          ? Number(path.concealedAudioRatio)
          : null,
    candidateType: path?.candidateType || null,
    protocol: path?.protocol || null,
  };
}

export function scoreQoeCandidate(candidate: any) {
  const paths = (candidate?.paths || []).map(normalizeQoePath);
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
  };
}

export function rankQoeCandidates(candidates: any[]) {
  return candidates.map(scoreQoeCandidate).sort((left, right) => {
    const leftTuple = [
      left.viable ? 0 : 1,
      left.worstLatencyMs,
      left.worstLossPercent,
      left.worstJitterMs,
      Number(left.infrastructureCost) || Number.POSITIVE_INFINITY,
    ];
    const rightTuple = [
      right.viable ? 0 : 1,
      right.worstLatencyMs,
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

export function qoeWouldImprove(active: any, candidate: any, now = Date.now()) {
  if (!candidate?.viable) return false;
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
  return Number(active.worstLatencyMs) - Number(candidate.worstLatencyMs) >= 20;
}
