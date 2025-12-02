// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import postgres from "postgres";
import type { LockBackend } from "../../common/types.js";
import { createPostgresBackend } from "../../postgres/index.js";
import { setupSchema } from "../../postgres/schema.js";
import type { PostgresCapabilities } from "../../postgres/types.js";

export interface PostgresFixture {
  name: string;
  kind: "postgres";
  envVar: string;
  available(): Promise<boolean>;
  setup(): Promise<{
    cleanup(): Promise<void>;
    teardown(): Promise<void>;
    createBackend(): LockBackend<PostgresCapabilities>;
  }>;
}

const TEST_PREFIX = "syncguard_test_";

export const postgresFixture: PostgresFixture = {
  name: "PostgreSQL",
  kind: "postgres",
  envVar: "TEST_POSTGRES",

  async available(): Promise<boolean> {
    const dbUrl =
      process.env.POSTGRES_URL ||
      "postgres://postgres@localhost:5432/syncguard";

    const sql = postgres(dbUrl, {
      max: 1,
      connect_timeout: 2,
    });

    try {
      await sql`SELECT 1 as ok`;
      await sql.end();
      return true;
    } catch {
      try {
        await sql.end();
      } catch {
        // Ignore cleanup errors
      }
      return false;
    }
  },

  async setup() {
    const dbUrl =
      process.env.POSTGRES_URL ||
      "postgres://postgres@localhost:5432/syncguard";

    const sql = postgres(dbUrl, {
      max: 10,
    });

    // Setup test schema
    await setupSchema(sql, {
      tableName: `${TEST_PREFIX}syncguard_locks`,
      fenceTableName: `${TEST_PREFIX}syncguard_fence_counters`,
    });

    // Clean test tables
    await sql.unsafe(`DELETE FROM ${TEST_PREFIX}syncguard_locks`);
    await sql.unsafe(`DELETE FROM ${TEST_PREFIX}syncguard_fence_counters`);

    return {
      async cleanup() {
        await sql.unsafe(`DELETE FROM ${TEST_PREFIX}syncguard_locks`);
        await sql.unsafe(`DELETE FROM ${TEST_PREFIX}syncguard_fence_counters`);
      },

      async teardown() {
        await sql.end();
      },

      createBackend() {
        return createPostgresBackend(sql, {
          tableName: `${TEST_PREFIX}syncguard_locks`,
          fenceTableName: `${TEST_PREFIX}syncguard_fence_counters`,
        });
      },
    };
  },
};
