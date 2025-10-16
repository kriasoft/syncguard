# Common Module

Shared utilities, types, and core functionality used across all SyncGuard backends.

## File Structure

```text
common/
  backend.ts           → Main entry point re-exporting from focused modules
  index.ts             → Re-exports from common module
  types.ts             → Core interfaces, types & capabilities
  constants.ts         → Configuration constants & defaults
  errors.ts            → LockError class & error handling
  validation.ts        → Key & lockId validation helpers
  crypto.ts            → Cryptographic functions (lockId generation, hashing, storage key generation)
  helpers.ts           → Utility functions (getByKey, owns, sanitizeLockInfo, checkAborted)
  auto-lock.ts         → Auto-managed lock functionality (createAutoLock, lock)
  config.ts            → Configuration merge helpers
  telemetry.ts         → Observability & telemetry decorators
  backend-semantics.ts → Result mapping & mutation semantics (internal)
  time-predicates.ts   → Unified time handling & liveness predicates
```

## Key Modules

### types.ts - Core Type Definitions

Defines the canonical TypeScript types that all backends implement:

- `BackendCapabilities` - Capability introspection interface
- `LockBackend<C>` - Core backend interface with generic capabilities
- `AcquireResult<C>` - Discriminated union for acquisition outcomes
- `ReleaseResult` / `ExtendResult` - Operation result types
- `LockInfo<C>` - Sanitized lock information
- `LockInfoDebug<C>` - Debug info with raw keys/lockIds
- `Fence` - Fencing token type (15-digit zero-padded string)

### constants.ts - Shared Constants

```typescript
// Maximum key length after Unicode NFC normalization and UTF-8 encoding
export const MAX_KEY_LENGTH_BYTES = 512;

// Backend defaults (TTL only)
export const BACKEND_DEFAULTS = {
  ttlMs: 30_000, // 30 seconds
} as const;

// Fence token thresholds (ADR-004)
export const FENCE_THRESHOLDS = {
  MAX: "900000000000000", // Hard limit: 9×10¹⁴
  WARN: "090000000000000", // Warning threshold: 9×10¹³ (10% before limit)
} as const;

// Time tolerance (ADR-005)
export const TIME_TOLERANCE_MS = 1000; // 1000ms - unified across all backends

// Backend-specific storage limits and reserve bytes
export const BACKEND_LIMITS = {
  redis: 1000, // Conservative limit for predictable headroom
  postgres: 1500, // Conservative PostgreSQL identifier limit
  firestore: 1500, // Firestore document ID limit
} as const;

export const RESERVE_BYTES = {
  redis: 26, // ":id:" (4) + lockId (22) = 26 bytes for dual-key pattern
  postgres: 0, // Independent tables, no suffix concatenation
  firestore: 0, // Independent document IDs
} as const;
```

### crypto.ts - Cryptographic Functions

**Key Functions:**

- `generateLockId()` - Generate cryptographically secure lockId (22 base64url chars, 128 bits entropy)
- `hashKey(value: string): HashId` - SHA-256 hash for sanitized identifiers (24 hex chars, 96 bits)
- `makeStorageKey()` - **Canonical storage key generation** with hash-based truncation (ADR-006, ADR-013)

**CRITICAL**: All backends MUST use `makeStorageKey()` for storage key generation. Custom implementations are FORBIDDEN.

### validation.ts - Input Validation

```typescript
// Validate lockId format (exactly 22 base64url characters)
export function validateLockId(lockId: string): void;

// Normalize and validate key (Unicode NFC, max 512 bytes UTF-8)
export function normalizeAndValidateKey(key: string): string;
```

### time-predicates.ts - Unified Time Handling

**CRITICAL**: All backends MUST use the unified liveness predicate (ADR-005):

```typescript
// Single source of truth for liveness checks
export function isLive(
  expiresAtMs: number,
  nowMs: number,
  toleranceMs: number,
): boolean {
  return expiresAtMs > nowMs - toleranceMs;
}

// Time source helpers
export function calculateRedisServerTimeMs(
  timeTuple: [string, string],
): number {
  return (
    parseInt(timeTuple[0]) * 1000 + Math.floor(parseInt(timeTuple[1]) / 1000)
  );
}

// Unified time tolerance constant (not user-configurable)
export const TIME_TOLERANCE_MS = 1000; // 1000ms - safe for all backends
```

### helpers.ts - Diagnostic Helpers

**Recommended API for lock diagnostics** (better than calling `backend.lookup()` directly):

```typescript
// Lookup lock by key (sanitized data)
export function getByKey<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

// Lookup lock by lockId (sanitized data)
export function getById<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
  opts?: { signal?: AbortSignal },
): Promise<LockInfo<C> | null>;

// Lookup with raw keys/lockIds (debugging only)
export function getByKeyRaw<C extends BackendCapabilities>(...): Promise<LockInfoDebug<C> | null>;
export function getByIdRaw<C extends BackendCapabilities>(...): Promise<LockInfoDebug<C> | null>;

// Quick ownership check
export function owns<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  lockId: string,
): Promise<boolean>;

// Sanitize lock info (convert raw data to LockInfo)
export function sanitizeLockInfo<C extends BackendCapabilities>(...): LockInfo<C>;

// AbortSignal helper
export function checkAborted(signal?: AbortSignal): void;
```

### auto-lock.ts - Auto-Managed Locks

High-level API for automatic lock management:

```typescript
// Create auto-managed lock function
export function createAutoLock<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  config?: Partial<LockConfig>,
): AutoLockFunction;

// Direct auto-lock function
export async function lock<T>(
  fn: () => Promise<T> | T,
  config: LockConfig & { acquisition?: AcquisitionOptions },
): Promise<T>;
```

### telemetry.ts - Observability

Opt-in telemetry decorator:

```typescript
// Wrap backend with telemetry
export function withTelemetry<C extends BackendCapabilities>(
  backend: LockBackend<C>,
  options: TelemetryOptions,
): LockBackend<C>;

// Telemetry configuration
interface TelemetryOptions {
  onEvent: (event: LockEvent) => void;
  includeRaw?: boolean | ((event: LockEvent) => boolean);
}
```

## Design Principles

### Zero-Cost Abstractions

- Telemetry has zero overhead when not enabled
- Type-level capabilities enable compile-time guarantees
- Helpers are thin wrappers with no hidden costs

### Single Source of Truth

- `makeStorageKey()` - Canonical storage key generation
- `isLive()` - Unified liveness predicate
- Constants in `constants.ts` - Shared across all backends

### Defensive Programming

- Input validation before I/O operations
- Explicit ownership verification (ADR-003)
- Hash-based sanitization by default

### Composability

- Helpers work with any `LockBackend<C>` implementation
- Telemetry decorator composable with any backend
- Type-safe capability inference

## Testing

Common utilities are tested independently:

```bash
# Unit tests
bun run test:unit common

# All common tests run as part of overall test suite
bun run test:unit
```

## Implementation References

- **Specification**: See `specs/interface.md` for complete requirements
- **ADRs**: See `specs/adrs.md` for design decisions
  - ADR-003: Explicit Ownership Verification
  - ADR-004: Fence Token Format
  - ADR-005: Unified Time Tolerance
  - ADR-006: Standardized Storage Key Generation
  - ADR-007: Opt-in Telemetry
