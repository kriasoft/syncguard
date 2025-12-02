// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import Redis from "ioredis";
import type { LockBackend } from "../../common/types.js";
import { createRedisBackend } from "../../redis/index.js";
import type { RedisCapabilities } from "../../redis/types.js";

export interface RedisFixture {
  name: string;
  kind: "redis";
  envVar: string;
  available(): Promise<boolean>;
  setup(): Promise<{
    cleanup(): Promise<void>;
    teardown(): Promise<void>;
    createBackend(): LockBackend<RedisCapabilities>;
  }>;
}

const TEST_PREFIX = "syncguard:test:";
const TEST_DB = 15;

export const redisFixture: RedisFixture = {
  name: "Redis",
  kind: "redis",
  envVar: "TEST_REDIS",

  async available(): Promise<boolean> {
    const redis = new Redis({
      host: "localhost",
      port: 6379,
      db: TEST_DB,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000),
      );

      await Promise.race([redis.ping(), timeoutPromise]);
      await redis.quit();
      return true;
    } catch {
      try {
        await redis.quit();
      } catch {
        // Ignore cleanup errors
      }
      return false;
    }
  },

  async setup() {
    const redis = new Redis({
      host: "localhost",
      port: 6379,
      db: TEST_DB,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    await redis.connect();

    // Clean slate before tests
    const keys = await redis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    return {
      async cleanup() {
        const keys = await redis.keys(`${TEST_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      },

      async teardown() {
        await redis.quit();
      },

      createBackend() {
        return createRedisBackend(redis, {
          keyPrefix: TEST_PREFIX,
        });
      },
    };
  },
};
