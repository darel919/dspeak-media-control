import { mediaDebug } from "./debug.ts";
import type {
  AudioLatencyProfileValue,
  DynamicRecord,
  MediaPolicySnapshot,
} from "./domain-types.ts";

const AUDIO_LATENCY_PROFILES = ["standard", "ultra-low"] as const;

export type MediaPolicyApplyResult =
  | { accepted: true; changed: boolean; policy: MediaPolicySnapshot }
  | {
      accepted: false;
      reason: "invalid-policy" | "stale-revision" | "conflicting-revision";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeAudioLatencyProfile(
  value: unknown,
): AudioLatencyProfileValue | null {
  return typeof value === "string" &&
    (AUDIO_LATENCY_PROFILES as readonly string[]).includes(value)
    ? (value as AudioLatencyProfileValue)
    : null;
}

export function normalizeMediaPolicySnapshot(
  value: unknown,
): MediaPolicySnapshot | null {
  if (!isRecord(value)) return null;
  const audioLatencyProfile = normalizeAudioLatencyProfile(
    value.audioLatencyProfile,
  );
  const revision = Number(value.revision);
  if (!audioLatencyProfile) return null;
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const updatedAt =
    typeof value.updatedAt === "string" || value.updatedAt === null
      ? value.updatedAt
      : null;
  return { audioLatencyProfile, revision, updatedAt };
}

function policyContentEquals(
  left: MediaPolicySnapshot,
  right: MediaPolicySnapshot,
): boolean {
  return (
    left.audioLatencyProfile === right.audioLatencyProfile &&
    left.updatedAt === right.updatedAt
  );
}

export function applyMediaPolicyUpdate(
  room: DynamicRecord,
  snapshot: unknown,
): MediaPolicyApplyResult {
  const next = normalizeMediaPolicySnapshot(snapshot);
  if (!next) {
    mediaDebug(room.env, "room.policy-update-invalid", {});
    return { accepted: false, reason: "invalid-policy" };
  }
  const current = room.mediaPolicy as MediaPolicySnapshot | null;
  if (current) {
    if (next.revision < current.revision)
      return { accepted: false, reason: "stale-revision" };
    if (next.revision === current.revision) {
      if (policyContentEquals(current, next))
        return { accepted: true, changed: false, policy: current };
      mediaDebug(room.env, "room.policy-update-conflict", {
        revision: next.revision,
        current: current.audioLatencyProfile,
        incoming: next.audioLatencyProfile,
      });
      return { accepted: false, reason: "conflicting-revision" };
    }
  }
  room.mediaPolicy = next;
  void room.state.storage.put("mediaPolicy", next);
  mediaDebug(room.env, "room.policy-updated", {
    audioLatencyProfile: next.audioLatencyProfile,
    revision: next.revision,
  });
  room.broadcastTopology();
  void room.maybeStartQualification?.();
  return { accepted: true, changed: true, policy: next };
}

export function getRequestedAudioLatencyProfile(
  room: DynamicRecord,
): AudioLatencyProfileValue {
  const policy = room.mediaPolicy as MediaPolicySnapshot | null;
  return policy?.audioLatencyProfile ?? "standard";
}
