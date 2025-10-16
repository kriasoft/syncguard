// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  type LockOp,
  type ReleaseResult,
  LockError,
  makeStorageKey,
  validateLockId,
} from "../../common/backend.js";
import {
  type MutationReason,
  FAILURE_REASON,
} from "../../common/backend-semantics.js";
import { TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { checkAborted, mapRedisError } from "../errors.js";
import { RELEASE_SCRIPT } from "../scripts.js";
import type { RedisConfig } from "../types.js";

/** Redis client with eval and optional cached releaseLock method */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  releaseLock?(
    lockIdKey: string,
    lockId: string,
    toleranceMs: string,
  ): Promise<number>;
}

/**
 * Creates release operation with atomic ownership verification and deletion.
 * @see redis/scripts.ts
 */
export function createReleaseOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (opts: LockOp): Promise<ReleaseResult> => {
    try {
      // Pre-dispatch abort check (ioredis does not accept AbortSignal)
      checkAborted(opts.signal);

      validateLockId(opts.lockId);

      const REDIS_LIMIT_BYTES = 1000;
      const RESERVE_BYTES = 26; // ":id:" (4 bytes) + 22-char lockId

      const lockIdKey = makeStorageKey(
        config.keyPrefix,
        `id:${opts.lockId}`,
        REDIS_LIMIT_BYTES,
        RESERVE_BYTES,
      );

      const toleranceMs = TIME_TOLERANCE_MS;

      // Prefer cached script (releaseLock) over eval for performance (ADR-013)
      const scriptResult = redis.releaseLock
        ? await redis.releaseLock(
            lockIdKey,
            opts.lockId,
            toleranceMs.toString(),
          )
        : ((await redis.eval(
            RELEASE_SCRIPT,
            1,
            lockIdKey,
            opts.lockId,
            toleranceMs.toString(),
          )) as number);

      // Script returns: 1=success, 0=mismatch, -1=not found, -2=expired
      const ok = scriptResult === 1;
      const result: ReleaseResult = { ok };

      // Attach telemetry metadata (hidden from public API)
      if (!ok) {
        let reason: MutationReason;
        if (scriptResult === -2) {
          reason = "expired";
        } else {
          reason = "not-found"; // -1 or 0 → "not-found"
        }
        (result as any)[FAILURE_REASON] = { reason };
      }

      return result;
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapRedisError(error);
    }
  };
}
