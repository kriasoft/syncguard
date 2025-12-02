// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for withTelemetry decorator
 *
 * Tests the telemetry wrapper including:
 * - Event emission for all operations
 * - Error isolation (telemetry errors don't affect operations)
 * - includeRaw predicate behavior
 * - Hash-based sanitization
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { FAILURE_REASON } from "../../../common/backend-semantics.js";
import { hashKey } from "../../../common/crypto.js";
import { decorateAcquireResult } from "../../../common/disposable.js";
import { withTelemetry } from "../../../common/telemetry.js";
import type {
  BackendCapabilities,
  LockBackend,
  LockEvent,
  LockInfo,
} from "../../../common/types.js";

describe("withTelemetry", () => {
  type TestCapabilities = BackendCapabilities & { supportsFencing: true };
  let mockBackend: LockBackend<TestCapabilities>;
  let events: LockEvent[];
  let onEvent: ReturnType<typeof mock<(event: LockEvent) => void>>;

  const testCapabilities: TestCapabilities = {
    supportsFencing: true,
    timeAuthority: "server" as const,
  };

  beforeEach(() => {
    events = [];
    onEvent = mock((event: LockEvent) => {
      events.push(event);
    });

    // Create mock ops for decorating acquire results
    const mockOps = {
      release: mock(async () => ({ ok: true as const })),
      extend: mock(async () => ({
        ok: true as const,
        expiresAtMs: Date.now() + 30000,
      })),
    };

    mockBackend = {
      acquire: mock(async () => {
        const result = {
          ok: true as const,
          lockId: "test-lock-id",
          expiresAtMs: Date.now() + 30000,
          fence: "000000000000001" as const,
        };
        return decorateAcquireResult<TestCapabilities>(
          mockOps,
          result,
          "test-key",
        );
      }),
      release: mockOps.release,
      extend: mockOps.extend,
      isLocked: mock(async () => true),
      lookup: mock(async () => null),
      capabilities: testCapabilities,
    };
  });

  describe("acquire operation", () => {
    it("should emit acquire event on success", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "acquire",
        keyHash: hashKey("test-key"),
        result: "ok",
      });
    });

    it("should emit acquire event with reason on contention", async () => {
      (mockBackend.acquire as ReturnType<typeof mock>).mockResolvedValueOnce(
        decorateAcquireResult<TestCapabilities>(
          mockBackend,
          { ok: false, reason: "locked" },
          "test-key",
        ),
      );

      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(result.ok).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "acquire",
        keyHash: hashKey("test-key"),
        result: "fail",
        reason: "locked",
      });
    });

    it("should include raw data when includeRaw is true", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: true,
      });

      await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(events[0]?.key).toBe("test-key");
      expect(events[0]?.lockId).toBe("test-lock-id");
    });

    it("should not include raw data when includeRaw is false", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: false,
      });

      await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(events[0]?.key).toBeUndefined();
      expect(events[0]?.lockId).toBeUndefined();
    });

    it("should support predicate function for includeRaw", async () => {
      const includeRaw = mock((event: LockEvent) => event.type === "acquire");

      const backend = withTelemetry(mockBackend, { onEvent, includeRaw });

      await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(includeRaw).toHaveBeenCalledTimes(1);
      expect(events[0]?.key).toBe("test-key");
    });

    it("should handle includeRaw predicate errors", async () => {
      const includeRaw = mock(() => {
        throw new Error("Predicate error");
      });

      const backend = withTelemetry(mockBackend, { onEvent, includeRaw });

      const result = await backend.acquire({ key: "test-key", ttlMs: 30000 });

      // Should still succeed and emit event without raw data
      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.key).toBeUndefined();
    });
  });

  describe("release operation", () => {
    it("should emit release event on success", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.release({ lockId: "test-lock-id" });

      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "release",
        lockIdHash: hashKey("test-lock-id"),
        result: "ok",
      });
    });

    it("should emit release event with failure reason metadata", async () => {
      const failResult = { ok: false as const };
      (failResult as any)[FAILURE_REASON] = { reason: "expired" };
      (mockBackend.release as ReturnType<typeof mock>).mockResolvedValueOnce(
        failResult,
      );

      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.release({ lockId: "test-lock-id" });

      expect(result.ok).toBe(false);
      expect(events[0]).toEqual({
        type: "release",
        lockIdHash: hashKey("test-lock-id"),
        result: "fail",
        reason: "expired",
      });
    });

    it("should include raw lockId when includeRaw is true", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: true,
      });

      await backend.release({ lockId: "test-lock-id" });

      expect(events[0]?.lockId).toBe("test-lock-id");
    });
  });

  describe("extend operation", () => {
    it("should emit extend event on success", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.extend({
        lockId: "test-lock-id",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "extend",
        lockIdHash: hashKey("test-lock-id"),
        result: "ok",
      });
    });

    it("should emit extend event with failure reason", async () => {
      const failResult = { ok: false as const };
      (failResult as any)[FAILURE_REASON] = { reason: "not-found" };
      (mockBackend.extend as ReturnType<typeof mock>).mockResolvedValueOnce(
        failResult,
      );

      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.extend({
        lockId: "test-lock-id",
        ttlMs: 30000,
      });

      expect(result.ok).toBe(false);
      expect(events[0]?.reason).toBe("not-found");
    });
  });

  describe("isLocked operation", () => {
    it("should emit isLocked event when locked", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.isLocked({ key: "test-key" });

      expect(result).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "isLocked",
        keyHash: hashKey("test-key"),
        result: "ok",
      });
    });

    it("should emit isLocked event when not locked", async () => {
      (mockBackend.isLocked as ReturnType<typeof mock>).mockResolvedValueOnce(
        false,
      );

      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.isLocked({ key: "test-key" });

      expect(result).toBe(false);
      expect(events[0]?.result).toBe("fail");
    });

    it("should include raw key when includeRaw is true", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: true,
      });

      await backend.isLocked({ key: "test-key" });

      expect(events[0]?.key).toBe("test-key");
    });
  });

  describe("lookup operation", () => {
    it("should emit lookup event by key on success", async () => {
      const mockLockInfo: LockInfo<TestCapabilities> = {
        keyHash: hashKey("test-key"),
        lockIdHash: hashKey("test-lock-id"),
        expiresAtMs: Date.now() + 30000,
        acquiredAtMs: Date.now(),
        fence: "000000000000001",
      };
      (mockBackend.lookup as ReturnType<typeof mock>).mockResolvedValueOnce(
        mockLockInfo,
      );

      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.lookup({ key: "test-key" });

      expect(result).toEqual(mockLockInfo);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "lookup",
        keyHash: hashKey("test-key"),
        result: "ok",
      });
    });

    it("should emit lookup event by key on not found", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      const result = await backend.lookup({ key: "test-key" });

      expect(result).toBeNull();
      expect(events[0]).toEqual({
        type: "lookup",
        keyHash: hashKey("test-key"),
        result: "fail",
      });
    });

    it("should emit lookup event by lockId", async () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      await backend.lookup({ lockId: "test-lock-id" });

      expect(events[0]).toEqual({
        type: "lookup",
        lockIdHash: hashKey("test-lock-id"),
        result: "fail",
      });
    });

    it("should include raw data when includeRaw is true for key lookup", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: true,
      });

      await backend.lookup({ key: "test-key" });

      expect(events[0]?.key).toBe("test-key");
    });

    it("should include raw data when includeRaw is true for lockId lookup", async () => {
      const backend = withTelemetry(mockBackend, {
        onEvent,
        includeRaw: true,
      });

      await backend.lookup({ lockId: "test-lock-id" });

      expect(events[0]?.lockId).toBe("test-lock-id");
    });
  });

  describe("error isolation", () => {
    it("should not affect operation when onEvent throws", async () => {
      const throwingOnEvent = mock(() => {
        throw new Error("Telemetry error");
      });

      const backend = withTelemetry(mockBackend, { onEvent: throwingOnEvent });

      // Should still succeed despite telemetry error
      const result = await backend.acquire({ key: "test-key", ttlMs: 30000 });

      expect(result.ok).toBe(true);
      expect(throwingOnEvent).toHaveBeenCalledTimes(1);
    });

    it("should isolate errors across multiple operations", async () => {
      let errorCount = 0;
      const throwingOnEvent = mock(() => {
        errorCount++;
        throw new Error(`Error ${errorCount}`);
      });

      const backend = withTelemetry(mockBackend, { onEvent: throwingOnEvent });

      // All operations should succeed
      await backend.acquire({ key: "test", ttlMs: 1000 });
      await backend.release({ lockId: "test" });
      await backend.extend({ lockId: "test", ttlMs: 1000 });
      await backend.isLocked({ key: "test" });
      await backend.lookup({ key: "test" });

      expect(errorCount).toBe(5);
    });
  });

  describe("capabilities passthrough", () => {
    it("should expose original backend capabilities", () => {
      const backend = withTelemetry(mockBackend, { onEvent });

      expect(backend.capabilities).toEqual(testCapabilities);
    });
  });
});
