import type { AudioQuantumUs } from "./domain-types.ts";

export interface ProviderAudioCapabilities {
  supportedQuantaUs: readonly AudioQuantumUs[];
  validated: boolean;
}

const COMPATIBILITY_ONLY: ProviderAudioCapabilities = {
  supportedQuantaUs: [10000] as readonly AudioQuantumUs[],
  validated: false,
} as const;

const CERTIFIED: ReadonlyMap<string, ProviderAudioCapabilities> = new Map([]);

export function getProviderAudioCapabilities(
  provider: string,
): ProviderAudioCapabilities {
  return CERTIFIED.get(provider) ?? COMPATIBILITY_ONLY;
}

export function providerSupportsQuantum(
  provider: string,
  quantumUs: number,
): boolean {
  return getProviderAudioCapabilities(provider).supportedQuantaUs.includes(
    quantumUs as AudioQuantumUs,
  );
}

export function providerEffectiveQuantumUs(
  provider: string,
  audioLatencyProfile: string,
): number {
  if (audioLatencyProfile !== "ultra-low") return 10000;
  if (providerSupportsQuantum(provider, 2500)) return 2500;
  if (providerSupportsQuantum(provider, 5000)) return 5000;
  return 10000;
}
