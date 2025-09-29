// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

// NOTE: Keep literals aligned with ReleaseResult/ExtendResult Reason types
export type MutationReason = "expired" | "not-found";

// Internal state taxonomy: maps backend observations to user-facing reasons
// DO NOT export in public API
export type MutationCondition =
  | "succeeded"
  | "observable-expired" // Expiry observed deterministically before mutation
  | "never-existed" // No record found
  | "ownership-mismatch" // Record exists but lockId mismatch
  | "cleaned-up-after-expiry" // Auto-removed due to expiry
  | "ambiguous-unknown"; // Clock skew, snapshot race, stale index, etc.

export type MutationResult =
  | { ok: true }
  | { ok: false; reason: MutationReason };

/**
 * Maps internal backend conditions to public API results.
 * Strategy: Collapse ambiguous states to "not-found" for safety.
 */
export function mapToMutationResult(cond: MutationCondition): MutationResult {
  switch (cond) {
    case "succeeded":
      return { ok: true };
    case "observable-expired":
      return { ok: false, reason: "expired" };
    // Conservative: all ambiguity → "not-found"
    case "never-existed":
    case "ownership-mismatch":
    case "cleaned-up-after-expiry":
    case "ambiguous-unknown":
    default:
      return { ok: false, reason: "not-found" };
  }
}

/**
 * Decodes Redis Lua script return codes to MutationCondition.
 * Codes: 1=success, 0=ownership mismatch, -1=never existed, -2=expired
 * @see redis/scripts.ts
 */
export function mapRedisScriptResult(code: number): MutationCondition {
  if (code === 1) return "succeeded";
  if (code === -2) return "observable-expired";
  if (code === -1) return "never-existed";
  if (code === 0) return "ownership-mismatch";
  return "ambiguous-unknown";
}

/**
 * Maps Firestore transaction/query observations to MutationCondition.
 * @param conditions.documentExists - !querySnapshot.empty
 * @param conditions.ownershipValid - data?.lockId === lockId
 * @param conditions.isLive - Computed via time authority + tolerance
 * @see common/time-predicates.ts
 */
export function mapFirestoreConditions(conditions: {
  /** Document found in query result */
  documentExists: boolean;
  /** Stored lockId matches request */
  ownershipValid: boolean;
  /** Lock not expired per time authority */
  isLive: boolean;
}): MutationCondition {
  if (!conditions.documentExists) return "never-existed";
  if (!conditions.ownershipValid) return "ownership-mismatch";
  if (!conditions.isLive) return "observable-expired";
  return "succeeded";
}

/**
 * Unified backend observation mapper (Redis codes or Firestore conditions).
 * @see specs/interface.md
 */
export function mapBackendObservation(
  observation:
    | number
    | { documentExists: boolean; ownershipValid: boolean; isLive: boolean },
): MutationCondition {
  if (typeof observation === "number") {
    return mapRedisScriptResult(observation);
  }
  return mapFirestoreConditions(observation);
}
