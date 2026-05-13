import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../ordrestyring/audit.js';
import {
  DRY_RUN_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  searchCapabilities,
  WRITE_TOOL_ANNOTATIONS,
} from '../ordrestyring/capabilities.js';
import type { OrdrestyringClient } from '../ordrestyring/client.js';
import {
  readDomainCollection,
  readDomainEntity,
  summarizeDomainCollection,
  type CollectionReadInput,
} from '../ordrestyring/domain.js';
import {
  assertPreparedMutationHash,
  assertReadQuery,
  prepareMutation,
} from '../ordrestyring/graphql.js';
import { checkMutationPolicy, checkToolPolicy } from '../ordrestyring/policy.js';
import {
  getSchemaCatalog,
  getSchemaType,
  refreshSchemaCatalog,
  searchSchema,
} from '../ordrestyring/schema.js';

const variablesSchema = z.record(z.string(), z.unknown()).default({});
const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use ISO 8601 date format YYYY-MM-DD.');
const paginationInputShape = {
  cursor: z.string().trim().min(1).nullable().default(null),
  limit: z.number().int().min(1).max(500).default(20),
};
const dateRangeInputShape = {
  dateFrom: isoDateSchema.optional(),
  dateTo: isoDateSchema.optional(),
};

const preparedMutationSchema = z.object({
  type: z.literal('ordrestyring_prepared_mutation'),
  createdAt: z.string().trim().min(1),
  query: z.string().trim().min(1),
  variables: variablesSchema,
  operationName: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
  mutationNames: z.array(z.string().trim().min(1)),
  operationHash: z.string().trim().min(1),
});

const casePreferredScalars = [
  'id',
  'caseNumber',
  'title',
  'name',
  'description',
  'status',
  'createdAt',
  'updatedAt',
  'startDate',
  'endDate',
  'address',
  'postalCode',
  'city',
  'customerId',
  'total',
  'amount',
  'budget',
  'cost',
  'profit',
];
const customerPreferredScalars = [
  'id',
  'customerNumber',
  'name',
  'companyName',
  'email',
  'phone',
  'telephone',
  'address',
  'postalCode',
  'city',
  'createdAt',
  'updatedAt',
];
const timePreferredScalars = [
  'id',
  'caseId',
  'userId',
  'employeeId',
  'date',
  'description',
  'hours',
  'minutes',
  'duration',
  'quantity',
  'billable',
  'createdAt',
  'updatedAt',
];
const materialPreferredScalars = [
  'id',
  'caseId',
  'date',
  'name',
  'description',
  'quantity',
  'unit',
  'unitPrice',
  'price',
  'cost',
  'total',
  'createdAt',
  'updatedAt',
];
const schedulePreferredScalars = [
  'id',
  'caseId',
  'userId',
  'employeeId',
  'date',
  'start',
  'startAt',
  'end',
  'endAt',
  'title',
  'description',
  'status',
];
const documentPreferredScalars = [
  'id',
  'caseId',
  'name',
  'fileName',
  'title',
  'description',
  'mimeType',
  'size',
  'url',
  'createdAt',
  'updatedAt',
];
const qualityPreferredScalars = [
  'id',
  'caseId',
  'name',
  'title',
  'status',
  'completed',
  'completedAt',
  'approved',
  'approvedAt',
  'createdAt',
  'updatedAt',
];
const invoicePreferredScalars = [
  'id',
  'caseId',
  'customerId',
  'invoiceNumber',
  'draftNumber',
  'status',
  'date',
  'dueDate',
  'amount',
  'total',
  'vat',
  'currency',
  'createdAt',
  'updatedAt',
];

const caseNestedPreferred = {
  customer: customerPreferredScalars,
  user: ['id', 'name', 'email'],
  employee: ['id', 'name', 'email'],
  responsible: ['id', 'name', 'email'],
};
const customerNestedPreferred = {
  address: ['id', 'address', 'postalCode', 'city'],
};

