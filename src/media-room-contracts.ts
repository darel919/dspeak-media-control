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

export function controlMessageByteLength(message) {
  if (typeof message === "string")
    return new TextEncoder().encode(message).byteLength;
  return Number(message?.byteLength) || 0;
}

export function normalizeMediaSources(value) {
  if (!Array.isArray(value) || value.length > MAX_MEDIA_SOURCES) return null;
  const sources = [];
  const seen = new Set();
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

export function normalizeMediaOwnerSource(source, value) {
  if (source !== "screen-audio") return null;
  return value === "system-audio" ? "system-audio" : "screen";
}

export function isVideoMediaSource(value) {
  return value === "camera" || value === "screen";
}

export function normalizeParticipantVoiceState(value) {
  if (
    !value ||
    typeof value.muted !== "boolean" ||
    typeof value.deafened !== "boolean"
  )
    return null;
  return {
    muted: value.muted,
    deafened: value.deafened,
  };
}

function boundedString(value, maxLength) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function normalizeCodecDirection(value) {
  const record = value && typeof value === "object" ? value : {};
  const supported = record.supported === true;
  const acceleration =
    supported && CODEC_ACCELERATIONS.has(record.acceleration)
      ? record.acceleration
      : supported
        ? "software"
        : "unsupported";
  const realtimeEfficiency =
    supported && CODEC_EFFICIENCIES.has(record.realtimeEfficiency)
      ? record.realtimeEfficiency
      : supported
        ? acceleration === "hardware"
          ? "good"
          : "acceptable"
        : "unusable";
  const result = {
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
  if (CODEC_POWER_CLASSES.has(record.powerClass))
    result.powerClass = record.powerClass;
  if (record.tested === true) result.tested = true;
  return result;
}

export function normalizeMediaCapabilities(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
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
  const videoCodecs = {};
  for (const codec of VIDEO_CODECS) {
    const candidate = rawCodecs[codec] || rawCodecs[codec.toLowerCase()] || {};
    videoCodecs[codec] = {
      encode: normalizeCodecDirection(candidate.encode),
      decode: normalizeCodecDirection(candidate.decode),
    };
  }
  const rawConcurrent =
    record.concurrentEncode || diagnostics.concurrentEncode || {};
  const concurrentEncode = {
    supported: rawConcurrent.supported === true,
  };
  const maxHardwareSessions = Number(rawConcurrent.maxHardwareSessions);
  if (Number.isFinite(maxHardwareSessions) && maxHardwareSessions > 0)
    concurrentEncode.maxHardwareSessions = Math.floor(maxHardwareSessions);
  if (Array.isArray(rawConcurrent.testedCodecPairs)) {
    const testedCodecPairs = rawConcurrent.testedCodecPairs
      .filter((pair) => Array.isArray(pair) && pair.length === 2)
      .map((pair) => [
        String(pair[0]).toUpperCase(),
        String(pair[1]).toUpperCase(),
      ])
      .filter(
        (pair) =>
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
  const result = { videoCodecs, concurrentEncode };
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

export function mediaPublicationKey(publication) {
  const peerId = String(publication?.peerId || "");
  const logicalStreamId = String(
    publication?.logicalStreamId || publication?.source || "",
  );
  if (!publication?.variantId)
    return `${peerId}:${publication?.source || logicalStreamId}`;
  const variantId = String(publication.variantId);
  return `${peerId}:${logicalStreamId}:${variantId}`;
}
