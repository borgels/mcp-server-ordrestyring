# Changelog

## 0.3.0 (2026-11-17)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
so one process can serve several tenants. The MCP server (stdio and HTTP) is
unchanged and still reads its configuration from the environment.

- `createOrdrestyringGateway` requires `apiToken` and never reads
  `ORDRESTYRING_API_TOKEN` or `ORDRESTYRING_BASE_URL`; the base URL defaults
  to `https://graphql.ordrestyring.dk`. A token shorter than 8 characters is
  refused, since the redactor cannot protect it. Breaking for hosts that
  relied on the environment fallback.
- Per-instance secret redaction replaces the process-wide registry: a
  gateway instance's token is redacted only in that instance's calls and is
  never kept by the process.
- `ordrestyringToolCatalog`: a deeply frozen catalog with each tool's
  definition, the GraphQL requests it may make (`query` or `mutation`) and a
  `broad` mark (false for every gateway tool).
- Input is validated with the MCP server's zod schemas before a handler
  runs; unknown fields are refused. The gateway's JSON schemas are derived
  from the same zod schemas.
- Host policy: `policy: { enableWrites, disabledTools, audit }`. Under it the
  instance reads none of `ORDRESTYRING_ENABLE_WRITES`,
  `ORDRESTYRING_POLICY_PATH` or `ORDRESTYRING_AUDIT_LOG`, disabled tools are
  left out of `tools` and refused, and refusals are worded for the host.
- Every gateway call runs in its own call scope (AsyncLocalStorage), with or
  without a policy, so a call from inside another instance's call never
  inherits its policy, sink, redactor or caller.
- `callTool(name, input, { caller, requestId })`: the call context is
  written to every audit record of the call. Every string in an audit
  record, keys included, is redacted before it reaches the sink or the file;
  unknown tool names and the call context are redacted before they are cut
  short. Unsupported and invalid calls are audited as `rejected`.

## 0.2.0 (2026-11-16)

HTTP transport hardening, upstream client hardening and dependency updates.

- The HTTP transport refuses to start on a non-loopback bind address, or with
  `MCP_ALLOW_ANY_ORIGIN=true`, unless `MCP_HTTP_TOKEN` is set.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` overrides this explicitly.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- `PORT`, `MCP_MAX_BODY_BYTES`, `ORDRESTYRING_TIMEOUT_MS` and boolean flags are
  validated at startup; invalid values stop the server instead of silently
  disabling a limit.
- Failed authentication is throttled per client address (HTTP 429 with
  `Retry-After`); valid tokens are never throttled. New variables
  `MCP_AUTH_FAILURE_LIMIT` (default 20, `0` disables) and
  `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- `Host` header check on loopback binds; new variable `MCP_ALLOWED_HOSTS`.
- HTTP 401 carries `WWW-Authenticate: Bearer`; invalid JSON gets HTTP 400
  (JSON-RPC parse error) instead of 500; oversized bodies get 413 before
  being read.
- New unauthenticated `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- Requests to Ordrestyring use `redirect: 'manual'`: a redirect is reported as
  an error and the token and request body are never re-sent to another location.
- Error bodies are read up to 64 KB; upstream text in errors is redacted
  (including the configured token by value) before it is shortened, and error
  URLs no longer include the query string.
- The server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32, `zod` 4.6) and
  overrides for patched transitive packages.

Upgrade notes: deployments that bind to `0.0.0.0` must set `MCP_HTTP_TOKEN`
(32+ characters) or the server exits at startup. Check that numeric variables
hold plain integers.

## 0.1.0

- Initial Ordrestyring GraphQL MCP server.
- Added read-first tools for capability discovery, connection checks, schema
  introspection, case listing, case lookup, and guarded GraphQL reads.
- Added schema-aware v1 domain tools for case/customer search, case and customer
  overview, time, materials, case financials, schedule, documents, quality
  checks, invoice drafts, and read-only business reports.
- Added schema cache refresh tooling and documented rate-limit handling.
- Added dry-run mutation preparation and policy-gated commit flow.
- Added credential-safe client, audit logging, tests, stdio transport, and
  Streamable HTTP transport.
- Included Apache-2.0 licensing, `SECURITY.md`, CI, Dependabot, package publish
  allowlisting, and hardened HTTP defaults from the initial release.
