# Changelog

## 0.3.1 (2026-11-18)

- Gateway results: a result built from a handler answer that is not an MCP
  result (the summary path, `Ordrestyring gateway result.`) now has its
  `structuredContent` as compact JSON in the text block after the summary
  (`summary\n\n{...}`), as the MCP specification recommends for tools that
  return structured content. Before, that text held only the summary, so a
  client that reads only the text got no data. The JSON is the redacted
  data, exactly `structuredContent`, and the sink check covers it.
- Unchanged: the usual path, where the handler answers with JSON text,
  already returned the redacted data as JSON text equal to
  `structuredContent`. Error results are unchanged.

## 0.3.0 (2026-11-17)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
so one process can serve several tenants. The MCP server (stdio and HTTP)
still reads its configuration from the environment; its errors change as
described below (no Ordrestyring text). The README has a threat model: what
is guaranteed about the token and the residual risk.

- Errors leave in final form: every error a gateway throws is a fresh
  error with no `cause`, a `stack` of just `name: message` (no frames,
  paths or function names), and name, message and stack masked against the
  secret; the sink check runs on the finished object, its non-enumerable
  fields included.
- Every element of a failure list (`failures`, `failure`, `errors`,
  `error`, `warnings`), at any depth and whatever its fields, becomes
  `{ status?, message }` with our own text; a failure context such as
  `metadata` or `amount` holds through wrappers such as `data`.
- Network, timeout and redirect errors name the method only, not the
  configured address.
- The sink check: every output of a gateway (the tool list, results, audit records and lines, construction errors) is checked in its
  final form, and one that holds a piece of 6 characters of the token is
  replaced by a fixed fallback (`src/fallbacks.ts`): a withheld result, a
  fixed audit record or line, or the fixed refusal. A token that shares a
  piece with a fallback or with the tool list is refused at creation.
- Key admission: printable ASCII (0x21-0x7E) of at least 16 characters,
  checked before anything is built from the token; the corpus of our own
  string literals stays as a cheap first filter.
- A text in a failure list of a successful answer (`failures`, `errors`,
  `warnings` and the like) is replaced by our own text, like a failure
  object.
- `createOrdrestyringGateway` requires `apiToken` and never reads
  `ORDRESTYRING_API_TOKEN` or `ORDRESTYRING_BASE_URL`; the base URL defaults
  to `https://graphql.ordrestyring.dk`. A token shorter than 16 characters,
  or one that shares a piece of 6 characters with any of this server's own
  texts (`src/fixed-corpus.generated.ts`), is refused with a fixed text that
  never repeats it. Breaking for hosts that relied on the environment
  fallback.
- Every string leaving the gateway passes the instance's redactor as the
  last step: results, construction errors and whole stderr lines.
- A failure reported inside the data of a successful call (a `status` of
  400 or more, an `error` field, or a message in `errors`, `metadata` and
  the like) keeps only its status and our own text.
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
- No Ordrestyring text in errors (also for the MCP server): an HTTP error
  gives the status, our hint and the parsed Retry-After and rate-limit numbers
  (the body is discarded unread, `payload` is gone); a GraphQL error gives the
  number of errors (`errors` and `data` are gone, `count` is new); a redirect
  error does not quote the `Location`; a network error names only a system
  error code; configuration errors do not quote the rejected value. Failed
  sections of a combined read (`get_case_health` and the like) use the same
  texts.
- The threat model's guarantees apply to the gateway (`./gateway`); the
  standalone MCP server keeps best-effort redaction. Audit records are
  redacted with the shared `redactDeep` (numbers and depth included); the
  separate audit implementation is gone.
- The redaction marker is `‹redacted›` (non-ASCII brackets). A gateway
  refuses a token that contains it or shares a 6-character piece with it.
  A successful result's JSON text is built from the redacted data and not
  redacted again as text, so it stays valid JSON.
- A network error names a system error code only from a fixed list.
- No Ordrestyring text in other errors either (also for the MCP server): an
  error while reading a response is a fixed text, and schema problems no
  longer name the schema's types, fields or arguments.
- Every result a gateway instance returns is redacted, best-effort, with its
  token after parsing and before serialising: the handler's text is rebuilt
  from the redacted data, keys included, and numbers and booleans whose
  string form matches become the string `"‹redacted›"`, so the text stays
  valid JSON. Responses are depth-limited when they are parsed. The redactor removes the exact token, its
  URL- and JSON-encoded forms and any piece of it of 6 characters or more.
  A policy that is an array is refused.
- A gateway instance hashes prepared mutations with its own random key and
  never reads `ORDRESTYRING_PREPARE_SECRET`.
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
