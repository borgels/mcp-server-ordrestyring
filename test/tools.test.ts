import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCapabilities } from '../src/ordrestyring/capabilities.js';
import { OrdrestyringClient } from '../src/ordrestyring/client.js';
import { registerOrdrestyringTools } from '../src/tools/ordrestyring.js';

const originalAuditLog = process.env.ORDRESTYRING_AUDIT_LOG;
const originalEnableWrites = process.env.ORDRESTYRING_ENABLE_WRITES;
const originalPolicyPath = process.env.ORDRESTYRING_POLICY_PATH;
let tempDir: string | undefined;

describe('Ordrestyring tool hardening', () => {
  afterEach(async () => {
    if (originalAuditLog === undefined) {
      delete process.env.ORDRESTYRING_AUDIT_LOG;
    } else {
      process.env.ORDRESTYRING_AUDIT_LOG = originalAuditLog;
    }
    if (originalEnableWrites === undefined) {
      delete process.env.ORDRESTYRING_ENABLE_WRITES;
    } else {
      process.env.ORDRESTYRING_ENABLE_WRITES = originalEnableWrites;
    }
    if (originalPolicyPath === undefined) {
      delete process.env.ORDRESTYRING_POLICY_PATH;
    } else {
      process.env.ORDRESTYRING_POLICY_PATH = originalPolicyPath;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers expected annotations for read, dry-run, and write tools', () => {
    const registered = captureRegisteredTools();

    expect(Object.keys(registered)).toEqual([
      'ordrestyring_search_capabilities',
      'ordrestyring_check_connection',
      'ordrestyring_introspect_schema',
      'ordrestyring_get_capability',
      'ordrestyring_search_schema',
      'ordrestyring_get_schema_type',
      'ordrestyring_refresh_schema',
      'ordrestyring_diagnostics',
      'ordrestyring_list_cases',
      'ordrestyring_get_case',
      'ordrestyring_search_cases',
      'ordrestyring_get_case_overview',
      'ordrestyring_search_customers',
      'ordrestyring_get_customer_overview',
      'ordrestyring_search_creditors',
      'ordrestyring_get_creditor',
      'ordrestyring_search_products',
      'ordrestyring_get_product',
      'ordrestyring_search_hour_types',
      'ordrestyring_list_case_time_entries',
      'ordrestyring_summarize_time',
      'ordrestyring_list_case_materials',
      'ordrestyring_get_case_financials',
      'ordrestyring_list_schedule',
      'ordrestyring_list_case_documents',
      'ordrestyring_list_case_quality_checks',
      'ordrestyring_list_invoice_drafts',
      'ordrestyring_get_case_activity',
      'ordrestyring_find_billable_cases',
      'ordrestyring_get_case_work_summary',
      'ordrestyring_get_case_health',
      'ordrestyring_find_stale_cases',
      'ordrestyring_get_invoice_readiness',
      'ordrestyring_get_billing_pipeline',
      'ordrestyring_get_unbilled_work_report',
      'ordrestyring_get_operational_model',
      'ordrestyring_get_business_report',
      'ordrestyring_prepare_operational_mutation',
      'ordrestyring_create_customer',
      'ordrestyring_create_case',
      'ordrestyring_create_case_activity',
      'ordrestyring_create_offer',
      'ordrestyring_convert_offer_to_case',
      'ordrestyring_create_product',
      'ordrestyring_update_product',
      'ordrestyring_delete_products',
      'ordrestyring_create_hour_type',
      'ordrestyring_update_hour_type',
      'ordrestyring_create_case_material',
      'ordrestyring_create_sales_invoice_draft',
      'ordrestyring_create_creditor',
      'ordrestyring_graphql_read',
      'ordrestyring_prepare_mutation',
      'ordrestyring_commit_prepared_mutation',
    ]);

    for (const name of [
      'ordrestyring_search_capabilities',
      'ordrestyring_graphql_read',
      'ordrestyring_prepare_mutation',
    ]) {
      expect(registered[name]?.config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }

    expect(registered.ordrestyring_commit_prepared_mutation?.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(registered.ordrestyring_create_offer?.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('searches capability metadata for MCP clients', () => {
    const results = searchCapabilities('schema');

    expect(results.map(result => result.id)).toContain('ordrestyring_introspect_schema');
    expect(results[0]?.examples.length).toBeGreaterThan(0);
  });

  it('searches live schema metadata through introspection', async () => {
    const fetchMock = mockSchemaFetch();
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const schemaTool = registered.ordrestyring_search_schema;
    if (!schemaTool) {
      throw new Error('ordrestyring_search_schema was not registered');
    }

    const result = await schemaTool.handler({ query: 'case', limit: 10 });
    const text = toolText(result);

    expect(text).toContain('cases');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('builds schema-aware case search queries with supported arguments only', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [{ id: 1, caseNumber: 'S-1', status: 'open', customer: { id: 2, name: 'ACME' } }],
        nextCursor: 'next',
        previousCursor: null,
      },
    });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const searchTool = registered.ordrestyring_search_cases;
    if (!searchTool) {
      throw new Error('ordrestyring_search_cases was not registered');
    }

    const result = await searchTool.handler({
      query: 'service',
      statusId: 7,
      customerId: 2,
      cursor: null,
      limit: 5,
      orderByField: 'updatedAt',
      orderDirection: 'DESC',
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(requestBody.query).toContain('result: cases');
    expect(requestBody.query).toContain('pagination: $pagination');
    expect(requestBody.query).toContain('search: $search');
    expect(requestBody.query).toContain('filters: $filters');
    expect(requestBody.query).toContain('customer { id name }');
    expect(requestBody.variables).toMatchObject({
      pagination: { cursor: null, limit: 5 },
      orderBy: [{ field: 'updatedAt', direction: 'DESC' }],
      search: { query: 'service', fields: ['caseNumber', 'description'] },
      filters: { customers: [2], statuses: [7] },
    });
    expect(toolText(result)).toContain('S-1');
  });

  it('reads creditor master data through dedicated tools', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [{ id: '70587114', number: '70587114', name: 'Carl Ras A/S', vatNumber: '70587114' }],
      },
    });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const searchTool = registered.ordrestyring_search_creditors;
    if (!searchTool) {
      throw new Error('ordrestyring_search_creditors was not registered');
    }

    const result = await searchTool.handler({ query: 'Carl Ras', page: 1, limit: 5 });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(requestBody.query).toContain('result: creditors');
    expect(requestBody.variables).toMatchObject({
      pagination: { page: 1, limit: 5 },
      search: { query: 'Carl Ras', fields: ['name', 'number', 'vatNumber'] },
    });
    expect(toolText(result)).toContain('Carl Ras A/S');
  });

  it('reads products through dedicated product tools', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [{ id: 1, number: 'P-100', description: 'Service product', isHour: false }],
      },
    });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const searchTool = registered.ordrestyring_search_products;
    if (!searchTool) {
      throw new Error('ordrestyring_search_products was not registered');
    }

    const result = await searchTool.handler({ query: 'P-100', productType: 'ITEMS', page: 1, limit: 5 });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(requestBody.query).toContain('result: products');
    expect(requestBody.variables).toMatchObject({
      pagination: { page: 1, limit: 5 },
      search: { query: 'P-100', fields: ['number', 'description'] },
      type: 'ITEMS',
    });
    expect(toolText(result)).toContain('Service product');
  });

  it('prepares curated operational mutations without calling Ordrestyring mutations', async () => {
    const fetchMock = mockSchemaFetch();
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const prepareTool = registered.ordrestyring_prepare_operational_mutation;
    if (!prepareTool) {
      throw new Error('ordrestyring_prepare_operational_mutation was not registered');
    }

    const result = await prepareTool.handler({
      operation: 'create_case',
      input: { customerId: 1, description: 'Install pump', statusId: 2 },
      reason: 'Customer approved work.',
    });
    const prepared = JSON.parse(toolText(result)) as {
      preparedMutation: { query: string; variables: Record<string, unknown>; mutationNames: string[] };
    };

    expect(prepared.preparedMutation.query).toContain('createCase(input: $input)');
    expect(prepared.preparedMutation.variables).toMatchObject({
      input: { customerId: 1, description: 'Install pump', statusId: 2 },
    });
    expect(prepared.preparedMutation.mutationNames).toEqual(['createCase']);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks direct operational writes when writes are disabled', async () => {
    delete process.env.ORDRESTYRING_ENABLE_WRITES;
    const fetchMock = mockSchemaFetch();
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const writeTool = registered.ordrestyring_create_offer;
    if (!writeTool) {
      throw new Error('ordrestyring_create_offer was not registered');
    }

    await expect(
      writeTool.handler({
        input: { customerId: 1, description: 'Offer' },
        reason: 'Customer requested offer.',
        idempotencyKey: 'offer-disabled',
      }),
    ).rejects.toThrow(/writes are disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commits direct operational writes when writes and policy allow them', async () => {
    process.env.ORDRESTYRING_ENABLE_WRITES = 'true';
    process.env.ORDRESTYRING_POLICY_PATH = await writePolicy({
      writesEnabled: true,
      allowedMutations: ['createOffer'],
    });
    const fetchMock = mockSchemaFetch({ createOffer: { id: 33, description: 'Offer' } });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const writeTool = registered.ordrestyring_create_offer;
    if (!writeTool) {
      throw new Error('ordrestyring_create_offer was not registered');
    }

    const result = await writeTool.handler({
      input: { customerId: 1, description: 'Offer' },
      reason: 'Customer requested offer.',
      idempotencyKey: 'offer-allowed',
    });
    const response = JSON.parse(toolText(result)) as {
      operation: string;
      mutationNames: string[];
      result: Record<string, unknown>;
    };
    const mutationBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(response.operation).toBe('create_offer');
    expect(response.mutationNames).toEqual(['createOffer']);
    expect(response.result).toMatchObject({ createOffer: { id: 33 } });
    expect(mutationBody.query).toContain('createOffer(input: $input)');
    expect(mutationBody.variables).toMatchObject({
      input: { customerId: 1, description: 'Offer' },
    });
  });

  it('deletes products one id at a time for reliable placeholder cleanup', async () => {
    process.env.ORDRESTYRING_ENABLE_WRITES = 'true';
    process.env.ORDRESTYRING_POLICY_PATH = await writePolicy({
      writesEnabled: true,
      allowedMutations: ['deleteProduct'],
    });
    const fetchMock = mockSchemaFetch({ deleteProduct: null });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const writeTool = registered.ordrestyring_delete_products;
    if (!writeTool) {
      throw new Error('ordrestyring_delete_products was not registered');
    }

    const result = await writeTool.handler({
      input: { ids: [14, 13] },
      reason: 'Clean trial placeholders.',
      idempotencyKey: 'delete-placeholders',
    });
    const response = JSON.parse(toolText(result)) as {
      operation: string;
      result: Array<{ id: number; result: Record<string, unknown> }>;
    };
    const firstMutationBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const secondMutationBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      variables: Record<string, unknown>;
    };

    expect(response.operation).toBe('delete_products');
    expect(response.result.map(item => item.id)).toEqual([14, 13]);
    expect(firstMutationBody.query).toContain('deleteProduct(id: $id)');
    expect(firstMutationBody.variables).toMatchObject({ id: [14] });
    expect(secondMutationBody.variables).toMatchObject({ id: [13] });
  });

  it('uses live Ordrestyring roots and required defaults for hours and materials', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [{ id: 9, description: 'Cable', quantity: 2 }],
        nextCursor: null,
        previousCursor: null,
      },
    });
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);

    await registered.ordrestyring_list_case_time_entries?.handler({
      caseId: 1,
      cursor: null,
      limit: 5,
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
    });
    await registered.ordrestyring_list_case_materials?.handler({
      caseId: 1,
      cursor: null,
      limit: 5,
    });

    const hourBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const materialBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(hourBody.query).toContain('result: hours');
    expect(hourBody.variables).toMatchObject({
      filters: { case: 1 },
      between: { field: 'startTime', from: 1767225600, to: 1769904000 },
    });
    expect(materialBody.query).toContain('result: caseMaterials');
    expect(materialBody.variables).toMatchObject({
      type: 'MATERIAL',
      filters: { caseIds: [1] },
    });
  });

  it('audits tool calls without writing raw targets or tokens', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ordrestyring-audit-'));
    const auditPath = join(tempDir, 'audit.jsonl');
    process.env.ORDRESTYRING_AUDIT_LOG = auditPath;
    const registered = captureRegisteredTools();

    const discoveryTool = registered.ordrestyring_search_capabilities;
    if (!discoveryTool) {
      throw new Error('ordrestyring_search_capabilities was not registered');
    }

    await discoveryTool.handler({ query: 'cases', limit: 5 });

    const auditText = await readFile(auditPath, 'utf8');
    const records = auditText
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tool: 'ordrestyring_search_capabilities',
      action: 'start',
    });
    expect(records[1]).toMatchObject({
      tool: 'ordrestyring_search_capabilities',
      action: 'finish',
      status: 'ok',
    });
    expect(auditText).not.toContain('cases');
    expect(auditText).not.toContain('ORDRESTYRING_API_TOKEN');
  });

  it('rejects mutations through the read GraphQL tool before calling fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const registered = captureRegisteredTools(fetchMock as unknown as typeof fetch);
    const readTool = registered.ordrestyring_graphql_read;
    if (!readTool) {
      throw new Error('ordrestyring_graphql_read was not registered');
    }

    await expect(
      readTool.handler({
        query: 'mutation { updateUser(id: 1, input: {}) { id } }',
        variables: {},
      }),
    ).rejects.toThrow(/Only GraphQL query/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function captureRegisteredTools(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch): Record<
  string,
  {
    config: { annotations?: unknown };
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }
> {
  const registered: Record<
    string,
    {
      config: { annotations?: unknown };
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }
  > = {};
  const server = {
    registerTool: vi.fn((name: string, config: { annotations?: unknown }, handler) => {
      registered[name] = { config, handler };
    }),
  };
  const client = new OrdrestyringClient({
    apiToken: 'test-token',
    baseUrl: 'https://example.test',
    fetchImpl,
  });

  registerOrdrestyringTools(server as never, client);

  return registered;
}

function toolText(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
}

function mockSchemaFetch(payload: Record<string, unknown> = {}): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    if (body.query?.includes('__schema')) {
      return jsonResponse({ data: { __schema: mockSchema() } });
    }

    return jsonResponse({ data: payload });
  });
}

