const REDACTED = "[redacted]";
const BLOCKED_KEY =
  /token|ticket|secret|authorization|password|private|sdp|candidate/i;

import type { MediaControlEnv } from "./domain-types.ts";

type SanitizedValue =
  | null
  | boolean
  | number
  | string
  | SanitizedValue[]
  | { [key: string]: SanitizedValue };

function enabled(env?: MediaControlEnv): boolean {
  return (
    env?.MEDIA_CONTROL_DEBUG === "1" || env?.MEDIA_CONTROL_DEBUG === "true"
  );
}

function sanitize(value: unknown, depth = 0): SanitizedValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string")
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      code: (() => {
        const code = (value as Error & { code?: SanitizedValue }).code;
        return code === undefined ? null : code;
      })(),
    } as SanitizedValue;
  if (depth >= 3) return "[depth-limited]";
  if (Array.isArray(value))
    return value.slice(0, 24).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output: { [key: string]: SanitizedValue } = {};
    for (const [key, entry] of Object.entries(value).slice(0, 32))
      output[key] = BLOCKED_KEY.test(key)
        ? REDACTED
        : sanitize(entry, depth + 1);
    return output;
  }
  return String(value);
}

export function mediaDebug(
  env: MediaControlEnv | undefined,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!enabled(env)) return;
  console.debug("[MediaControl]", event, sanitize(details));
}

export function mediaDebugEnabled(env?: MediaControlEnv): boolean {
  return enabled(env);
}
