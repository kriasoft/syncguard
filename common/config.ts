// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { BACKEND_DEFAULTS, LOCK_DEFAULTS } from "./constants.js";
import type { AcquisitionOptions, LockConfig } from "./types.js";

/**
 * Applies backend defaults to user config for lock operations.
 * @see ./constants.ts for default values
 */
export function mergeBackendConfig(
  config: Pick<LockConfig, "ttlMs">,
): Required<Pick<LockConfig, "ttlMs">> {
  return {
    ttlMs: config.ttlMs ?? BACKEND_DEFAULTS.ttlMs,
  };
}

/**
 * Applies retry/timeout defaults to acquisition options.
 * @see ./auto-lock.ts for usage in lock() helper
 */
export function mergeAcquisitionConfig(
  options: AcquisitionOptions | undefined,
): Omit<Required<AcquisitionOptions>, "signal"> & { signal?: AbortSignal } {
  return {
    maxRetries: options?.maxRetries ?? LOCK_DEFAULTS.maxRetries,
    retryDelayMs: options?.retryDelayMs ?? LOCK_DEFAULTS.retryDelayMs,
    timeoutMs: options?.timeoutMs ?? LOCK_DEFAULTS.timeoutMs,
    backoff: options?.backoff ?? LOCK_DEFAULTS.backoff,
    jitter: options?.jitter ?? LOCK_DEFAULTS.jitter,
    signal: options?.signal,
  };
}