function mockSchema() {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      objectType('Query', [
        field('cases', named('CaseConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
          arg('filters', named('CaseFilterInput')),
        ]),
        field('hours', named('HourConnection'), [
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('between', named('HourBetweenInput')),
          arg('filters', named('HoursFilterInput')),
        ]),
        field('caseMaterials', named('CaseMaterialConnection'), [
          arg('caseId', named('Int')),
          arg('type', nonNull(named('AddedBy'))),
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('filters', named('CaseMaterialsFilterInput')),
        ]),
        field('creditors', named('CreditorConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
        ]),
        field('creditor', named('Creditor'), [arg('number', nonNull(named('String')))]),
        field('products', named('ProductConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('type', named('ProductTypeEnum')),
          arg('search', named('Search')),
        ]),
        field('product', named('Product'), [arg('id', nonNull(named('Int')))]),
        field('hourTypes', named('HourTypeConnection'), [
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
          arg('requireCase', named('Boolean')),
          arg('allHourTypes', named('Boolean')),
        ]),
      ]),
      objectType('Mutation', [
        field('createCase', named('Case'), [arg('input', nonNull(named('CreateCaseInput')))]),
        field('createOffer', named('Offer'), [arg('input', nonNull(named('CreateOfferInput')))]),
        field('createProduct', named('Product'), [arg('input', nonNull(named('CreateProductInput')))]),
        field('updateProduct', named('Product'), [
          arg('id', nonNull(named('Int'))),
          arg('input', nonNull(named('UpdateProductInput'))),
        ]),
        field('deleteProduct', named('Null'), [arg('id', list(nonNull(named('Int'))))]),
        field('createHourType', named('HourType'), [arg('input', nonNull(named('CreateHourTypeInput')))]),
        field('updateHourType', named('HourType'), [
          arg('id', nonNull(named('Int'))),
          arg('input', nonNull(named('UpdateHourTypeInput'))),
        ]),
      ]),
      objectType('CaseConnection', [
        field('items', list(named('Case'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Case', [
        field('id', named('Int')),
        field('caseNumber', named('String')),
        field('status', named('String')),
        field('customer', named('Customer')),
      ]),
      objectType('HourConnection', [
        field('items', list(named('Hour'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Hour', [
        field('id', named('Int')),
        field('description', named('String')),
        field('startTime', named('Int')),
        field('billableHours', named('Float')),
      ]),
      objectType('CaseMaterialConnection', [
        field('items', list(named('CaseMaterial'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('CaseMaterial', [
        field('id', named('Int')),
        field('description', named('String')),
        field('quantity', named('Float')),
        field('type', named('AddedBy')),
      ]),
      objectType('CreditorConnection', [
        field('items', list(named('Creditor'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Creditor', [
        field('id', named('String')),
        field('number', named('String')),
        field('name', named('String')),
        field('address', named('String')),
        field('postalCode', named('String')),
        field('city', named('String')),
        field('vatNumber', named('String')),
      ]),
      objectType('ProductConnection', [
        field('items', list(named('Product'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Product', [
        field('id', named('Int')),
        field('number', named('String')),
        field('description', named('String')),
        field('isHour', named('Boolean')),
        field('costPrice', named('Float')),
        field('listPrice', named('Float')),
      ]),
      objectType('HourTypeConnection', [
        field('items', list(named('HourType'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('HourType', [
        field('id', named('Int')),
        field('name', named('String')),
        field('requireCase', named('Boolean')),
        field('color', named('String')),
        field('sortOrder', named('Int')),
        field('product', named('Product')),
      ]),
      objectType('Customer', [field('id', named('Int')), field('name', named('String'))]),
      objectType('Offer', [
        field('id', named('Int')),
        field('number', named('String')),
        field('description', named('String')),
      ]),
      inputType('PaginationInput', [inputField('cursor', named('String')), inputField('limit', nonNull(named('Int')))]),
      inputType('OrderByInput', [inputField('field', nonNull(named('String'))), inputField('direction', nonNull(named('Direction')))]),
      inputType('Search', [inputField('query', named('String')), inputField('fields', nonNull(list(named('String'))))]),
      inputType('CaseFilterInput', [inputField('statuses', list(named('Int'))), inputField('customers', list(named('Int')))]),
      inputType('HoursFilterInput', [inputField('case', named('Int')), inputField('users', list(named('Int')))]),
      inputType('HourBetweenInput', [
        inputField('field', nonNull(named('HourBetweenColumn'))),
        inputField('from', named('Int')),
        inputField('to', named('Int')),
      ]),
      inputType('CaseMaterialsFilterInput', [inputField('caseIds', list(named('Int')))]),
      inputType('CreateCaseInput', [
        inputField('customerId', nonNull(named('Int'))),
        inputField('description', nonNull(named('String'))),
        inputField('statusId', nonNull(named('Int'))),
      ]),
      inputType('CreateOfferInput', [
        inputField('customerId', nonNull(named('Int'))),
        inputField('description', named('String')),
      ]),
      inputType('CreateProductInput', [
        inputField('number', nonNull(named('String'))),
        inputField('description', nonNull(named('String'))),
        inputField('costPrice', nonNull(named('Float'))),
        inputField('listPrice', nonNull(named('Float'))),
        inputField('isHour', nonNull(named('Boolean'))),
      ]),
      inputType('UpdateProductInput', [
        inputField('number', named('String')),
        inputField('description', named('String')),
        inputField('costPrice', named('Float')),
        inputField('listPrice', named('Float')),
      ]),
      inputType('CreateHourTypeInput', [
        inputField('name', nonNull(named('String'))),
        inputField('productNumber', named('String')),
        inputField('requireCase', nonNull(named('Boolean'))),
        inputField('color', nonNull(named('String'))),
      ]),
      inputType('UpdateHourTypeInput', [
        inputField('name', named('String')),
        inputField('productNumber', named('String')),
        inputField('color', named('String')),
        inputField('sortOrder', named('Int')),
      ]),
      enumType('Direction', ['ASC', 'DESC']),
      enumType('ProductTypeEnum', ['ITEMS', 'HOURS']),
      enumType('HourBetweenColumn', ['id', 'startTime', 'createdAt', 'updatedAt']),
      enumType('AddedBy', ['MATERIAL', 'OFFER']),
      scalarType('Boolean'),
      scalarType('Float'),
      scalarType('Int'),
      scalarType('Null'),
      scalarType('String'),
    ],
  };
}

function objectType(name: string, fields: unknown[]) {
  return { kind: 'OBJECT', name, fields, inputFields: null, enumValues: null };
}

function inputType(name: string, inputFields: unknown[] = []) {
  return { kind: 'INPUT_OBJECT', name, fields: null, inputFields, enumValues: null };
}

function enumType(name: string, values: string[]) {
  return {
    kind: 'ENUM',
    name,
    fields: null,
    inputFields: null,
    enumValues: values.map(value => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })),
  };
}

function scalarType(name: string) {
  return { kind: 'SCALAR', name, fields: null, inputFields: null, enumValues: null };
}

function field(name: string, type: unknown, args: unknown[] = []) {
  return { name, description: null, isDeprecated: false, deprecationReason: null, args, type };
}

function arg(name: string, type: unknown) {
  return { name, description: null, defaultValue: null, type };
}

function inputField(name: string, type: unknown) {
  return { name, description: null, defaultValue: null, type };
}

function named(name: string) {
  const scalarNames = new Set(['Int', 'String', 'Boolean', 'Float', 'ID', 'Null']);
  return { kind: scalarNames.has(name) ? 'SCALAR' : 'OBJECT', name, ofType: null };
}

function list(ofType: unknown) {
  return { kind: 'LIST', name: null, ofType };
}

function nonNull(ofType: unknown) {
  return { kind: 'NON_NULL', name: null, ofType };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

async function writePolicy(policy: unknown): Promise<string> {
  tempDir = tempDir ?? (await mkdtemp(join(tmpdir(), 'ordrestyring-policy-')));
  const path = join(tempDir, `policy-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, JSON.stringify(policy), 'utf8');
  return path;
}
