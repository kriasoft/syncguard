// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import {
  BACKEND_LIMITS,
  type KeyLookup,
  LockError,
  type LockInfo,
  type OwnershipLookup,
  RESERVE_BYTES,
  attachRawData,
  makeStorageKey,
  normalizeAndValidateKey,
  sanitizeLockInfo,
  validateLockId,
} from "../../common/backend.js";
import { TIME_TOLERANCE_MS, isLive } from "../../common/time-predicates.js";
import { checkAborted, mapPostgresError } from "../errors.js";
import type {
  LockRow,
  PostgresCapabilities,
  PostgresConfig,
} from "../types.js";

/**
 * Creates lookup operation for PostgreSQL backend.
 *
 * **Dual-mode operation:**
 * - Key lookup: Direct query by key (O(1) via primary key)
 * - LockId lookup: Query by lockId using index
 *
 * **Implementation Pattern:**
 * - Non-atomic (acceptable for diagnostic-only lookups per ADR-011)
 * - Returns sanitized LockInfo with hashed key/lockId
 * - Attaches raw data for debugging purposes
 * - Uses server time for liveness check
 * - Returns null for non-existent or expired locks
 *
 * Flow:
 * 1. Determine lookup mode (key vs lockId)
 * 2. Validate and normalize input
 * 3. Query database (key: primary key, lockId: index)
 * 4. Check liveness using server time
 * 5. Sanitize and return LockInfo or null
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 * @returns Lookup operation function
 *
 * @see docs/specs/interface.md#lookup-operation-requirements - Normative requirements
 */
export function createLookupOperation(sql: Sql, config: PostgresConfig) {
  return async (
    opts: KeyLookup | OwnershipLookup,
  ): Promise<LockInfo<PostgresCapabilities> | null> => {
    try {
      // Check for cancellation before starting operation
      checkAborted(opts.signal);

      let rows: Array<LockRow>;
      let serverTime: number;

      if ("key" in opts) {
        // Key lookup: validate and normalize, then fetch by primary key
        const normalizedKey = normalizeAndValidateKey(opts.key);
        const storageKey = makeStorageKey(
          "", // No prefix for PostgreSQL (table namespaces keys)
          normalizedKey,
          BACKEND_LIMITS.POSTGRES,
          RESERVE_BYTES.POSTGRES,
        );

        // Query by primary key with server time
        const result = await sql<Array<{ now_ms: string } & LockRow>>`
          SELECT
            EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms,
            key, lock_id, expires_at_ms, acquired_at_ms, fence, user_key
          FROM ${sql(config.tableName)}
          WHERE key = ${storageKey}
        `;

        // Check for cancellation after read
        checkAborted(opts.signal);

        if (result.length === 0) {
          return null; // Lock not found
        }

        const firstKeyRow = result[0];
        if (!firstKeyRow) {
          return null;
        }

        serverTime = Math.floor(Number(firstKeyRow.now_ms));
        rows = result.map((r) => ({
          key: r.key,
          lock_id: r.lock_id,
          expires_at_ms: r.expires_at_ms,
          acquired_at_ms: r.acquired_at_ms,
          fence: r.fence,
          user_key: r.user_key,
        }));
      } else {
        // LockId lookup: validate and query by index
        validateLockId(opts.lockId);

        // Query by lockId index with server time
        const result = await sql<Array<{ now_ms: string } & LockRow>>`
          SELECT
            EXTRACT(EPOCH FROM NOW()) * 1000 AS now_ms,
            key, lock_id, expires_at_ms, acquired_at_ms, fence, user_key
          FROM ${sql(config.tableName)}
          WHERE lock_id = ${opts.lockId}
        `;

        // Check for cancellation after read
        checkAborted(opts.signal);

        if (result.length === 0) {
          return null; // Lock not found
        }

        const firstLockIdRow = result[0];
        if (!firstLockIdRow) {
          return null;
        }

        serverTime = Math.floor(Number(firstLockIdRow.now_ms));
        rows = result.map((r) => ({
          key: r.key,
          lock_id: r.lock_id,
          expires_at_ms: r.expires_at_ms,
          acquired_at_ms: r.acquired_at_ms,
          fence: r.fence,
          user_key: r.user_key,
        }));

        // Defense-in-depth: verify lockId match despite WHERE clause
        const firstRowCheck = rows[0];
        if (!firstRowCheck || firstRowCheck.lock_id !== opts.lockId) {
          return null;
        }
      }

      const data = rows[0];
      if (!data) {
        return null;
      }
      const expiresAtMs = Number(data.expires_at_ms);

      // Check liveness using server time
      if (!isLive(expiresAtMs, serverTime, TIME_TOLERANCE_MS)) {
        return null; // Lock expired
      }

      const capabilities: PostgresCapabilities = {
        backend: "postgres",
        supportsFencing: true,
        timeAuthority: "server",
      };

      // Prepare data for sanitization
      const lockData = {
        lockId: data.lock_id,
        expiresAtMs,
        acquiredAtMs: Number(data.acquired_at_ms),
        key: data.user_key,
        fence: data.fence,
      };

      const lockInfo = sanitizeLockInfo(lockData, capabilities);

      // Attach raw data for debugging (see: getByKeyRaw/getByIdRaw in common/helpers.ts)
      return attachRawData(lockInfo, {
        key: data.user_key,
        lockId: data.lock_id,
      });
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapPostgresError(error);
    }
  };
}
