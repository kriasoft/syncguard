/* SPDX-FileCopyrightText: 2025-present Kriasoft */
/* SPDX-License-Identifier: MIT */

/**
 * Example usage of the D-Lock library with Redis backend
 */

import Redis from "ioredis";
import { createLock } from "syncguard/redis";

// Initialize Redis client
const redis = new Redis({
  host: "localhost",
  port: 6379,
  // Add your Redis configuration here
  // For Redis Cloud or other hosted Redis:
  // host: "your-redis-host.com",
  // port: 6380,
  // password: "your-password",
  // tls: {},
});

// Create a lock instance with Redis backend
const lock = createLock(redis, {
  keyPrefix: "myapp:locks:", // Custom key prefix
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

// Example 2: Manual lock management for fine-grained control
async function processPayment(orderId: string) {
  const lockResult = await lock.acquire({
    key: `payment:${orderId}`,
    ttlMs: 60000, // 1 minute
    timeoutMs: 5000, // 5 seconds to acquire
  });

  if (!lockResult.success) {
    console.error("Failed to acquire payment lock:", lockResult.error);
    return;
  }

  console.log(`Payment lock acquired for order: ${orderId}`);
  console.log(`Lock expires at: ${lockResult.expiresAt}`);

  try {
    // Process payment
    console.log("Processing payment...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Extend lock if processing takes longer
    const extended = await lock.extend(lockResult.lockId, 30000); // Extend by 30s
    if (extended) {
      console.log("Lock extended successfully");
    }

    // Complete payment processing
    console.log("Payment processed successfully");
  } catch (error) {
    console.error("Payment processing failed:", error);
  } finally {
    // Always release the lock
    const released = await lock.release(lockResult.lockId);
    console.log(`Lock released: ${released}`);
  }
}

// Example 3: Check if a resource is locked
async function checkResourceStatus(resourceId: string) {
  const isLocked = await lock.isLocked(`resource:${resourceId}`);
  console.log(`Resource ${resourceId} is ${isLocked ? "locked" : "available"}`);
  return isLocked;
}

// Example 4: Concurrent processing demonstration
async function simulateConcurrentUpdates() {
  console.log("\\n--- Simulating concurrent updates ---");

  const promises = Array.from({ length: 3 }, (_, i) =>
    processInventoryUpdate(`item-${i + 1}`),
  );

  await Promise.all(promises);
  console.log("All updates completed");
}

// Example 5: Error handling and recovery
async function robustProcessing(taskId: string) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await lock(
        async () => {
          console.log(`Processing task ${taskId}, attempt ${attempt + 1}`);

          // Simulate potential failure
          if (Math.random() < 0.3) {
            throw new Error("Random processing error");
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          console.log(`Task ${taskId} completed successfully`);
        },
        {
          key: `task:${taskId}`,
          ttlMs: 15000,
          timeoutMs: 5000,
        },
      );

      return; // Success, exit retry loop
    } catch (error) {
      attempt++;
      console.warn(
        `Task ${taskId} failed (attempt ${attempt}/${MAX_RETRIES}):`,
        error.message,
      );

      if (attempt >= MAX_RETRIES) {
        console.error(`Task ${taskId} failed after ${MAX_RETRIES} attempts`);
        throw error;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// Run examples
async function runExamples() {
  console.log("D-Lock Redis Backend Examples\\n");

  try {
    // Test Redis connection
    await redis.ping();
    console.log("✓ Redis connection successful\\n");

    // Run examples
    await processInventoryUpdate("example-item");
    console.log("\\n---\\n");

    await processPayment("order-123");
    console.log("\\n---\\n");

    await checkResourceStatus("shared-resource");
    console.log("\\n---\\n");

    await simulateConcurrentUpdates();
    console.log("\\n---\\n");

    await robustProcessing("critical-task-1");
  } catch (error) {
    console.error("Example execution failed:", error);
  } finally {
    // Clean up Redis connection
    await redis.quit();
    console.log("\\nRedis connection closed");
  }
}

// Run examples if this file is executed directly
if (require.main === module) {
  runExamples().catch(console.error);
}

export {
  checkResourceStatus,
  processInventoryUpdate,
  processPayment,
  robustProcessing,
  simulateConcurrentUpdates,
};
