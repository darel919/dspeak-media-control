const REDACTED = "[redacted]";
const BLOCKED_KEY =
  /token|ticket|secret|authorization|password|private|sdp|candidate/i;

function enabled(env) {
  return (
    env?.MEDIA_CONTROL_DEBUG === "1" || env?.MEDIA_CONTROL_DEBUG === "true"
  );
}

function sanitize(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string")
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      code: value.code || null,
    };
  if (depth >= 3) return "[depth-limited]";
  if (Array.isArray(value))
    return value.slice(0, 24).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value).slice(0, 32))
      output[key] = BLOCKED_KEY.test(key)
        ? REDACTED
        : sanitize(entry, depth + 1);
    return output;
  }
  return String(value);
}

export function mediaDebug(env, event, details = {}) {
  if (!enabled(env)) return;
  console.debug("[MediaControl]", event, sanitize(details));
}

export function mediaDebugEnabled(env) {
  return enabled(env);
}
