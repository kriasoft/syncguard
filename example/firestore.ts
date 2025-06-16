/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Example usage of the D-Lock library with Firestore backend
 */

import { Firestore } from "@google-cloud/firestore";
import { createLock } from "syncguard/firestore";

// Initialize Firestore
const db = new Firestore({
  projectId: "your-project-id",
  // Add your Firestore configuration here
});

// Create a lock instance with Firestore backend
const lock = createLock(db, {
  collection: "distributed_locks", // Custom collection name
  retryDelayMs: 150,
  maxRetries: 5,
});

// Example 1: Automatic lock management (recommended approach)
async function processInventoryUpdate(itemId: string) {
  try {
    const result = await lock(
      async () => {
        console.log(`Processing inventory update for item: ${itemId}`);

        // Simulate some critical work that must be done exclusively
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Update inventory in database
        console.log(`Inventory updated for item: ${itemId}`);
        return { itemId, status: "updated" };
      },
      {
        key: `inventory:${itemId}`,
        ttlMs: 30000, // 30 seconds
        timeoutMs: 10000, // Wait up to 10 seconds to acquire lock
        maxRetries: 3,
      },
    );

    console.log("Update result:", result);
  } catch (error) {
    console.error("Failed to process inventory update:", error);
  }
}

// Example 2: Manual lock management for more control
async function processBatchOperation() {
  const lockResult = await lock.acquire({
    key: "batch:daily-report",
    ttlMs: 300000, // 5 minutes
    timeoutMs: 5000,
  });

  if (!lockResult.success) {
    console.error("Could not acquire batch lock:", lockResult.error);
    return;
  }

  console.log(
    `Acquired lock: ${lockResult.lockId}, expires at: ${lockResult.expiresAt}`,
  );

  try {
    // Perform long-running batch operation
    console.log("Starting batch processing...");

    for (let i = 0; i < 5; i++) {
      console.log(`Processing batch ${i + 1}/5...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Extend lock if needed for long operations
      if (i === 2) {
        const extended = await lock.extend(lockResult.lockId, 300000);
        if (!extended) {
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
    // Always release the lock
    const released = await lock.release(lockResult.lockId);
    console.log("Lock released:", released);
  }
}

// Example 3: Check lock status
async function checkResourceStatus(resourceId: string) {
  const isLocked = await lock.isLocked(`resource:${resourceId}`);
  console.log(`Resource ${resourceId} is ${isLocked ? "locked" : "available"}`);
  return isLocked;
}

// Example 4: Rate limiting pattern
async function rateLimitedAPI(userId: string) {
  const rateLimitKey = `rate-limit:user:${userId}`;

  const lockResult = await lock.acquire({
    key: rateLimitKey,
    ttlMs: 60000, // 1 minute rate limit window
    timeoutMs: 0, // Don't wait, fail immediately if locked
    maxRetries: 0,
  });

  if (!lockResult.success) {
    throw new Error("Rate limit exceeded. Please try again later.");
  }

  // Perform API operation
  console.log(`API call processed for user: ${userId}`);

  // Note: We don't release the lock - let it expire naturally for rate limiting
  return { success: true, rateLimitExpires: lockResult.expiresAt };
}

// Demo function to run examples
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

    // Try to call again immediately (should be rate limited)
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

// Uncomment to run examples (requires proper Firestore setup)
// runExamples()

export { runExamples };
