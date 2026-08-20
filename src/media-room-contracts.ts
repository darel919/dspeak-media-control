export const MAX_CONTROL_MESSAGE_BYTES = 96 * 1024;
const MAX_MEDIA_SOURCES = 8;
const MAX_MEDIA_SOURCE_LENGTH = 32;
const VIDEO_CODECS = ["H264", "H265", "VP8", "VP9", "AV1"];
const CODEC_ACCELERATIONS = new Set(["hardware", "software", "unsupported"]);
const CODEC_EFFICIENCIES = new Set([
  "excellent",
  "good",
  "acceptable",
  "poor",
  "unusable",
]);
const CODEC_POWER_CLASSES = new Set(["low", "medium", "high"]);

type CodecDirection = {
  supported: boolean;
  acceleration: string;
  realtimeEfficiency: string;
  [key: string]: unknown;
};

type ConcurrentEncode = {
  supported: boolean;
  [key: string]: unknown;
};

type NormalizedMediaCapabilities = {
  videoCodecs: Record<
    string,
    { encode: CodecDirection; decode: CodecDirection }
  >;
  concurrentEncode: ConcurrentEncode;
  [key: string]: unknown;
};

export function controlMessageByteLength(message: unknown): number {
  if (typeof message === "string")
    return new TextEncoder().encode(message).byteLength;
  if (message && typeof message === "object" && "byteLength" in message)
    return Number((message as { byteLength?: unknown }).byteLength) || 0;
  return 0;
}

export function normalizeMediaSources(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_SOURCES) return null;
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const source of value) {
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      source.length > MAX_MEDIA_SOURCE_LENGTH ||
      !/^[a-z][a-z0-9-]*$/.test(source)
    )
      return null;
    if (!seen.has(source)) {
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}

export function normalizeMediaOwnerSource(
  source: unknown,
  value: unknown,
): string | null {
  if (source !== "screen-audio") return null;
  return value === "system-audio" ? "system-audio" : "screen";
}

export function isVideoMediaSource(value: unknown): boolean {
  return value === "camera" || value === "screen";
}

export function normalizeParticipantVoiceState(value: unknown) {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    typeof record.muted !== "boolean" ||
    typeof record.deafened !== "boolean"
  )
    return null;
  return {
    muted: record.muted,
    deafened: record.deafened,
  };
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function normalizeCodecDirection(value: unknown): CodecDirection {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const supported = record.supported === true;
  const accelerationValue =
    typeof record.acceleration === "string" ? record.acceleration : "";
  const acceleration =
    supported && CODEC_ACCELERATIONS.has(accelerationValue)
      ? accelerationValue
      : supported
        ? "software"
        : "unsupported";
  const efficiencyValue =
    typeof record.realtimeEfficiency === "string"
      ? record.realtimeEfficiency
      : "";
  const realtimeEfficiency =
    supported && CODEC_EFFICIENCIES.has(efficiencyValue)
      ? efficiencyValue
      : supported
        ? acceleration === "hardware"
          ? "good"
          : "acceptable"
        : "unusable";
  const result: CodecDirection = {
    supported,
    acceleration,
    realtimeEfficiency,
  };
  for (const field of ["maxWidth", "maxHeight", "maxFps"]) {
    const number = Number(record[field]);
    if (Number.isFinite(number) && number > 0)
      result[field] = Math.floor(number);
  }
  const implementation = boundedString(record.implementation, 128);
  const testedProfile = boundedString(record.testedProfile, 128);
  const failureReason = boundedString(record.failureReason, 256);
  if (implementation) result.implementation = implementation;
  if (testedProfile) result.testedProfile = testedProfile;
  if (failureReason) result.failureReason = failureReason;
  const powerClass =
    typeof record.powerClass === "string" ? record.powerClass : "";
  if (CODEC_POWER_CLASSES.has(powerClass)) result.powerClass = powerClass;
  if (record.tested === true) result.tested = true;
  return result;
}

export function normalizeMediaCapabilities(
  value: unknown,
): NormalizedMediaCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, any>;
  const diagnostics =
    record.videoCodecDiagnostics &&
    typeof record.videoCodecDiagnostics === "object"
      ? record.videoCodecDiagnostics
      : record;
  const rawCodecs =
    record.videoCodecs ||
    record.videoCodecCapabilities ||
    diagnostics.videoCodecs ||
    diagnostics.capabilities ||
    {};
  const videoCodecs: NormalizedMediaCapabilities["videoCodecs"] = {};
  for (const codec of VIDEO_CODECS) {
    const candidate = rawCodecs[codec] || rawCodecs[codec.toLowerCase()] || {};
    videoCodecs[codec] = {
      encode: normalizeCodecDirection(candidate.encode),
      decode: normalizeCodecDirection(candidate.decode),
    };
  }
  const rawConcurrent =
    record.concurrentEncode || diagnostics.concurrentEncode || {};
  const concurrentEncode: ConcurrentEncode = {
    supported: rawConcurrent.supported === true,
  };
  const maxHardwareSessions = Number(rawConcurrent.maxHardwareSessions);
  if (Number.isFinite(maxHardwareSessions) && maxHardwareSessions > 0)
    concurrentEncode.maxHardwareSessions = Math.floor(maxHardwareSessions);
  if (Array.isArray(rawConcurrent.testedCodecPairs)) {
    const testedCodecPairs = rawConcurrent.testedCodecPairs
      .filter(
        (pair: unknown): pair is [unknown, unknown] =>
          Array.isArray(pair) && pair.length === 2,
      )
      .map(
        (pair: [unknown, unknown]) =>
          [String(pair[0]).toUpperCase(), String(pair[1]).toUpperCase()] as [
            string,
            string,
          ],
      )
      .filter(
        (pair: [string, string]) =>
          VIDEO_CODECS.includes(pair[0]) && VIDEO_CODECS.includes(pair[1]),
      );
    if (testedCodecPairs.length)
      concurrentEncode.testedCodecPairs = testedCodecPairs;
  }
  if (
    rawConcurrent.confidence === "tested" ||
    rawConcurrent.confidence === "conservative-default" ||
    rawConcurrent.confidence === "unknown"
  )
    concurrentEncode.confidence = rawConcurrent.confidence;
  const result: NormalizedMediaCapabilities = { videoCodecs, concurrentEncode };
  if (
    record.source === "native-runtime-probe" ||
    record.source === "browser-probe" ||
    record.source === "fallback"
  )
    result.source = record.source;
  const probeVersion = boundedString(record.probeVersion, 64);
  if (probeVersion) result.probeVersion = probeVersion;
  return result;
}

export function mediaPublicationKey(publication: Record<string, any>): string {
  const peerId = String(publication?.peerId || "");
  const logicalStreamId = String(
    publication?.logicalStreamId || publication?.source || "",
  );
  const connectionEpoch = publication?.connectionEpoch
    ? String(publication.connectionEpoch)
    : "";
  const generation = publication?.generation
    ? String(publication.generation)
    : "";
  if (!publication?.variantId)
    return `${peerId}:${publication?.source || logicalStreamId}:${connectionEpoch}:${generation}`;
  const variantId = String(publication.variantId);
  return `${peerId}:${logicalStreamId}:${variantId}:${connectionEpoch}:${generation}`;
}
