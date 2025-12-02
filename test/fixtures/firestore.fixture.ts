// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import { Firestore } from "@google-cloud/firestore";
import type { LockBackend } from "../../common/types.js";
import { createFirestoreBackend } from "../../firestore/index.js";
import type { FirestoreCapabilities } from "../../firestore/types.js";

export interface FirestoreFixture {
  name: string;
  kind: "firestore";
  envVar: string;
  available(): Promise<boolean>;
  setup(): Promise<{
    cleanup(): Promise<void>;
    teardown(): Promise<void>;
    createBackend(): LockBackend<FirestoreCapabilities>;
  }>;
}

const TEST_COLLECTION = "syncguard_test_locks";
const TEST_FENCE_COLLECTION = "syncguard_test_fences";

/**
 * Check if Firestore emulator is available by attempting a health check operation.
 */
async function checkFirestoreEmulatorAvailability(
  db: Firestore,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new Error("Firestore emulator timeout"));
      });
    });

    const testPromise = (async () => {
      await db.collection("_health").doc("test").set({ test: true });
      await db.collection("_health").doc("test").delete();
    })();

    try {
      await Promise.race([testPromise, abortPromise]);
      clearTimeout(timeoutId);
      return true;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}

export const firestoreFixture: FirestoreFixture = {
  name: "Firestore",
  kind: "firestore",
  envVar: "TEST_FIRESTORE",

  async available(): Promise<boolean> {
    const db = new Firestore({
      projectId: "syncguard-test",
      host: "localhost:8080",
      ssl: false,
    });

    try {
      const available = await checkFirestoreEmulatorAvailability(db, 2000);
      // Force terminate with immediate flag to prevent hanging
      try {
        await Promise.race([
          db.terminate(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore terminate errors
      }
      return available;
    } catch {
      // Force terminate with timeout to prevent hanging
      try {
        await Promise.race([
          db.terminate(),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      } catch {
        // Ignore cleanup errors
      }
      return false;
    }
  },

  async setup() {
    const db = new Firestore({
      projectId: "syncguard-test",
      host: "localhost:8080",
      ssl: false,
    });

    // Clean test collections
    const lockDocs = await db.collection(TEST_COLLECTION).listDocuments();
    const fenceDocs = await db
      .collection(TEST_FENCE_COLLECTION)
      .listDocuments();

    await Promise.all([
      ...lockDocs.map((doc) => doc.delete()),
      ...fenceDocs.map((doc) => doc.delete()),
    ]);

    return {
      async cleanup() {
        const lockDocs = await db.collection(TEST_COLLECTION).listDocuments();
        const fenceDocs = await db
          .collection(TEST_FENCE_COLLECTION)
          .listDocuments();

        await Promise.all([
          ...lockDocs.map((doc) => doc.delete()),
          ...fenceDocs.map((doc) => doc.delete()),
        ]);
      },

      async teardown() {
        await db.terminate();
      },

      createBackend() {
        return createFirestoreBackend(db, {
          collection: TEST_COLLECTION,
          fenceCollection: TEST_FENCE_COLLECTION,
        });
      },
    };
  },
};
