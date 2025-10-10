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
 * Creates lookup operation for Firestore backend.
 *
 * NOTE: Firestore uses non-atomic indexed queries with post-read verification.
 * Per ADR-011, this is acceptable because lookup is DIAGNOSTIC ONLY—correctness
 * relies on atomic release/extend operations (which use transactions), NOT lookup
 * results. For Redis, atomicity is required due to multi-key reads; for Firestore,
 * single indexed queries with explicit lockId verification suffice.
 *
 * @returns Async function that retrieves lock info by key or lockId
 * @see common/time-predicates.ts for expiration logic
 * @see specs/adrs.md ADR-011 for atomicity rationale
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
        // Key lookup path: validates and normalizes key
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
        // LockId lookup path: validates lockId and queries by index
        validateLockId(opts.lockId);
        const querySnapshot = await locksCollection
          .where("lockId", "==", opts.lockId)
          .limit(1)
          .get();

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

      // Preserve raw data for debugging (see: getByKeyRaw/getByIdRaw in common/helpers.ts)
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
