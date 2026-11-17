// The rest of the threat model (README, "Threat model"), through callTool: a token that is a number, a schema
// whose type names are short pieces of the token, an error while reading a successful body, failures reported
// inside a successful body, and a response too deep to serialise naively. Every result text must still be JSON.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrdrestyringGateway, type GatewayToolResult } from '../src/gateway.js';
import { nestedFailuresAsStatus } from '../src/errors.js';
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
    const NUMERIC = '1234567890123456';
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
      expect(result.structuredContent).toEqual({ ok: true, typename: '‹redacted›' });
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

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a token that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const apiToken of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createOrdrestyringGateway({ apiToken, baseUrl: BASE, timeoutMs: 5_000 }), apiToken).toThrow(/key was refused/);
    }
    const LOOKALIKE = 'REDACTED-0123456789';
    const records: unknown[] = [];
    const gateway = createOrdrestyringGateway({
      apiToken: LOOKALIKE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: { __typename: `Query ${LOOKALIKE}` } })),
      policy: { audit: record => void records.push(record) },
    });
    const result = await gateway.callTool('check_connection', {}, { caller: LOOKALIKE });
    expectValidJson(result);
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('keeps the result text valid JSON when a piece of the token is JSON syntax', async () => {
    // With a space, as in round 7's counterexample, the token is not printable ASCII without spaces: refused.
    expect(() => createOrdrestyringGateway({ apiToken: 'x"ok": y-0123456789', baseUrl: BASE })).toThrow(/key was refused/);
    const JSONISH = 'x"ok":y-0123456789';
    const gateway = createOrdrestyringGateway({
      apiToken: JSONISH,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: { __typename: 'Query' } })),
    });
    const result = await gateway.callTool('check_connection', {});
    expectValidJson(result);
    const seen = JSON.stringify(result) + result.content.map(part => part.text).join('');
    for (let i = 0; i + 6 <= JSONISH.length; i += 1) expect(seen).not.toContain(JSONISH.slice(i, i + 6));
  });

  it('redacts an audit sink failure that quotes the token', async () => {
    const VALUE = 'plainvalue-5555666677';
    const gateway = createOrdrestyringGateway({
      apiToken: VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: { __typename: 'Query' } })),
      policy: {
        audit: () => {
          throw new Error(`sink failed for ${VALUE}`);
        },
      },
    });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    for (const piece of pieces(VALUE)) expect(JSON.stringify(result), piece).not.toContain(piece);
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const VALUE = 'plainvalue-0123456789';
    const gateway = createOrdrestyringGateway({
      apiToken: VALUE,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(`Vendor diagnostic ${VALUE.slice(0, 5)}`));
              },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/HTTP 500/);
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses tokens that collide with our own texts, without repeating them', () => {
    for (const apiToken of ['[nested too deep]-0123456789', 'ordrestyring-mcp-0123456789', 'ORDRESTYRING_BASE_URL-0123456789']) {
      let message = '';
      try {
        createOrdrestyringGateway({ apiToken, baseUrl: BASE, timeoutMs: 5_000 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, apiToken).toMatch(/key was refused/);
      for (const piece of pieces(apiToken)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createOrdrestyringGateway({ apiToken: HOSTLIKE, baseUrl: `http://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}`, timeoutMs: 5_000 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', () => {
    expect(
      nestedFailuresAsStatus({
        failures: [{ status: 403, message: 'Vendor diagnostic' }],
        metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
        errors: [{ message: 'Vendor diagnostic' }],
        rows: [{ status: 200, message: 'kept' }],
      }),
    ).toEqual({
      failures: [{ status: 403, message: 'Ordrestyring reported a failure with HTTP 403.' }],
      metadata: { status: 401, error: 'Ordrestyring reported a failure with HTTP 401.' },
      errors: [{ message: 'Ordrestyring reported a failure.' }],
      rows: [{ status: 200, message: 'kept' }],
    });
  });

  it('reduces a failure reported inside the data of a successful call', async () => {
    const gateway = createOrdrestyringGateway({
      apiToken: 'plainvalue-4444333322',
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream(() => json({ data: { __typename: { status: 403, message: 'Vendor diagnostic' } } })),
    });
    const result = await gateway.callTool('check_connection', {});
    expect(JSON.stringify(result)).not.toContain('Vendor');
    expectValidJson(result);
  });
});
