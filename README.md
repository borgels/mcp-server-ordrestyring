# mcp-server-ordrestyring

TypeScript MCP server for Ordrestyring's GraphQL API. It is intentionally boring
good: typed, documented, read-first, policy-aware, credential-sane, and
audit-friendly.

> **Disclaimer:** This is an independent, unofficial project. It is not
> developed, endorsed or supported by Ordrestyring. "Ordrestyring" and the
> Ordrestyring GraphQL API are referenced only to describe what this server
> talks to. You need your own Ordrestyring API token, and use of the API is
> subject to Ordrestyring's own terms.

## Scope

The server exposes Ordrestyring through three layers:

- Curated MCP tools for connection checks, schema discovery, cases, customers,
  time, materials, planning, documents, quality checks, invoice drafts, and
  read-only reporting.
- A guarded GraphQL read tool for long-tail query coverage.
- A dry-run + commit flow for mutations, disabled by default and gated by policy.

Default install mode is read-only. Mutations require explicit environment opt-in,
a prepared operation hash, a reason, an idempotency key for the audit trail, and
optional policy-file approval.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Set Ordrestyring credentials in the MCP server environment. The server sends the
token as `Authorization: Bearer ...` and never accepts credentials as tool
arguments.

```sh
export ORDRESTYRING_API_TOKEN="your-api-token"
```

Optional hardening settings:

```sh
export ORDRESTYRING_TIMEOUT_MS=30000
export ORDRESTYRING_AUDIT_LOG="/absolute/path/to/ordrestyring-audit.jsonl"
```

## Claude Or Cursor Config

Use the stdio server for local MCP clients:

```json
{
  "mcpServers": {
    "ordrestyring": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ordrestyring/dist/stdio.js"],
      "env": {
        "ORDRESTYRING_API_TOKEN": "your-api-token",
        "ORDRESTYRING_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

During development:

```json
{
  "mcpServers": {
    "ordrestyring": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-ordrestyring"],
      "env": {
        "ORDRESTYRING_API_TOKEN": "your-api-token",
        "ORDRESTYRING_AUDIT_LOG": "/absolute/path/to/ordrestyring-audit.jsonl"
      }
    }
  }
}
```

## Start Here

Ask the MCP client to call:

- `ordrestyring_diagnostics` to verify credentials and live schema coverage.
- `ordrestyring_search_capabilities` to find tools and examples.
- `ordrestyring_get_capability` to inspect one tool before using it.
- `ordrestyring_check_connection` to verify credentials.
- `ordrestyring_search_schema` to find API fields before using a focused tool.

## Tools

All read tools are registered with MCP tool annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint`) so clients can reason
about safety. The domain tools are schema-aware: they use authenticated
introspection, send only arguments exposed by the live schema, and fail clearly
when the API does not expose a required workflow field.

### Discovery

- `ordrestyring_search_capabilities` — search this MCP server's capabilities.
- `ordrestyring_get_capability` — inspect one discovered capability.
- `ordrestyring_check_connection` — verify the configured API token.
- `ordrestyring_diagnostics` — check auth, schema counts, and workflow field
  availability.
- `ordrestyring_introspect_schema` — fetch top-level Query and Mutation fields.
- `ordrestyring_search_schema` — search GraphQL types, fields, and arguments.
- `ordrestyring_get_schema_type` — inspect one GraphQL type by exact name.
- `ordrestyring_refresh_schema` — clear and refetch the per-process schema cache.

```json
{
  "query": "case customer",
  "limit": 10
}
```

### Cases And Customers

- `ordrestyring_list_cases` — stable documented `cases` query selecting `id` and
  `caseNumber`.
- `ordrestyring_get_case` — stable documented `caseById` query selecting `id`
  and `caseNumber`.
- `ordrestyring_search_cases` — schema-aware case search/filter by query,
  status, customer, update range, cursor, and order when supported.
- `ordrestyring_get_case_overview` — schema-aware case details with common
  scalar fields and related customer/user fields where available.
- `ordrestyring_search_customers` — schema-aware customer list/search.
- `ordrestyring_get_customer_overview` — schema-aware customer detail by id.
- `ordrestyring_search_creditors` — schema-aware supplier/creditor
  list/search by name, number, or VAT number.
- `ordrestyring_get_creditor` — supplier/creditor detail by creditor number.
- `ordrestyring_search_products` — product/item list/search by number,
  description, and product type.
- `ordrestyring_get_product` — product/item detail by id.
- `ordrestyring_search_hour_types` — hour types with linked time products.

```json
{
  "query": "service",
  "customerId": 456,
  "statusId": 7,
  "limit": 20
}
```

### Operations

- `ordrestyring_list_case_time_entries` — time registrations by case, date range,
  user, or employee when supported.
