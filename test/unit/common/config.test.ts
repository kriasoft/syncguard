// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

/**
 * Unit tests for configuration helpers
 *
 * Tests default merging for backend and acquisition options
 */

import { describe, expect, it } from "bun:test";
import {
  mergeAcquisitionConfig,
  mergeBackendConfig,
} from "../../../common/config.js";
import { BACKEND_DEFAULTS, LOCK_DEFAULTS } from "../../../common/constants.js";

describe("mergeBackendConfig", () => {
  it("should use default ttlMs when not provided", () => {
    const result = mergeBackendConfig({});

    expect(result.ttlMs).toBe(BACKEND_DEFAULTS.ttlMs);
  });

  it("should use provided ttlMs when specified", () => {
    const result = mergeBackendConfig({ ttlMs: 60000 });

    expect(result.ttlMs).toBe(60000);
  });

  it("should handle zero as explicit value", () => {
    // Zero is technically falsy but should be used if provided
    // However, the implementation uses ?? so zero would be preserved
    const result = mergeBackendConfig({ ttlMs: 0 });

    expect(result.ttlMs).toBe(0);
  });

  it("should handle undefined explicitly", () => {
    const result = mergeBackendConfig({ ttlMs: undefined });

    expect(result.ttlMs).toBe(BACKEND_DEFAULTS.ttlMs);
  });
});

describe("mergeAcquisitionConfig", () => {
  it("should use all defaults when options is undefined", () => {
    const result = mergeAcquisitionConfig(undefined);

    expect(result.maxRetries).toBe(LOCK_DEFAULTS.maxRetries);
    expect(result.retryDelayMs).toBe(LOCK_DEFAULTS.retryDelayMs);
    expect(result.timeoutMs).toBe(LOCK_DEFAULTS.timeoutMs);
    expect(result.backoff).toBe(LOCK_DEFAULTS.backoff);
    expect(result.jitter).toBe(LOCK_DEFAULTS.jitter);
    expect(result.signal).toBeUndefined();
  });

  it("should use all defaults when options is empty object", () => {
    const result = mergeAcquisitionConfig({});

    expect(result.maxRetries).toBe(LOCK_DEFAULTS.maxRetries);
    expect(result.retryDelayMs).toBe(LOCK_DEFAULTS.retryDelayMs);
    expect(result.timeoutMs).toBe(LOCK_DEFAULTS.timeoutMs);
    expect(result.backoff).toBe(LOCK_DEFAULTS.backoff);
    expect(result.jitter).toBe(LOCK_DEFAULTS.jitter);
  });

  it("should merge custom maxRetries", () => {
    const result = mergeAcquisitionConfig({ maxRetries: 5 });

    expect(result.maxRetries).toBe(5);
    expect(result.retryDelayMs).toBe(LOCK_DEFAULTS.retryDelayMs);
  });

  it("should merge custom retryDelayMs", () => {
    const result = mergeAcquisitionConfig({ retryDelayMs: 200 });

    expect(result.retryDelayMs).toBe(200);
    expect(result.maxRetries).toBe(LOCK_DEFAULTS.maxRetries);
  });

  it("should merge custom timeoutMs", () => {
    const result = mergeAcquisitionConfig({ timeoutMs: 10000 });

    expect(result.timeoutMs).toBe(10000);
  });

  it("should merge custom backoff strategy", () => {
    const result = mergeAcquisitionConfig({ backoff: "fixed" });

    expect(result.backoff).toBe("fixed");
  });

  it("should merge custom jitter strategy", () => {
    const result = mergeAcquisitionConfig({ jitter: "full" });

    expect(result.jitter).toBe("full");
  });

  it("should merge custom jitter none strategy", () => {
    const result = mergeAcquisitionConfig({ jitter: "none" });

    expect(result.jitter).toBe("none");
  });

  it("should preserve signal when provided", () => {
    const controller = new AbortController();
    const result = mergeAcquisitionConfig({ signal: controller.signal });

    expect(result.signal).toBe(controller.signal);
  });

  it("should handle all options at once", () => {
    const controller = new AbortController();
    const result = mergeAcquisitionConfig({
      maxRetries: 3,
      retryDelayMs: 50,
      timeoutMs: 2000,
      backoff: "fixed",
      jitter: "none",
      signal: controller.signal,
    });

    expect(result.maxRetries).toBe(3);
    expect(result.retryDelayMs).toBe(50);
    expect(result.timeoutMs).toBe(2000);
    expect(result.backoff).toBe("fixed");
    expect(result.jitter).toBe("none");
    expect(result.signal).toBe(controller.signal);
  });

  it("should handle zero values explicitly", () => {
    const result = mergeAcquisitionConfig({
      maxRetries: 0,
      retryDelayMs: 0,
      timeoutMs: 0,
    });

    expect(result.maxRetries).toBe(0);
    expect(result.retryDelayMs).toBe(0);
    expect(result.timeoutMs).toBe(0);
  });
});
