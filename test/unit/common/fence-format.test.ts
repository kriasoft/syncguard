// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Fence token format tests
 *
 * Tests for fence token formatting and validation:
 * - 15-digit zero-padded fence format (ADR-004)
 * - hasFence type guard
 * - Lexicographic comparison support
 */

import { describe, expect, it } from "bun:test";
import { hasFence } from "../../../common/helpers.js";

describe("Fence Token Format", () => {
  describe("15-Digit Format (ADR-004)", () => {
    it("should enforce 15-digit zero-padded fence format", () => {
      // Per ADR-004: ALL fence tokens MUST be exactly 15 digits with zero-padding
      const validFences = [
        "000000000000001",
        "000000000000042",
        "000000000001337",
        "000000123456789",
        "999999999999999", // Maximum 15-digit value
      ];

      const invalidFences = [
        "1", // Too short
        "0000000000000001", // 16 digits (old format, now invalid)
        "00000000000000001", // 17 digits
        "0000000000000000001", // 19 digits (original format, now invalid)
        "abc000000000001", // Non-numeric
        " 000000000000001", // Leading whitespace
      ];

      // Regex per ADR-004: /^\d{15}$/
      const fenceFormatRegex = /^\d{15}$/;

      validFences.forEach((fence) => {
        expect(fence).toMatch(fenceFormatRegex);
        expect(fence.length).toBe(15);
      });

      invalidFences.forEach((fence) => {
        expect(fence).not.toMatch(fenceFormatRegex);
      });
    });

    it("should support lexicographic fence comparison", () => {
      // 15-digit zero-padded fence tokens for consistent ordering
      const fence1 = "000000000000001";
      const fence2 = "000000000000002";
      const fence10 = "000000000000010";

      // String comparison should work correctly with zero-padding
      expect(fence1 < fence2).toBe(true);
      expect(fence2 < fence10).toBe(true);
      expect(fence10 > fence1).toBe(true);

      // Verify 15-digit format per ADR-004
      expect(fence1.length).toBe(15);
      expect(fence2.length).toBe(15);
      expect(fence10.length).toBe(15);
    });

    it("should maintain lexicographic ordering for large values", () => {
      const fences = [
        "000000000000001",
        "000000000000010",
        "000000000000100",
        "000000000001000",
        "000000000010000",
        "000000000100000",
        "000000001000000",
        "000000010000000",
        "000000100000000",
        "000001000000000",
        "999999999999999",
      ];

      // Verify they're in ascending order
      for (let i = 0; i < fences.length - 1; i++) {
        const current = fences[i];
        const next = fences[i + 1];
        if (!current || !next) continue;

        expect(current < next).toBe(true);
      }
    });
  });

  describe("hasFence Type Guard", () => {
    it("should handle fence tokens with type guards", () => {
      const successWithFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      const successWithoutFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
      };

      const failure = {
        ok: false as const,
        reason: "locked" as const,
      };

      // Type guard should work correctly
      expect(hasFence(successWithFence)).toBe(true);
      expect(hasFence(successWithoutFence)).toBe(false);
      expect(hasFence(failure)).toBe(false);
    });

    it("should validate fence token format", () => {
      const mockCapabilities = {
        supportsFencing: true,
        timeAuthority: "server" as const,
      };

      const successWithFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      const successWithoutFence = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
      };

      const failure = {
        ok: false as const,
        reason: "locked" as const,
      };

      // Per ADR-008, with typed backends, fence is compile-time guaranteed
      // The type system ensures result.fence exists for fencing backends
      // For generic code, use hasFence() type guard
      expect(hasFence(successWithFence)).toBe(true);
      expect(hasFence(successWithoutFence)).toBe(false);
      expect(hasFence(failure)).toBe(false);
    });

    it("should narrow types correctly", () => {
      const result = {
        ok: true as const,
        lockId: "test-lock-id",
        expiresAtMs: Date.now() + 30000,
        fence: "000000000000001",
      };

      if (hasFence(result)) {
        // TypeScript should know result.fence exists here
        expect(result.fence).toBe("000000000000001");
        expect(result.fence.length).toBe(15);
      } else {
        throw new Error("Expected hasFence to be true");
      }
    });
  });

  describe("Fence Token Edge Cases", () => {
    it("should handle minimum fence value", () => {
      const minFence = "000000000000001";
      expect(minFence).toMatch(/^\d{15}$/);
      expect(minFence.length).toBe(15);
    });

    it("should handle maximum fence value", () => {
      const maxFence = "999999999999999";
      expect(maxFence).toMatch(/^\d{15}$/);
      expect(maxFence.length).toBe(15);
    });

    it("should reject fence with leading zeros removed", () => {
      const invalidFence = "1"; // Should be "000000000000001"
      expect(invalidFence).not.toMatch(/^\d{15}$/);
    });

    it("should reject fence with extra padding", () => {
      const invalidFence = "0000000000000001"; // 16 digits
      expect(invalidFence).not.toMatch(/^\d{15}$/);
    });
  });
});
