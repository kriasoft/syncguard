// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import { FAILURE_REASON } from "../../common/backend-semantics.js";
import {
  type ExtendResult,
  type LockOp,
  LockError,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS, isLive } from "../../common/time-predicates.js";
import { checkAborted, mapPostgresError } from "../errors.js";
import type { LockRow, PostgresConfig } from "../types.js";

/**
 * Creates PostgreSQL extend operation with atomic transaction and authoritative expiresAtMs.
 *
 * **Implementation Pattern:**
 * - Atomic transaction: Query by lockId → verify ownership → update expiresAtMs
 * - TOCTOU protection: All steps within single `sql.begin()` transaction
 * - Ownership verification: Explicit `data.lock_id === opts.lockId` check (ADR-003)
 * - Authoritative time: MUST capture server time inside transaction (ADR-010)
 * - TTL semantics: Replaces remaining TTL entirely (`nowMs + ttlMs`), not additive
 * - AbortSignal: Manual cancellation checks via `checkAborted()` at strategic points
 *
 * Transaction flow:
 * 1. Get server time for authoritative timestamp
 * 2. Query by lockId using index (FOR UPDATE for row-level lock)
 * 3. Verify ownership (data.lock_id === lockId)
 * 4. Check liveness using isLive() predicate
 * 5. If all checks pass, compute new expiresAtMs from server time
 * 6. Update expires_at_ms in database
 * 7. Return success with authoritative expiresAtMs
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 * @returns Extend operation function
 *
 * @see specs/interface.md#extend-operation-requirements - Normative TOCTOU requirements
 * @see specs/adrs.md ADR-003 - Explicit ownership verification rationale
 * @see specs/adrs.md ADR-010 - Authoritative expiresAtMs from mutations rationale
 */
export function createExtendOperation(sql: Sql, config: PostgresConfig) {
  return async (opts: LockOp & { ttlMs: number }): Promise<ExtendResult> => {
    try {
      // Pre-transaction abort check
      checkAborted(opts.signal);

      // Validate lockId format (22-char base64url)
      validateLockId(opts.lockId);

      // Validate ttlMs
      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      // Atomic transaction: lookup → verify → update
      const result = await sql.begin(async (sql) => {
        // Check abort signal inside transaction
        checkAborted(opts.signal);

        // Get server time (authoritative time source - ADR-010)
        const timeResult = await sql<
          Array<{ now_ms: string }>
        >`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`;
        const timeRow = timeResult[0];
        if (!timeRow) {
          throw new LockError("Internal", "Failed to get server time");
        }
        const nowMs = Math.floor(Number(timeRow.now_ms));

        // Query by lockId index (FOR UPDATE for row-level lock)
        const rows = await sql<Array<LockRow>>`
          SELECT * FROM ${sql(config.tableName)}
          WHERE lock_id = ${opts.lockId}
          FOR UPDATE
        `;

        // Check if lock exists
        if (rows.length === 0) {
          const result: ExtendResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        const data = rows[0];
        if (!data) {
          const result: ExtendResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        // Explicit ownership verification (ADR-003: defense-in-depth)
        if (data.lock_id !== opts.lockId) {
          const result: ExtendResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        // Check liveness (no resurrection of expired locks)
        const expiresAtMs = Number(data.expires_at_ms);
        if (!isLive(expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
          const result: ExtendResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "expired" };
          return result;
        }

        // Check abort signal before write
        checkAborted(opts.signal);

        // Compute new expiresAtMs from authoritative server time (ADR-010)
        // TTL replacement (not additive): nowMs + ttlMs
        const newExpiresAtMs = nowMs + opts.ttlMs;

        // Update the lock's expiration
        await sql`
          UPDATE ${sql(config.tableName)}
          SET expires_at_ms = ${newExpiresAtMs}
          WHERE key = ${data.key}
        `;

        return { ok: true, expiresAtMs: newExpiresAtMs } as ExtendResult;
      });

      return result;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapPostgresError(error);
    }
  };
}
