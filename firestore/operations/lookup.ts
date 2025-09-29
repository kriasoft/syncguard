// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  type KeyLookup,
  type LockInfo,
  type OwnershipLookup,
  attachRawData,
  LockError,
  makeStorageKey,
  normalizeAndValidateKey,
  sanitizeLockInfo,
  validateLockId,
} from "../../common/backend.js";
import { isLive, TIME_TOLERANCE_MS } from "../../common/time-predicates.js";
import { mapFirestoreError } from "../errors.js";
import type {
  FirestoreCapabilities,
  FirestoreConfig,
  LockDocument,
} from "../types.js";

/**
 * Creates lookup operation for Firestore backend.
 * @returns Async function that retrieves lock info by key or lockId
 * @see ../../common/time-predicates.ts for expiration logic
 */
export function createLookupOperation(
  db: Firestore,
  locksCollection: CollectionReference,
  config: FirestoreConfig,
) {
  return async (
    opts: KeyLookup | OwnershipLookup,
  ): Promise<LockInfo<FirestoreCapabilities> | null> => {
    try {
      let doc: FirebaseFirestore.DocumentSnapshot;

      if ("key" in opts) {
        // Key lookup path: validates and normalizes key
        const normalizedKey = normalizeAndValidateKey(opts.key);
        const storageKey = makeStorageKey("", normalizedKey, 1500); // 1500 = Firestore doc ID limit
        const docRef = locksCollection.doc(storageKey);
        doc = await docRef.get();

        if (!doc.exists) {
          return null;
        }
      } else {
        // LockId lookup path: validates lockId and queries by index
        validateLockId(opts.lockId);
        const querySnapshot = await locksCollection
          .where("lockId", "==", opts.lockId)
          .limit(1)
          .get();

        if (querySnapshot.empty) {
          return null;
        }

        doc = querySnapshot.docs[0]!;
        const data = doc.data() as LockDocument;

        // Defense-in-depth: verify lockId match despite WHERE clause
        if (data?.lockId !== opts.lockId) {
          return null;
        }
      }

      const data = doc.data() as LockDocument;
      const nowMs = Date.now();

      if (!isLive(data.expiresAtMs, nowMs, TIME_TOLERANCE_MS)) {
        return null; // Lock expired
      }

      const capabilities: FirestoreCapabilities = {
        backend: "firestore",
        supportsFencing: true,
        timeAuthority: "client",
      };

      const lockInfo = sanitizeLockInfo(data, capabilities);

      // Preserve raw data for debugging (see: common/helpers.ts lookupDebug)
      return attachRawData(lockInfo, {
        key: data.key,
        lockId: data.lockId,
      });
    } catch (error) {
      if (error instanceof LockError) {
        throw error;
      }
      throw mapFirestoreError(error);
    }
  };
}
