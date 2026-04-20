// Mirrors CANONICAL_SECTORS_L1 in scripts/build_masterlist.py:161-167.
// Keep byte-for-byte in sync with the Python source.

export const CANONICAL_SECTORS_L1 = [
  "AI_ML", "SaaS", "FinTech", "HealthTech", "BioTech", "MedTech",
  "ClimateTech", "Consumer", "Marketplace", "DevTools", "Cybersecurity",
  "DeepTech", "Hardware", "Robotics", "PropTech", "EdTech", "Gaming",
  "Defense", "Crypto_Web3", "Space", "AgTech", "FoodTech",
  "AdTech_MarTech", "Logistics", "LegalTech_HRTech", "Other",
] as const;

export type CanonicalSectorL1 = (typeof CANONICAL_SECTORS_L1)[number];

const SECTOR_SET: Set<string> = new Set(CANONICAL_SECTORS_L1);

export function isCanonicalSectorL1(s: string): s is CanonicalSectorL1 {
  return SECTOR_SET.has(s);
}

// Canonical stages mirror CanonicalStage enum in src/lib/firestore/schema.ts.
export const CANONICAL_STAGES = [
  "pre_seed", "seed", "seed_plus",
  "series_a", "series_b", "series_c", "series_d", "series_e_plus",
  "growth", "bridge",
] as const;

export type CanonicalStageValue = (typeof CANONICAL_STAGES)[number];

const STAGE_SET: Set<string> = new Set(CANONICAL_STAGES);

export function isCanonicalStage(s: string): s is CanonicalStageValue {
  return STAGE_SET.has(s);
}
