export type CapabilityRisk = 'read' | 'dry-run' | 'write';

export interface OrdrestyringCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const DRY_RUN_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const ORDRESTYRING_CAPABILITIES: OrdrestyringCapability[] = [
  {
    id: 'ordrestyring_search_capabilities',
    title: 'Search Ordrestyring Capabilities',
    description: 'Find the Ordrestyring MCP tool to use for cases, GraphQL reads, schema discovery, or governed mutations.',
    risk: 'read',
    examples: [{ query: 'cases' }],
    identifierFormats: ['Tool id such as ordrestyring_list_cases.'],
    safetyNotes: ['Discovery only. Does not call Ordrestyring.'],
    keywords: ['discover', 'search tools', 'help', 'capabilities'],
  },
  {
    id: 'ordrestyring_check_connection',
    title: 'Check Ordrestyring Connection',
    description: 'Verify the configured Bearer token with a minimal GraphQL query.',
    risk: 'read',
    examples: [{}],
    identifierFormats: ['Uses ORDRESTYRING_API_TOKEN from the server environment.'],
    safetyNotes: ['Read-only. Does not expose the token.'],
    keywords: ['auth', 'connection', 'token', 'health'],
  },
  {
    id: 'ordrestyring_introspect_schema',
    title: 'Introspect Schema Overview',
    description: 'Fetch the top-level Query and Mutation field overview from Ordrestyring introspection.',
    risk: 'read',
    examples: [{ includeDeprecated: true }],
    identifierFormats: ['GraphQL schema field names.'],
    safetyNotes: ['Read-only. Requires a valid token because Ordrestyring protects introspection.'],
    keywords: ['schema', 'introspection', 'fields', 'query', 'mutation'],
  },
  {
    id: 'ordrestyring_search_schema',
    title: 'Search GraphQL Schema',
    description: 'Search authenticated Ordrestyring GraphQL types, query fields, mutation fields, and field arguments.',
    risk: 'read',
    examples: [{ query: 'customer cases', limit: 10 }],
    identifierFormats: ['GraphQL type name, field name, or argument name.'],
    safetyNotes: ['Read-only. Uses introspection metadata only.'],
    keywords: ['schema', 'search', 'field', 'type', 'argument'],
  },
  {
    id: 'ordrestyring_get_schema_type',
    title: 'Get GraphQL Schema Type',
    description: 'Inspect one GraphQL object, input, enum, or scalar type before composing long-tail queries.',
    risk: 'read',
    examples: [{ typeName: 'Case' }],
    identifierFormats: ['Exact GraphQL type name.'],
    safetyNotes: ['Read-only. Uses introspection metadata only.'],
    keywords: ['schema', 'type', 'introspection', 'input', 'enum'],
  },
  {
    id: 'ordrestyring_refresh_schema',
    title: 'Refresh GraphQL Schema Cache',
    description: 'Clear the per-process introspection cache and fetch a fresh Ordrestyring GraphQL schema.',
    risk: 'read',
    examples: [{}],
    identifierFormats: ['Uses configured Ordrestyring token.'],
    safetyNotes: ['Read-only. Useful after Ordrestyring changes schema while the MCP server is running.'],
    keywords: ['schema', 'refresh', 'cache', 'introspection'],
  },
  {
    id: 'ordrestyring_list_cases',
    title: 'List Cases',
    description: 'List Ordrestyring cases with documented cursor pagination and updatedAt ordering.',
    risk: 'read',
    examples: [{ limit: 10, cursor: null, orderByField: 'updatedAt', orderDirection: 'DESC' }],
    identifierFormats: ['Cursor from nextCursor / previousCursor.'],
    safetyNotes: ['Read-only. Returns id, caseNumber, nextCursor, and previousCursor.'],
    keywords: ['cases', 'orders', 'pagination', 'caseNumber'],
  },
  {
    id: 'ordrestyring_search_cases',
    title: 'Search Cases',
    description: 'Search or filter cases using schema-supported query arguments and cursor pagination.',
    risk: 'read',
    examples: [{ query: 'service', status: 'open', limit: 20 }],
    identifierFormats: ['Cursor from nextCursor / previousCursor, numeric customer id where supported.'],
    safetyNotes: ['Read-only. Only sends filters exposed by the live schema.'],
    keywords: ['cases', 'search', 'status', 'customer', 'updated'],
  },
  {
    id: 'ordrestyring_get_case',
    title: 'Get Case',
    description: 'Fetch a case by Ordrestyring case id using the documented caseById query.',
    risk: 'read',
    examples: [{ id: 123 }],
    identifierFormats: ['Numeric Ordrestyring case id.'],
    safetyNotes: ['Read-only. Default selection only includes id and caseNumber.'],
    keywords: ['case', 'caseById', 'order'],
  },
  {
    id: 'ordrestyring_get_case_overview',
    title: 'Get Case Overview',
    description: 'Fetch a case detail bundle with common scalar fields and related customer/user/address fields where the schema exposes them.',
    risk: 'read',
    examples: [{ id: 123 }],
    identifierFormats: ['Numeric Ordrestyring case id.'],
    safetyNotes: ['Read-only. Selection is built from live schema fields.'],
    keywords: ['case', 'overview', 'customer', 'status', 'address', 'financials'],
  },
  {
    id: 'ordrestyring_search_customers',
    title: 'Search Customers',
    description: 'Search or list customers before filtering cases or building reports.',
    risk: 'read',
    examples: [{ query: 'Acme', limit: 10 }],
    identifierFormats: ['Customer search text, cursor.'],
    safetyNotes: ['Read-only. Only sends filters exposed by the live schema.'],
    keywords: ['customer', 'customers', 'search', 'client'],
  },
  {
    id: 'ordrestyring_get_customer_overview',
    title: 'Get Customer Overview',
    description: 'Fetch customer master data and common scalar fields by id.',
    risk: 'read',
    examples: [{ id: 456 }],
    identifierFormats: ['Numeric Ordrestyring customer id.'],
    safetyNotes: ['Read-only. Selection is built from live schema fields.'],
    keywords: ['customer', 'overview', 'master data'],
  },
  {
    id: 'ordrestyring_list_case_time_entries',
    title: 'List Case Time Entries',
    description: 'List time registrations for a case, optional date range, and optional user or employee filters where supported.',
    risk: 'read',
    examples: [{ caseId: 123, dateFrom: '2026-01-01', dateTo: '2026-01-31' }],
    identifierFormats: ['Numeric case id, ISO date range.'],
    safetyNotes: ['Read-only. Only sends arguments exposed by the live schema.'],
    keywords: ['time', 'hours', 'timeregistrering', 'case', 'employee'],
  },
  {
    id: 'ordrestyring_summarize_time',
    title: 'Summarize Time',
    description: 'Aggregate numeric time-registration fields for a case/date range from read-only API results.',
    risk: 'read',
    examples: [{ caseId: 123, dateFrom: '2026-01-01', dateTo: '2026-01-31', limit: 500 }],
    identifierFormats: ['Numeric case id, ISO date range.'],
    safetyNotes: ['Read-only. Summary is computed locally from returned items.'],
    keywords: ['time', 'summary', 'hours', 'report', 'employee'],
  },
  {
    id: 'ordrestyring_list_case_materials',
    title: 'List Case Materials',
    description: 'List material registrations for a case and optional date range where supported.',
    risk: 'read',
    examples: [{ caseId: 123, dateFrom: '2026-01-01', dateTo: '2026-01-31' }],
    identifierFormats: ['Numeric case id, ISO date range.'],
    safetyNotes: ['Read-only. Only sends arguments exposed by the live schema.'],
    keywords: ['materials', 'materialer', 'case', 'quantity', 'cost'],
  },
  {
    id: 'ordrestyring_get_case_financials',
    title: 'Get Case Financials',
    description: 'Fetch case economy, totals, budget, invoice, or profitability fields where the schema exposes them.',
    risk: 'read',
    examples: [{ caseId: 123 }],
    identifierFormats: ['Numeric case id.'],
    safetyNotes: ['Read-only. Selection is built from live schema fields.'],
    keywords: ['financials', 'economy', 'profitability', 'invoice', 'budget', 'case'],
  },
  {
    id: 'ordrestyring_list_schedule',
    title: 'List Schedule',
    description: 'Read planning/calendar entries by date range and optional employee or case filters where supported.',
    risk: 'read',
    examples: [{ dateFrom: '2026-01-01', dateTo: '2026-01-07', employeeId: 12 }],
    identifierFormats: ['ISO date range, numeric employee id, numeric case id.'],
    safetyNotes: ['Read-only. Only sends arguments exposed by the live schema.'],
    keywords: ['schedule', 'calendar', 'planning', 'employee', 'planlægning'],
  },
  {
    id: 'ordrestyring_list_case_documents',
    title: 'List Case Documents',
    description: 'List document, photo, or attachment metadata for a case where supported.',
    risk: 'read',
    examples: [{ caseId: 123 }],
    identifierFormats: ['Numeric case id.'],
    safetyNotes: ['Read-only. Does not download or upload files.'],
    keywords: ['documents', 'photos', 'attachments', 'case', 'files'],
  },
  {
    id: 'ordrestyring_list_case_quality_checks',
    title: 'List Case Quality Checks',
    description: 'List quality assurance forms, checklists, or KS records for a case where supported.',
    risk: 'read',
    examples: [{ caseId: 123 }],
    identifierFormats: ['Numeric case id.'],
    safetyNotes: ['Read-only. Does not submit or approve checklists.'],
    keywords: ['quality', 'ks', 'checklist', 'forms', 'case'],
  },
  {
    id: 'ordrestyring_list_invoice_drafts',
    title: 'List Invoice Drafts',
    description: 'Read invoice drafts or invoice pipeline records by status, customer, or case where supported.',
    risk: 'read',
    examples: [{ status: 'draft', limit: 20 }],
    identifierFormats: ['Cursor, status, numeric customer id, numeric case id.'],
    safetyNotes: ['Read-only. Does not send, book, or export invoices.'],
    keywords: ['invoice', 'draft', 'billing', 'fakturering', 'pipeline'],
  },
  {
    id: 'ordrestyring_get_business_report',
    title: 'Get Business Report',
    description: 'Read-only report wrapper for hours, materials, case profitability, or invoice pipeline.',
    risk: 'read',
    examples: [{ report: 'hours', dateFrom: '2026-01-01', dateTo: '2026-01-31' }],
    identifierFormats: ['Report id: hours, materials, case_profitability, invoice_pipeline.'],
    safetyNotes: ['Read-only. Uses the same schema-aware read paths as the focused tools.'],
    keywords: ['report', 'business', 'hours', 'materials', 'profitability', 'invoice'],
  },
  {
    id: 'ordrestyring_graphql_read',
    title: 'Run GraphQL Read Query',
    description: 'Run a validated GraphQL query operation for long-tail read coverage.',
    risk: 'read',
    examples: [
      {
        query: 'query { cases(pagination: {cursor: null, limit: 10}, orderBy: {field: "updatedAt", direction: DESC}) { items { id caseNumber } nextCursor } }',
      },
    ],
    identifierFormats: ['GraphQL query operation. Mutation and subscription documents are rejected.'],
    safetyNotes: ['Read-only guard rejects mutation documents before any network call.'],
    keywords: ['graphql', 'query', 'read', 'long-tail'],
  },
  {
    id: 'ordrestyring_prepare_mutation',
    title: 'Prepare Mutation',
    description: 'Create a dry-run prepared mutation with an operation hash for human inspection.',
    risk: 'dry-run',
    examples: [
      {
        query: 'mutation($id: Int!, $input: UpdateUserInput!) { updateUser(id: $id, input: $input) { id } }',
        variables: { id: 1, input: { firstName: 'Henrik' } },
        reason: 'Update contact name after user approval.',
      },
    ],
    identifierFormats: ['GraphQL mutation operation plus variables.'],
    safetyNotes: ['Dry-run only. Does not call Ordrestyring. Upload mutations are rejected.'],
    keywords: ['prepare', 'mutation', 'dry-run', 'hash', 'write'],
  },
  {
    id: 'ordrestyring_commit_prepared_mutation',
    title: 'Commit Prepared Mutation',
    description: 'Commit a prepared mutation only when writes are enabled and policy allows the mutation names.',
    risk: 'write',
    examples: [{ confirmOperationHash: 'sha256...', idempotencyKey: 'case-123-user-approved' }],
    identifierFormats: ['Prepared mutation object returned by ordrestyring_prepare_mutation.'],
    safetyNotes: [
      'Writes are blocked unless ORDRESTYRING_ENABLE_WRITES=true.',
      'Optional ORDRESTYRING_POLICY_PATH can allowlist or deny mutation names.',
      'idempotencyKey is audited; Ordrestyring does not document an idempotency header.',
    ],
    keywords: ['commit', 'mutation', 'write', 'policy', 'audit'],
  },
];

export function searchCapabilities(query: string, limit = 20): OrdrestyringCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return ORDRESTYRING_CAPABILITIES.slice(0, limit);
  }

  return ORDRESTYRING_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: OrdrestyringCapability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    ...capability.identifierFormats,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
