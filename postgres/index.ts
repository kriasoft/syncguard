// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * PostgreSQL backend for SyncGuard distributed locking.
 *
 * Uses postgres.js (porsager/postgres) for transaction-based locking
 * with table storage, server-side time authority, and fence tokens.
 *
 * @module syncguard/postgres
 */

export { createPostgresBackend } from "./backend.js";
export type {
  PostgresBackendOptions,
  PostgresCapabilities,
  PostgresConfig,
} from "./types.js";
