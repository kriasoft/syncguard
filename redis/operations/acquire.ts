/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { LockConfig, LockResult } from "../../common/backend.js";
import { generateLockId, mergeLockConfig } from "../../common/backend.js";
import { withAcquireRetries } from "../retry.js";
import type { LockData, RedisConfig } from "../types.js";
import { ACQUIRE_SCRIPT } from "../scripts.js";

/**
 * Extended Redis interface with defined commands
 */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  acquireLock?(
    lockKey: string,
    lockIdKey: string,
    lockData: string,
    ttlSeconds: string,
    currentTime: string,
    keyPrefix: string,
  ): Promise<number>;
}

/**
 * Creates an acquire operation for Redis backend
 */
export function createAcquireOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (lockConfig: LockConfig): Promise<LockResult> => {
    const mergedConfig = mergeLockConfig(lockConfig);
    const lockId = generateLockId();
    const startTime = Date.now();

    try {
      const result = await withAcquireRetries(
        async () => {
          // Check timeout before starting operation
          if (Date.now() - startTime > mergedConfig.timeoutMs) {
            return {
              acquired: false,
              reason: "Acquisition timeout before operation",
            } as const;
          }

          const currentTime = Date.now();
          const expiresAt = currentTime + mergedConfig.ttlMs;
          const ttlSeconds = Math.ceil(mergedConfig.ttlMs / 1000);

          const lockKey = `${config.keyPrefix}${mergedConfig.key}`;
          const lockIdKey = `${config.keyPrefix}id:${lockId}`;

          const lockData: LockData = {
            lockId,
            expiresAt,
            createdAt: currentTime,
            key: mergedConfig.key,
          };

          // Final timeout check before Redis operation
          if (Date.now() - startTime > mergedConfig.timeoutMs) {
            return {
              acquired: false,
              reason: "Acquisition timeout before Redis operation",
            } as const;
          }

          const scriptResult = redis.acquireLock
            ? await redis.acquireLock(
                lockKey,
                lockIdKey,
                JSON.stringify(lockData),
                ttlSeconds.toString(),
                currentTime.toString(),
                config.keyPrefix,
              )
            : ((await redis.eval(
                ACQUIRE_SCRIPT,
                2,
                lockKey,
                lockIdKey,
                JSON.stringify(lockData),
                ttlSeconds.toString(),
                currentTime.toString(),
                config.keyPrefix,
              )) as number);

          if (scriptResult === 1) {
            return { acquired: true, expiresAt } as const;
          } else {
            return {
              acquired: false,
              reason: "Lock already held",
            } as const;
          }
        },
        config,
        mergedConfig.timeoutMs,
      );

      if (result.acquired) {
        return {
          success: true,
          lockId,
          expiresAt: new Date(result.expiresAt!),
        };
      } else {
        return {
          success: false,
          error: result.reason || "Failed to acquire lock",
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: `Failed to acquire lock "${mergedConfig.key}": ${errorMessage}`,
      };
    }
  };
}
