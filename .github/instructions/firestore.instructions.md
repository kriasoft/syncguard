---
applyTo: "firestore/**/*"
---

# Firestore Backend Requirements

## Document Storage Strategy

- **Document ID**: Use lock `key` as Firestore document ID
- **Collection**: Default `"locks"`, configurable via `collection` option
- **Document Schema**:
  ```typescript
  interface LockDocument {
    lockId: string; // For ownership verification
    expiresAt: number; // Expiration timestamp (ms)
    createdAt: number; // Creation timestamp (ms)
    key: string; // Lock key
  }
  ```

## Critical Requirements

### Required Index

Create single-field index on `lockId` field for release/extend performance.

### Acquire Operation

- Use `db.runTransaction()` for atomicity
- Direct document access: `collection.doc(key).get()`
- Overwrite expired locks atomically with `trx.set()`
- Distinguish lock contention from system errors

### Release Operation

- Query by `lockId` to find document, then verify ownership in transaction
- Handle race conditions between query and transaction
- Use `trx.delete()` after ownership verification

### Extend Operation

- Same query-then-verify pattern as release
- Verify ownership AND lock not expired before extending
- Use `trx.update()` to extend expiration

### IsLocked Operation

- Direct document access by key
- Fire-and-forget cleanup of expired locks

## Error Handling

### Retry on Transient Errors

- `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL`, `ABORTED`
- Network errors, connection issues

### Don't Retry

- `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`
