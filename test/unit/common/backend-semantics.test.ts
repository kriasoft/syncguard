// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for backend semantics mapping functions
 *
 * Tests the internal condition-to-result mapping used for telemetry
 */

import { describe, expect, it } from "bun:test";
import {
  FAILURE_REASON,
  mapBackendObservation,
  mapFirestoreConditions,
  mapRedisScriptResult,
  mapToMutationResult,
} from "../../../common/backend-semantics.js";

describe("FAILURE_REASON symbol", () => {
  it("should be a symbol", () => {
    expect(typeof FAILURE_REASON).toBe("symbol");
  });

  it("should be registered with specific key", () => {
    expect(FAILURE_REASON.description).toBe("failureReason");
  });
});

describe("mapToMutationResult", () => {
  it("should return ok: true for succeeded", () => {
    const result = mapToMutationResult("succeeded");

    expect(result).toEqual({ ok: true });
  });

  it("should return expired reason for observable-expired", () => {
    const result = mapToMutationResult("observable-expired");

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("should return not-found for never-existed", () => {
    const result = mapToMutationResult("never-existed");

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("should return not-found for ownership-mismatch", () => {
    const result = mapToMutationResult("ownership-mismatch");

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("should return not-found for cleaned-up-after-expiry", () => {
    const result = mapToMutationResult("cleaned-up-after-expiry");

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });

  it("should return not-found for ambiguous-unknown", () => {
    const result = mapToMutationResult("ambiguous-unknown");

    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("mapRedisScriptResult", () => {
  it("should map 1 to succeeded", () => {
    expect(mapRedisScriptResult(1)).toBe("succeeded");
  });

  it("should map -2 to observable-expired", () => {
    expect(mapRedisScriptResult(-2)).toBe("observable-expired");
  });

  it("should map -1 to never-existed", () => {
    expect(mapRedisScriptResult(-1)).toBe("never-existed");
  });

  it("should map 0 to ownership-mismatch", () => {
    expect(mapRedisScriptResult(0)).toBe("ownership-mismatch");
  });

  it("should map unknown codes to ambiguous-unknown", () => {
    expect(mapRedisScriptResult(2)).toBe("ambiguous-unknown");
    expect(mapRedisScriptResult(-3)).toBe("ambiguous-unknown");
    expect(mapRedisScriptResult(999)).toBe("ambiguous-unknown");
  });
});

describe("mapFirestoreConditions", () => {
  it("should return never-existed when document not found", () => {
    const result = mapFirestoreConditions({
      documentExists: false,
      ownershipValid: false,
      isLive: false,
    });

    expect(result).toBe("never-existed");
  });

  it("should return ownership-mismatch when lockId doesn't match", () => {
    const result = mapFirestoreConditions({
      documentExists: true,
      ownershipValid: false,
      isLive: true,
    });

    expect(result).toBe("ownership-mismatch");
  });

  it("should return observable-expired when lock expired", () => {
    const result = mapFirestoreConditions({
      documentExists: true,
      ownershipValid: true,
      isLive: false,
    });

    expect(result).toBe("observable-expired");
  });

  it("should return succeeded when all conditions pass", () => {
    const result = mapFirestoreConditions({
      documentExists: true,
      ownershipValid: true,
      isLive: true,
    });

    expect(result).toBe("succeeded");
  });

  it("should prioritize document existence over ownership", () => {
    // Document doesn't exist - can't check ownership
    const result = mapFirestoreConditions({
      documentExists: false,
      ownershipValid: true, // This would be odd but should still return never-existed
      isLive: true,
    });

    expect(result).toBe("never-existed");
  });

  it("should prioritize ownership over liveness", () => {
    // Wrong owner - doesn't matter if live
    const result = mapFirestoreConditions({
      documentExists: true,
      ownershipValid: false,
      isLive: false, // Also expired, but ownership is checked first
    });

    expect(result).toBe("ownership-mismatch");
  });
});

describe("mapBackendObservation", () => {
  describe("Redis numeric codes", () => {
    it("should handle Redis success code", () => {
      expect(mapBackendObservation(1)).toBe("succeeded");
    });

    it("should handle Redis expired code", () => {
      expect(mapBackendObservation(-2)).toBe("observable-expired");
    });

    it("should handle Redis not found code", () => {
      expect(mapBackendObservation(-1)).toBe("never-existed");
    });

    it("should handle Redis ownership mismatch code", () => {
      expect(mapBackendObservation(0)).toBe("ownership-mismatch");
    });
  });

  describe("Firestore conditions object", () => {
    it("should handle Firestore success conditions", () => {
      const result = mapBackendObservation({
        documentExists: true,
        ownershipValid: true,
        isLive: true,
      });

      expect(result).toBe("succeeded");
    });

    it("should handle Firestore not found conditions", () => {
      const result = mapBackendObservation({
        documentExists: false,
        ownershipValid: false,
        isLive: false,
      });

      expect(result).toBe("never-existed");
    });

    it("should handle Firestore expired conditions", () => {
      const result = mapBackendObservation({
        documentExists: true,
        ownershipValid: true,
        isLive: false,
      });

      expect(result).toBe("observable-expired");
    });
  });
});
