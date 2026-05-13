# Changelog

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
