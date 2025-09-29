// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "../common/backend.js";

/**
 * Firestore-specific backend capabilities
 */
export interface FirestoreCapabilities extends BackendCapabilities {
  /** Backend type discriminant */
  backend: "firestore";
  /** Firestore always provides fencing tokens */
  supportsFencing: true;
  /** Uses client time with unified tolerance constant */
  timeAuthority: "client";
}

/**
 * Configuration options specific to Firestore backend
 */
export interface FirestoreBackendOptions {
  /** Firestore collection name for storing locks (default: "locks") */
  collection?: string;
  /** Firestore collection name for storing fence counters (default: "fence_counters") */
  fenceCollection?: string;
  /** Enable cleanup in isLocked operation (default: false) */
  cleanupInIsLocked?: boolean;
}

/**
 * Document structure for lock storage in Firestore
 */
export interface LockDocument {
  /** Unique identifier for ownership verification */
  lockId: string;
  /** Expiration timestamp in ms (Unix epoch) */
  expiresAtMs: number;
  /** Acquisition timestamp in ms (Unix epoch) */
  acquiredAtMs: number;
  /** Lock key for identification */
  key: string;
  /** Monotonic fencing token (copy from counter doc for convenience) */
  fence: string;
}

/**
 * Fence counter document structure (lifecycle-independent from locks)
 */
export interface FenceCounterDocument {
  /** Monotonic counter as canonical decimal string (source of truth) */
  fence: string;
  /** Original key for debugging */
  keyDebug?: string;
}

/**
 * Internal configuration with defaults applied
 */
export interface FirestoreConfig {
  collection: string;
  fenceCollection: string;
  cleanupInIsLocked: boolean;
}
