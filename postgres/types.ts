// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "../common/backend.js";

/**
 * PostgreSQL backend capabilities with server-side time authority.
 */
export interface PostgresCapabilities extends BackendCapabilities {
  backend: "postgres";
  supportsFencing: true; // PostgreSQL always provides fence tokens
  timeAuthority: "server"; // Uses PostgreSQL server time
}

/**
 * Configuration options for PostgreSQL backend.
 */
export interface PostgresBackendOptions {
  /**
   * Table name for lock storage.
   * @default "syncguard_locks"
   */
  tableName?: string;

  /**
   * Table name for fence counter storage.
   * @default "syncguard_fence_counters"
   */
  fenceTableName?: string;

  /**
   * Enable opportunistic cleanup in isLocked operation.
   * @default false
   */
  cleanupInIsLocked?: boolean;
}

/**
 * Internal configuration after applying defaults and validation.
 */
export interface PostgresConfig {
  tableName: string;
  fenceTableName: string;
  cleanupInIsLocked: boolean;
}

/**
 * Lock row structure in syncguard_locks table.
 */
export interface LockRow {
  key: string;
  lock_id: string;
  expires_at_ms: string; // BIGINT as string
  acquired_at_ms: string; // BIGINT as string
  fence: string;
  user_key: string;
}

/**
 * Fence counter row structure in syncguard_fence_counters table.
 */
export interface FenceRow {
  fence_key: string;
  fence: string; // BIGINT as string
  key_debug: string | null;
}