export function registerOrdrestyringTools(server: McpServer, client: OrdrestyringClient): void {
  server.registerTool(
    'ordrestyring_search_capabilities',
    {
      title: 'Search Ordrestyring Capabilities',
      description:
        'Search the Ordrestyring MCP server capabilities and examples. Use this first when deciding which Ordrestyring tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'ordrestyring_check_connection',
    {
      title: 'Check Ordrestyring Connection',
      description:
        'Verify ORDRESTYRING_API_TOKEN with a minimal GraphQL query. Returns ok=true when Ordrestyring accepts the token.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_check_connection', input, async () => {
        const data = await client.graphql<{ __typename: string }>({
          query: 'query OrdrestyringMcpCheckConnection { __typename }',
        });
        return jsonToolResult({ ok: true, typename: data.__typename });
      }),
  );

  server.registerTool(
    'ordrestyring_introspect_schema',
    {
      title: 'Introspect Ordrestyring Schema',
      description:
        'Fetch top-level Query and Mutation field metadata from Ordrestyring introspection. Use this before composing long-tail GraphQL reads.',
      inputSchema: {
        includeDeprecated: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_introspect_schema', input, async () =>
        jsonToolResult(
          await client.graphql({
            query: schemaOverviewQuery(),
            variables: { includeDeprecated: input.includeDeprecated },
          }),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_search_schema',
    {
      title: 'Search Ordrestyring GraphQL Schema',
      description:
        'Search authenticated Ordrestyring GraphQL schema metadata: types, query fields, mutation fields, and arguments.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_schema', input, async () => {
        const catalog = await getSchemaCatalog(client);
        return jsonToolResult(searchSchema(catalog, input.query, input.limit));
      }),
  );

  server.registerTool(
    'ordrestyring_get_schema_type',
    {
      title: 'Get Ordrestyring GraphQL Schema Type',
      description:
        'Inspect one GraphQL object, input, enum, or scalar type by exact name before composing long-tail reads.',
      inputSchema: {
        typeName: z.string().trim().min(1),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_schema_type', input, async () => {
        const catalog = await getSchemaCatalog(client);
        return jsonToolResult(getSchemaType(catalog, input.typeName));
      }),
  );

  server.registerTool(
    'ordrestyring_refresh_schema',
    {
      title: 'Refresh Ordrestyring GraphQL Schema Cache',
      description:
        'Clear the per-process introspection cache and fetch a fresh Ordrestyring GraphQL schema.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_refresh_schema', input, async () => {
        const catalog = await refreshSchemaCatalog(client);
        return jsonToolResult({
          ok: true,
          queryTypeName: catalog.queryTypeName,
          mutationTypeName: catalog.mutationTypeName,
          typeCount: catalog.types.length,
          queryFieldCount: catalog.queryFields.length,
          mutationFieldCount: catalog.mutationFields.length,
        });
      }),
  );

  server.registerTool(
    'ordrestyring_list_cases',
    {
      title: 'List Ordrestyring Cases',
      description:
        'List Ordrestyring cases with the documented cursor pagination shape. Returns id, caseNumber, nextCursor, and previousCursor.',
      inputSchema: {
        cursor: z.string().trim().min(1).nullable().default(null),
        limit: z.number().int().min(1).max(100).default(10),
        orderByField: z.literal('updatedAt').default('updatedAt'),
        orderDirection: z.enum(['ASC', 'DESC']).default('DESC'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_cases', input, async () =>
        jsonToolResult(
          await client.graphql({
            query: `
              query OrdrestyringMcpListCases($cursor: String, $limit: Int!) {
                cases(
                  pagination: {cursor: $cursor, limit: $limit},
                  orderBy: {field: "updatedAt", direction: ${input.orderDirection}}
                ) {
                  items {
                    id
                    caseNumber
                  }
                  nextCursor
                  previousCursor
                }
              }
            `,
            variables: { cursor: input.cursor, limit: input.limit },
          }),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_get_case',
    {
      title: 'Get Ordrestyring Case',
      description:
        'Fetch a case by Ordrestyring case id using the documented caseById query. Use ordrestyring_graphql_read for custom field selections.',
      inputSchema: {
        id: z.number().int().positive(),
        fields: z.array(z.enum(['id', 'caseNumber'])).min(1).default(['id', 'caseNumber']),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => {
      const fields = [...new Set(input.fields)].join('\n');
      return runAuditedTool('ordrestyring_get_case', input, async () =>
        jsonToolResult(
          await client.graphql({
            query: `
              query OrdrestyringMcpGetCase($id: Int!) {
                caseById(id: $id) {
                  ${fields}
                }
              }
            `,
            variables: { id: input.id },
          }),
        ),
      );
    },
  );

  server.registerTool(
    'ordrestyring_search_cases',
    {
      title: 'Search Ordrestyring Cases',
      description:
        'Search or filter cases using schema-supported arguments. Only arguments exposed by the live schema are sent.',
      inputSchema: {
        ...paginationInputShape,
        query: z.string().trim().min(1).optional(),
        status: z.string().trim().min(1).optional(),
        customerId: z.number().int().positive().optional(),
        updatedFrom: isoDateSchema.optional(),
        updatedTo: isoDateSchema.optional(),
        orderByField: z.string().trim().min(1).default('updatedAt'),
        orderDirection: z.enum(['ASC', 'DESC']).default('DESC'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_cases', input, async () =>
        jsonToolResult(
          await readDomainCollection(
            client,
            {
              operationName: 'OrdrestyringMcpSearchCases',
              rootCandidates: ['cases', 'searchCases', 'caseSearch'],
              preferredScalars: casePreferredScalars,
              nestedPreferred: caseNestedPreferred,
              defaultOrderByField: 'updatedAt',
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_get_case_overview',
    {
      title: 'Get Ordrestyring Case Overview',
      description:
        'Fetch a case detail bundle using the best matching schema field. Selection includes common case scalar fields and related customer/user fields where available.',
      inputSchema: {
        id: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_case_overview', input, async () =>
        jsonToolResult(
          await readDomainEntity(
            client,
            {
              operationName: 'OrdrestyringMcpGetCaseOverview',
              rootCandidates: ['caseById', 'case', 'getCase'],
              idArgCandidates: ['id', 'caseId'],
              preferredScalars: casePreferredScalars,
              nestedPreferred: caseNestedPreferred,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_search_customers',
    {
      title: 'Search Ordrestyring Customers',
      description:
        'Search or list customers using schema-supported query arguments. Use this before case filtering or customer reports.',
      inputSchema: {
        ...paginationInputShape,
        query: z.string().trim().min(1).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_customers', input, async () =>
        jsonToolResult(
          await readDomainCollection(
            client,
            {
              operationName: 'OrdrestyringMcpSearchCustomers',
              rootCandidates: ['customers', 'searchCustomers', 'customerSearch'],
              preferredScalars: customerPreferredScalars,
              nestedPreferred: customerNestedPreferred,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_get_customer_overview',
    {
      title: 'Get Ordrestyring Customer Overview',
      description: 'Fetch customer master data by id using the best matching schema field.',
      inputSchema: {
        id: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_customer_overview', input, async () =>
        jsonToolResult(
          await readDomainEntity(
            client,
            {
              operationName: 'OrdrestyringMcpGetCustomerOverview',
              rootCandidates: ['customerById', 'customer', 'getCustomer'],
              idArgCandidates: ['id', 'customerId'],
              preferredScalars: customerPreferredScalars,
              nestedPreferred: customerNestedPreferred,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_list_case_time_entries',
    {
      title: 'List Ordrestyring Case Time Entries',
      description:
        'List time registrations for a case, optional date range, and optional user/employee filters where supported.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive(),
        userId: z.number().int().positive().optional(),
        employeeId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_case_time_entries', input, async () =>
        jsonToolResult(await readTimeEntries(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_summarize_time',
    {
      title: 'Summarize Ordrestyring Time',
      description:
        'Aggregate numeric time-registration fields for a case/date range from read-only API results.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive().optional(),
        userId: z.number().int().positive().optional(),
        employeeId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_summarize_time', input, async () =>
        jsonToolResult(await summarizeTimeEntries(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_list_case_materials',
    {
      title: 'List Ordrestyring Case Materials',
      description:
        'List material registrations for a case and optional date range where supported.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_case_materials', input, async () =>
        jsonToolResult(await readMaterials(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_case_financials',
    {
      title: 'Get Ordrestyring Case Financials',
      description:
        'Fetch case economy, totals, budget, invoice, or profitability fields where the schema exposes them.',
      inputSchema: {
        caseId: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_case_financials', input, async () =>
        jsonToolResult(
          await readDomainEntity(
            client,
            {
              operationName: 'OrdrestyringMcpGetCaseFinancials',
              rootCandidates: ['caseFinancials', 'caseEconomyByCaseId', 'caseEconomy', 'caseById'],
              idArgCandidates: ['caseId', 'id'],
              preferredScalars: [
                'id',
                'caseId',
                'caseNumber',
                'budget',
                'cost',
                'price',
                'amount',
                'total',
                'vat',
                'profit',
                'profitMargin',
                'invoiceTotal',
                'materialTotal',
                'timeTotal',
              ],
            },
            { id: input.caseId },
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_list_schedule',
    {
      title: 'List Ordrestyring Schedule',
      description:
        'Read planning/calendar entries by date range and optional employee or case filters where supported.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        employeeId: z.number().int().positive().optional(),
        caseId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_schedule', input, async () =>
        jsonToolResult(
          await readDomainCollection(
            client,
            {
              operationName: 'OrdrestyringMcpListSchedule',
              rootCandidates: ['schedule', 'calendar', 'planning', 'appointments', 'events'],
              preferredScalars: schedulePreferredScalars,
              nestedPreferred: caseNestedPreferred,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_list_case_documents',
    {
      title: 'List Ordrestyring Case Documents',
      description:
        'List document, photo, or attachment metadata for a case where supported. This does not download or upload files.',
      inputSchema: {
        ...paginationInputShape,
        caseId: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_case_documents', input, async () =>
        jsonToolResult(
          await readDomainCollection(
            client,
            {
              operationName: 'OrdrestyringMcpListCaseDocuments',
              rootCandidates: [
                'caseDocuments',
                'documents',
                'caseAttachments',
                'attachments',
                'casePhotos',
                'photos',
              ],
              preferredScalars: documentPreferredScalars,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_list_case_quality_checks',
    {
      title: 'List Ordrestyring Case Quality Checks',
      description:
        'List quality assurance forms, checklists, or KS records for a case where supported.',
      inputSchema: {
        ...paginationInputShape,
        caseId: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_case_quality_checks', input, async () =>
        jsonToolResult(
          await readDomainCollection(
            client,
            {
              operationName: 'OrdrestyringMcpListCaseQualityChecks',
              rootCandidates: [
                'caseQualityChecks',
                'qualityChecks',
                'qualityAssurance',
                'checklists',
                'forms',
                'caseForms',
              ],
              preferredScalars: qualityPreferredScalars,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_list_invoice_drafts',
    {
      title: 'List Ordrestyring Invoice Drafts',
      description:
        'Read invoice drafts or invoice pipeline records by status, customer, or case where supported. Does not send, book, or export invoices.',
      inputSchema: {
        ...paginationInputShape,
        status: z.string().trim().min(1).optional(),
        caseId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_list_invoice_drafts', input, async () =>
        jsonToolResult(await readInvoiceDrafts(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_business_report',
    {
      title: 'Get Ordrestyring Business Report',
      description:
        'Read-only report wrapper for hours, materials, case profitability, or invoice pipeline.',
      inputSchema: {
        report: z.enum(['hours', 'materials', 'case_profitability', 'invoice_pipeline']),
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        employeeId: z.number().int().positive().optional(),
        status: z.string().trim().min(1).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_business_report', input, async () =>
        jsonToolResult(await readBusinessReport(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_graphql_read',
    {
      title: 'Run Ordrestyring GraphQL Read Query',
      description:
        'Run a validated GraphQL query operation for long-tail read coverage. Mutation and subscription documents are rejected before network calls.',
      inputSchema: {
        query: z.string().trim().min(1),
        variables: variablesSchema,
        operationName: z.string().trim().min(1).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_graphql_read', input, async () => {
        assertReadQuery(input.query);
        return jsonToolResult(
          await client.graphql({
            query: input.query,
            variables: input.variables,
            operationName: input.operationName,
          }),
        );
      }),
  );

  server.registerTool(
    'ordrestyring_prepare_mutation',
    {
      title: 'Prepare Ordrestyring Mutation',
      description:
        'Prepare a GraphQL mutation for inspection. This is a dry-run tool: it never calls Ordrestyring and returns an operationHash for commit confirmation.',
      inputSchema: {
        query: z.string().trim().min(1),
        variables: variablesSchema,
        operationName: z.string().trim().min(1).optional(),
        reason: z.string().trim().min(3),
      },
      annotations: DRY_RUN_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_prepare_mutation', input, async () =>
        jsonToolResult(
          prepareMutation({
            query: input.query,
            variables: input.variables,
            operationName: input.operationName,
            reason: input.reason,
          }),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_commit_prepared_mutation',
    {
      title: 'Commit Prepared Ordrestyring Mutation',
      description:
        'Commit a prepared mutation only after hash confirmation and write-policy approval. Requires ORDRESTYRING_ENABLE_WRITES=true.',
      inputSchema: {
        preparedMutation: preparedMutationSchema,
        confirmOperationHash: z.string().trim().min(1),
        idempotencyKey: z
          .string()
          .trim()
          .min(8)
          .describe('Audited caller-provided key. Ordrestyring does not document an idempotency header.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(
        'ordrestyring_commit_prepared_mutation',
        {
          operationHash: input.preparedMutation.operationHash,
          mutationNames: input.preparedMutation.mutationNames,
        },
        async () => {
          assertPreparedMutationHash(input.preparedMutation, input.confirmOperationHash);
          const mutationPolicy = await checkMutationPolicy(input.preparedMutation);
          if (!mutationPolicy.allowed) {
            await writeAuditEvent({
              tool: 'ordrestyring_commit_prepared_mutation',
              action: 'policy_denied',
              operationHash: input.preparedMutation.operationHash,
              idempotencyKey: input.idempotencyKey,
              reason: mutationPolicy.reason,
            });
            throw new Error(mutationPolicy.reason);
          }

          const result = await client.graphql({
            query: input.preparedMutation.query,
            variables: input.preparedMutation.variables,
            operationName: input.preparedMutation.operationName,
          });

          return jsonToolResult({
            operationHash: input.preparedMutation.operationHash,
            mutationNames: input.preparedMutation.mutationNames,
            result,
          });
        },
        {
          operationHash: input.preparedMutation.operationHash,
          idempotencyKey: input.idempotencyKey,
        },
      ),
  );
}

function readTimeEntries(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpListCaseTimeEntries',
      rootCandidates: [
        'caseTimeEntries',
        'timeEntries',
        'timeRegistrations',
        'caseTimeRegistrations',
        'registrations',
      ],
      preferredScalars: timePreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'date',
    },
    input,
  );
}

function summarizeTimeEntries(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return summarizeDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpSummarizeTime',
      rootCandidates: [
        'caseTimeEntries',
        'timeEntries',
        'timeRegistrations',
        'caseTimeRegistrations',
        'registrations',
      ],
      preferredScalars: timePreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'date',
    },
    input,
  );
}

function readMaterials(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpListCaseMaterials',
      rootCandidates: [
        'caseMaterials',
        'materials',
        'materialEntries',
        'caseMaterialEntries',
        'materialRegistrations',
      ],
      preferredScalars: materialPreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'date',
    },
    input,
  );
}

function readInvoiceDrafts(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpListInvoiceDrafts',
      rootCandidates: ['invoiceDrafts', 'invoices', 'draftInvoices', 'invoicePipeline'],
      preferredScalars: invoicePreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'updatedAt',
    },
    input,
  );
}

async function readBusinessReport(
  client: OrdrestyringClient,
  input: CollectionReadInput & {
    report: 'hours' | 'materials' | 'case_profitability' | 'invoice_pipeline';
  },
): Promise<unknown> {
  if (input.report === 'hours') {
    return summarizeTimeEntries(client, input);
  }

  if (input.report === 'materials') {
    return summarizeDomainCollection(
      client,
      {
        operationName: 'OrdrestyringMcpMaterialsReport',
        rootCandidates: [
          'caseMaterials',
          'materials',
          'materialEntries',
          'caseMaterialEntries',
          'materialRegistrations',
        ],
        preferredScalars: materialPreferredScalars,
        nestedPreferred: caseNestedPreferred,
        defaultOrderByField: 'date',
      },
      input,
    );
  }

  if (input.report === 'invoice_pipeline') {
    return readInvoiceDrafts(client, input);
  }

  if (!input.caseId) {
    throw new Error('case_profitability report requires caseId.');
  }

  return readDomainEntity(
    client,
    {
      operationName: 'OrdrestyringMcpCaseProfitabilityReport',
      rootCandidates: ['caseFinancials', 'caseEconomyByCaseId', 'caseEconomy', 'caseById'],
      idArgCandidates: ['caseId', 'id'],
      preferredScalars: [
        'id',
        'caseId',
        'caseNumber',
        'budget',
        'cost',
        'price',
        'amount',
        'total',
        'profit',
        'profitMargin',
        'invoiceTotal',
        'materialTotal',
        'timeTotal',
      ],
    },
    { id: input.caseId },
  );
}

async function runAuditedTool<T>(
  tool: string,
  input: unknown,
  call: () => Promise<T>,
  auditOptions: { operationHash?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({
      tool,
      action: 'policy_denied',
      target,
      reason: policy.reason,
      ...auditOptions,
    });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason, ...auditOptions });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok', ...auditOptions });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
      ...auditOptions,
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    query: value.query,
    operationName: value.operationName,
    id: value.id,
    caseId: value.caseId,
    customerId: value.customerId,
    userId: value.userId,
    employeeId: value.employeeId,
    cursor: value.cursor,
    limit: value.limit,
    status: value.status,
    dateFrom: value.dateFrom,
    dateTo: value.dateTo,
    updatedFrom: value.updatedFrom,
    updatedTo: value.updatedTo,
    orderByField: value.orderByField,
    orderDirection: value.orderDirection,
    fields: value.fields,
    includeDeprecated: value.includeDeprecated,
    typeName: value.typeName,
    report: value.report,
    reason: value.reason,
    operationHash: value.operationHash,
    mutationNames: value.mutationNames,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function schemaOverviewQuery(): string {
  return `
    query OrdrestyringMcpSchemaOverview($includeDeprecated: Boolean!) {
      __schema {
        queryType {
          name
          fields(includeDeprecated: $includeDeprecated) {
            name
            description
            isDeprecated
            deprecationReason
            args {
              name
              description
              defaultValue
              type { ...TypeRef }
            }
            type { ...TypeRef }
          }
        }
        mutationType {
          name
          fields(includeDeprecated: $includeDeprecated) {
            name
            description
            isDeprecated
            deprecationReason
            args {
              name
              description
              defaultValue
              type { ...TypeRef }
            }
            type { ...TypeRef }
          }
        }
      }
    }

    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
          }
        }
      }
    }
  `;
}
