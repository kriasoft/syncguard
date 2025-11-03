// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import type { Firestore } from "@google-cloud/firestore";

/**
 * Check if Firestore emulator is available by attempting a health check operation.
 *
 * @param db Firestore instance (already configured for emulator by caller)
 * @param timeoutMs Timeout in milliseconds (default: 2000)
 * @returns true if emulator is available, false otherwise
 */
export async function checkFirestoreEmulatorAvailability(
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

/**
 * Handle Firestore emulator unavailability based on CI environment.
 * Fails in CI (with suite context in error), warns in local dev.
 *
 * @param available Whether emulator is available
 * @param suiteName Test suite name for error context
 * @throws Error if in CI environment and emulator unavailable
 */
export function handleFirestoreUnavailability(
  available: boolean,
  suiteName: string,
): void {
  if (available) {
    console.log("✅ Connected to Firestore emulator for integration tests");
    return;
  }

  const ciValue = process.env.CI?.toLowerCase();
  const isCI = ciValue === "true" || ciValue === "1";

  if (isCI) {
    throw new Error(
      `[${suiteName}] Firestore emulator is not available. ` +
        `In CI environment, all services must be running.`,
    );
  } else {
    console.warn(
      "⚠️  Firestore emulator not available - Firestore tests will be skipped",
    );
  }
}
