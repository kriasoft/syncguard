/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import { withRetries } from "../retry.js";
import type { RedisConfig } from "../types.js";
import { RELEASE_SCRIPT } from "../scripts.js";

/**
 * Extended Redis interface with defined commands
 */
interface RedisWithCommands {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  releaseLock?(lockIdKey: string, lockId: string): Promise<number>;
}

/**
 * Creates a release operation for Redis backend
 */
export function createReleaseOperation(
  redis: RedisWithCommands,
  config: RedisConfig,
) {
  return async (lockId: string): Promise<boolean> => {
    return withRetries(async () => {
      const lockIdKey = `${config.keyPrefix}id:${lockId}`;

      const scriptResult = redis.releaseLock
        ? await redis.releaseLock(lockIdKey, lockId)
        : ((await redis.eval(RELEASE_SCRIPT, 1, lockIdKey, lockId)) as number);

      return scriptResult === 1;
    }, config);
  };
}
