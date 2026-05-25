import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../ordrestyring/audit.js';
import {
  DRY_RUN_TOOL_ANNOTATIONS,
  getCapability,
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
  isScalarLike,
  namedTypeName,
  refreshSchemaCatalog,
  searchSchema,
  selectionForType,
  typeRefToString,
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
const operationalMutationSchema = z.enum([
  'create_customer',
  'create_case',
  'create_case_activity',
  'create_offer',
  'convert_offer_to_case',
  'create_product',
  'update_product',
  'delete_products',
  'create_hour_type',
  'update_hour_type',
  'create_case_material',
  'create_sales_invoice_draft',
  'create_creditor',
]);
const operationalInputSchema = z.record(z.string(), z.unknown()).default({});
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .describe('Audited caller-provided key. Ordrestyring does not document an idempotency header.');

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
const creditorPreferredScalars = [
  'id',
  'number',
  'name',
  'address',
  'postalCode',
  'city',
  'vatNumber',
  'vatZone',
  'createdAt',
  'locked',
  'isAccessible',
  'transferToInventoryProvider',
  'gln',
];
const productPreferredScalars = [
  'id',
  'number',
  'description',
  'isHour',
  'costPrice',
  'listPrice',
  'createdAt',
  'updatedAt',
];
const hourTypePreferredScalars = [
  'id',
  'name',
  'requireCase',
  'color',
  'salaryHandle',
  'sortOrder',
];
const timePreferredScalars = [
  'id',
  'caseId',
  'userId',
  'employeeId',
  'startTime',
  'stopTime',
  'description',
  'hours',
  'billableHours',
  'totalHours',
  'minutes',
  'duration',
  'quantity',
  'billable',
  'costPrice',
  'salesPrice',
  'isAddedToInvoiceDraft',
  'status',
  'createdAt',
  'updatedAt',
];
const materialPreferredScalars = [
  'id',
  'caseId',
  'addedDate',
  'materialDate',
  'name',
  'description',
  'productNumber',
  'quantity',
  'unit',
  'unitPrice',
  'price',
  'cost',
  'costPrice',
  'salesPrice',
  'total',
  'isAddedToInvoiceDraft',
  'type',
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
  'totalSalesPrice',
  'vat',
  'currency',
  'invoiceDate',
  'createdAt',
  'updatedAt',
];
const activityPreferredScalars = [
  'id',
  'caseId',
  'type',
  'title',
  'description',
  'comment',
  'status',
  'createdAt',
  'updatedAt',
  'changedAt',
];
const salesInvoicePreferredScalars = [
  'id',
  'invoiceNumber',
  'caseId',
  'customerId',
  'status',
  'date',
  'dueDate',
  'total',
  'totalSalesPrice',
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
const creditorNestedPreferred = {
  supplier: ['id', 'name'],
  purchaseAccount: ['id', 'number', 'name'],
  currency: ['id', 'code', 'name'],
  paymentTerm: ['id', 'name'],
  country: ['id', 'code', 'name'],
  economyTransferState: ['id', 'state', 'status'],
};
const productNestedPreferred = {
  account: ['number', 'name'],
};
const hourTypeNestedPreferred = {
  product: productPreferredScalars,
};
const timeNestedPreferred = {
  case: ['id', 'caseNumber', 'description'],
  user: ['id', 'name', 'email'],
  type: ['id', 'name'],
};
const materialNestedPreferred = {
  case: ['id', 'caseNumber', 'description'],
  createdBy: ['id', 'name', 'email'],
  supplier: ['id', 'name'],
};
const invoiceNestedPreferred = {
  case: ['id', 'caseNumber', 'description'],
  customer: customerPreferredScalars,
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
    'ordrestyring_get_capability',
    {
      title: 'Get Ordrestyring Capability',
      description: 'Return details for one discovered Ordrestyring capability.',
      inputSchema: {
        id: z.string().trim().min(1),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_capability', input, async () =>
        jsonToolResult(getCapability(input.id) ?? { error: `Unknown capability: ${input.id}` }),
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
    'ordrestyring_diagnostics',
    {
      title: 'Ordrestyring Diagnostics',
      description:
        'Check authentication and summarize live schema counts and important workflow fields.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_diagnostics', input, async () => {
        const connection = await client.graphql<{ __typename: string }>({
          query: 'query OrdrestyringMcpDiagnosticsConnection { __typename }',
        });
        const catalog = await getSchemaCatalog(client);
        const queryFieldNames = new Set(catalog.queryFields.map(field => field.name));
        const mutationFieldNames = new Set(catalog.mutationFields.map(field => field.name));
        const expectedQueryFields = [
          'cases',
          'customers',
          'hours',
          'caseMaterials',
          'salesInvoiceDrafts',
          'salesInvoices',
          'caseFinanceAggregate',
          'caseActivities',
          'caseStatusHistory',
        ];

        return jsonToolResult({
          ok: true,
          typename: connection.__typename,
          schema: {
            queryTypeName: catalog.queryTypeName,
            mutationTypeName: catalog.mutationTypeName,
            typeCount: catalog.types.length,
            queryFieldCount: catalog.queryFields.length,
            mutationFieldCount: catalog.mutationFields.length,
          },
          queryFields: Object.fromEntries(
            expectedQueryFields.map(field => [field, queryFieldNames.has(field)]),
          ),
          writes: {
            enabled: process.env.ORDRESTYRING_ENABLE_WRITES === 'true',
            mutationCount: mutationFieldNames.size,
          },
          warnings: expectedQueryFields
            .filter(field => !queryFieldNames.has(field))
            .map(field => `Live schema does not expose expected query field: ${field}`),
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
        statusId: z.number().int().positive().optional(),
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
              searchFields: ['caseNumber', 'description'],
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
    'ordrestyring_search_creditors',
    {
      title: 'Search Ordrestyring Creditors',
      description:
        'Search or list supplier/creditor master data in Ordrestyring by name, number, or VAT number.',
      inputSchema: {
        page: z.number().int().positive().default(1),
        cursor: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(500).default(20),
        query: z.string().trim().min(1).optional(),
        orderByField: z.string().trim().min(1).optional(),
        orderDirection: z.enum(['ASC', 'DESC']).default('ASC'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_creditors', input, async () =>
        jsonToolResult(await readCreditors(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_creditor',
    {
      title: 'Get Ordrestyring Creditor',
      description: 'Fetch supplier/creditor master data by creditor number.',
      inputSchema: {
        number: z.string().trim().min(1),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_creditor', input, async () =>
        jsonToolResult(
          await readDomainEntity(
            client,
            {
              operationName: 'OrdrestyringMcpGetCreditor',
              rootCandidates: ['creditor'],
              idArgCandidates: ['number'],
              preferredScalars: creditorPreferredScalars,
              nestedPreferred: creditorNestedPreferred,
            },
            { id: input.number },
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_search_products',
    {
      title: 'Search Ordrestyring Products',
      description: 'Search or list product/item master data by number or description.',
      inputSchema: {
        page: z.number().int().positive().default(1),
        cursor: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        query: z.string().trim().min(1).optional(),
        productType: z.enum(['ITEMS', 'HOURS']).optional(),
        orderByField: z.string().trim().min(1).optional(),
        orderDirection: z.enum(['ASC', 'DESC']).default('ASC'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_products', input, async () =>
        jsonToolResult(await readProducts(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_product',
    {
      title: 'Get Ordrestyring Product',
      description: 'Fetch product/item master data by numeric product id.',
      inputSchema: {
        id: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_product', input, async () =>
        jsonToolResult(
          await readDomainEntity(
            client,
            {
              operationName: 'OrdrestyringMcpGetProduct',
              rootCandidates: ['product'],
              idArgCandidates: ['id'],
              preferredScalars: productPreferredScalars,
              nestedPreferred: productNestedPreferred,
            },
            input,
          ),
        ),
      ),
  );

  server.registerTool(
    'ordrestyring_search_hour_types',
    {
      title: 'Search Ordrestyring Hour Types',
      description: 'Search or list Ordrestyring hour types and linked time products.',
      inputSchema: {
        page: z.number().int().positive().default(1),
        cursor: z.string().trim().min(1).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        query: z.string().trim().min(1).optional(),
        requireCase: z.boolean().optional(),
        allHourTypes: z.boolean().default(true),
        orderByField: z.string().trim().min(1).optional(),
        orderDirection: z.enum(['ASC', 'DESC']).default('ASC'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_search_hour_types', input, async () =>
        jsonToolResult(await readHourTypes(client, input)),
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
        jsonToolResult(await readCaseFinancials(client, input.caseId)),
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
        statusId: z.number().int().positive().optional(),
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
    'ordrestyring_get_case_activity',
    {
      title: 'Get Ordrestyring Case Activity',
      description: 'Read case activity and status-history records for one case.',
      inputSchema: {
        ...paginationInputShape,
        caseId: z.number().int().positive(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_case_activity', input, async () =>
        jsonToolResult({
          activities: await readSection(() => readCaseActivities(client, input)),
          statusHistory: await readSection(() => readCaseStatusHistory(client, input)),
        }),
      ),
  );

  server.registerTool(
    'ordrestyring_find_billable_cases',
    {
      title: 'Find Ordrestyring Billable Cases',
      description: 'Find operational cases that look ready for billing review.',
      inputSchema: {
        ...paginationInputShape,
        customerId: z.number().int().positive().optional(),
        statusId: z.number().int().positive().optional(),
        includeReadiness: z.boolean().default(false),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_find_billable_cases', input, async () =>
        jsonToolResult(await findBillableCases(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_case_work_summary',
    {
      title: 'Get Ordrestyring Case Work Summary',
      description: 'Summarize hours and materials for a case and optional date range.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive(),
        includeSubCases: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_case_work_summary', input, async () =>
        jsonToolResult(await readCaseWorkSummary(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_case_health',
    {
      title: 'Get Ordrestyring Case Health',
      description:
        'Collect case overview, activity, work, documents, quality checks, and billing readiness.',
      inputSchema: {
        ...paginationInputShape,
        caseId: z.number().int().positive(),
        includeSubCases: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_case_health', input, async () =>
        jsonToolResult(await readCaseHealth(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_find_stale_cases',
    {
      title: 'Find Ordrestyring Stale Cases',
      description: 'Find cases not updated for a configurable number of days.',
      inputSchema: {
        ...paginationInputShape,
        daysWithoutUpdate: z.number().int().min(1).max(730).default(30),
        customerId: z.number().int().positive().optional(),
        statusId: z.number().int().positive().optional(),
        currentUserAssigned: z.boolean().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_find_stale_cases', input, async () =>
        jsonToolResult(await findStaleCases(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_invoice_readiness',
    {
      title: 'Get Ordrestyring Invoice Readiness',
      description:
        'Inspect one case for billing readiness: overview, uninvoiced work, draft invoice, and financials.',
      inputSchema: {
        ...paginationInputShape,
        caseId: z.number().int().positive(),
        includeSubCases: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_invoice_readiness', input, async () =>
        jsonToolResult(await readInvoiceReadiness(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_billing_pipeline',
    {
      title: 'Get Ordrestyring Billing Pipeline',
      description: 'Read invoice drafts and sales invoices for pipeline review.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive().optional(),
        customerId: z.number().int().positive().optional(),
        statusId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_billing_pipeline', input, async () =>
        jsonToolResult({
          drafts: await readSection(() => readInvoiceDrafts(client, input)),
          invoices: await readSection(() => readSalesInvoices(client, input)),
        }),
      ),
  );

  server.registerTool(
    'ordrestyring_get_unbilled_work_report',
    {
      title: 'Get Ordrestyring Unbilled Work Report',
      description: 'Summarize uninvoiced hours and materials for a case/date range.',
      inputSchema: {
        ...paginationInputShape,
        ...dateRangeInputShape,
        caseId: z.number().int().positive().optional(),
        includeSubCases: z.boolean().default(true),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_unbilled_work_report', input, async () =>
        jsonToolResult(await readUnbilledWorkReport(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_get_operational_model',
    {
      title: 'Get Ordrestyring Operational Model',
      description:
        'Show the recommended Ordrestyring/e-conomic ownership boundary and live create/update mutation coverage.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_operational_model', input, async () =>
        jsonToolResult(await readOperationalModel(client)),
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
        statusId: z.number().int().positive().optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_get_business_report', input, async () =>
        jsonToolResult(await readBusinessReport(client, input)),
      ),
  );

  server.registerTool(
    'ordrestyring_prepare_operational_mutation',
    {
      title: 'Prepare Ordrestyring Operational Mutation',
      description:
        'Prepare curated Ordrestyring create/convert mutations for inspection. This dry-run tool never calls Ordrestyring.',
      inputSchema: {
        operation: operationalMutationSchema,
        input: z.record(z.string(), z.unknown()).default({}),
        reason: z.string().trim().min(3),
      },
      annotations: DRY_RUN_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('ordrestyring_prepare_operational_mutation', input, async () =>
        jsonToolResult(await prepareOperationalMutation(client, input.operation, input.input, input.reason)),
      ),
  );

  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_customer',
    operation: 'create_customer',
    title: 'Create Ordrestyring Customer',
    description: 'Create an operational customer in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_case',
    operation: 'create_case',
    title: 'Create Ordrestyring Case',
    description: 'Create an operational case/order in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_case_activity',
    operation: 'create_case_activity',
    title: 'Create Ordrestyring Case Activity',
    description: 'Create an operational case activity or note in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_offer',
    operation: 'create_offer',
    title: 'Create Ordrestyring Offer',
    description: 'Create an operational offer in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_convert_offer_to_case',
    operation: 'convert_offer_to_case',
    title: 'Convert Ordrestyring Offer To Case',
    description: 'Convert an accepted offer to a case/order in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_product',
    operation: 'create_product',
    title: 'Create Ordrestyring Product',
    description: 'Create an operational product/item in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_update_product',
    operation: 'update_product',
    title: 'Update Ordrestyring Product',
    description: 'Update product/item master data in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_delete_products',
    operation: 'delete_products',
    title: 'Delete Ordrestyring Products',
    description: 'Delete product/item master data in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_hour_type',
    operation: 'create_hour_type',
    title: 'Create Ordrestyring Hour Type',
    description: 'Create an hour type linked to an Ordrestyring time product.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_update_hour_type',
    operation: 'update_hour_type',
    title: 'Update Ordrestyring Hour Type',
    description: 'Update Ordrestyring hour type metadata and linked product number.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_case_material',
    operation: 'create_case_material',
    title: 'Create Ordrestyring Case Material',
    description: 'Register operational material on a case in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_sales_invoice_draft',
    operation: 'create_sales_invoice_draft',
    title: 'Create Ordrestyring Sales Invoice Draft',
    description: 'Create an operational sales invoice draft in Ordrestyring.',
  });
  registerOperationalWriteTool(server, client, {
    toolName: 'ordrestyring_create_creditor',
    operation: 'create_creditor',
    title: 'Create Ordrestyring Creditor',
    description: 'Create supplier/creditor master data in Ordrestyring.',
  });

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
        idempotencyKey: idempotencyKeySchema,
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

function registerOperationalWriteTool(
  server: McpServer,
  client: OrdrestyringClient,
  config: {
    toolName: string;
    operation: z.infer<typeof operationalMutationSchema>;
    title: string;
    description: string;
  },
): void {
  server.registerTool(
    config.toolName,
    {
      title: config.title,
      description: `${config.description} Requires ORDRESTYRING_ENABLE_WRITES=true and write policy approval.`,
      inputSchema: {
        input: operationalInputSchema,
        reason: z.string().trim().min(3),
        idempotencyKey: idempotencyKeySchema,
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(
        config.toolName,
        {
          operation: config.operation,
          reason: input.reason,
        },
        async () =>
          jsonToolResult(
            await commitOperationalMutation(
              client,
              config.operation,
              input.input,
              input.reason,
              input.idempotencyKey,
            ),
          ),
        { idempotencyKey: input.idempotencyKey },
      ),
  );
}

function readTimeEntries(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpListCaseTimeEntries',
      rootCandidates: [
        'hours',
        'caseTimeEntries',
        'timeEntries',
        'timeRegistrations',
        'caseTimeRegistrations',
        'registrations',
      ],
      preferredScalars: timePreferredScalars,
      nestedPreferred: timeNestedPreferred,
      defaultOrderByField: 'startTime',
      searchFields: ['description'],
    },
    input,
  );
}

function readCreditors(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpSearchCreditors',
      rootCandidates: ['creditors'],
      preferredScalars: creditorPreferredScalars,
      nestedPreferred: creditorNestedPreferred,
      searchFields: ['name', 'number', 'vatNumber'],
    },
    input,
  );
}

function readProducts(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpSearchProducts',
      rootCandidates: ['products'],
      preferredScalars: productPreferredScalars,
      nestedPreferred: productNestedPreferred,
      searchFields: ['number', 'description'],
    },
    input,
  );
}

function readHourTypes(client: OrdrestyringClient, input: CollectionReadInput): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpSearchHourTypes',
      rootCandidates: ['hourTypes'],
      preferredScalars: hourTypePreferredScalars,
      nestedPreferred: hourTypeNestedPreferred,
      searchFields: ['name'],
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
        'hours',
        'caseTimeEntries',
        'timeEntries',
        'timeRegistrations',
        'caseTimeRegistrations',
        'registrations',
      ],
      preferredScalars: timePreferredScalars,
      nestedPreferred: timeNestedPreferred,
      defaultOrderByField: 'startTime',
      searchFields: ['description'],
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
      nestedPreferred: materialNestedPreferred,
      defaultOrderByField: 'materialDate',
      searchFields: ['description', 'productNumber'],
      argumentDefaults: { type: 'MATERIAL' },
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
      rootCandidates: ['salesInvoiceDrafts', 'invoiceDrafts', 'draftInvoices', 'invoicePipeline'],
      preferredScalars: invoicePreferredScalars,
      nestedPreferred: invoiceNestedPreferred,
      defaultOrderByField: 'updatedAt',
      searchFields: ['text', 'header'],
    },
    input,
  );
}

function readSalesInvoices(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpListSalesInvoices',
      rootCandidates: ['salesInvoices'],
      preferredScalars: salesInvoicePreferredScalars,
      nestedPreferred: invoiceNestedPreferred,
      defaultOrderByField: 'updatedAt',
      searchFields: ['invoiceNumber'],
    },
    input,
  );
}

function readCaseActivities(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpCaseActivities',
      rootCandidates: ['caseActivities'],
      preferredScalars: activityPreferredScalars,
      nestedPreferred: {
        user: ['id', 'name', 'email'],
      },
      defaultOrderByField: 'createdAt',
    },
    input,
  );
}

function readCaseStatusHistory(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpCaseStatusHistory',
      rootCandidates: ['caseStatusHistory'],
      preferredScalars: activityPreferredScalars,
      nestedPreferred: {
        user: ['id', 'name', 'email'],
        status: ['id', 'name'],
      },
      defaultOrderByField: 'changedAt',
    },
    input,
  );
}

async function readCaseWorkSummary(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return {
    hours: await readSection(() => summarizeTimeEntries(client, input)),
    materials: await readSection(() =>
      summarizeDomainCollection(
        client,
        {
          operationName: 'OrdrestyringMcpCaseMaterialsSummary',
          rootCandidates: [
            'caseMaterials',
            'materials',
            'materialEntries',
            'caseMaterialEntries',
            'materialRegistrations',
          ],
          preferredScalars: materialPreferredScalars,
          nestedPreferred: materialNestedPreferred,
          defaultOrderByField: 'materialDate',
          searchFields: ['description', 'productNumber'],
          argumentDefaults: { type: 'MATERIAL' },
        },
        input,
      ),
    ),
  };
}

async function findBillableCases(
  client: OrdrestyringClient,
  input: CollectionReadInput & { includeReadiness?: boolean },
): Promise<unknown> {
  const cases = await readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpFindBillableCases',
      rootCandidates: ['cases'],
      preferredScalars: casePreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'updatedAt',
      searchFields: ['caseNumber', 'description'],
    },
    {
      ...input,
      hoursPending: true,
      invoiceSent: false,
    },
  );

  if (!input.includeReadiness) {
    return cases;
  }

  const items = extractItems((cases as { result?: unknown }).result).slice(0, Math.min(input.limit ?? 20, 10));
  const readiness = await Promise.all(
    items
      .map(item => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
      .filter((id): id is number => typeof id === 'number')
      .map(async caseId => ({
        caseId,
        readiness: await readSection(() => readInvoiceReadiness(client, { ...input, caseId })),
      })),
  );

  return {
    cases,
    readiness,
  };
}

async function readCaseHealth(
  client: OrdrestyringClient,
  input: CollectionReadInput & { caseId: number },
): Promise<unknown> {
  const sections = {
    case: await readSection(() =>
      readDomainEntity(
        client,
        {
          operationName: 'OrdrestyringMcpCaseHealthCase',
          rootCandidates: ['caseById', 'case', 'getCase'],
          idArgCandidates: ['id', 'caseId'],
          preferredScalars: casePreferredScalars,
          nestedPreferred: caseNestedPreferred,
        },
        { id: input.caseId },
      ),
    ),
    activity: await readSection(() => readCaseActivities(client, input)),
    statusHistory: await readSection(() => readCaseStatusHistory(client, input)),
    work: await readSection(() => readCaseWorkSummary(client, input)),
    documents: await readSection(() =>
      readDomainCollection(
        client,
        {
          operationName: 'OrdrestyringMcpCaseHealthDocuments',
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
    qualityChecks: await readSection(() =>
      readDomainCollection(
        client,
        {
          operationName: 'OrdrestyringMcpCaseHealthQualityChecks',
          rootCandidates: [
            'caseQualityChecks',
            'qualityChecks',
            'qualityAssurance',
            'checklists',
            'forms',
            'caseForms',
            'caseSchemes',
          ],
          preferredScalars: qualityPreferredScalars,
        },
        input,
      ),
    ),
    invoiceReadiness: await readSection(() => readInvoiceReadiness(client, input)),
  };

  return {
    sections,
    warnings: sectionWarnings(sections),
  };
}

function findStaleCases(
  client: OrdrestyringClient,
  input: CollectionReadInput & { daysWithoutUpdate: number },
): Promise<unknown> {
  return readDomainCollection(
    client,
    {
      operationName: 'OrdrestyringMcpFindStaleCases',
      rootCandidates: ['cases'],
      preferredScalars: casePreferredScalars,
      nestedPreferred: caseNestedPreferred,
      defaultOrderByField: 'updatedAt',
      searchFields: ['caseNumber', 'description'],
    },
    {
      ...input,
      updatedTo: daysAgoIsoDate(input.daysWithoutUpdate),
    },
  );
}

async function readInvoiceReadiness(
  client: OrdrestyringClient,
  input: CollectionReadInput & { caseId: number },
): Promise<unknown> {
  return {
    case: await readSection(() =>
      readDomainEntity(
        client,
        {
          operationName: 'OrdrestyringMcpInvoiceReadinessCase',
          rootCandidates: ['caseById', 'case', 'getCase'],
          idArgCandidates: ['id', 'caseId'],
          preferredScalars: casePreferredScalars,
          nestedPreferred: caseNestedPreferred,
        },
        { id: input.caseId },
      ),
    ),
    uninvoicedHours: await readSection(() =>
      summarizeTimeEntries(client, { ...input, isInvoiced: false, isAddedToDraft: false }),
    ),
    uninvoicedMaterials: await readSection(() =>
      summarizeDomainCollection(
        client,
        {
          operationName: 'OrdrestyringMcpInvoiceReadinessMaterials',
          rootCandidates: [
            'caseMaterials',
            'materials',
            'materialEntries',
            'caseMaterialEntries',
            'materialRegistrations',
          ],
          preferredScalars: materialPreferredScalars,
          nestedPreferred: materialNestedPreferred,
          defaultOrderByField: 'materialDate',
          searchFields: ['description', 'productNumber'],
          argumentDefaults: { type: 'MATERIAL' },
        },
        { ...input, isInvoiced: false, isAddedToDraft: false },
      ),
    ),
    drafts: await readSection(() => readInvoiceDrafts(client, input)),
    financials: await readSection(() => readCaseFinancials(client, input.caseId)),
  };
}

async function readUnbilledWorkReport(
  client: OrdrestyringClient,
  input: CollectionReadInput,
): Promise<unknown> {
  return {
    hours: await readSection(() =>
      summarizeTimeEntries(client, { ...input, isInvoiced: false, isAddedToDraft: false }),
    ),
    materials: await readSection(() =>
      summarizeDomainCollection(
        client,
        {
          operationName: 'OrdrestyringMcpUnbilledMaterialsReport',
          rootCandidates: [
            'caseMaterials',
            'materials',
            'materialEntries',
            'caseMaterialEntries',
            'materialRegistrations',
          ],
          preferredScalars: materialPreferredScalars,
          nestedPreferred: materialNestedPreferred,
          defaultOrderByField: 'materialDate',
          searchFields: ['description', 'productNumber'],
          argumentDefaults: { type: 'MATERIAL' },
        },
        { ...input, isInvoiced: false, isAddedToDraft: false },
      ),
    ),
  };
}

async function readOperationalModel(client: OrdrestyringClient): Promise<unknown> {
  const catalog = await getSchemaCatalog(client);
  const mutationNames = new Set(catalog.mutationFields.map(field => field.name));

  return {
    recommendedOwnership: {
      ordrestyring: [
        'customers and contacts as operational context',
        'offers and offer lines',
        'cases/orders, planning, activities, documentation, and quality checks',
        'time and material registrations',
        'invoice draft preparation and operational billing readiness',
      ],
      economic: [
        'chart of accounts, VAT codes, dimensions, and posting setup',
        'booked invoices and credit notes after approval',
        'payments, open items, reconciliation, and accounting reports',
        'supplier invoices and bookkeeping archive when finance owns the flow',
      ],
      integrationNotes: [
        'Ordrestyring has a public e-conomic integration, so prefer using Ordrestyring as the daily operational source and e-conomic as the financial ledger.',
        'Keep account numbers and VAT setup clean in e-conomic; use synchronized account/product metadata in Ordrestyring when creating operational lines.',
      ],
    },
    curatedMutations: operationalMutationDefinitions().map(definition => ({
      operation: definition.operation,
      mutationName: definition.mutationName,
      inputType: definition.inputType,
      available: mutationNames.has(definition.mutationName),
      owner: definition.owner,
      notes: definition.notes,
    })),
  };
}

async function prepareOperationalMutation(
  client: OrdrestyringClient,
  operation: z.infer<typeof operationalMutationSchema>,
  input: Record<string, unknown>,
  reason: string,
): Promise<unknown> {
  const prepared = await buildPreparedOperationalMutation(client, operation, input, reason);
  const definition = operationalMutationDefinitions().find(item => item.operation === operation);

  return {
    preparedMutation: prepared,
    operation,
    owner: definition?.owner,
    notes: definition?.notes ?? [],
  };
}

async function commitOperationalMutation(
  client: OrdrestyringClient,
  operation: z.infer<typeof operationalMutationSchema>,
  input: Record<string, unknown>,
  reason: string,
  idempotencyKey: string,
): Promise<unknown> {
  if (operation === 'delete_products') {
    return commitDeleteProductsMutation(client, input, reason, idempotencyKey);
  }

  const prepared = await buildPreparedOperationalMutation(client, operation, input, reason);
  const mutationPolicy = await checkMutationPolicy(prepared);
  if (!mutationPolicy.allowed) {
    await writeAuditEvent({
      tool: `ordrestyring_${operation}`,
      action: 'policy_denied',
      operationHash: prepared.operationHash,
      idempotencyKey,
      reason: mutationPolicy.reason,
    });
    throw new Error(mutationPolicy.reason);
  }

  const result = await client.graphql({
    query: prepared.query,
    variables: prepared.variables,
    operationName: prepared.operationName,
  });
  const definition = operationalMutationDefinitions().find(item => item.operation === operation);

  return {
    operation,
    operationHash: prepared.operationHash,
    mutationNames: prepared.mutationNames,
    owner: definition?.owner,
    notes: definition?.notes ?? [],
    result,
  };
}

async function commitDeleteProductsMutation(
  client: OrdrestyringClient,
  input: Record<string, unknown>,
  reason: string,
  idempotencyKey: string,
): Promise<unknown> {
  const ids = deleteProductIdsFromInput(input);
  const definition = operationalMutationDefinitions().find(item => item.operation === 'delete_products');
  const results: Array<{ id: number; operationHash: string; result: unknown }> = [];

  for (const id of ids) {
    const prepared = await buildPreparedOperationalMutation(client, 'delete_products', { ids: [id] }, reason);
    const mutationPolicy = await checkMutationPolicy(prepared);
    if (!mutationPolicy.allowed) {
      await writeAuditEvent({
        tool: 'ordrestyring_delete_products',
        action: 'policy_denied',
        operationHash: prepared.operationHash,
        idempotencyKey,
        reason: mutationPolicy.reason,
      });
      throw new Error(mutationPolicy.reason);
    }

    results.push({
      id,
      operationHash: prepared.operationHash,
      result: await client.graphql({
        query: prepared.query,
        variables: prepared.variables,
        operationName: prepared.operationName,
      }),
    });
  }

  return {
    operation: 'delete_products',
    operationHash: results.map(item => item.operationHash),
    mutationNames: ['deleteProduct'],
    owner: definition?.owner,
    notes: definition?.notes ?? [],
    result: results,
  };
}

async function buildPreparedOperationalMutation(
  client: OrdrestyringClient,
  operation: z.infer<typeof operationalMutationSchema>,
  input: Record<string, unknown>,
  reason: string,
) {
  const catalog = await getSchemaCatalog(client);
  const definition = operationalMutationDefinitions().find(item => item.operation === operation);
  if (!definition) {
    throw new Error(`Unsupported operational mutation: ${operation}`);
  }

  const field = catalog.mutationFields.find(item => item.name === definition.mutationName);
  if (!field) {
    throw new Error(`Ordrestyring schema does not expose mutation: ${definition.mutationName}`);
  }

  return prepareMutation({
    query: buildOperationalMutationQuery(catalog, definition, field),
    variables: variablesForOperationalMutation(definition, input),
    operationName: `OrdrestyringMcp${pascalCase(operation)}`,
    reason,
  });
}

interface OperationalMutationDefinition {
  operation: z.infer<typeof operationalMutationSchema>;
  mutationName: string;
  inputType?: string;
  owner: 'ordrestyring' | 'finance-boundary';
  notes: string[];
}

function operationalMutationDefinitions(): OperationalMutationDefinition[] {
  return [
    {
      operation: 'create_customer',
      mutationName: 'createCustomer',
      inputType: 'CreateCustomerInput',
      owner: 'ordrestyring',
      notes: ['Operational customer context; financial customer sync should be governed by the existing integration.'],
    },
    {
      operation: 'create_case',
      mutationName: 'createCase',
      inputType: 'CreateCaseInput',
      owner: 'ordrestyring',
      notes: ['Daily order/case work belongs in Ordrestyring.'],
    },
    {
      operation: 'create_case_activity',
      mutationName: 'createCaseActivity',
      inputType: 'CreateCaseActivityInput',
      owner: 'ordrestyring',
      notes: ['Use for operational notes and timeline events.'],
    },
    {
      operation: 'create_offer',
      mutationName: 'createOffer',
      inputType: 'CreateOfferInput',
      owner: 'ordrestyring',
      notes: ['Offers and offer lines are operational and should be prepared in Ordrestyring.'],
    },
    {
      operation: 'convert_offer_to_case',
      mutationName: 'convertOfferToCase',
      owner: 'ordrestyring',
      notes: ['Converts accepted operational offers into cases/orders.'],
    },
    {
      operation: 'create_product',
      mutationName: 'createProduct',
      inputType: 'CreateProductInput',
      owner: 'ordrestyring',
      notes: ['Operational products/items can live in Ordrestyring; account/VAT discipline remains finance-owned.'],
    },
    {
      operation: 'update_product',
      mutationName: 'updateProduct',
      inputType: 'UpdateProductInput',
      owner: 'ordrestyring',
      notes: ['Use for governed product catalog synchronization from approved price sources.'],
    },
    {
      operation: 'delete_products',
      mutationName: 'deleteProduct',
      owner: 'ordrestyring',
      notes: ['Use only for explicit cleanup of placeholder product master data.'],
    },
    {
      operation: 'create_hour_type',
      mutationName: 'createHourType',
      inputType: 'CreateHourTypeInput',
      owner: 'ordrestyring',
      notes: ['Hour types are operational time registration setup linked to time products.'],
    },
    {
      operation: 'update_hour_type',
      mutationName: 'updateHourType',
      inputType: 'UpdateHourTypeInput',
      owner: 'ordrestyring',
      notes: ['Use for governed synchronization of operational time registration setup.'],
    },
    {
      operation: 'create_case_material',
      mutationName: 'createCaseMaterial',
      inputType: 'CreateCaseMaterialInput',
      owner: 'ordrestyring',
      notes: ['Materials are operational registrations before billing.'],
    },
    {
      operation: 'create_sales_invoice_draft',
      mutationName: 'createSalesInvoiceDraft',
      inputType: 'CreateSalesInvoiceDraftInput',
      owner: 'finance-boundary',
      notes: ['Draft creation is still operational; booking/sending belongs behind stricter finance approval.'],
    },
    {
      operation: 'create_creditor',
      mutationName: 'createCreditor',
      inputType: 'CreateCreditorInput',
      owner: 'finance-boundary',
      notes: ['Supplier/creditor master data crosses into finance; keep policy allowlists tighter here.'],
    },
  ];
}

function buildOperationalMutationQuery(
  catalog: Awaited<ReturnType<typeof getSchemaCatalog>>,
  definition: OperationalMutationDefinition,
  field: { type: Parameters<typeof namedTypeName>[0] },
): string {
  if (definition.operation === 'convert_offer_to_case') {
    return `
      mutation OrdrestyringMcp${pascalCase(definition.operation)}($id: Int!, $options: ConvertOfferToCaseOptionsInput) {
        ${definition.mutationName}(id: $id, options: $options)${mutationSelection(catalog, field)}
      }
    `;
  }

  if (definition.operation === 'update_product' || definition.operation === 'update_hour_type') {
    return `
      mutation OrdrestyringMcp${pascalCase(definition.operation)}($id: Int!, $input: ${definition.inputType}!) {
        ${definition.mutationName}(id: $id, input: $input)${mutationSelection(catalog, field)}
      }
    `;
  }

  if (definition.operation === 'delete_products') {
    return `
      mutation OrdrestyringMcp${pascalCase(definition.operation)}($id: [Int!]) {
        ${definition.mutationName}(id: $id)${mutationSelection(catalog, field)}
      }
    `;
  }

  return `
    mutation OrdrestyringMcp${pascalCase(definition.operation)}($input: ${definition.inputType}!) {
      ${definition.mutationName}(input: $input)${mutationSelection(catalog, field)}
    }
  `;
}

function mutationSelection(
  catalog: Awaited<ReturnType<typeof getSchemaCatalog>>,
  field: { type: Parameters<typeof namedTypeName>[0] },
): string {
  if (isScalarLike(field.type)) {
    return '';
  }

  const typeName = namedTypeName(field.type);
  if (!typeName) {
    return '';
  }

  return ` {\n${selectionForType(catalog, typeName, ['id', 'number', 'caseNumber', 'description', 'name', 'createdAt', 'updatedAt'])}\n}`;
}

function variablesForOperationalMutation(
  definition: OperationalMutationDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (definition.operation === 'convert_offer_to_case') {
    if (typeof input.id !== 'number') {
      throw new Error('convert_offer_to_case requires numeric input.id.');
    }

    return {
      id: input.id,
      options: input.options ?? null,
    };
  }

  if (definition.operation === 'update_product' || definition.operation === 'update_hour_type') {
    if (typeof input.id !== 'number') {
      throw new Error(`${definition.operation} requires numeric input.id.`);
    }
    if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
      throw new Error(`${definition.operation} requires object input.input.`);
    }

    return {
      id: input.id,
      input: input.input,
    };
  }

  if (definition.operation === 'delete_products') {
    return { id: deleteProductIdsFromInput(input) };
  }

  return { input };
}

function deleteProductIdsFromInput(input: Record<string, unknown>): number[] {
  const ids = input.ids ?? input.id;
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'number')) {
    throw new Error('delete_products requires numeric input.ids array.');
  }

  return ids;
}

function readCaseFinancials(client: OrdrestyringClient, caseId: number): Promise<unknown> {
  return readDomainEntity(
    client,
    {
      operationName: 'OrdrestyringMcpGetCaseFinancials',
      rootCandidates: ['caseFinanceAggregate', 'caseFinancials', 'caseEconomyByCaseId', 'caseEconomy', 'caseById'],
      idArgCandidates: ['caseId', 'id'],
      preferredScalars: [
        'budget',
        'budgetModifications',
        'revisedBudget',
        'pendingBudgetChanges',
        'projectedBudget',
        'directCosts',
        'directMaterialCosts',
        'pendingCosts',
        'projectedCosts',
        'projectedMarkup',
        'markup',
        'costDeviation',
        'contracts',
        'id',
        'caseId',
        'caseNumber',
        'cost',
        'total',
        'profit',
        'profitMargin',
      ],
    },
    { id: caseId },
  );
}

async function readSection<T>(call: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await call();
  } catch (error) {
    return { error: formatUnknownError(error) };
  }
}

function extractItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    return record.items;
  }

  return [];
}

function sectionWarnings(sections: Record<string, unknown>): string[] {
  return Object.entries(sections)
    .filter((entry): entry is [string, { error: string }] => {
      const value = entry[1];
      return Boolean(value && typeof value === 'object' && 'error' in value);
    })
    .map(([name, value]) => `${name}: ${value.error}`);
}

function daysAgoIsoDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function pascalCase(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
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
      rootCandidates: ['caseFinanceAggregate', 'caseFinancials', 'caseEconomyByCaseId', 'caseEconomy', 'caseById'],
      idArgCandidates: ['caseId', 'id'],
      preferredScalars: [
        'budget',
        'budgetModifications',
        'revisedBudget',
        'pendingBudgetChanges',
        'projectedBudget',
        'directCosts',
        'directMaterialCosts',
        'pendingCosts',
        'projectedCosts',
        'projectedMarkup',
        'markup',
        'costDeviation',
        'contracts',
        'id',
        'caseId',
        'caseNumber',
        'cost',
        'total',
        'profit',
        'profitMargin',
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
    statusId: value.statusId,
    daysWithoutUpdate: value.daysWithoutUpdate,
    includeReadiness: value.includeReadiness,
    dateFrom: value.dateFrom,
    dateTo: value.dateTo,
    updatedFrom: value.updatedFrom,
    updatedTo: value.updatedTo,
    isInvoiced: value.isInvoiced,
    isAddedToDraft: value.isAddedToDraft,
    includeSubCases: value.includeSubCases,
    hoursPending: value.hoursPending,
    invoiceCreated: value.invoiceCreated,
    invoiceSent: value.invoiceSent,
    currentUserAssigned: value.currentUserAssigned,
    operation: value.operation,
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
