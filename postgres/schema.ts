// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import type { PostgresConfig } from "./types.js";

/**
 * Ensures required tables and indexes exist for lock storage.
 *
 * Creates:
 * - syncguard_locks table (primary key on 'key')
 * - idx_lock_id index for fast lockId lookups
 * - syncguard_fence_counters table (primary key on 'fence_key')
 *
 * Tables are created with IF NOT EXISTS, making this operation idempotent.
 *
 * @param sql - postgres.js SQL instance
 * @param config - PostgreSQL backend configuration
 */
export async function ensureTables(
  sql: Sql,
  config: PostgresConfig,
): Promise<void> {
  if (!config.autoCreateTables) {
    return;
  }

  // Create locks table
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${config.tableName} (
      key TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      acquired_at_ms BIGINT NOT NULL,
      fence TEXT NOT NULL,
      user_key TEXT NOT NULL
    )
  `);

  // Create unique index on lock_id for fast reverse lookups
  // UNIQUE enforces the invariant that each lockId appears at most once
  // (lockIds are cryptographically random, collisions are ~2^-128 impossible)
  await sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${config.tableName}_lock_id
    ON ${config.tableName}(lock_id)
  `);

  // Create index on expires_at_ms for cleanup queries and monitoring
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_${config.tableName}_expires
    ON ${config.tableName}(expires_at_ms)
  `);

  // Create fence counters table (persistent, never deleted)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${config.fenceTableName} (
      fence_key TEXT PRIMARY KEY,
      fence BIGINT NOT NULL DEFAULT 0,
      key_debug TEXT
    )
  `);
}
