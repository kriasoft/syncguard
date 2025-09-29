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
