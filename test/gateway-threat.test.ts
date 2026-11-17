// The rest of the threat model (README, "Threat model"), through callTool: a token that is a number, a schema
// whose type names are short pieces of the token, an error while reading a successful body, failures reported
// inside a successful body, and a response too deep to serialise naively. Every result text must still be JSON.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrdrestyringGateway, type GatewayToolResult } from '../src/gateway.js';
import { mockSchema } from './schema-fixture.js';

const BASE = 'https://example.test';
const DEEP = 20_000;
const DEEP_VALUE = 'plainvalue-9876543210';

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['ORDRESTYRING_ENABLE_WRITES', 'ORDRESTYRING_AUDIT_LOG', 'ORDRESTYRING_POLICY_PATH', 'ORDRESTYRING_TIMEOUT_MS']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Answer = (operation: string) => Response;

function upstream(answer: Answer, schema: unknown = mockSchema()): typeof fetch {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const operation = /query\s+(\w+)/.exec(body.query ?? '')?.[1] ?? '';
    if (operation === 'OrdrestyringMcpFullIntrospection') return json({ data: { __schema: schema } });
    return answer(operation);
  });
}

/** Every result's text parses as JSON when it is JSON at all, and its data matches the text. */
function expectValidJson(result: GatewayToolResult): void {
  const text = result.content[0]?.text ?? '';
  if (text.startsWith('{') || text.startsWith('[')) {
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  }
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric token and its pieces in numbers, and the text stays valid JSON', async () => {
    const NUMERIC = '12345678';
    const records: unknown[] = [];
    const answers = [Number(NUMERIC), Number(NUMERIC.slice(1, 7)), Number(`${NUMERIC}9`)];
    let call = 0;
    const gateway = createOrdrestyringGateway({
      apiToken: NUMERIC,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: { __typename: answers[call++ % answers.length] } })),
      policy: { audit: record => void records.push(record) },
    });
    for (let i = 0; i < answers.length; i += 1) {
      const result = await gateway.callTool('check_connection', {});
      expect(result.isError, result.content[0]?.text).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true, typename: '[REDACTED]' });
      expectValidJson(result);
      expect(JSON.stringify(result)).not.toMatch(/234567|12345678/);
    }
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('does not quote schema names, even pieces of the token too short to redact', async () => {
    const VALUE = 'abcdeFGHIJK12345';
    const piece = VALUE.slice(0, 5);
    const schema = mockSchema() as { types: Array<{ name: string; fields: Array<{ name: string; type: unknown }> | null }> };
    const query = schema.types.find(type => type.name === 'Query')!;
    for (const field of query.fields!) {
      if (field.name === 'cases') field.type = { kind: 'OBJECT', name: piece, ofType: null };
    }
    const records: unknown[] = [];
    const gateway = createOrdrestyringGateway({
      apiToken: VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: {} }), schema),
      policy: { audit: record => void records.push(record) },
    });
    const result = await gateway.callTool('search_cases', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/schema/i);
    expect(JSON.stringify(result)).not.toContain(piece);
    expect(JSON.stringify(records)).not.toContain(piece);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const VALUE = 'plainvalue-0123456789';
    const records: unknown[] = [];
    const failing = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            controller.error(new Error(`Vendor diagnostic ${VALUE.slice(0, 5)}`));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const gateway = createOrdrestyringGateway({
      apiToken: VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(failing),
      policy: { audit: record => void records.push(record) },
    });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('The Ordrestyring GraphQL response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(VALUE.slice(0, 5));
    }
  });

  it('keeps no vendor text from failures reported inside a successful body', async () => {
    const VALUE = 'plainvalue-0123456789';
    const gateway = createOrdrestyringGateway({
      apiToken: VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() =>
        json({ data: { __typename: 'Query' }, errors: [{ message: `Vendor detail ${VALUE.slice(0, 5)}`, path: ['Vendor path'] }] }),
      ),
    });
    for (const result of [await gateway.callTool('check_connection', {}), await gateway.callTool('get_case_health', { caseId: 1 })]) {
      expect(JSON.stringify(result)).not.toContain('Vendor');
      expect(JSON.stringify(result)).not.toContain(VALUE.slice(0, 5));
      expectValidJson(result);
    }
  });

  it('answers a very deep response without exhausting the stack', async () => {
    const gateway = createOrdrestyringGateway({
      apiToken: DEEP_VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(
        () =>
          new Response(`{"data":{"__typename":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(JSON.stringify(result)).toContain('[nested too deep]');
    expectValidJson(result);
  });
});
