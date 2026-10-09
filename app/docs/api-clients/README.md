# API Client Development Guides

Guides for extending the API clients in `src/core/clients/`. Each guide documents the authoritative sources, conventions, and checklists for adding new endpoints.

| Guide | Client path | Auth |
|-------|-------------|------|
| [qonto.md](qonto.md) | `src/core/clients/qonto/` | Login:SecretKey (env-aware: production/staging) |
| [paperless.md](paperless.md) | `packages/paperless/` | Token |
