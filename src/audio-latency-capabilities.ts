import type {
  AudioLatencyCapabilitiesV1,
  AudioQuantumUs,
  EffectiveAudioLatencyMode,
} from "./domain-types.ts";

export const AUDIO_QUANTUM_US = Object.freeze({
  MS_2_5: 2500,
  MS_5: 5000,
  MS_10: 10000,
} as const);

const VALID_QUANTA: readonly AudioQuantumUs[] = [
  AUDIO_QUANTUM_US.MS_2_5,
  AUDIO_QUANTUM_US.MS_5,
  AUDIO_QUANTUM_US.MS_10,
];

export function compatibilityAudioLatencyCapabilities(): AudioLatencyCapabilitiesV1 {
  return {
    version: 1,
    nativeAudioEngine: false,
    restrictedLowDelayOpus: false,
    captureQuantaUs: [AUDIO_QUANTUM_US.MS_10],
    encodeFrameDurationsUs: [AUDIO_QUANTUM_US.MS_10],
    decodeFrameDurationsUs: [AUDIO_QUANTUM_US.MS_10],
    renderQuantaUs: [AUDIO_QUANTUM_US.MS_10],
  };
}

function normalizeQuanta(value: unknown): AudioQuantumUs[] {
  if (!Array.isArray(value)) return [];
  const present = new Set<unknown>(value);
  return VALID_QUANTA.filter((quantum) => present.has(quantum));
}

export function normalizeAudioLatencyCapabilities(
  value: unknown,
): AudioLatencyCapabilitiesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return compatibilityAudioLatencyCapabilities();
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return compatibilityAudioLatencyCapabilities();
  const captureQuantaUs = normalizeQuanta(record.captureQuantaUs);
  const encodeFrameDurationsUs = normalizeQuanta(record.encodeFrameDurationsUs);
  const decodeFrameDurationsUs = normalizeQuanta(record.decodeFrameDurationsUs);
  const renderQuantaUs = normalizeQuanta(record.renderQuantaUs);
  if (
    !captureQuantaUs.length ||
    !encodeFrameDurationsUs.length ||
    !decodeFrameDurationsUs.length ||
    !renderQuantaUs.length
  )
    return compatibilityAudioLatencyCapabilities();
  return {
    version: 1,
    nativeAudioEngine: record.nativeAudioEngine === true,
    restrictedLowDelayOpus: record.restrictedLowDelayOpus === true,
    captureQuantaUs,
    encodeFrameDurationsUs,
    decodeFrameDurationsUs,
    renderQuantaUs,
  };
}

export function supportedAudioQuantaUs(
  capabilities: AudioLatencyCapabilitiesV1,
): AudioQuantumUs[] {
  const common = new Set<AudioQuantumUs>([
    AUDIO_QUANTUM_US.MS_2_5,
    AUDIO_QUANTUM_US.MS_5,
    AUDIO_QUANTUM_US.MS_10,
  ]);
  const keep = (quanta: readonly AudioQuantumUs[]) => {
    for (const quantum of [...common])
      if (!quanta.includes(quantum)) common.delete(quantum);
  };
  keep(capabilities.captureQuantaUs);
  keep(capabilities.encodeFrameDurationsUs);
  keep(capabilities.decodeFrameDurationsUs);
  keep(capabilities.renderQuantaUs);
  if (!common.size) return [AUDIO_QUANTUM_US.MS_10];
  return VALID_QUANTA.filter((quantum) => common.has(quantum));
}

export function effectiveAudioQuantumUs(
  capabilities: AudioLatencyCapabilitiesV1,
): AudioQuantumUs {
  return supportedAudioQuantaUs(capabilities)[0];
}

export function computeEffectiveAudioLatencyMode(
  requested: "standard" | "ultra-low",
  quantumUs: AudioQuantumUs,
): EffectiveAudioLatencyMode {
  if (requested !== "ultra-low") return "standard-10ms";
  if (quantumUs === AUDIO_QUANTUM_US.MS_2_5) return "ultra-low-2_5ms";
  if (quantumUs === AUDIO_QUANTUM_US.MS_5) return "ultra-low-5ms";
  return "ultra-low-10ms-compat";
}
