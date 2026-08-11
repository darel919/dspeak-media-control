export const MAX_CONTROL_MESSAGE_BYTES = 96 * 1024;
const MAX_MEDIA_SOURCES = 8;
const MAX_MEDIA_SOURCE_LENGTH = 32;

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
