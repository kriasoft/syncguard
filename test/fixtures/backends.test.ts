// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Tests for backend fixture infrastructure.
 * Verifies that fixtures can be discovered, checked for availability, and setup/teardown correctly.
 */

import { describe, expect, it } from "bun:test";
import {
  backends,
  getAvailableBackends,
  getEnabledBackends,
  setupBackend,
} from "./backends.js";

describe("Backend Fixtures", () => {
  it("should list all backend fixtures", () => {
    expect(backends).toHaveLength(3);
    expect(backends.map((b) => b.kind)).toEqual([
      "redis",
      "postgres",
      "firestore",
    ]);
  });

  it("should get enabled backends based on env vars", () => {
    const enabled = getEnabledBackends();
    expect(enabled.length).toBeGreaterThan(0);
    enabled.forEach((backend) => {
      expect(["redis", "postgres", "firestore"]).toContain(backend.kind);
    });
  });

  it(
    "should check backend availability",
    async () => {
      const available = await getAvailableBackends();
      // At least one backend should be available in the test environment
      // (based on CLAUDE.local.md, Redis and Firestore are running)
      expect(available.length).toBeGreaterThan(0);

      // Log which backends are available for debugging
      console.log(
        "Available backends:",
        available.map((b) => b.name).join(", "),
      );
    },
    { timeout: 15000 },
  );

  it(
    "should setup and teardown a backend fixture",
    async () => {
      const available = await getAvailableBackends();
      if (available.length === 0) {
        console.warn("No backends available, skipping setup test");
        return;
      }

      const fixture = available[0]!;
      const result = await setupBackend(fixture);

      try {
        // Verify result structure
        expect(result.name).toBe(fixture.name);
        expect(result.kind).toBe(fixture.kind);
        expect(result.backend).toBeDefined();
        expect(typeof result.cleanup).toBe("function");
        expect(typeof result.teardown).toBe("function");

        // Verify backend has required methods
        expect(typeof result.backend.acquire).toBe("function");
        expect(typeof result.backend.release).toBe("function");
        expect(typeof result.backend.extend).toBe("function");
        expect(typeof result.backend.isLocked).toBe("function");
        expect(typeof result.backend.lookup).toBe("function");

        // Verify capabilities
        expect(result.backend.capabilities).toBeDefined();
        expect(typeof result.backend.capabilities.supportsFencing).toBe(
          "boolean",
        );
        expect(["server", "client"]).toContain(
          result.backend.capabilities.timeAuthority,
        );

        // Test cleanup
        await result.cleanup();
      } finally {
        // Always teardown
        await result.teardown();
      }
    },
    { timeout: 15000 },
  );
});
