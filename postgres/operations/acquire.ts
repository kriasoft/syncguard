// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import {
  type AcquireResult,
  BACKEND_LIMITS,
  FENCE_THRESHOLDS,
  type KeyOp,
  LockError,
  RESERVE_BYTES,
  generateLockId,
  logFenceWarning,
  makeStorageKey,
  normalizeAndValidateKey,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS, isLive } from "../../common/time-predicates.js";
import { checkAborted, mapPostgresError } from "../errors.js";
import type {
  LockRow,
  PostgresCapabilities,
  PostgresConfig,
} from "../types.js";

/**
 * Creates PostgreSQL acquire operation with atomic transaction.
 *
 * Transaction flow:
 * 1. Acquire advisory lock on storage key (serializes concurrent acquires)
 * 2. Get server time
 * 3. Check if lock exists and is live
 * 4. If live, return contention
 * 5. Increment fence counter atomically using two-step pattern:
 *    a. INSERT ... ON CONFLICT DO NOTHING (ensures row exists)
 *    b. UPDATE ... RETURNING (implicit row lock serializes concurrent increments)
 *    This pattern prevents absent-row race where multiple clients both see
 *    missing row and both insert fence=1.
 * 6. Insert/update lock with new lockId and fence
 * 7. Return success with authoritative server-time expiresAtMs
 * 8. Advisory lock automatically released on transaction commit
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 * @returns Acquire operation function
 */
export function createAcquireOperation(sql: Sql, config: PostgresConfig) {
  return async (
    opts: KeyOp & { ttlMs: number },
  ): Promise<AcquireResult<PostgresCapabilities>> => {
    try {
      // Pre-transaction abort check
      checkAborted(opts.signal);

      const normalizedKey = normalizeAndValidateKey(opts.key);

      if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
        throw new LockError(
          "InvalidArgument",
          "ttlMs must be a positive integer",
        );
      }

      const lockId = generateLockId();

      // Storage key generation (two-step pattern for fence key derivation)
      const baseKey = makeStorageKey(
        "", // No prefix for PostgreSQL (table namespaces keys)
        normalizedKey,
        BACKEND_LIMITS.POSTGRES,
        RESERVE_BYTES.POSTGRES,
      );
      const storageKey = baseKey;

      // Fence key derivation (ADR-006: two-step pattern)
      const fenceKey = makeStorageKey(
        "",
        `fence:${baseKey}`,
        BACKEND_LIMITS.POSTGRES,
        RESERVE_BYTES.POSTGRES,
      );

      // Atomic transaction: check → increment fence → insert/update lock
      const result = await sql.begin(async (sql) => {
        // Check abort signal inside transaction
        checkAborted(opts.signal);

        // Acquire advisory lock on storage key to serialize concurrent acquires
        // Uses hashtext() for deterministic 32-bit hash of storage key
        await sql`SELECT pg_advisory_xact_lock(hashtext(${storageKey}))`;

        // Get server time (authoritative time source)
        const timeResult = await sql<
          Array<{ now_ms: string }>
        >`SELECT EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms`;
        const timeRow = timeResult[0];
        if (!timeRow) {
          throw new LockError("Internal", "Failed to get server time");
        }
        const nowMs = Math.floor(Number(timeRow.now_ms));

        // Check if lock exists and is live
        const existing = await sql<Array<LockRow>>`
          SELECT * FROM ${sql(config.tableName)}
          WHERE key = ${storageKey}
        `;

        if (existing.length > 0) {
          const existingRow = existing[0];
          if (!existingRow) {
            throw new LockError("Internal", "Invalid lock row data");
          }
          const expiresAtMs = Number(existingRow.expires_at_ms);
          if (isLive(expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
            // Lock is held by another process
            return { ok: false, reason: "locked" } as const;
          }
        }

        // Increment fence counter atomically (two-step pattern for absent-row race protection)
        // Step 1: Ensure row exists (idempotent initialization)
        await sql`
          INSERT INTO ${sql(config.fenceTableName)} (fence_key, fence, key_debug)
          VALUES (${fenceKey}, 0, ${normalizedKey})
          ON CONFLICT (fence_key) DO NOTHING
        `;

        // Step 2: Increment with implicit row lock (serializes concurrent updates)
        const fenceResult = await sql<Array<{ fence: string }>>`
          UPDATE ${sql(config.fenceTableName)}
          SET fence = fence + 1
          WHERE fence_key = ${fenceKey}
          RETURNING fence
        `;

        const fenceRow = fenceResult[0];
        if (!fenceRow) {
          throw new LockError("Internal", "Failed to increment fence counter");
        }
        const fenceNum = BigInt(fenceRow.fence);
        const fence = String(fenceNum).padStart(15, "0");

        // Overflow enforcement (ADR-004)
        if (fence > FENCE_THRESHOLDS.MAX) {
          throw new LockError(
            "Internal",
            `Fence counter overflow - exceeded operational limit (${FENCE_THRESHOLDS.MAX})`,
            { key: opts.key },
          );
        }

        // Operational monitoring: warn at threshold
        if (fence > FENCE_THRESHOLDS.WARN) {
          logFenceWarning(fence, opts.key);
        }

        const expiresAtMs = nowMs + opts.ttlMs;

        // Insert or update lock
        await sql`
          INSERT INTO ${sql(config.tableName)} (
            key, lock_id, expires_at_ms, acquired_at_ms, fence, user_key
          )
          VALUES (
            ${storageKey},
            ${lockId},
            ${expiresAtMs},
            ${nowMs},
            ${fence},
            ${normalizedKey}
          )
          ON CONFLICT (key)
          DO UPDATE SET
            lock_id = EXCLUDED.lock_id,
            expires_at_ms = EXCLUDED.expires_at_ms,
            acquired_at_ms = EXCLUDED.acquired_at_ms,
            fence = EXCLUDED.fence,
            user_key = EXCLUDED.user_key
        `;

        return {
          ok: true,
          lockId,
          expiresAtMs,
          fence,
        } as const;
      });

      return result as AcquireResult<PostgresCapabilities>;
    } catch (error) {
      throw mapPostgresError(error);
    }
  };
}
