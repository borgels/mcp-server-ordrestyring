import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets } from '../src/errors.js';
import {
  createOrdrestyringGateway,
  GatewayConfigError,
  ordrestyringGatewayTools,
  ordrestyringToolCatalog,
} from '../src/gateway.js';

const TOKEN = 'tenant-a-token-0123456789abcdef';
const OTHER = 'tenant-b-token-fedcba9876543210';
const BASE = 'https://example.test';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordrestyring-gateway-'));
  vi.unstubAllEnvs();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them.
  vi.stubEnv('ORDRESTYRING_API_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('ORDRESTYRING_BASE_URL', 'https://env-base.example.test');
  vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', '');
  vi.stubEnv('ORDRESTYRING_AUDIT_LOG', '');
  vi.stubEnv('ORDRESTYRING_POLICY_PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function okFetch() {
  return vi.fn<typeof fetch>(async () => jsonResponse({ data: { __typename: 'Query' } }));
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

describe('Ordrestyring gateway surface', () => {
  it('exposes a stable gateway surface with writes disabled by default', () => {
    expect(ordrestyringGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['check_connection', 'read', true],
      ['search_cases', 'read', true],
      ['get_case_health', 'read', true],
      ['find_billable_cases', 'read', true],
      ['get_invoice_readiness', 'read', true],
      ['create_customer', 'write', false],
      ['delete_products', 'destructive', false],
    ]);
  });

  it('has a deeply frozen catalog with the upstream requests and the broad mark', () => {
    expect(Object.isFrozen(ordrestyringToolCatalog)).toBe(true);
    for (const entry of ordrestyringToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      expect(entry.broad).toBe(false);
      expect(entry.upstream.length).toBeGreaterThan(0);
      for (const op of entry.upstream) expect(op).toMatchObject({ method: 'POST', path: '/graphql' });
      const reads = entry.riskLevel === 'read';
      expect(entry.upstream.some(op => op.operation === 'mutation')).toBe(!reads);
      expect(entry.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(ordrestyringToolCatalog.map(entry => entry.name)).toEqual(ordrestyringGatewayTools.map(tool => tool.name));
    expect(() => {
      (ordrestyringToolCatalog[0] as { broad: boolean }).broad = true;
    }).toThrow();
  });

  it('derives each input schema from the zod schema the call is validated with', () => {
    const health = ordrestyringToolCatalog.find(entry => entry.name === 'get_case_health')!;
    expect(health.inputSchema).toMatchObject({ required: ['caseId'] });
    expect(Object.keys(health.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(['caseId', 'includeSubCases', 'cursor', 'limit']),
    );
  });
});

describe('Ordrestyring gateway credentials', () => {
  it('requires apiToken and never reads ORDRESTYRING_API_TOKEN', () => {
    expect(() => createOrdrestyringGateway({} as never)).toThrow(GatewayConfigError);
    expect(() => createOrdrestyringGateway(undefined as never)).toThrow(/requires options\.apiToken/);
    expect(() => createOrdrestyringGateway({ apiToken: '   ' })).toThrow(GatewayConfigError);
  });

  it('refuses a token shorter than the redactor protects', () => {
    expect(() => createOrdrestyringGateway({ apiToken: 'short7!' })).toThrow(/key was refused/);
    expect(() => createOrdrestyringGateway({ apiToken: '123456789012345' })).toThrow(/key was refused/);
    expect(() => createOrdrestyringGateway({ apiToken: '1234567890123456' })).not.toThrow();
  });

  it('uses the Ordrestyring API, never ORDRESTYRING_BASE_URL, and only its own token', async () => {
    const fetchImpl = okFetch();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, fetchImpl });

    const result = await gateway.callTool('check_connection');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, typename: 'Query' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://graphql.ordrestyring.dk/graphql');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it('accepts names with or without the prefix', async () => {
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: okFetch() });
    await expect(gateway.callTool('ordrestyring_check_connection')).resolves.not.toHaveProperty('isError');
  });
});

