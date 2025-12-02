# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SyncGuard, please report it responsibly:

**Do not** open a public issue. Email <security@kriasoft.com>.

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

SyncGuard is a distributed lock library; safety depends on backend security and correct time authority:

- **Ownership enforcement**: Lock IDs are cryptographically strong; backends enforce ownership on release/extend.
- **Fencing tokens**: Use fence values to reject stale writers; all backends return monotonic 15-digit tokens.
- **TOCTOU protection**: Acquire/release/extend are atomic (ADR-003); avoid out-of-band deletes.
- **Time authority**: Redis/PostgreSQL use server time; Firestore uses client time—ensure NTP on clients.
- **Backend security**: Configure Redis/PostgreSQL/Firestore with authentication and TLS where available.
- **Dependencies**: Keep dependencies current to reduce supply chain risk.

## Best Practices

When using SyncGuard:

1. **Secure backends**: Enforce auth and TLS for Redis/PostgreSQL/Firestore; restrict network access.
2. **Least privilege**: Limit who can acquire/release locks via backend permissions.
3. **Use fencing**: Pass fence tokens to downstream writes to block stale actors.
4. **Monitor cleanup**: Provide `onReleaseError` hooks and/or `withTelemetry()` for observability.
5. **Keys**: Use non-guessable keys for sensitive resources; validate via helpers where applicable.
6. **Clock sync**: Keep NTP running on clients when using Firestore (client time authority).

## Disclosure Policy

- Vulnerabilities will be disclosed publicly after fixes are available
- Credit will be given to security researchers (with permission)
- CVE numbers will be requested for significant vulnerabilities

---

**This policy may be updated as the project evolves. Last updated: 2025-12-02**
