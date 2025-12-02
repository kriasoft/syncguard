// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import { FAILURE_REASON } from "../../common/backend-semantics.js";
import {
  LockError,
  type LockOp,
  type ReleaseResult,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS, isLive } from "../../common/time-predicates.js";
import { checkAborted, mapPostgresError } from "../errors.js";
import type { LockRow, PostgresConfig } from "../types.js";

/**
 * Creates PostgreSQL release operation with atomic transaction and ownership verification.
 *
 * **Implementation Pattern:**
 * - Atomic transaction: Query by lockId → verify ownership → check liveness → delete
 * - TOCTOU protection: All steps within single `sql.begin()` transaction
 * - Ownership verification: Explicit `data.lock_id === opts.lockId` check (ADR-003)
 * - AbortSignal: Manual cancellation checks via `checkAborted()` at strategic points
 *
 * Transaction flow:
 * 1. Get server time for authoritative liveness check
 * 2. Query by lockId using index (FOR UPDATE for row-level lock)
 * 3. Verify ownership (data.lock_id === lockId)
 * 4. Check liveness using isLive() predicate
 * 5. If all checks pass, delete the lock
 * 6. Return simplified result with optional telemetry reason
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 * @returns Release operation function
 *
 * @see docs/specs/interface.md#release-operation-requirements - Normative TOCTOU requirements
 */
export function createReleaseOperation(sql: Sql, config: PostgresConfig) {
  return async (opts: LockOp): Promise<ReleaseResult> => {
    try {
      // Pre-transaction abort check
      checkAborted(opts.signal);

      // Validate lockId format (22-char base64url)
      validateLockId(opts.lockId);

      // Atomic transaction: lookup → verify → delete
      const result = await sql.begin(async (sql) => {
        // Check abort signal inside transaction
        checkAborted(opts.signal);

        // Get server time (authoritative time source)
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
          const result: ReleaseResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        const data = rows[0];
        if (!data) {
          const result: ReleaseResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        // Explicit ownership verification (ADR-003: defense-in-depth)
        if (data.lock_id !== opts.lockId) {
          const result: ReleaseResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "not-found" };
          return result;
        }

        // Check liveness
        const expiresAtMs = Number(data.expires_at_ms);
        if (!isLive(expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
          const result: ReleaseResult = { ok: false };
          (result as any)[FAILURE_REASON] = { reason: "expired" };
          return result;
        }

        // Check abort signal before write
        checkAborted(opts.signal);

        // All checks passed - delete the lock
        await sql`
          DELETE FROM ${sql(config.tableName)}
          WHERE key = ${data.key}
        `;

        return { ok: true } as ReleaseResult;
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