describe('Ordrestyring gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = okFetch();
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl, policy: { audit } });

    for (const [tool, input] of [
      ['get_case_health', { caseId: -1 }],
      ['get_case_health', {}],
      ['search_cases', { query: 'x', apiToken: 'smuggled' }],
      ['check_connection', { anything: true }],
    ] as const) {
      const result = await gateway.callTool(tool, input as never);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]?.text, tool).toMatch(/^Invalid input for /);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => [record.action, record.reason])).toEqual(
      Array.from({ length: 4 }, () => ['rejected', 'invalid input']),
    );
  });

  it('returns an error for unsupported tools, also for MCP server tools outside the gateway', async () => {
    const fetchImpl = okFetch();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl });

    await expect(gateway.callTool('unknown_tool')).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Unsupported Ordrestyring gateway tool: unknown_tool' }],
    });
    const graphql = await gateway.callTool('graphql_read', { query: '{ __typename }' });
    expect(graphql.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Ordrestyring gateway policy', () => {
  it('blocks write calls by default before contacting Ordrestyring', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl });

    const result = await gateway.callTool('create_customer', {
      input: { name: 'ACME ApS' },
      reason: 'Approved test setup.',
      idempotencyKey: 'customer-acme',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/writes are disabled/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('under a host policy reads no policy or audit variables, and words refusals for the host', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', 'true');
    vi.stubEnv('ORDRESTYRING_AUDIT_LOG', auditFile);
    vi.stubEnv('ORDRESTYRING_POLICY_PATH', join(dir, 'missing-policy.json'));
    const fetchImpl = vi.fn<typeof fetch>();
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl, policy: { audit } });

    const result = await gateway.callTool(
      'create_customer',
      { input: { name: 'ACME ApS' }, reason: 'Approved test setup.', idempotencyKey: 'customer-acme' },
      { caller: 'person-1', requestId: 'call-1' },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('The embedding host has not enabled writes for this instance.');
    expect(result.content[0]?.text).not.toContain('ORDRESTYRING_');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(auditFile)).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: 'ordrestyring_create_customer',
      action: 'policy_denied',
      caller: 'person-1',
      requestId: 'call-1',
    });
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = okFetch();
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl,
      policy: { disabledTools: ['check_connection', 'ordrestyring_delete_products'], audit },
    });

    expect(gateway.tools.map(tool => tool.name)).not.toContain('check_connection');
    expect(gateway.tools.map(tool => tool.name)).not.toContain('delete_products');
    expect(gateway.tools).toHaveLength(5);
    const result = await gateway.callTool('check_connection');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled on this instance by the embedding host');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => record.action)).toEqual(['policy_denied']);

    expect(() =>
      createOrdrestyringGateway({ apiToken: TOKEN, policy: { disabledTools: ['graphql_read'] } }),
    ).toThrow(GatewayConfigError);
    expect(() => createOrdrestyringGateway({ apiToken: TOKEN, policy: { enableWrites: 'yes' as never } })).toThrow(
      GatewayConfigError,
    );
  });

  it('writes start and finish records with the call context to the host sink, and nothing to the env audit log', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('ORDRESTYRING_AUDIT_LOG', auditFile);
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: okFetch(), policy: { audit } });

    await gateway.callTool('check_connection', {}, { caller: 'person-1', requestId: 'call-7' });

    expect(records.map(record => [record.action, record.caller, record.requestId])).toEqual([
      ['start', 'person-1', 'call-7'],
      ['finish', 'person-1', 'call-7'],
    ]);
    expect(existsSync(auditFile)).toBe(false);
  });

  it('does not run a tool whose start record the sink refuses', async () => {
    const fetchImpl = okFetch();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl,
      policy: {
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const result = await gateway.callTool('check_connection');
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Ordrestyring gateway redaction', () => {
  it('redacts the token from upstream errors and from every audit record field', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(`token ${TOKEN} rejected`, {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl, policy: { audit } });

    const result = await gateway.callTool('check_connection', {}, { caller: `person ${TOKEN}`, requestId: TOKEN });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(records[0]?.caller).toBe('person ‹redacted›');
  });

  it('redacts an unknown tool name before cutting it short, so no part of the token is left', async () => {
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: okFetch(), policy: { audit } });
    const name = `${'x'.repeat(90)}${TOKEN}`;

    const result = await gateway.callTool(name);

    const everything = JSON.stringify([result, records]);
    for (const piece of [TOKEN, TOKEN.slice(0, 10), TOKEN.slice(0, 8)]) expect(everything).not.toContain(piece);
    expect(records.map(record => [record.action, record.reason])).toEqual([['rejected', 'unsupported tool']]);
  });

  it('keeps no process-wide registry: an instance token is not redacted outside its calls', async () => {
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: okFetch() });
    await gateway.callTool('check_connection');
    expect(redactSecrets(`plain ${TOKEN}`)).toBe(`plain ${TOKEN}`);
  });
});

describe('Ordrestyring gateway call scopes', () => {
  it('keeps two tenants apart when they call at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      await gate;
      return jsonResponse({ errors: [{ message: `echo ${String((init?.headers as Record<string, string>).Authorization)}` }] });
    });
    const a = sink();
    const b = sink();
    const gatewayA = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl, policy: { audit: a.audit } });
    const gatewayB = createOrdrestyringGateway({ apiToken: OTHER, baseUrl: BASE, fetchImpl, policy: { audit: b.audit } });

    const both = Promise.all([
      gatewayA.callTool('check_connection', {}, { caller: 'a' }),
      gatewayB.callTool('check_connection', {}, { caller: 'b' }),
    ]);
    for (let i = 0; i < 50 && seen.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(seen.sort()).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER}`].sort());
    release();
    const [ra, rb] = await both;

    expect(JSON.stringify(ra)).not.toContain(TOKEN);
    expect(JSON.stringify(rb)).not.toContain(OTHER);
    expect(a.records.every(record => record.caller === 'a')).toBe(true);
    expect(b.records.every(record => record.caller === 'b')).toBe(true);
    expect(JSON.stringify(a.records)).not.toContain(TOKEN);
    expect(JSON.stringify(b.records)).not.toContain(OTHER);
  });

  it('runs a call made from inside another instance’s sink under its own scope, not the outer policy', async () => {
    const outer = sink();
    const innerFetch = okFetch();
    const inner = createOrdrestyringGateway({ apiToken: OTHER, baseUrl: BASE, fetchImpl: innerFetch });
    let innerResult: unknown;
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: okFetch(),
      policy: {
        disabledTools: [],
        audit: async record => {
          outer.audit(record);
          if (record.action === 'start' && innerResult === undefined) {
            innerResult = 'pending';
            innerResult = await inner.callTool('check_connection', {}, { caller: 'inner' });
          }
        },
      },
    });

    await gateway.callTool('check_connection', {}, { caller: 'outer' });

    expect(innerResult).toMatchObject({ structuredContent: { ok: true } });
    expect(innerFetch).toHaveBeenCalledOnce();
    // The inner, policy-less call wrote nothing to the outer instance's sink.
    expect(outer.records.map(record => record.caller)).toEqual(['outer', 'outer']);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
