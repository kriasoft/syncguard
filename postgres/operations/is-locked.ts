// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import {
  BACKEND_LIMITS,
  type KeyOp,
  LockError,
  RESERVE_BYTES,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS, isLive } from "../../common/time-predicates.js";
import { checkAborted, mapPostgresError } from "../errors.js";
import type { LockRow, PostgresConfig } from "../types.js";

/**
 * Creates isLocked operation for PostgreSQL backend.
 *
 * **Implementation Pattern:**
 * - Read-only by default (no side effects)
 * - Optional cleanup when cleanupInIsLocked: true (fire-and-forget)
 * - Uses server time for liveness check
 * - Simple boolean return value
 *
 * Flow:
 * 1. Normalize and validate key
 * 2. Query lock by key
 * 3. Check liveness using server time
 * 4. Optionally cleanup expired locks (fire-and-forget, with safety guard)
 * 5. Return boolean result
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 * @returns IsLocked operation function
 *
 * @see docs/specs/interface.md#islocked-operation-requirements - Normative requirements
 */
export function createIsLockedOperation(sql: Sql, config: PostgresConfig) {
  return async (opts: KeyOp): Promise<boolean> => {
    try {
      // Check for cancellation before starting operation
      checkAborted(opts.signal);

      const normalizedKey = normalizeAndValidateKey(opts.key);

      const storageKey = makeStorageKey(
        "", // No prefix for PostgreSQL (table namespaces keys)
        normalizedKey,
        BACKEND_LIMITS.POSTGRES,
        RESERVE_BYTES.POSTGRES,
      );

      // Get server time and lock data
      const result = await sql<
        Array<{ now_ms: string; expires_at_ms?: string; key?: string }>
      >`
        SELECT
          EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms,
          expires_at_ms,
          key
        FROM ${sql(config.tableName)}
        WHERE key = ${storageKey}
      `;

      // Check for cancellation after read
      checkAborted(opts.signal);

      // No lock found
      if (result.length === 0) {
        return false;
      }

      const row = result[0];
      if (!row) {
        return false;
      }

      const nowMs = Math.floor(Number(row.now_ms));
      const expiresAtMs = Number(row.expires_at_ms);

      // Check if lock is live
      if (!isLive(expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
        // Lock is expired
        if (config.cleanupInIsLocked) {
          // Fire-and-forget cleanup with safety guard
          // 1s safety guard prevents race with concurrent extend operations
          const guardMs = 1000;
          if (nowMs - expiresAtMs > TIME_TOLERANCE_MS + guardMs) {
            // Non-blocking cleanup - don't await, swallow errors
            // Note: opts.signal intentionally not passed to background cleanup
            sql
              .begin(async (sql) => {
                // Re-check expiration in transaction to prevent races
                const timeResult = await sql<Array<{ now_ms: string }>>`
                  SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms
                `;
                const timeRow = timeResult[0];
                if (!timeRow) {
                  return;
                }
                const txNowMs = Math.floor(Number(timeRow.now_ms));

                const rows = await sql<Array<LockRow>>`
                  SELECT * FROM ${sql(config.tableName)}
                  WHERE key = ${storageKey}
                  FOR UPDATE
                `;

                if (rows.length > 0) {
                  const data = rows[0];
                  if (!data) {
                    return;
                  }
                  const txExpiresAtMs = Number(data.expires_at_ms);

                  // Re-verify expiration with guard
                  if (
                    !isLive(txExpiresAtMs, txNowMs, TIME_TOLERANCE_MS + guardMs)
                  ) {
                    await sql`
                      DELETE FROM ${sql(config.tableName)}
                      WHERE key = ${storageKey}
                    `;
                  }
                }
              })
              .catch(() => {
                // Lock expires naturally if cleanup fails
                // Silently ignore cleanup errors
              });
          }
        }
        return false;
      }

      return true;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapPostgresError(error);
    }
  };
}
