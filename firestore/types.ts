/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Configuration options specific to Firestore backend
 */
export interface FirestoreBackendOptions {
  /** Firestore collection name for storing locks (default: "locks") */
  collection?: string;
  /** Delay between retries in milliseconds (default: 100) */
  retryDelayMs?: number;
  /** Maximum number of retries (default: 10) */
  maxRetries?: number;
}

/**
 * Document structure for lock storage in Firestore
 */
export interface LockDocument {
  /** Unique identifier for the lock */
  lockId: string;
  /** Timestamp when the lock expires */
  expiresAt: number;
  /** Timestamp when the lock was created */
  createdAt: number;
  /** Lock key for identification */
  key: string;
}

/**
 * Internal configuration with defaults applied
 */
export interface FirestoreConfig {
  collection: string;
  retryDelayMs: number;
  maxRetries: number;
}
