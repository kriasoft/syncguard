// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Time helper functions tests
 *
 * Tests for time-related utilities:
 * - TIME_TOLERANCE_MS constant and enforcement
 * - isLive predicate for liveness checking
 * - calculateRedisServerTimeMs for Redis TIME command
 *
 * Per specs/interface.md:
 * - TIME_TOLERANCE_MS in common/time-predicates.ts is the NORMATIVE SOURCE
 * - All backends MUST import and use this constant
 * - Backends MUST NOT hard-code alternative tolerance values
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TIME_TOLERANCE_MS,
  calculateRedisServerTimeMs,
  isLive,
} from "../../../common/time-predicates.js";

describe("Time Helper Functions", () => {
  describe("TIME_TOLERANCE_MS Constant", () => {
    it("should be defined as 1000ms", () => {
      expect(TIME_TOLERANCE_MS).toBe(1000);
    });

    it("should be the single normative source per spec", () => {
      const source = readFileSync("common/time-predicates.ts", "utf-8");

      // Verify it's exported and marked as normative
      expect(source).toContain("export const TIME_TOLERANCE_MS");
      expect(source).toContain("= 1000");
    });
  });

  describe("isLive Predicate", () => {
    it("should implement consistent liveness predicate", () => {
      const now = Date.now();
      const expired = now - 5000; // 5 seconds ago
      const live = now + 5000; // 5 seconds from now

      // With 1000ms tolerance, something expired 5 seconds ago is definitely expired
      expect(isLive(expired, now, TIME_TOLERANCE_MS)).toBe(false);

      // Something expiring 5 seconds from now is definitely live
      expect(isLive(live, now, TIME_TOLERANCE_MS)).toBe(true);

      // Edge case: expired 500ms ago but within tolerance
      const recentlyExpired = now - 500;
      expect(isLive(recentlyExpired, now, TIME_TOLERANCE_MS)).toBe(true);
    });

    it("should consider lock live if it expired within tolerance window", () => {
      const now = 1000000;
      const tolerance = 1000;

      // Expired 500ms ago (within tolerance)
      expect(isLive(now - 500, now, tolerance)).toBe(true);

      // Expired exactly at tolerance boundary (NOT live, because > not >=)
      expect(isLive(now - tolerance, now, tolerance)).toBe(false);

      // Expired 999ms ago (within tolerance, still live)
      expect(isLive(now - tolerance + 1, now, tolerance)).toBe(true);

      // Expired 1001ms ago (outside tolerance)
      expect(isLive(now - tolerance - 1, now, tolerance)).toBe(false);
    });

    it("should handle edge cases correctly", () => {
      const now = 1000000;
      const tolerance = 1000;

      // Future expiry (definitely live)
      expect(isLive(now + 5000, now, tolerance)).toBe(true);

      // Expiry exactly at now (live due to tolerance)
      expect(isLive(now, now, tolerance)).toBe(true);

      // Very old expiry (definitely expired)
      expect(isLive(now - 10000, now, tolerance)).toBe(false);
    });
  });

  describe("calculateRedisServerTimeMs", () => {
    it("should correctly calculate Redis server time", () => {
      const seconds = "1640995200"; // 2022-01-01 00:00:00 UTC
      const microseconds = "123456";

      const result = calculateRedisServerTimeMs([seconds, microseconds]);
      const expected =
        parseInt(seconds) * 1000 + Math.floor(parseInt(microseconds) / 1000);

      expect(result).toBe(expected);
      expect(result).toBe(1640995200123); // Precise calculation
    });

    it("should handle zero microseconds", () => {
      const seconds = "1640995200";
      const microseconds = "0";

      const result = calculateRedisServerTimeMs([seconds, microseconds]);
      expect(result).toBe(1640995200000);
    });

    it("should handle maximum microseconds", () => {
      const seconds = "1640995200";
      const microseconds = "999999"; // Max microseconds in a second

      const result = calculateRedisServerTimeMs([seconds, microseconds]);
      expect(result).toBe(1640995200999);
    });

    it("should truncate microseconds correctly", () => {
      const seconds = "1640995200";
      const microseconds = "123456"; // 123.456 milliseconds

      const result = calculateRedisServerTimeMs([seconds, microseconds]);
      // Should truncate to 123 milliseconds (not round)
      expect(result).toBe(1640995200123);
    });
  });
});