- `ordrestyring_summarize_time` — local aggregate of numeric time fields from
  returned registrations.
- `ordrestyring_list_case_materials` — material registrations by case and date
  range when supported.
- `ordrestyring_get_case_financials` — case economy/profitability fields where
  exposed by the schema.
- `ordrestyring_list_schedule` — planning/calendar entries by date range,
  employee, or case when supported.
- `ordrestyring_list_case_documents` — document/photo/attachment metadata only.
- `ordrestyring_list_case_quality_checks` — KS/checklist/form status by case.
- `ordrestyring_list_invoice_drafts` — invoice draft/pipeline records only; no
  send, book, export, or accounting mutation.
- `ordrestyring_get_case_activity` — case activities and status history.
- `ordrestyring_find_billable_cases` — find cases that look ready for billing
  review.
- `ordrestyring_get_case_work_summary` — combined hours/materials summary for a
  case.
- `ordrestyring_get_case_health` — case overview, activity, work, documents,
  quality checks, and billing readiness in one response.
- `ordrestyring_find_stale_cases` — find cases not updated for a configurable
  number of days.
- `ordrestyring_get_invoice_readiness` — case overview, uninvoiced work,
  existing drafts, and financials for billing review.
- `ordrestyring_get_billing_pipeline` — sales invoice drafts and invoices for
  pipeline review.
- `ordrestyring_get_unbilled_work_report` — summarize uninvoiced hours and
  materials.
- `ordrestyring_get_operational_model` — show the recommended
  Ordrestyring/e-conomic ownership boundary and live mutation coverage.
- `ordrestyring_get_business_report` — report wrapper for `hours`, `materials`,
  `case_profitability`, and `invoice_pipeline`.

Example:

```json
{
  "caseId": 123,
  "dateFrom": "2026-01-01",
  "dateTo": "2026-01-31",
  "limit": 100
}
```

### Operational Writes

These tools create or convert operational records directly when writes are
enabled and policy allows the underlying mutation:

- `ordrestyring_create_customer`
- `ordrestyring_create_case`
- `ordrestyring_create_case_activity`
- `ordrestyring_create_offer`
- `ordrestyring_convert_offer_to_case`
- `ordrestyring_create_product`
- `ordrestyring_update_product`
- `ordrestyring_delete_products`
- `ordrestyring_create_hour_type`
- `ordrestyring_update_hour_type`
- `ordrestyring_create_case_material`
- `ordrestyring_create_sales_invoice_draft`
- `ordrestyring_create_creditor`

Example:

```json
{
  "input": {
    "customerId": 123,
    "description": "Udskiftning af pumpe"
  },
  "reason": "Customer requested an offer.",
  "idempotencyKey": "offer-123-pump-2026-05-25"
}
```

### Long-Tail Reads

`ordrestyring_graphql_read` runs a validated GraphQL query operation for
long-tail read coverage.

```json
{
  "query": "query($cursor: String) { cases(pagination: {cursor: $cursor, limit: 10}, orderBy: {field: \"updatedAt\", direction: DESC}) { items { id caseNumber } nextCursor previousCursor } }",
  "variables": {
    "cursor": null
  }
}
```

Mutation and subscription documents are rejected before any network call.

## Write Policy

Mutations are blocked unless explicitly enabled:

```sh
export ORDRESTYRING_ENABLE_WRITES=true
export ORDRESTYRING_POLICY_PATH="/absolute/path/to/ordrestyring-policy.json"
export ORDRESTYRING_AUDIT_LOG="/absolute/path/to/ordrestyring-audit.jsonl"
```

Example policy:

```json
{
  "writesEnabled": true,
  "allowedMutations": ["updateUser"],
  "deniedMutationPatterns": ["^delete", "upload"],
  "maxVariableBytes": 20000
}
```

Write flow:

1. Prefer a focused direct tool such as `ordrestyring_create_offer` or
   `ordrestyring_create_case`.
2. For advanced/debug flows, call `ordrestyring_prepare_mutation` or
   `ordrestyring_prepare_operational_mutation`, inspect the returned
   `operationHash`, then call `ordrestyring_commit_prepared_mutation`.
   The `operationHash` is an HMAC-SHA256 keyed with `ORDRESTYRING_PREPARE_SECRET`
   (a random per-process key when unset), so a prepared mutation cannot be
   forged or altered by the caller. Preparations expire after 15 minutes. Set a
   shared secret if several instances (or restarts) must accept each other's
   preparations.
3. Keep `allowedMutations` narrow in the policy file, for example
   `["createOffer", "createCase"]` while testing.

`idempotencyKey` is stored only as a hash in the audit log. Ordrestyring's public
GraphQL docs do not document an idempotency header, so this server does not send
one upstream.

### Ordrestyring And e-conomic

