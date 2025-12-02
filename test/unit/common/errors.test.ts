// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Error handling tests
 *
 * Tests for LockError construction and error codes:
 * - LockError class
 * - Error codes
 * - Error context
 * - Error messages
 */

import { describe, expect, it } from "bun:test";
import { LockError } from "../../../common/errors.js";

describe("Error Handling", () => {
  describe("LockError Construction", () => {
    it("should create consistent LockError instances", () => {
      const error = new LockError("InvalidArgument", "Test error message", {
        key: "test:key",
        lockId: "test-lock-id",
        cause: new Error("root cause"),
      });

      expect(error.name).toBe("LockError");
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toBe("Test error message");
      expect(error.context?.key).toBe("test:key");
      expect(error.context?.lockId).toBe("test-lock-id");
      expect(error.context?.cause).toBeInstanceOf(Error);
    });

    it("should use error code as default message", () => {
      const error = new LockError("ServiceUnavailable");
      expect(error.message).toBe("ServiceUnavailable");
    });

    it("should allow custom message with code", () => {
      const error = new LockError("InvalidArgument", "Custom error message");
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toBe("Custom error message");
    });

    it("should support context without cause", () => {
      const error = new LockError("InvalidArgument", "Lock not found", {
        key: "test:key",
        lockId: "test-lock-id",
      });

      expect(error.context?.key).toBe("test:key");
      expect(error.context?.lockId).toBe("test-lock-id");
      expect(error.context?.cause).toBeUndefined();
    });

    it("should support minimal construction (code only)", () => {
      const error = new LockError("ServiceUnavailable");
      expect(error.code).toBe("ServiceUnavailable");
      expect(error.message).toBe("ServiceUnavailable");
      expect(error.context).toBeUndefined();
    });
  });

  describe("Error Codes", () => {
    it("should support all standard error codes", () => {
      const errorCodes: Array<
        | "InvalidArgument"
        | "ServiceUnavailable"
        | "AuthFailed"
        | "RateLimited"
        | "NetworkTimeout"
        | "AcquisitionTimeout"
        | "Aborted"
        | "Internal"
      > = [
        "InvalidArgument",
        "ServiceUnavailable",
        "AuthFailed",
        "RateLimited",
        "NetworkTimeout",
        "AcquisitionTimeout",
        "Aborted",
        "Internal",
      ];

      errorCodes.forEach((code) => {
        const error = new LockError(code);
        expect(error.code).toBe(code);
      });
    });

    it("should use descriptive messages for common errors", () => {
      const invalidArgError = new LockError(
        "InvalidArgument",
        "Key must not be empty",
      );
      expect(invalidArgError.message).toContain("Key must not be empty");

      const internalError = new LockError("Internal", "Lock operation failed");
      expect(internalError.message).toContain("Lock operation failed");

      const unavailableError = new LockError(
        "ServiceUnavailable",
        "Redis connection failed",
      );
      expect(unavailableError.message).toContain("Redis connection failed");
    });
  });

  describe("Error Context", () => {
    it("should include key in context when available", () => {
      const error = new LockError("InvalidArgument", "Invalid key format", {
        key: "invalid:key:format",
      });

      expect(error.context?.key).toBe("invalid:key:format");
    });

    it("should include lockId in context when available", () => {
      const error = new LockError("Internal", "Lock not found", {
        lockId: "test-lock-id-123",
      });

      expect(error.context?.lockId).toBe("test-lock-id-123");
    });

    it("should include both key and lockId in context", () => {
      const error = new LockError("Internal", "Failed to release lock", {
        key: "test:key",
        lockId: "test-lock-id",
      });

      expect(error.context?.key).toBe("test:key");
      expect(error.context?.lockId).toBe("test-lock-id");
    });

    it("should include cause error in context", () => {
      const cause = new Error("Network timeout");
      const error = new LockError("ServiceUnavailable", "Backend unavailable", {
        cause,
      });

      expect(error.context?.cause).toBe(cause);
      expect((error.context?.cause as Error)?.message).toBe("Network timeout");
    });

    it("should preserve cause error stack trace", () => {
      const cause = new Error("Original error");
      const error = new LockError("Internal", "Wrapped error", {
        cause,
      });

      expect((error.context?.cause as Error)?.stack).toBeDefined();
    });
  });

  describe("Error Inheritance", () => {
    it("should be instanceof Error", () => {
      const error = new LockError("InvalidArgument");
      expect(error).toBeInstanceOf(Error);
    });

    it("should be instanceof LockError", () => {
      const error = new LockError("InvalidArgument");
      expect(error).toBeInstanceOf(LockError);
    });

    it("should be catchable as Error", () => {
      try {
        throw new LockError("InvalidArgument", "Test error");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(LockError);
      }
    });

    it("should preserve stack trace", () => {
      const error = new LockError("InvalidArgument");
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("LockError");
    });
  });

  describe("Error Messages", () => {
    it("should format error messages with context", () => {
      const error = new LockError(
        "InvalidArgument",
        "Key exceeds maximum length",
        {
          key: "x".repeat(100),
        },
      );

      expect(error.message).toBe("Key exceeds maximum length");
      expect(error.context?.key).toBeDefined();
    });

    it("should handle empty context gracefully", () => {
      const error = new LockError("Internal", "Lock not found", {});
      expect(error.message).toBe("Lock not found");
      expect(error.context).toBeDefined();
    });

    it("should handle undefined context gracefully", () => {
      const error = new LockError("Internal", "Lock not found");
      expect(error.message).toBe("Lock not found");
      expect(error.context).toBeUndefined();
    });
  });
});
