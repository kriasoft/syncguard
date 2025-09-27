# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in SyncGuard, please report it responsibly:

**DO NOT** open a public issue for security vulnerabilities.

Instead, please email: <security@github.com>

Include in your report:

- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity, typically 2-4 weeks

Critical vulnerabilities affecting distributed locking integrity will be prioritized and may receive emergency patches.

## Security Considerations

SyncGuard handles distributed locking, which is security-sensitive. Key areas:

- **Lock integrity**: Preventing unauthorized lock acquisition/release
- **Timing attacks**: Protecting against race conditions in lock operations
- **Backend security**: Proper configuration of Redis/Firestore credentials
- **Dependencies**: Regular updates to prevent supply chain attacks

## Best Practices

When using SyncGuard:

1. **Secure your backends**: Use proper authentication for Redis/Firestore
2. **Network security**: Use TLS/SSL for backend connections
3. **Access control**: Limit who can acquire/release locks
4. **Monitoring**: Log lock operations for audit trails
5. **Key management**: Use non-predictable lock keys when needed

## Disclosure Policy

- Vulnerabilities will be disclosed publicly after fixes are available
- Credit will be given to security researchers (with permission)
- CVE numbers will be requested for significant vulnerabilities

---

**This policy may be updated as the project evolves. Last updated: 2025-09-27**
