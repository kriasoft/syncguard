// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { hashKey } from "./crypto.js";
import type {
  AcquireOk,
  AcquireResult,
  BackendCapabilities,
  Fence,
  LockBackend,
  LockInfo,
  LockInfoDebug,
} from "./types.js";

// ============================================================================
// Fence Token Type Safety
// ============================================================================

/**
 * Type guard for fence token presence. Only needed for generic backend code.
 *
 * @param result - Acquire result to check
 * @returns true if successful with fence token
 */
export function hasFence<C extends BackendCapabilities>(
  result: AcquireResult<C>,
): result is AcquireOk<C> & { fence: Fence } {
  return result.ok && "fence" in result && !!result.fence;
}

// ============================================================================
// Observability & Data Sanitization
// ============================================================================

/**
 * Sanitizes raw lock data for safe observability (hashes sensitive fields).
 * @internal Used by backend implementations
 */
export function sanitizeLockInfo<C extends BackendCapabilities>(
  rawData: {
    key: string;
    lockId: string;
    expiresAtMs: number;
    acquiredAtMs: number;
    fence?: string;
  },
  capabilities: C,
): LockInfo<C> {
  const lockInfo: LockInfo<C> = {
    keyHash: hashKey(rawData.key),
    lockIdHash: hashKey(rawData.lockId),
    expiresAtMs: rawData.expiresAtMs,
    acquiredAtMs: rawData.acquiredAtMs,
  } as LockInfo<C>;

  if (capabilities.supportsFencing && rawData.fence) {
    (lockInfo as any).fence = rawData.fence;
  }

  return lockInfo;
}

// Symbol for attaching raw key/lockId to LockInfo without public API exposure
const RAW_DATA_SYMBOL = Symbol.for("syncguard.rawData");

/**
 * Attaches raw data for debug access via lookupDebug().
 * @internal Used by backend implementations
 */
export function attachRawData<C extends BackendCapabilities>(
  lockInfo: LockInfo<C>,
  rawData: { key: string; lockId: string },
): LockInfo<C> {
  (lockInfo as any)[RAW_DATA_SYMBOL] = rawData;
  return lockInfo;
}

/**
 * Retrieves lock info with raw key/lockId for debugging.
 * WARNING: Contains sensitive identifiers, use only for debugging.
 *
 * @param backend - Backend instance
 * @param query - { key } or { lockId }
 * @returns LockInfoDebug with raw fields, or null
 */
export async function lookupDebug<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  query: { key: string } | { lockId: string },
): Promise<LockInfoDebug<C> | null> {
  const info = await backend.lookup(query as any);

  if (!info) {
    return null;
  }

  // Extract raw data attached via RAW_DATA_SYMBOL
  const rawData = (info as any)[RAW_DATA_SYMBOL] as
    | { key: string; lockId: string }
    | undefined;

  if (rawData) {
    return {
      ...info,
      key: rawData.key,
      lockId: rawData.lockId,
    } as LockInfoDebug<C>;
  }

  // Fallback: partial info from query when backend doesn't attach raw data
  if ("key" in query) {
    return {
      ...info,
      key: query.key,
      lockId: "[backend does not provide raw lockId]",
    } as LockInfoDebug<C>;
  } else {
    return {
      ...info,
      key: "[backend does not provide raw key]",
      lockId: query.lockId,
    } as LockInfoDebug<C>;
  }
}

// ============================================================================
// Diagnostic API (O(1) lookups with sanitized data)
// ============================================================================

/**
 * Looks up lock by key (direct access, O(1)).
 * @returns Sanitized LockInfo or null
 */
export function getByKey<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null> {
  return backend.lookup({ key, ...opts });
}

/**
 * Looks up lock by lockId (reverse lookup).
 * @returns Sanitized LockInfo or null
 */
export function getById<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null> {
  return backend.lookup({ lockId, ...opts });
}

/**
 * Looks up lock by key with raw key/lockId (for debugging).
 * @returns LockInfoDebug with sensitive fields or null
 */
export function getByKeyRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null> {
  return lookupDebug(backend, { key });
}

/**
 * Looks up lock by lockId with raw key/lockId (for debugging).
 * @returns LockInfoDebug with sensitive fields or null
 */
export function getByIdRaw<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfoDebug<C> | null> {
  return lookupDebug(backend, { lockId });
}

/**
 * Checks if lockId owns an active lock.
 * @returns true if lockId has an active lock
 */
export function owns<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
): Promise<boolean> {
  return backend.lookup({ lockId }).then((result) => result !== null);
}

// ============================================================================
// Utilities
// ============================================================================

/** Creates a delay promise for testing/retries. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
