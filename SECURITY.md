# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest `main` | ✅ |
| older releases | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues to: **security@foxtrotcommunications.net**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide a detailed response within 7 days.

## Security Measures

Roundtable implements the following security controls:

- **Authentication**: bcrypt(12) password hashing
- **Rate Limiting**: Login (5/min), registration (3/min), API (100/min)
- **Security Headers**: Helmet.js (CSP, HSTS, X-Content-Type-Options, etc.)
- **XSS Protection**: DOMPurify sanitization on all rendered markdown
- **SQL Safety**: Data warehouse tools block all write operations (INSERT, UPDATE, DELETE, DROP, etc.)
- **Shell Execution**: Strict command allowlist with dangerous pattern detection
- **File Access**: Path traversal protection on all file operations
- **Session Security**: HttpOnly, SameSite=Lax cookies with configurable Secure flag

## Dependency Monitoring

We use `npm audit` and GitHub Dependabot to monitor for known vulnerabilities in dependencies.
