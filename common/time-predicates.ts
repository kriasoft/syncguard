// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Canonical time authority predicates for cross-backend consistency.
 * ALL backends MUST use these functions - custom time logic is forbidden.
 * @see docs/specs/interface.md
 */

/**
 * Canonical liveness check used by all backends.
 * Formula: `expiresAtMs > nowMs - toleranceMs` handles clock skew gracefully.
 *
 * @param expiresAtMs - Lock expiration timestamp from storage
 * @param nowMs - Current time from backend's authority (server/client)
 * @param toleranceMs - Clock skew tolerance in ms
 * @returns true if lock is still live
 */
export function isLive(
  expiresAtMs: number,
  nowMs: number,
  toleranceMs: number,
): boolean {
  return expiresAtMs > nowMs - toleranceMs;
}

/**
 * Converts Redis TIME command output to milliseconds.
 *
 * @param redisTime - redis.call('TIME') returns [seconds, microseconds]
 * @returns server time in ms
 */
export function calculateRedisServerTimeMs(
  redisTime: [string, string],
): number {
  return (
    parseInt(redisTime[0]) * 1000 + Math.floor(parseInt(redisTime[1]) / 1000)
  );
}

/**
 * Fixed 1000ms tolerance for all backends (ADR-005).
 * Accommodates network delays and clock skew while ensuring predictable cross-backend behavior.
 * Not user-configurable to prevent semantic drift between Redis/Firestore.
 */
export const TIME_TOLERANCE_MS = 1000;