The recommended ownership boundary is: Ordrestyring owns daily operations
(offers, cases/orders, planning, time/materials, documentation, KS, and invoice
draft readiness), while e-conomic stays the financial ledger for accounts, VAT,
booked invoices, payments, reconciliation, and accounting reports. Ordrestyring
publishes an e-conomic integration, so prefer the product integration for routine
sync and use MCP tools for governed inspection, preparation, and exception
handling.

## Security And Audit

If `ORDRESTYRING_AUDIT_LOG` is set, every tool attempt writes a JSONL record with
timestamp, request id, tool, target hash, policy decision, operation hash,
idempotency-key hash, status, and redacted errors. Tokens are never logged
intentionally.

Credentials are read only from the MCP server environment and are never accepted
as tool arguments. Requests to Ordrestyring never follow redirects, so the token
is not re-sent to another location. Errors carry no text from Ordrestyring: an
HTTP error gives the status, our hint and the parsed Retry-After and rate-limit
numbers (the body is discarded unread), a GraphQL error gives the number of
errors, a redirect error does not quote the `Location`, a network error names
only a system error code, an error while reading a response is a fixed text,
schema problems do not name the schema's types or fields, and configuration
errors do not quote the rejected value. What is and is not guaranteed is in
the threat model below. Report suspected vulnerabilities privately to
<security@borgels.com>. Do not include API tokens, customer data, or other
secrets in public GitHub issues.

## Optional HTTP Server

The local stdio transport is the default. A small Streamable HTTP entrypoint is
available:

```sh
PORT=3000 ORDRESTYRING_API_TOKEN="your-api-token" npm run dev:http
```

By default the HTTP server binds to `127.0.0.1`, limits request bodies to 10 MiB,
and allows browser CORS only from loopback origins. Without `MCP_HTTP_TOKEN` it
refuses to start on a non-loopback address. The token is compared in constant
time.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` (or `HOST`) | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | unset | Bearer token required on `/mcp`; at least 32 printable ASCII characters. Required when binding to a non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Start without a token on a non-loopback bind anyway (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin` (requires a token). |
| `MCP_ALLOWED_HOSTS` | see meaning | Comma-separated host names accepted in the `Host` header. By default a loopback bind only accepts localhost names and its bind address; other binds do not check `Host`. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body size. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get HTTP 429; `0` disables. Requests with a valid token are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

Invalid numeric or boolean values stop the server at startup with a message
naming the variable. `GET /healthz` answers `{"status":"ok"}` without
authentication, for container health checks.

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`.

## Gateway Export

`mcp-server-ordrestyring/gateway` exposes a small typed adapter for host
applications that need to wrap this server without copying connector logic,
in the same shape as `mcp-server-template`. One process can run several
gateway instances, for example one per tenant.

The gateway exports:

- `ordrestyringGatewayTools`: stable unprefixed tool definitions with name,
  title, description, risk level, default enablement, and JSON input schema
  (derived from the zod schemas the calls are validated with).
- `ordrestyringToolCatalog`: the same tools as a deeply frozen catalog, with
  the GraphQL requests each tool may make (`upstream`: `query` or `mutation`
  on `POST /graphql`) and the `broad` mark. No gateway tool is broad: the free
  GraphQL read and the schema tools are not in the gateway.
- `createOrdrestyringGateway({ apiToken, baseUrl?, timeoutMs?, fetchImpl?, policy? })`:
  `apiToken` is required (printable ASCII, at least 16 characters; see "Key admission") and is never read from
  `ORDRESTYRING_API_TOKEN`; `baseUrl` defaults to
  `https://graphql.ordrestyring.dk` and is never read from
  `ORDRESTYRING_BASE_URL`.
- `callTool(name, input, { caller, requestId })`: input is validated before
  anything is sent, and unknown fields are refused. `caller` and `requestId`
  go into the audit records of the call.

With `policy: { enableWrites, disabledTools, audit }` the host decides the
instance's policy: the instance then reads none of
`ORDRESTYRING_ENABLE_WRITES`, `ORDRESTYRING_POLICY_PATH` or
`ORDRESTYRING_AUDIT_LOG`, leaves the disabled tools out of `tools`, and sends
its audit records to `audit` (none without it). A sink that throws refuses
the call. Every call runs in a call scope of its own, so a call made from
inside another instance's call never inherits that instance's policy, sink or
redactor. There is no process-wide registry of tokens.

Each instance redacts its own token, best-effort, from every result it
returns (text and structured data, object keys included, numbers and
booleans by their string form), from every audit record, and from errors
about its options: the exact value, its URL- and JSON-encoded forms, and any
piece of it of 6 characters or more. Structured data is redacted before it
is serialised and the handler's text is rebuilt from it, so the text stays
valid JSON; responses are depth-limited when they are parsed.
`test/gateway-leaks.test.ts` and `test/gateway-threat.test.ts` prove this
through every channel. See the threat model for the residual risk.

