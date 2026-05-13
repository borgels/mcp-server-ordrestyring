import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCapabilities } from '../src/ordrestyring/capabilities.js';
import { OrdrestyringClient } from '../src/ordrestyring/client.js';
import { registerOrdrestyringTools } from '../src/tools/ordrestyring.js';

const originalAuditLog = process.env.ORDRESTYRING_AUDIT_LOG;
let tempDir: string | undefined;

describe('Ordrestyring tool hardening', () => {
  afterEach(async () => {
    if (originalAuditLog === undefined) {
      delete process.env.ORDRESTYRING_AUDIT_LOG;
    } else {
      process.env.ORDRESTYRING_AUDIT_LOG = originalAuditLog;
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
      'ordrestyring_search_schema',
      'ordrestyring_get_schema_type',
      'ordrestyring_refresh_schema',
      'ordrestyring_list_cases',
      'ordrestyring_get_case',
      'ordrestyring_search_cases',
      'ordrestyring_get_case_overview',
      'ordrestyring_search_customers',
      'ordrestyring_get_customer_overview',
      'ordrestyring_list_case_time_entries',
      'ordrestyring_summarize_time',
      'ordrestyring_list_case_materials',
      'ordrestyring_get_case_financials',
      'ordrestyring_list_schedule',
      'ordrestyring_list_case_documents',
      'ordrestyring_list_case_quality_checks',
      'ordrestyring_list_invoice_drafts',
      'ordrestyring_get_business_report',
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
      status: 'open',
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
    expect(requestBody.query).toContain('customer { id name }');
    expect(requestBody.variables).toMatchObject({
      pagination: { cursor: null, limit: 5 },
      orderBy: { field: 'updatedAt', direction: 'DESC' },
      query: 'service',
      status: 'open',
      customerId: 2,
    });
    expect(toolText(result)).toContain('S-1');
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
          arg('pagination', named('PaginationInput')),
          arg('orderBy', named('OrderByInput')),
          arg('query', named('String')),
          arg('status', named('String')),
          arg('customerId', named('Int')),
        ]),
      ]),
      objectType('Mutation', []),
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
      objectType('Customer', [field('id', named('Int')), field('name', named('String'))]),
      inputType('PaginationInput'),
      inputType('OrderByInput'),
      scalarType('Int'),
      scalarType('String'),
    ],
  };
}

function objectType(name: string, fields: unknown[]) {
  return { kind: 'OBJECT', name, fields, inputFields: null, enumValues: null };
}

function inputType(name: string) {
  return { kind: 'INPUT_OBJECT', name, fields: null, inputFields: [], enumValues: null };
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

function named(name: string) {
  const scalarNames = new Set(['Int', 'String', 'Boolean', 'Float', 'ID']);
  return { kind: scalarNames.has(name) ? 'SCALAR' : 'OBJECT', name, ofType: null };
}

function list(ofType: unknown) {
  return { kind: 'LIST', name: null, ofType };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
