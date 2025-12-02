// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Sql } from "postgres";
import type { LockBackend } from "../common/backend.js";
import { decorateAcquireResult } from "../common/disposable.js";
import { normalizeAndValidateKey } from "../common/validation.js";
import { createPostgresConfig } from "./config.js";
import {
  createAcquireOperation,
  createExtendOperation,
  createIsLockedOperation,
  createLookupOperation,
  createReleaseOperation,
} from "./operations/index.js";
import type { PostgresBackendOptions, PostgresCapabilities } from "./types.js";

/**
 * Creates PostgreSQL-based distributed lock backend using transactions.
 *
 * Storage: Two tables:
 * - {tableName}: Lock data (key PRIMARY KEY, lock_id indexed)
 * - {fenceTableName}: Fence counters (fence_key PRIMARY KEY, never deleted)
 *
 * Uses postgres.js library (porsager/postgres) for optimal performance.
 *
 * IMPORTANT: Call setupSchema() once before creating backends to set up schema.
 *
 * @param sql - postgres.js SQL instance
 * @param options - Backend configuration (tables, cleanup options)
 * @returns LockBackend with server-side time authority
 * @see docs/specs/postgres-backend.md
 *
 * @example
 * ```typescript
 * import postgres from 'postgres';
 * import { createPostgresBackend, setupSchema } from 'syncguard/postgres';
 *
 * const sql = postgres('postgresql://localhost:5432/myapp');
 *
 * // Setup schema (once, during initialization)
 * await setupSchema(sql);
 *
 * // Create backend (synchronous)
 * const backend = createPostgresBackend(sql);
 *
 * const result = await backend.acquire({ key: 'resource:123', ttlMs: 30_000 });
 * ```
 */
export function createPostgresBackend(
  sql: Sql,
  options: PostgresBackendOptions = {},
): LockBackend<PostgresCapabilities> {
  const config = createPostgresConfig(options);

  const capabilities: Readonly<PostgresCapabilities> = {
    backend: "postgres",
    supportsFencing: true,
    timeAuthority: "server",
  };

  // Create base operations
  const acquireCore = createAcquireOperation(sql, config);
  const releaseOp = createReleaseOperation(sql, config);
  const extendOp = createExtendOperation(sql, config);

  // Create backend object with disposal support
  const backend: LockBackend<PostgresCapabilities> = {
    acquire: async (opts) => {
      const normalizedKey = normalizeAndValidateKey(opts.key);
      const result = await acquireCore(opts);
      return decorateAcquireResult(
        backend,
        result,
        normalizedKey,
        config.onReleaseError,
        config.disposeTimeoutMs,
      );
    },
    release: releaseOp,
    extend: extendOp,
    isLocked: createIsLockedOperation(sql, config),
    lookup: createLookupOperation(sql, config),
    capabilities,
  };

  return backend;
}
