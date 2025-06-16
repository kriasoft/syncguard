---
applyTo: "**/*.ts,**/*.json,**/*.md"
---

# D-Lock Library Instructions

## Core Purpose

TypeScript distributed lock library with Redis/Firestore backends. Prevents race conditions across distributed systems with automatic lock management.

## Critical Design Principles

### API Design - Primary Pattern

```typescript
// Main usage pattern - function that auto-manages locks
const lock = createLock(backend);
await lock(
  async () => {
    /* critical section */
  },
  { key: "resource:123" },
);

// Manual control when needed
const result = await lock.acquire({ key: "resource:123", ttl: 30000 });
if (result.success) {
  try {
    /* work */
  } finally {
    await lock.release(result.lockId);
  }
}
```

### Backend Abstraction

```typescript
interface LockBackend {
  acquire: (config: LockConfig) => Promise<LockResult>;
  release: (lockId: string) => Promise<boolean>;
  extend: (lockId: string, ttl: number) => Promise<boolean>;
  isLocked: (key: string) => Promise<boolean>;
}

type LockResult =
  | { success: true; lockId: string; expiresAt: Date }
  | { success: false; error: string };
```

### Package Structure

- `syncguard` - core API for custom backends
- `syncguard/redis` - Redis backend
- `syncguard/firestore` - Firestore backend

## Performance Requirements

All operations must be O(1) or acceptable O(log n):

- **Acquire**: Single atomic operation with timeout - O(1)
- **Status Check**: Single read operation by key - O(1)
- **Release/Extend**: Direct access or indexed query - O(1) or O(log n)

### Backend Requirements

- **Use `key` as document ID**: Natural lock semantics and fast common operations
- **Store `lockId` as field**: For ownership verification in release/extend
- **Single document per lock**: Avoid dual-document complexity
- **Direct document access**: Use `doc(key).get()` for acquire/isLocked operations (O(1))
- **Query-then-direct access**: Release/extend operations query by `lockId` field to find document, then use direct access for atomic updates (O(log n) acceptable)

#### **Acquire Operation**

- **Atomicity**: Use transactions to prevent double locks
- **Contention vs Errors**: Distinguish lock contention from system errors in retry logic
- **Expired Lock Cleanup**: Check and clean up expired locks before granting new ones
- **Timeout Respect**: Honor acquisition timeouts, don't retry indefinitely

#### **Release Operation**

- **Query-then-verify approach**: Query by `lockId` field to find document, then verify ownership
- **Ownership Verification**: Verify lockId ownership before deletion using atomic transaction
- **Idempotency**: Safe to call multiple times (return false for non-existent)
- **Atomic deletion**: Use transaction to ensure ownership check and deletion are atomic

#### **Extend Operation**

- **Query-then-verify approach**: Query by `lockId` field to find document, then verify ownership
- **Ownership Verification**: Verify lockId ownership before extending TTL using atomic transaction
- **Atomicity**: Use transactions for read-then-write operations
- **Expiry Validation**: Reject extensions on already-expired locks

#### **IsLocked Operation**

- **Performance**: Use direct key-based document access (O(1))
- **Non-Mutating**: Don't modify lock state during checks
- **Cleanup**: Opportunistically clean up expired locks (fire-and-forget)

#### **Cross-Operation Requirements**

- **Error Classification**: Distinguish transient vs permanent errors
- **Concurrency Safety**: All operations must be safe under high concurrency

## Code Style

### Functional Programming

- Pure functions, immutable data
- Function composition over inheritance
- Descriptive names, proper error handling
- `const` over `let`, avoid classes

### Error Handling

- Primary API (`lock(fn, config)`) throws `LockError` on failure
- Manual operations return `LockResult` type
- Include timeout handling for all operations

### Critical Implementation Details

```typescript
export function createLock(backend: LockBackend) {
  const withLock = async <T>(
    fn: () => Promise<T>,
    config: LockConfig,
  ): Promise<T> => {
    // Auto acquire/release with proper cleanup
  };

  // Expose manual operations
  withLock.acquire = backend.acquire;
  withLock.release = backend.release;
  withLock.extend = backend.extend;
  withLock.isLocked = backend.isLocked;

  return withLock;
}
```

## Key Types

```typescript
interface LockConfig {
  key: string;
  ttlMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}
```

## Non-Negotiables

- Concurrent access safety
- Automatic cleanup on failure
- Backend-agnostic core
- Tree-shakable exports
- Strict TypeScript
- JSDoc for public APIs
