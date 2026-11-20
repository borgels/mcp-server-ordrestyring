// The project manager's everyday work through the gateway (issue #48): cases, notes, offers, offer to case and
// materials as write tools, plus the reads they need. Each write sends exactly its own mutation, only when the host
// enables writes; nothing in the new set deletes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrdrestyringGateway, ordrestyringToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { mockSchema } from './schema-fixture.js';

const TOKEN = 'tenant-a-token-0123456789abcdef';
const BASE = 'https://example.test';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', '');
  vi.stubEnv('ORDRESTYRING_AUDIT_LOG', '');
  vi.stubEnv('ORDRESTYRING_POLICY_PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function upstream() {
  const queries: string[] = [];
  const variables: unknown[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: unknown };
    queries.push(body.query ?? '');
    variables.push(body.variables);
    const data = body.query?.includes('__schema') ? { __schema: mockSchema() } : { result: { id: 7 } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const mutations = () => queries.filter(query => /^\s*mutation\b/.test(query));
  return { fetchImpl, queries, variables, mutations };
}

const WRITES: Array<[string, GatewayJsonObject, string]> = [
  ['create_case', { customerId: 3, description: 'Nyt badeværelse', statusId: 1 }, 'createCase(input: $input)'],
  ['create_case_activity', { caseId: 12, description: 'Kunden ringede' }, 'createCaseActivity(input: $input)'],
  ['create_offer', { customerId: 3, description: 'Tilbud på tag' }, 'createOffer(input: $input)'],
  ['convert_offer_to_case', { id: 41 }, 'convertOfferToCase(id: $id, options: $options)'],
  ['create_case_material', { caseId: 12, description: 'Rør', quantity: 2, type: 'MATERIAL' }, 'createCaseMaterial(input: $input)'],
];

describe('project manager tools in the gateway', () => {
  it('lists the new tools as reads and non-destructive writes, none of them broad', () => {
    const byName = new Map(ordrestyringToolCatalog.map(entry => [entry.name, entry]));
    for (const name of ['search_customers', 'search_products', 'search_hour_types', 'list_case_time_entries', 'list_case_materials']) {
      expect(byName.get(name)).toMatchObject({ riskLevel: 'read', enabledByDefault: true, broad: false });
    }
    for (const [name] of WRITES) {
      expect(byName.get(name)).toMatchObject({ riskLevel: 'write', enabledByDefault: false, broad: false });
      expect(byName.get(name)!.inputSchema).toMatchObject({ required: expect.arrayContaining(['reason', 'idempotencyKey']) });
    }
    expect(ordrestyringToolCatalog.filter(entry => entry.riskLevel === 'destructive').map(entry => entry.name)).toEqual([
      'delete_products',
    ]);
  });

  it.each(WRITES)('%s sends only its own mutation when the host enables writes', async (name, input, call) => {
    const api = upstream();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
      policy: { enableWrites: true },
    });

    const result = await gateway.callTool(name, { input, reason: 'Projektlederens arbejde.', idempotencyKey: `${name}-key-1` });

    expect(result.isError).toBeUndefined();
    expect(api.mutations()).toHaveLength(1);
    expect(api.mutations()[0]).toContain(call);
    expect(api.mutations()[0]).not.toMatch(/delete/i);
  });

  it.each(WRITES)('%s contacts nothing while writes are off', async (name, input) => {
    const api = upstream();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: api.fetchImpl, policy: {} });

    const result = await gateway.callTool(name, { input, reason: 'Projektlederens arbejde.', idempotencyKey: `${name}-key-1` });

    expect(result.isError).toBe(true);
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the offer id and options as variables when converting an offer', async () => {
    const api = upstream();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: api.fetchImpl,
      policy: { enableWrites: true },
    });

    await gateway.callTool('convert_offer_to_case', {
      input: { id: 41 },
      reason: 'Kunden har sagt ja.',
      idempotencyKey: 'offer-41-to-case',
    });

    const index = api.queries.findIndex(query => /^\s*mutation\b/.test(query));
    expect(api.variables[index]).toEqual({ id: 41, options: null });
  });

  it('reads hours and materials for a case without any mutation', async () => {
    const api = upstream();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: api.fetchImpl, policy: {} });

    for (const name of ['list_case_time_entries', 'list_case_materials']) {
      const result = await gateway.callTool(name, { caseId: 12 });
      expect(result.isError).toBeUndefined();
    }
    expect(api.mutations()).toEqual([]);
  });
});
