// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Configuration constants and defaults for the SyncGuard library.
 */

/**
 * Max key length after NFC normalization + UTF-8 encoding, before backend prefixing.
 */
export const MAX_KEY_LENGTH_BYTES = 512;

/**
 * Backend-specific byte limits for storage keys.
 * These limits account for the underlying storage system constraints.
 */
export const BACKEND_LIMITS = {
  /** Redis key length limit (practical maximum) */
  REDIS: 1000,
  /**
   * PostgreSQL TEXT primary key limit based on B-tree index tuple size.
   *
   * **Rationale:**
   * - PostgreSQL B-tree index pages are 8KB by default
   * - Theoretical max tuple size: ~2704 bytes (1/3 of page size)
   * - Required headroom for:
   *   - Tuple header overhead (~23 bytes)
   *   - Multi-column indexes (e.g., composite primary key or secondary indexes)
   *   - UTF-8 encoding variations (worst case: 4 bytes per character)
   * - Conservative limit: 1700 bytes ensures safety with ~1000 bytes margin
   *
   * **NOT related to:** PostgreSQL identifier limit (63 bytes for table/column names).
   * That limit applies to schema object names, not row data.
   *
   * @see https://www.postgresql.org/docs/current/btree-implementation.html
   */
  POSTGRES: 1700,
  /** Firestore document ID limit */
  FIRESTORE: 1500,
} as const;

/**
 * Reserve bytes for derived keys in backend storage systems.
 *
 * Reserve bytes are extra space that backends must account for when generating
 * storage keys to ensure derived keys (with suffixes) fit within backend limits.
 *
 * **Calculation for Redis:**
 * - ":id:" prefix = 4 bytes (ASCII: 4 characters)
 * - lockId = 22 bytes (base64url encoded from 16 random bytes)
 * - Total: 26 bytes
 *
 * **Calculation for PostgreSQL:**
 * - No derived keys with suffixes (lock and fence tables use separate primary keys)
 * - Total: 0 bytes
 *
 * **Calculation for Firestore:**
 * - No derived keys with suffixes (each key type uses independent document IDs)
 * - Total: 0 bytes
 *
 * @example Redis dual-key pattern
 * ```typescript
 * // Main lock key: "syncguard:user:resource"
 * // Derived index key: "syncguard:id:abc123def456..." (adds ":id:" + lockId)
 * const baseKey = makeStorageKey(prefix, key, BACKEND_LIMITS.REDIS, RESERVE_BYTES.REDIS);
 * const indexKey = makeStorageKey(prefix, `id:${lockId}`, BACKEND_LIMITS.REDIS, RESERVE_BYTES.REDIS);
 * ```
 *
 * @example PostgreSQL independent table design
 * ```typescript
 * // Lock table primary key: "user:resource"
 * // Fence counter table primary key: "fence:user:resource" (independent, not derived)
 * const baseKey = makeStorageKey("", key, BACKEND_LIMITS.POSTGRES, RESERVE_BYTES.POSTGRES);
 * const fenceKey = makeStorageKey("", `fence:${baseKey}`, BACKEND_LIMITS.POSTGRES, RESERVE_BYTES.POSTGRES);
 * ```
 *
 * @example Firestore independent document IDs
 * ```typescript
 * // Lock document ID: "user:resource"
 * // Fence counter document ID: "fence:user:resource" (independent, not derived)
 * const baseKey = makeStorageKey("", key, BACKEND_LIMITS.FIRESTORE, RESERVE_BYTES.FIRESTORE);
 * const fenceDocId = makeStorageKey("", `fence:${baseKey}`, BACKEND_LIMITS.FIRESTORE, RESERVE_BYTES.FIRESTORE);
 * ```
 *
 * @see specs/redis-backend.md#dual-key-storage-pattern - Redis reserve bytes calculation
 * @see specs/postgres-backend.md#lock-table-requirements - PostgreSQL reserve bytes (0) rationale
 * @see specs/firestore-backend.md#lock-documents - Firestore reserve bytes (0) rationale
 */
export const RESERVE_BYTES = {
  /**
   * Redis reserve bytes: 26
   * Formula: ":id:" (4 bytes) + lockId (22 bytes) = 26 bytes
   */
  REDIS: 26,
  /**
   * PostgreSQL reserve bytes: 0
   * Formula: 0 bytes (separate tables with independent primary keys)
   */
  POSTGRES: 0,
  /**
   * Firestore reserve bytes: 0
   * Formula: 0 bytes (no derived keys with suffixes)
   */
  FIRESTORE: 0,
} as const;

/**
 * Backend defaults - single-attempt operations only.
 * @see common/auto-lock.ts for retry logic
 */
export const BACKEND_DEFAULTS = {
  /** Lock TTL in milliseconds */
  ttlMs: 30_000,
} as const;

/**
 * Lock helper defaults - retry logic via lock() function, not backends.
 * @see common/auto-lock.ts
 */
export const LOCK_DEFAULTS = {
  /** Max retry attempts for lock acquisition */
  maxRetries: 10,
  /** Base delay between retries in ms */
  retryDelayMs: 100,
  /** Max time to wait for lock acquisition in ms */
  timeoutMs: 5_000,
  /** Backoff strategy: exponential growth per attempt */
  backoff: "exponential" as const,
  /** Jitter type: 50% randomization to prevent thundering herd */
  jitter: "equal" as const,
};

/**
 * Fence overflow thresholds for monotonic fencing tokens (ADR-004).
 *
 * **Format**: 15-digit zero-padded decimal strings for lexicographic comparison
 * and precision safety within Lua's 53-bit float (2^53-1 ≈ 9.007e15).
 *
 * **Capacity**: 10^15 fence tokens = ~31.7 years at 1M locks/sec.
 *
 * @see specs/adrs.md ADR-004 - Fence token format and overflow handling
 */
export const FENCE_THRESHOLDS = {
  /**
   * Maximum fence value (9e14).
   * Backends MUST throw LockError("Internal") when fence exceeds this limit.
   * Stays well within Lua's 53-bit precision (2^53-1 ≈ 9.007e15).
   */
  MAX: "900000000000000",

  /**
   * Warning threshold (9e13).
   * Backends MUST log warnings via logFenceWarning() when fence exceeds this value.
   * Provides early operational signal at 10% of maximum capacity.
   */
  WARN: "090000000000000",
} as const;
