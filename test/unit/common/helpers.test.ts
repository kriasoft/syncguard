// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for helper functions in common/helpers.ts
 *
 * Tests sanitization, raw data access, ownership checking, and utilities
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { hashKey } from "../../../common/crypto.js";
import { LockError } from "../../../common/errors.js";
import {
  attachRawData,
  checkAborted,
  delay,
  getById,
  getByIdRaw,
  getByKey,
  getByKeyRaw,
  hasFence,
  logFenceWarning,
  owns,
  sanitizeLockInfo,
} from "../../../common/helpers.js";
import type {
  BackendCapabilities,
  LockBackend,
  LockInfo,
} from "../../../common/types.js";

describe("sanitizeLockInfo", () => {
  const testCapabilities: BackendCapabilities & { supportsFencing: true } = {
    supportsFencing: true,
    timeAuthority: "server",
  };

  const testCapabilitiesNoFencing: BackendCapabilities & {
    supportsFencing: false;
  } = {
    supportsFencing: false,
    timeAuthority: "client",
  };

  it("should hash key and lockId", () => {
    const rawData = {
      key: "user:123",
      lockId: "abc123lockid12345678",
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now() - 1000,
    };

    const result = sanitizeLockInfo(rawData, testCapabilitiesNoFencing);

    expect(result.keyHash).toBe(hashKey("user:123"));
    expect(result.lockIdHash).toBe(hashKey("abc123lockid12345678"));
    expect(result.expiresAtMs).toBe(rawData.expiresAtMs);
    expect(result.acquiredAtMs).toBe(rawData.acquiredAtMs);
  });

  it("should include fence when supportsFencing is true", () => {
    const rawData = {
      key: "resource:456",
      lockId: "lockid12345678901234",
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
      fence: "000000000000042",
    };

    const result = sanitizeLockInfo(rawData, testCapabilities);

    expect((result as any).fence).toBe("000000000000042");
  });

  it("should not include fence when supportsFencing is false", () => {
    const rawData = {
      key: "resource:456",
      lockId: "lockid12345678901234",
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
      fence: "000000000000042",
    };

    const result = sanitizeLockInfo(rawData, testCapabilitiesNoFencing);

    expect((result as any).fence).toBeUndefined();
  });

  it("should not include fence when not provided", () => {
    const rawData = {
      key: "resource:789",
      lockId: "lockid12345678901234",
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const result = sanitizeLockInfo(rawData, testCapabilities);

    expect((result as any).fence).toBeUndefined();
  });
});

describe("attachRawData", () => {
  it("should attach raw data to lock info for later retrieval", () => {
    const lockInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("test-lock"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const result = attachRawData(lockInfo, {
      key: "test-key",
      lockId: "test-lock",
    });

    // Should return same object with attached data
    expect(result).toBe(lockInfo);
  });
});

describe("hasFence", () => {
  it("should return true for successful result with fence", () => {
    const result = {
      ok: true as const,
      lockId: "test-lock",
      expiresAtMs: Date.now() + 30000,
      fence: "000000000000001",
    };

    expect(hasFence(result)).toBe(true);
  });

  it("should return false for failed result", () => {
    const result = { ok: false as const, reason: "locked" as const };

    expect(hasFence(result)).toBe(false);
  });

  it("should return false for successful result without fence", () => {
    const result = {
      ok: true as const,
      lockId: "test-lock",
      expiresAtMs: Date.now() + 30000,
    };

    expect(hasFence(result)).toBe(false);
  });

  it("should return false when fence is empty string", () => {
    const result = {
      ok: true as const,
      lockId: "test-lock",
      expiresAtMs: Date.now() + 30000,
      fence: "",
    };

    expect(hasFence(result)).toBe(false);
  });
});

describe("getByKey", () => {
  it("should call backend.lookup with key", async () => {
    const mockLookup = mock(async () => null);
    const mockBackend = {
      lookup: mockLookup,
    } as unknown as LockBackend<BackendCapabilities>;

    await getByKey(mockBackend, "test-key");

    expect(mockLookup).toHaveBeenCalledWith({ key: "test-key" });
  });

  it("should forward signal option", async () => {
    const mockLookup = mock(async () => null);
    const mockBackend = {
      lookup: mockLookup,
    } as unknown as LockBackend<BackendCapabilities>;

    const controller = new AbortController();
    await getByKey(mockBackend, "test-key", { signal: controller.signal });

    expect(mockLookup).toHaveBeenCalledWith({
      key: "test-key",
      signal: controller.signal,
    });
  });

  it("should return lock info when found", async () => {
    const expectedInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("test-lock"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const mockBackend = {
      lookup: mock(async () => expectedInfo),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByKey(mockBackend, "test-key");

    expect(result).toEqual(expectedInfo);
  });
});

describe("getById", () => {
  it("should call backend.lookup with lockId", async () => {
    const mockLookup = mock(async () => null);
    const mockBackend = {
      lookup: mockLookup,
    } as unknown as LockBackend<BackendCapabilities>;

    await getById(mockBackend, "test-lock-id");

    expect(mockLookup).toHaveBeenCalledWith({ lockId: "test-lock-id" });
  });

  it("should forward signal option", async () => {
    const mockLookup = mock(async () => null);
    const mockBackend = {
      lookup: mockLookup,
    } as unknown as LockBackend<BackendCapabilities>;

    const controller = new AbortController();
    await getById(mockBackend, "test-lock-id", { signal: controller.signal });

    expect(mockLookup).toHaveBeenCalledWith({
      lockId: "test-lock-id",
      signal: controller.signal,
    });
  });
});

describe("getByKeyRaw", () => {
  it("should return null when lock not found", async () => {
    const mockBackend = {
      lookup: mock(async () => null),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByKeyRaw(mockBackend, "test-key");

    expect(result).toBeNull();
  });

  it("should include raw key from query when backend doesn't attach raw data", async () => {
    const mockInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("test-lock"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const mockBackend = {
      lookup: mock(async () => mockInfo),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByKeyRaw(mockBackend, "test-key");

    expect(result).not.toBeNull();
    expect(result!.key).toBe("test-key");
    expect(result!.lockId).toBe("[backend does not provide raw lockId]");
  });

  it("should include attached raw data when available", async () => {
    const mockInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("real-lock-id"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    // Attach raw data
    attachRawData(mockInfo, { key: "test-key", lockId: "real-lock-id" });

    const mockBackend = {
      lookup: mock(async () => mockInfo),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByKeyRaw(mockBackend, "test-key");

    expect(result).not.toBeNull();
    expect(result!.key).toBe("test-key");
    expect(result!.lockId).toBe("real-lock-id");
  });
});

describe("getByIdRaw", () => {
  it("should return null when lock not found", async () => {
    const mockBackend = {
      lookup: mock(async () => null),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByIdRaw(mockBackend, "test-lock-id");

    expect(result).toBeNull();
  });

  it("should include raw lockId from query when backend doesn't attach raw data", async () => {
    const mockInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("test-lock-id"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const mockBackend = {
      lookup: mock(async () => mockInfo),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await getByIdRaw(mockBackend, "test-lock-id");

    expect(result).not.toBeNull();
    expect(result!.lockId).toBe("test-lock-id");
    expect(result!.key).toBe("[backend does not provide raw key]");
  });
});

describe("owns", () => {
  it("should return true when lookup returns lock info", async () => {
    const mockInfo: LockInfo<BackendCapabilities> = {
      keyHash: hashKey("test-key"),
      lockIdHash: hashKey("test-lock"),
      expiresAtMs: Date.now() + 30000,
      acquiredAtMs: Date.now(),
    };

    const mockBackend = {
      lookup: mock(async () => mockInfo),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await owns(mockBackend, "test-lock");

    expect(result).toBe(true);
  });

  it("should return false when lookup returns null", async () => {
    const mockBackend = {
      lookup: mock(async () => null),
    } as unknown as LockBackend<BackendCapabilities>;

    const result = await owns(mockBackend, "test-lock");

    expect(result).toBe(false);
  });
});

describe("logFenceWarning", () => {
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("should log warning with fence and key", () => {
    logFenceWarning("999999999999999", "test-key");

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain("[SyncGuard]");
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain(
      "fence=999999999999999",
    );
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain("key=test-key");
  });

  it("should accept numeric fence value", () => {
    logFenceWarning(123456789, "numeric-key");

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain("fence=123456789");
  });
});

describe("checkAborted", () => {
  it("should not throw when signal is undefined", () => {
    expect(() => checkAborted(undefined)).not.toThrow();
  });

  it("should not throw when signal is not aborted", () => {
    const controller = new AbortController();

    expect(() => checkAborted(controller.signal)).not.toThrow();
  });

  it("should throw LockError when signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => checkAborted(controller.signal)).toThrow(LockError);
    expect(() => checkAborted(controller.signal)).toThrow(
      /Operation aborted by signal/,
    );
  });

  it("should throw with code Aborted", () => {
    const controller = new AbortController();
    controller.abort();

    try {
      checkAborted(controller.signal);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(LockError);
      expect((error as LockError).code).toBe("Aborted");
    }
  });
});

describe("delay", () => {
  it("should resolve after specified time", async () => {
    const start = Date.now();
    await delay(50);
    const elapsed = Date.now() - start;

    // Allow some tolerance for timing
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(150);
  });

  it("should resolve immediately for zero delay", async () => {
    const start = Date.now();
    await delay(0);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
