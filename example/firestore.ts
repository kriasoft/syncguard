// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Example usage patterns for distributed locks with Firestore backend.
 * Demonstrates auto-managed locks, manual control, and common patterns.
 * @see specs/interface.md for complete API reference
 */

import { Firestore } from "@google-cloud/firestore";
import { createFirestoreBackend, createLock } from "syncguard/firestore";

const db = new Firestore({
  projectId: "your-project-id",
});

/**
 * Creates lock manager with exponential backoff: 150ms * 2^attempt, max 5 attempts.
 * @see firestore/config.ts for configuration options
 */
// Backend for manual lock operations
const backend = createFirestoreBackend(db, {
  collection: "distributed_locks",
});

// Auto-managed lock function
const lock = createLock(db, {
  collection: "distributed_locks",
});

/**
 * Example 1: Auto-managed locks (recommended).
 * Lock auto-acquired, function executed, lock auto-released.
 * @see common/auto-lock.ts for implementation
 */
async function processInventoryUpdate(itemId: string) {
  try {
    const result = await lock(
      async () => {
        console.log(`Processing inventory update for item: ${itemId}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        console.log(`Inventory updated for item: ${itemId}`);
        return { itemId, status: "updated" };
      },
      {
        key: `inventory:${itemId}`,
        ttlMs: 30000,
        acquisition: {
          timeoutMs: 10000,
          maxRetries: 3,
        },
        // Release failures are rare but should be logged for observability
        onReleaseError(error, context) {
          console.error(
            `Firestore lock release failed for ${context.key} (${context.lockId}):`,
            error,
          );
          // Report to error tracking: errorReporter.captureException(error, { tags: { lockKey: key, lockId } })
        },
      },
    );

    console.log("Update result:", result);
  } catch (error) {
    console.error("Failed to process inventory update:", error);
  }
}

/**
 * Example 2: Manual lock control for long-running operations.
 * Demonstrates explicit acquire/extend/release pattern.
 */
async function processBatchOperation() {
  const lockResult = await backend.acquire({
    key: "batch:daily-report",
    ttlMs: 300000,
  });

  if (!lockResult.ok) {
    console.error("Could not acquire batch lock (locked by another process)");
    return;
  }

  console.log(
    `Acquired lock: ${lockResult.lockId}, expires at: ${lockResult.expiresAtMs}`,
  );

  try {
    console.log("Starting batch processing...");

    for (let i = 0; i < 5; i++) {
      console.log(`Processing batch ${i + 1}/5...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Extend TTL mid-operation to prevent expiry during long processing
      if (i === 2) {
        const extendResult = await backend.extend({
          lockId: lockResult.lockId,
          ttlMs: 300000,
        });
        if (!extendResult.ok) {
          throw new Error(
            "Failed to extend lock - another process may have acquired it. " +
              "Aborting batch operation to prevent race conditions.",
          );
        }
        console.log("Lock extended successfully");
      }
    }

    console.log("Batch processing completed");
  } finally {
    // Always release in finally block to prevent lock leak
    const releaseResult = await backend.release({ lockId: lockResult.lockId });
    console.log("Lock released:", releaseResult.ok);
  }
}

/**
 * Example 3: Non-blocking lock status check.
 * Returns true if any lock exists for the key, regardless of ownership.
 */
async function checkResourceStatus(resourceId: string) {
  const isLocked = await backend.isLocked({ key: `resource:${resourceId}` });
  console.log(`Resource ${resourceId} is ${isLocked ? "locked" : "available"}`);
  return isLocked;
}

/**
 * Example 4: Rate limiting with locks.
 * Lock acquired once per window, never released (expires naturally).
 * Fails immediately if already locked.
 */
async function rateLimitedAPI(userId: string) {
  const rateLimitKey = `rate-limit:user:${userId}`;

  const lockResult = await backend.acquire({
    key: rateLimitKey,
    ttlMs: 60000,
  });

  if (!lockResult.ok) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }

  console.log(`API call processed for user: ${userId}`);

  // Lock not released - TTL expiry enforces rate limit window
  return { success: true, rateLimitExpires: lockResult.expiresAtMs };
}

/** Runs all example patterns sequentially */
async function runExamples() {
  console.log("=== D-Lock Examples ===\n");

  try {
    console.log("1. Processing inventory updates...");
    await processInventoryUpdate("item-123");

    console.log("\n2. Running batch operation...");
    await processBatchOperation();

    console.log("\n3. Checking resource status...");
    await checkResourceStatus("shared-resource-1");

    console.log("\n4. Testing rate limiting...");
    await rateLimitedAPI("user-456");

    // Second call should be rate limited
    try {
      await rateLimitedAPI("user-456");
    } catch (error) {
      console.log(
        "Expected rate limit error:",
        error instanceof Error ? error.message : String(error),
      );
    }
  } catch (error) {
    console.error("Example error:", error);
  }
}

// Uncomment to run (requires Firestore setup: firebase emulators:start)
// runExamples()

export { runExamples };
