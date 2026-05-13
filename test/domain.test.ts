import { describe, expect, it, vi } from 'vitest';
import { OrdrestyringClient } from '../src/ordrestyring/client.js';
import { readDomainCollection, summarizeDomainCollection } from '../src/ordrestyring/domain.js';

describe('Ordrestyring domain query builder', () => {
  it('sends only schema-supported collection arguments', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [{ id: 1, hours: 2, ignored: 7 }],
        nextCursor: null,
        previousCursor: null,
      },
    });
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await readDomainCollection(
      client,
      {
        operationName: 'TestTime',
        rootCandidates: ['timeEntries'],
        preferredScalars: ['id', 'hours'],
      },
      { caseId: 123, customerId: 456, limit: 10 },
    );

    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };

    expect(requestBody.query).toContain('caseId: $caseId');
    expect(requestBody.query).not.toContain('customerId');
    expect(requestBody.variables).toMatchObject({
      pagination: { cursor: null, limit: 10 },
      caseId: 123,
    });
  });

  it('summarizes numeric time-like fields locally', async () => {
    const fetchMock = mockSchemaFetch({
      result: {
        items: [
          { id: 1, hours: 2, price: 100, ignored: 7 },
          { id: 2, hours: 3, price: 50, ignored: 11 },
        ],
      },
    });
    const client = new OrdrestyringClient({
      apiToken: 'test-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const result = await summarizeDomainCollection(
      client,
      {
        operationName: 'TestTimeSummary',
        rootCandidates: ['timeEntries'],
        preferredScalars: ['id', 'hours', 'price'],
      },
      { limit: 10 },
    );

    expect(result).toMatchObject({
      summary: {
        itemCount: 2,
        numericTotals: {
          hours: 5,
          price: 150,
        },
      },
    });
  });
});

function mockSchemaFetch(payload: Record<string, unknown>): ReturnType<typeof vi.fn<typeof fetch>> {
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
        field('timeEntries', named('TimeEntryConnection'), [
          arg('pagination', named('PaginationInput')),
          arg('caseId', named('Int')),
        ]),
      ]),
      objectType('Mutation', []),
      objectType('TimeEntryConnection', [
        field('items', list(named('TimeEntry'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('TimeEntry', [
        field('id', named('Int')),
        field('hours', named('Float')),
        field('price', named('Float')),
      ]),
      inputType('PaginationInput'),
      scalarType('Int'),
      scalarType('Float'),
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
