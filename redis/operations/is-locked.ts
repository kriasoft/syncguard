/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";
import { IS_LOCKED_SCRIPT } from "../scripts.js";

/**
 * Extended Redis interface with defined commands
 */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  checkLock?(
    lockKey: string,
    keyPrefix: string,
    currentTime: string,
  ): Promise<number>;
}

/**
 * Creates an isLocked operation for Redis backend
 */
export function createIsLockedOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (key: string): Promise<boolean> => {
    return withRetries(async () => {
      const lockKey = `${config.keyPrefix}${key}`;
      const currentTime = Date.now();

      const scriptResult = redis.checkLock
        ? await redis.checkLock(
            lockKey,
            config.keyPrefix,
            currentTime.toString(),
          )
        : ((await redis.eval(
            IS_LOCKED_SCRIPT,
            1,
            lockKey,
            config.keyPrefix,
            currentTime.toString(),
          )) as number);

      return scriptResult === 1;
    }, config);
  };
}