Under a host policy with `timeoutMs` given, an instance reads nothing from
the environment: prepared-mutation hashes use a random key of the instance
(not `ORDRESTYRING_PREPARE_SECRET`). Without `timeoutMs` the timeout is read
from `ORDRESTYRING_TIMEOUT_MS`; it is a limit, not a credential or policy.

First-wedge gateway tools:

- `check_connection`
- `search_cases`
- `get_case_health`
- `find_billable_cases`
- `get_invoice_readiness`
- `create_customer` (disabled by default)
- `delete_products` (disabled by default, destructive)

The gateway reads credentials only from the factory options, never from the
environment or from tool arguments. Without a host policy, write tools remain
disabled unless `ORDRESTYRING_ENABLE_WRITES=true` and the write policy allows
the underlying mutation; under a host policy, unless `enableWrites` is true.
The gateway keeps the same safety model as the full MCP server.

## Threat model

What this server guarantees about the API token, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one token, keeps best-effort
redaction: its errors and audit records are redacted with its token, but it
is not held to these guarantees.

**Guaranteed:**

- **(a) The token never reaches anything persisted or shared:** audit sinks
  and the audit log file, logs, error texts, export hooks or files. Errors
  are our own texts; audit records and everything a gateway instance returns
  are redacted with the instance's own token before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After, rate limits)
  and the number of GraphQL errors; never a response body, a GraphQL error
  message or path, a redirect's `Location`, a type, field or argument name
  from the schema, or the message of an error thrown while reading a
  response. A failed section of a combined read is the status or a fixed
  text as well. Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose token it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one token.

**Not guaranteed (residual risk):** Ordrestyring deliberately echoing the
customer's own token back in data. Gateway results are redacted on a
best-effort basis: the exact token, its URL- and JSON-encoded forms and any
piece of it of 6 characters or more, in strings, object keys and the string
form of numbers and booleans, are replaced by `"‹redacted›"` before anything
is serialised, so the text stays valid JSON. A token that comes back
otherwise transformed (split into pieces shorter than 6 characters,
reversed, re-encoded, hashed) is not recognised. Such data reaches only the
tenant whose token it is, which already holds it. **What leaves a gateway holds no piece of the token.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the token (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included) and audit records and lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a token that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every token is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the token. As a cheap first filter it also
refuses a token that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the token. The
standalone MCP server applies the same redaction to errors and audit records
on a best-effort basis; its successful results are passed on as Ordrestyring
returned them.

## Security model

- The server uses one shared Ordrestyring API token for every caller. Anyone
  who can call its tools acts with that token's access.
- `MCP_HTTP_TOKEN` is a single shared secret that authenticates callers of
  the HTTP endpoint; it does not identify individual users. Per-user
  authentication and authorization belong in an identity-aware gateway or
  proxy in front of this server.
- Access to a tool is access to the data that tool can reach with the shared
  token; the write policy limits which operations run, not which records a
  caller may see.
- The HTTP server does not terminate TLS. Run it on loopback or a private
  network, behind a TLS-terminating proxy when traffic leaves the host.

## Rate Limits

Ordrestyring documents GraphQL rate limiting with `Retry-After`,
`X-RateLimit-Limit`, and `X-RateLimit-Remaining` headers. HTTP failures include
those values in formatted errors when Ordrestyring returns them. GraphQL
responses with an `errors` array are treated as tool errors even when HTTP status
is 2xx, matching Ordrestyring's documented error model.

## Schema Cache

Schema-aware tools cache authenticated introspection for the lifetime of the
server process. Use `ordrestyring_refresh_schema` after Ordrestyring changes the
schema or after enabling new API access on a token. Restarting the MCP server
also clears the cache.

## Verification

Run checks without real credentials:

```sh
npm run typecheck
npm test
npm run build
```

Run the optional live smoke test only when you have a valid Ordrestyring API
token:

```sh
ORDRESTYRING_API_TOKEN="your-api-token" npm run smoke:live
```

After `npm run build`, run the MCP stdio smoke test to verify the packaged
server registers tools and can call Ordrestyring through MCP:

```sh
ORDRESTYRING_API_TOKEN="your-api-token" npm run smoke:mcp
```

## API Sources

- GraphQL docs: <https://graphql.ordrestyring.dk/docs>
- GraphiQL UI: <https://graphql.ordrestyring.dk/graphiql>
- Ordrestyring e-conomic integration: <https://ordrestyring.dk/integrationspartnere/e-conomic/>
- e-conomic app listing for Ordrestyring: <https://www.e-conomic.dk/apps-og-udvidelser/ordrestyringdk>
- Legacy REST API notice: <https://api.ordrestyring.dk/>

## License

Apache-2.0. See [LICENSE](LICENSE).
