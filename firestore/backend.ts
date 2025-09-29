// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Firestore } from "@google-cloud/firestore";
import type { LockBackend } from "../common/backend.js";
import { createFirestoreConfig } from "./config.js";
import { createAcquireOperation } from "./operations/acquire.js";
import { createExtendOperation } from "./operations/extend.js";
import { createIsLockedOperation } from "./operations/is-locked.js";
import { createLookupOperation } from "./operations/lookup.js";
import { createReleaseOperation } from "./operations/release.js";
import type {
  FirestoreBackendOptions,
  FirestoreCapabilities,
} from "./types.js";

/**
 * Creates Firestore-based distributed lock backend using transactions.
 *
 * IMPORTANT: Requires composite index on lockId field for release()/extend() performance.
 * See firebase.json for index configuration.
 *
 * @param db - Firestore instance from @google-cloud/firestore
 * @param options - Backend configuration (collection, ttl, tolerance)
 * @returns LockBackend with client-side time authority
 * @see specs/firestore.md
 */
export function createFirestoreBackend(
  db: Firestore,
  options: FirestoreBackendOptions = {},
): LockBackend<FirestoreCapabilities> {
  const config = createFirestoreConfig(options);
  const locksCollection = db.collection(config.collection);
  const fenceCounterCollection = db.collection(config.fenceCollection);

  const capabilities: Readonly<FirestoreCapabilities> = {
    backend: "firestore",
    supportsFencing: true,
    timeAuthority: "client",
  };

  return {
    acquire: createAcquireOperation(
      db,
      locksCollection,
      fenceCounterCollection,
      config,
    ),
    release: createReleaseOperation(db, locksCollection, config),
    extend: createExtendOperation(db, locksCollection, config),
    isLocked: createIsLockedOperation(db, locksCollection, config),
    lookup: createLookupOperation(db, locksCollection, config),
    capabilities,
  };
}
