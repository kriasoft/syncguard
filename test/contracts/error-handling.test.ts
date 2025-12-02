// SPDX-FileCopyrightText: 2025-present Kriasoft
// SPDX-License-Identifier: MIT

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { LockError } from "../../common/errors.js";
import type { LockBackend } from "../../common/types.js";
import { getAvailableBackends } from "../fixtures/backends.js";

describe("Error Handling", async () => {
  const availableBackends = await getAvailableBackends();

  if (availableBackends.length === 0) {
    it.skip("No backends available", () => {});
    return;
  }

  for (const fixture of availableBackends) {
    describe(`${fixture.name}`, () => {
      let backend: LockBackend;
      let cleanup: () => Promise<void>;
      let teardown: () => Promise<void>;

      beforeAll(async () => {
        const result = await fixture.setup();
        backend = result.createBackend();
        cleanup = result.cleanup;
        teardown = result.teardown;
      });

      beforeEach(async () => {
        await cleanup();
      });

      afterAll(async () => {
        await teardown();
      });

      describe("Invalid key inputs", () => {
        it("should reject empty key", async () => {
          await expect(
            backend.acquire({ key: "", ttlMs: 30000 }),
          ).rejects.toThrow(LockError);

          await expect(backend.isLocked({ key: "" })).rejects.toThrow(
            LockError,
          );

          await expect(backend.lookup({ key: "" })).rejects.toThrow(LockError);
        });

        it("should reject key exceeding maximum length", async () => {
          const longKey = "x".repeat(600); // Exceeds 512 byte limit

          await expect(
            backend.acquire({ key: longKey, ttlMs: 30000 }),
          ).rejects.toThrow("exceeds maximum length");

          await expect(backend.isLocked({ key: longKey })).rejects.toThrow(
            "exceeds maximum length",
          );

          await expect(backend.lookup({ key: longKey })).rejects.toThrow(
            "exceeds maximum length",
          );
        });

        it("should accept keys at maximum length boundary", async () => {
          // 512 bytes is within limit
          const maxKey = "a".repeat(512);

          const result = await backend.acquire({ key: maxKey, ttlMs: 30000 });
          expect(result.ok).toBe(true);

          if (result.ok) {
            await backend.release({ lockId: result.lockId });
          }
        });
      });

      describe("Invalid lockId inputs", () => {
        it("should reject empty lockId", async () => {
          await expect(backend.release({ lockId: "" })).rejects.toThrow(
            "Invalid lockId format",
          );

          await expect(
            backend.extend({ lockId: "", ttlMs: 30000 }),
          ).rejects.toThrow("Invalid lockId format");

          await expect(backend.lookup({ lockId: "" })).rejects.toThrow(
            "Invalid lockId format",
          );
        });

        it("should reject lockId with invalid format", async () => {
          const invalidLockIds = [
            "invalid-lockid",
            "too-short",
            "this-is-way-too-long-for-valid-lockid-format",
            "invalid!@#$%",
            "spaces not allowed",
          ];

          for (const lockId of invalidLockIds) {
            await expect(backend.release({ lockId })).rejects.toThrow(
              "Invalid lockId format",
            );

            await expect(
              backend.extend({ lockId, ttlMs: 30000 }),
            ).rejects.toThrow("Invalid lockId format");

            await expect(backend.lookup({ lockId })).rejects.toThrow(
              "Invalid lockId format",
            );
          }
        });
      });

      describe("Invalid TTL inputs", () => {
        it("should reject negative TTL", async () => {
          await expect(
            backend.acquire({ key: "error:ttl:negative", ttlMs: -1 }),
          ).rejects.toThrow(LockError);
        });

        it("should reject zero TTL", async () => {
          await expect(
            backend.acquire({ key: "error:ttl:zero", ttlMs: 0 }),
          ).rejects.toThrow(LockError);
        });

        it("should accept valid TTL range", async () => {
          const validTtls = [100, 1000, 30000, 3600000]; // 100ms to 1 hour

          for (const ttlMs of validTtls) {
            const result = await backend.acquire({
              key: `error:ttl:valid:${ttlMs}`,
              ttlMs,
            });
            expect(result.ok).toBe(true);

            if (result.ok) {
              await backend.release({ lockId: result.lockId });
            }
          }
        });
      });

      describe("Non-existent resource operations", () => {
        it("should handle release of non-existent lock gracefully", async () => {
          const result = await backend.release({
            lockId: "AAAAAAAAAAAAAAAAAAAAAA",
          });
          expect(result.ok).toBe(false);
        });

        it("should handle extend of non-existent lock gracefully", async () => {
          const result = await backend.extend({
            lockId: "BBBBBBBBBBBBBBBBBBBBBB",
            ttlMs: 30000,
          });
          expect(result.ok).toBe(false);
        });

        it("should return false for isLocked on non-existent lock", async () => {
          const isLocked = await backend.isLocked({
            key: "error:nonexistent:resource",
          });
          expect(isLocked).toBe(false);
        });

        it("should return null for lookup on non-existent lock", async () => {
          const result = await backend.lookup({
            key: "error:nonexistent:lookup",
          });
          expect(result).toBeNull();
        });
      });

      describe("Edge cases", () => {
        it("should handle special characters in keys", async () => {
          const specialKeys = [
            "key:with:colons",
            "key/with/slashes",
            "key-with-dashes",
            "key_with_underscores",
            "key.with.dots",
          ];

          for (const key of specialKeys) {
            const result = await backend.acquire({ key, ttlMs: 30000 });
            expect(result.ok).toBe(true);

            if (result.ok) {
              expect(await backend.isLocked({ key })).toBe(true);
              await backend.release({ lockId: result.lockId });
            }
          }
        });

        it("should handle Unicode characters in keys", async () => {
          const unicodeKeys = [
            "key-with-emoji-🔒",
            "clé-française",
            "キー",
            "ключ",
          ];

          for (const key of unicodeKeys) {
            const result = await backend.acquire({ key, ttlMs: 30000 });
            expect(result.ok).toBe(true);

            if (result.ok) {
              await backend.release({ lockId: result.lockId });
            }
          }
        });

        it("should handle rapid error conditions without state corruption", async () => {
          const operations = Array.from({ length: 10 }, async () => {
            try {
              await backend.acquire({ key: "", ttlMs: 30000 });
            } catch {
              // Expected to throw
            }

            try {
              await backend.release({ lockId: "invalid" });
            } catch {
              // Expected to throw
            }
          });

          await Promise.all(operations);

          // Backend should still be operational after error storm
          const result = await backend.acquire({
            key: "error:after-storm",
            ttlMs: 30000,
          });
          expect(result.ok).toBe(true);

          if (result.ok) {
            await backend.release({ lockId: result.lockId });
          }
        });

        it("should throw LockError consistently across operations", async () => {
          const errors: LockError[] = [];

          try {
            await backend.acquire({ key: "", ttlMs: 30000 });
          } catch (error) {
            if (error instanceof LockError) errors.push(error);
          }

          try {
            await backend.isLocked({ key: "" });
          } catch (error) {
            if (error instanceof LockError) errors.push(error);
          }

          try {
            await backend.lookup({ key: "" });
          } catch (error) {
            if (error instanceof LockError) errors.push(error);
          }

          try {
            await backend.release({ lockId: "invalid" });
          } catch (error) {
            if (error instanceof LockError) errors.push(error);
          }

          // All should throw LockError
          expect(errors.length).toBe(4);
          errors.forEach((error) => {
            expect(error).toBeInstanceOf(LockError);
            expect(error.code).toBeDefined();
            expect(error.message).toBeDefined();
          });
        });
      });
    });
  }
});
