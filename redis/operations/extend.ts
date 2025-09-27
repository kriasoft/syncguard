/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";
import { EXTEND_SCRIPT } from "../scripts.js";

/**
 * Extended Redis interface with defined commands
 */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  extendLock?(
    lockIdKey: string,
    lockId: string,
    ttlMs: string,
    currentTime: string,
  ): Promise<number>;
}

/**
 * Creates an extend operation for Redis backend
 */
export function createExtendOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (lockId: string, ttl: number): Promise<boolean> => {
    return withRetries(async () => {
      const lockIdKey = `${config.keyPrefix}id:${lockId}`;
      const currentTime = Date.now();

      const scriptResult = redis.extendLock
        ? await redis.extendLock(
            lockIdKey,
            lockId,
            ttl.toString(),
            currentTime.toString(),
          )
        : ((await redis.eval(
            EXTEND_SCRIPT,
            1,
            lockIdKey,
            lockId,
            ttl.toString(),
            currentTime.toString(),
          )) as number);

      return scriptResult === 1;
    }, config);
  };
}
