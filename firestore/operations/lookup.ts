// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { CollectionReference, Firestore } from "@google-cloud/firestore";
import {
  type KeyLookup,
  type LockInfo,
  type OwnershipLookup,
  attachRawData,
  checkAborted,
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
 * Retrieves lock info by key or lockId (diagnostic only, non-atomic).
 *
 * @remarks
 * Non-atomic queries acceptable for diagnostic lookups (ADR-011). Omits `.limit(1)`
 * to detect duplicate lockIds (ADR-014).
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
      // Check for cancellation before starting operation
      checkAborted(opts.signal);

      let doc: FirebaseFirestore.DocumentSnapshot;

      const FIRESTORE_LIMIT_BYTES = 1500;
      const RESERVE_BYTES = 0; // No derived keys in Firestore

      if ("key" in opts) {
        // Key lookup: validate and normalize, then fetch by document ID
        const normalizedKey = normalizeAndValidateKey(opts.key);
        const storageKey = makeStorageKey(
          "",
          normalizedKey,
          FIRESTORE_LIMIT_BYTES,
          RESERVE_BYTES,
        );
        const docRef = locksCollection.doc(storageKey);
        doc = await docRef.get();

        // Check for cancellation after read
        checkAborted(opts.signal);

        if (!doc.exists) {
          return null;
        }
      } else {
        // LockId lookup: validate and query index without .limit(1) (ADR-014)
        validateLockId(opts.lockId);
        const querySnapshot = await locksCollection
          .where("lockId", "==", opts.lockId)
          .get();

        // Duplicate detection (ADR-014): log only for diagnostic lookup
        if (querySnapshot.docs.length > 1) {
          console.warn(
            `[syncguard] Duplicate lockId detected in lookup: ${opts.lockId} (${querySnapshot.docs.length} documents)`,
          );
        }

        // Check for cancellation after read
        checkAborted(opts.signal);

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

      // Attach raw data for debugging (see: common/helpers.ts)
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
