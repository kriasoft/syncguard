/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

import type { Firestore } from "@google-cloud/firestore";
import type { LockBackend } from "../common/backend.js";
import { createFirestoreConfig } from "./config.js";
import { createAcquireOperation } from "./operations/acquire.js";
import { createExtendOperation } from "./operations/extend.js";
import { createIsLockedOperation } from "./operations/is-locked.js";
import { createReleaseOperation } from "./operations/release.js";
import type { FirestoreBackendOptions } from "./types.js";

/**
 * Creates a Firestore-based distributed lock backend
 *
 * IMPORTANT: This backend requires a Firestore index for optimal performance:
 * - Collection: {collection} (default: "locks")
 * - Field: lockId
 * - Type: Single field index (ascending)
 *
 * Without this index, release() and extend() operations will be slow and may fail.
 *
 * @param db Firestore instance
 * @param options Backend-specific configuration options
 * @returns LockBackend implementation for Firestore
 */
export function createFirestoreBackend(
  db: Firestore,
  options: FirestoreBackendOptions = {},
): LockBackend {
  const config = createFirestoreConfig(options);
  const locksCollection = db.collection(config.collection);

  return {
    acquire: createAcquireOperation(db, locksCollection, config),
    release: createReleaseOperation(db, locksCollection, config),
    extend: createExtendOperation(db, locksCollection, config),
    isLocked: createIsLockedOperation(locksCollection, config),
  };
}
