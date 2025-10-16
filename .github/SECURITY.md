# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SyncGuard, please report it responsibly:

**DO NOT** open a public issue for security vulnerabilities.

Instead, please email: <security@kriasoft.com>

Include in your report:

- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity, typically 1-4 weeks

Critical vulnerabilities affecting distributed locking integrity will be prioritized and may receive emergency patches.

## Security Considerations

SyncGuard handles distributed locking, which is security-sensitive. Key areas:

- **Lock integrity**: Preventing unauthorized lock acquisition/release (enforced via cryptographically strong lockIds)
- **Fencing tokens**: Monotonic counters prevent stale lock holders from corrupting data
- **TOCTOU protection**: Atomic operations prevent race conditions (ADR-003)
- **Timing attacks**: 1000ms unified tolerance provides predictable behavior (ADR-005)
- **Backend security**: Proper configuration of Redis/Firestore credentials
- **Dependencies**: Regular updates to prevent supply chain attacks

## Best Practices

When using SyncGuard:

1. **Secure your backends**: Use proper authentication for Redis/Firestore
2. **Network security**: Use TLS/SSL for backend connections in production
3. **Access control**: Limit who can acquire/release locks through backend permissions
4. **Monitoring**: Use `withTelemetry()` decorator for audit trails (opt-in)
5. **Key management**: Use non-predictable lock keys when needed
6. **Fencing tokens**: Use fence tokens to prevent stale writes in critical operations
7. **Time synchronization**: Ensure NTP sync for Firestore backends (±500ms accuracy)
8. **Key validation**: Leverage `normalizeAndValidateKey()` and `validateLockId()` helpers
9. **Error handling**: Catch `LockError` for system failures, handle contention via result types

## Disclosure Policy

- Vulnerabilities will be disclosed publicly after fixes are available
- Credit will be given to security researchers (with permission)
- CVE numbers will be requested for significant vulnerabilities

## Responsible Disclosure

We appreciate security researchers who help keep SyncGuard secure. If you report a valid security issue:

- We'll acknowledge your contribution in the release notes (with your permission)
- Critical issues affecting lock integrity will receive emergency patches
- We'll coordinate disclosure timing with you

---

**This policy may be updated as the project evolves. Last updated: 2025-10-16**
