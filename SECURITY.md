# Security Policy

## Supported Versions

Only the latest commit on the `main` branch is actively supported with security fixes.

## Reporting a Vulnerability

If you discover a security issue, please report it privately via GitHub Security Advisories:

1. Open the repository on GitHub.
2. Go to **Security → Advisories → New draft security advisory**.
3. Describe the vulnerability, impact, and steps to reproduce.

We will acknowledge the report as soon as possible and coordinate a fix and disclosure timeline.

## Security Model

- The GUI server binds to `127.0.0.1` only and validates the `Host` header for every request. State-changing requests also require a matching `Origin` or `Referer` header.
- The MCP server (`npm run mcp-server`) runs with the privileges of the local user and can read file paths supplied by the connected MCP client. Only connect trusted clients.
