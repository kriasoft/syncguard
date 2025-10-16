// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import type { PostgresConfig } from "./types.js";

/**
 * Sets up required schema (tables and indexes) for PostgreSQL lock backend.
 *
 * Creates (if not exist):
 * - Lock table with primary key on 'key' and indexes on 'lock_id' and 'expires_at_ms'
 * - Fence counter table with primary key on 'fence_key'
 *
 * This is an idempotent operation and safe to call multiple times.
 * Call this once during application initialization, before creating lock backends.
 *
 * @param sql - postgres.js SQL instance
 * @param options - Optional configuration for table names
 * @returns Promise that resolves when schema is created
 *
 * @example
 * ```typescript
 * import postgres from 'postgres';
 * import { setupSchema, createLock } from 'syncguard/postgres';
 *
 * const sql = postgres('postgresql://localhost:5432/myapp');
 *
 * // Setup phase (once, during initialization)
 * await setupSchema(sql);
 *
 * // Usage phase (synchronous)
 * const lock = createLock(sql);
 * ```
 */
export async function setupSchema(
  sql: Sql,
  options: { tableName?: string; fenceTableName?: string } = {},
): Promise<void> {
  // Create config from options to get validated table names
  const config = {
    tableName: options.tableName ?? "syncguard_locks",
    fenceTableName: options.fenceTableName ?? "syncguard_fence_counters",
  } as PostgresConfig;

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