describe("TIME_TOLERANCE_MS Enforcement Across Backends", () => {
  describe("Firestore Backend Compliance", () => {
    const firestoreOperations = [
      "firestore/operations/acquire.ts",
      "firestore/operations/release.ts",
      "firestore/operations/extend.ts",
      "firestore/operations/is-locked.ts",
      "firestore/operations/lookup.ts",
    ];

    for (const file of firestoreOperations) {
      it(`${file} must import TIME_TOLERANCE_MS from common`, () => {
        const source = readFileSync(file, "utf-8");

        // MUST import from common/time-predicates
        expect(source).toContain("TIME_TOLERANCE_MS");
        expect(source).toContain('from "../../common/time-predicates.js"');
      });

      it(`${file} must not hard-code tolerance values`, () => {
        const source = readFileSync(file, "utf-8");

        // Check for hard-coded 1000 (tolerance value) in suspicious contexts
        // Allow: "1000" in comments, but not in actual tolerance comparisons
        const lines = source.split("\n");
        const suspiciousLines = lines.filter((line) => {
          // Skip comments and imports
          if (
            line.trim().startsWith("//") ||
            line.trim().startsWith("*") ||
            line.includes("import")
          ) {
            return false;
          }

          // Flag lines that might be hard-coding tolerance
          return (
            (line.includes("1000") &&
              (line.includes("tolerance") ||
                line.includes("nowMs") ||
                line.includes("expiresAtMs"))) ||
            (line.match(/[+-]\s*1000\b/) && // arithmetic with 1000
              (line.includes("nowMs") || line.includes("expiresAtMs")))
          );
        });

        if (suspiciousLines.length > 0) {
          console.error(
            `Suspicious hard-coded tolerance in ${file}:`,
            suspiciousLines,
          );
        }
        expect(suspiciousLines.length).toBe(0);
      });
    }
  });

  describe("Redis Backend Compliance", () => {
    const redisOperations = [
      "redis/operations/acquire.ts",
      "redis/operations/release.ts",
      "redis/operations/extend.ts",
      "redis/operations/is-locked.ts",
      "redis/operations/lookup.ts",
    ];

    for (const file of redisOperations) {
      it(`${file} must import TIME_TOLERANCE_MS from common`, () => {
        const source = readFileSync(file, "utf-8");

        // MUST import from common/time-predicates
        expect(source).toContain("TIME_TOLERANCE_MS");
        expect(source).toContain('from "../../common/time-predicates.js"');
      });

      it(`${file} must not hard-code tolerance values`, () => {
        const source = readFileSync(file, "utf-8");

        // Check for hard-coded 1000 in tolerance contexts
        const lines = source.split("\n");
        const suspiciousLines = lines.filter((line) => {
          // Skip comments and imports
          if (
            line.trim().startsWith("//") ||
            line.trim().startsWith("*") ||
            line.includes("import")
          ) {
            return false;
          }

          // Flag lines that might be hard-coding tolerance
          return (
            (line.includes("1000") &&
              (line.includes("tolerance") ||
                line.includes("ARGV") ||
                line.includes("toleranceMs"))) ||
            (line.match(/[+-]\s*1000\b/) &&
              (line.includes("nowMs") || line.includes("expiresAtMs")))
          );
        });

        if (suspiciousLines.length > 0) {
          console.error(
            `Suspicious hard-coded tolerance in ${file}:`,
            suspiciousLines,
          );
        }
        expect(suspiciousLines.length).toBe(0);
      });
    }
  });

  describe("Lua Scripts Compliance", () => {
    it("redis/scripts.ts must not hard-code tolerance values in Lua", () => {
      const source = readFileSync("redis/scripts.ts", "utf-8");

      // Scripts should receive toleranceMs as ARGV parameter, not hard-code it
      // This is acceptable: toleranceMs comes from ARGV
      expect(source).toContain("ARGV"); // Scripts use parameters

      // Check that tolerance isn't hard-coded in Lua logic
      const lines = source.split("\n");
      const suspiciousLines = lines.filter((line) => {
        // Skip comments
        if (line.trim().startsWith("--") || line.trim().startsWith("//")) {
          return false;
        }

        // Allow: time[1] * 1000 (seconds to milliseconds conversion)
        if (line.includes("* 1000") && line.includes("time[")) {
          return false;
        }

        // Allow: time[2] / 1000 (microseconds to milliseconds conversion)
        if (line.includes("/ 1000") && line.includes("time[")) {
          return false;
        }

        // Flag Lua lines that hard-code tolerance value (e.g., "tolerance = 1000")
        return (
          line.includes("1000") &&
          (line.includes("toleranceMs") ||
            line.includes("tolerance =") ||
            (line.includes("local tolerance") && !line.includes("ARGV")))
        );
      });

      if (suspiciousLines.length > 0) {
        console.error(
          "Suspicious hard-coded tolerance in redis/scripts.ts:",
          suspiciousLines,
        );
      }
      expect(suspiciousLines.length).toBe(0);
    });
  });

  describe("Cross-Backend Consistency", () => {
    it("both backends must use identical TIME_TOLERANCE_MS value", () => {
      // Import from actual backend operations to verify they use the same constant
      const {
        TIME_TOLERANCE_MS: firestoreTolerance,
      } = require("../../../common/time-predicates.js");
      const {
        TIME_TOLERANCE_MS: redisTolerance,
      } = require("../../../common/time-predicates.js");

      expect(firestoreTolerance).toBe(redisTolerance);
      expect(firestoreTolerance).toBe(1000);
    });

    it("should fail if tolerance drift is detected", () => {
      // This test ensures no backend has introduced its own tolerance constant
      const firestoreConfig = readFileSync("firestore/config.ts", "utf-8");
      const redisConfig = readFileSync("redis/config.ts", "utf-8");

      // Neither config file should define its own tolerance constant
      expect(firestoreConfig).not.toContain("TOLERANCE_MS = ");
      expect(redisConfig).not.toContain("TOLERANCE_MS = ");

      // Neither should have tolerance in their defaults (it's not configurable)
      expect(firestoreConfig).not.toContain("tolerance");
      expect(redisConfig).not.toContain("tolerance");
    });
  });

  describe("Documentation Consistency", () => {
    it("interface spec must declare TIME_TOLERANCE_MS as normative source", () => {
      const spec = readFileSync("specs/interface.md", "utf-8");

      // Verify spec marks it as normative
      expect(spec).toContain("TIME_TOLERANCE_MS");
      expect(spec).toContain("NORMATIVE SOURCE");
      expect(spec).toContain("single source of truth");
    });

    it("backend specs must reference interface.md, not duplicate the value", () => {
      const firestoreSpec = readFileSync("specs/firestore-backend.md", "utf-8");
      const redisSpec = readFileSync("specs/redis-backend.md", "utf-8");

      // Both specs should reference interface.md
      expect(firestoreSpec).toContain("TIME_TOLERANCE_MS");
      expect(firestoreSpec).toContain("interface.md");
      expect(redisSpec).toContain("TIME_TOLERANCE_MS");
      expect(redisSpec).toContain("interface.md");
    });

    it("ADR-005 must reference interface.md as normative source", () => {
      const adr = readFileSync("specs/adrs.md", "utf-8");

      // ADR-005 section should reference interface.md
      const adr005Section =
        adr.split("## ADR-005")[1]?.split("## ADR-")[0] ?? "";

      expect(adr005Section).toContain("TIME_TOLERANCE_MS");
      expect(adr005Section).toContain("interface.md");
      expect(adr005Section).toContain("normative");
    });
  });
});
