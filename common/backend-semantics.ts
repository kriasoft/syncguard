// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Symbol for attaching failure reason metadata to results without polluting public API.
 * Enables telemetry decorator to track failure reasons without exposing them to users.
 */
export const FAILURE_REASON = Symbol("failureReason");

/** Internal tracking for telemetry events (not in public result types) */
export type MutationReason = "expired" | "not-found";

/**
 * Internal state taxonomy mapping backend observations to user-facing reasons.
 * DO NOT export in public API - used only by telemetry/mapping layers.
 */
export type MutationCondition =
  | "succeeded"
  /** Expiry observed deterministically before mutation */
  | "observable-expired"
  /** No record found in storage */
  | "never-existed"
  /** Record exists but lockId mismatch */
  | "ownership-mismatch"
  /** Auto-removed due to expiry */
  | "cleaned-up-after-expiry"
  /** Clock skew, snapshot race, stale index, etc. */
  | "ambiguous-unknown";

export type MutationResult =
  | { ok: true }
  | { ok: false; reason: MutationReason };

/**
 * Maps internal backend conditions to public API results.
 * Conservative strategy: collapses ambiguous states to "not-found" for safety.
 */
export function mapToMutationResult(cond: MutationCondition): MutationResult {
  switch (cond) {
    case "succeeded":
      return { ok: true };
    case "observable-expired":
      return { ok: false, reason: "expired" };
    // All ambiguity → "not-found" (ownership-mismatch, cleaned-up, unknown)
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
 * @param code - Script result: 1=success, 0=ownership mismatch, -1=not found, -2=expired
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
 * @param conditions - Query result analysis
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
 * Unified backend observation mapper for Redis codes or Firestore conditions.
 * @param observation - Redis script code or Firestore query analysis
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
