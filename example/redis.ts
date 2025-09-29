// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Example usage patterns for SyncGuard with Redis backend.
 * Demonstrates automatic lock management, manual control, and error handling.
 */

import Redis from "ioredis";
import { createLock, createRedisBackend } from "syncguard/redis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
  // For hosted Redis add: password, tls: {}
});

// Backend for manual lock operations
const backend = createRedisBackend(redis, {
  keyPrefix: "myapp:locks:",
});

// Auto-managed lock function
const lock = createLock(redis, {
  keyPrefix: "myapp:locks:",
});

// Example 1: Automatic lock management (recommended)
async function processInventoryUpdate(itemId: string) {
  try {
    const result = await lock(
      async () => {
        console.log(`Processing inventory update for item: ${itemId}`);

        // Critical work requiring exclusive access
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
        // Hook for monitoring/alerting on release failures
        onReleaseError: (error, context) => {
          console.error(
            `Lock release failed for ${context.key} (${context.lockId}):`,
            error,
          );
          // Production: send to monitoring system
        },
      },
    );

    console.log("Update result:", result);
  } catch (error) {
    console.error("Failed to process inventory update:", error);
  }
}

// Example 2: Manual lock management (fine-grained control)
async function processPayment(orderId: string) {
  const lockResult = await backend.acquire({
    key: `payment:${orderId}`,
    ttlMs: 60000,
  });

  if (!lockResult.ok) {
    console.error("Failed to acquire payment lock (locked by another process)");
    return;
  }

  console.log(`Payment lock acquired for order: ${orderId}`);
  console.log(`Lock expires at: ${lockResult.expiresAtMs}`);

  try {
    console.log("Processing payment...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Extend if operation takes longer than expected
    const extendResult = await backend.extend({
      lockId: lockResult.lockId,
      ttlMs: 30000,
    });
    if (extendResult.ok) {
      console.log("Lock extended successfully");
    }

    console.log("Payment processed successfully");
  } catch (error) {
    console.error("Payment processing failed:", error);
  } finally {
    const releaseResult = await backend.release({ lockId: lockResult.lockId });
    console.log(`Lock released: ${releaseResult.ok}`);
  }
}

// Example 3: Check lock status
async function checkResourceStatus(resourceId: string) {
  const isLocked = await backend.isLocked({ key: `resource:${resourceId}` });
  console.log(`Resource ${resourceId} is ${isLocked ? "locked" : "available"}`);
  return isLocked;
}

// Example 4: Concurrent operations demonstration
async function simulateConcurrentUpdates() {
  console.log("\\n--- Simulating concurrent updates ---");

  const promises = Array.from({ length: 3 }, (_, i) =>
    processInventoryUpdate(`item-${i + 1}`),
  );

  await Promise.all(promises);
  console.log("All updates completed");
}

// Example 5: Retry logic with lock protection
async function robustProcessing(taskId: string) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await lock(
        async () => {
          console.log(`Processing task ${taskId}, attempt ${attempt + 1}`);

          // Simulated transient failure
          if (Math.random() < 0.3) {
            throw new Error("Random processing error");
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          console.log(`Task ${taskId} completed successfully`);
        },
        {
          key: `task:${taskId}`,
          ttlMs: 15000,
          acquisition: {
            timeoutMs: 5000,
          },
        },
      );

      return;
    } catch (error) {
      attempt++;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Task ${taskId} failed (attempt ${attempt}/${MAX_RETRIES}):`,
        message,
      );

      if (attempt >= MAX_RETRIES) {
        console.error(`Task ${taskId} failed after ${MAX_RETRIES} attempts`);
        throw error;
      }

      // Backoff before retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function runExamples() {
  console.log("SyncGuard Redis Examples\\n");

  try {
    await redis.ping();
    console.log("✓ Redis connection successful\\n");

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
    await redis.quit();
    console.log("\\nRedis connection closed");
  }
}

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
