// The gateway's isolation between tenants and from the environment, beyond test/gateway.test.ts: writes under a
// host policy, nesting in both directions, concurrency with different rules, and redaction of everything an
// instance returns or throws.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrdrestyringGateway, GatewayConfigError, type GatewayToolResult } from '../src/gateway.js';
import { mockSchema } from './schema-fixture.js';

const TOKEN = 'tenant-a-token-0123456789abcdef';
const OTHER = 'tenant-b-token-fedcba9876543210';
const BASE = 'https://example.test';
const DELETE = { input: { ids: [14] }, reason: 'Clean placeholders.', idempotencyKey: 'delete-placeholders' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordrestyring-isolation-'));
  vi.unstubAllEnvs();
  vi.stubEnv('ORDRESTYRING_API_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', '');
  vi.stubEnv('ORDRESTYRING_AUDIT_LOG', '');
  vi.stubEnv('ORDRESTYRING_POLICY_PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A GraphQL stand-in: the schema for introspection, `payload` for everything else. Records which bodies were sent. */
function graphql(payload: Record<string, unknown> = { deleteProduct: null }, before?: () => Promise<void>) {
  const bodies: Array<{ query: string; authorization: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    bodies.push({ query: body.query ?? '', authorization: String((init?.headers as Record<string, string>).Authorization) });
    if (body.query?.includes('__schema')) {
      return jsonResponse({ data: { __schema: mockSchema() } });
    }
    await before?.();
    return jsonResponse({ data: payload });
  });
  const mutations = () => bodies.filter(body => /^\s*mutation\b/.test(body.query));
  return { fetchImpl, bodies, mutations };
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

function everything(...values: unknown[]): string {
  return JSON.stringify(values);
}

describe('writes under a host policy', () => {
  it('runs an allowed write without reading the policy file or ORDRESTYRING_ENABLE_WRITES', async () => {
    // An environment that would refuse every write and cannot even be read.
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, '{ not json');
    vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', 'false');
    vi.stubEnv('ORDRESTYRING_POLICY_PATH', policyFile);
    const upstream = graphql();
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: upstream.fetchImpl,
      policy: { enableWrites: true, audit },
    });

    const result = await gateway.callTool('delete_products', DELETE, { caller: 'owner-1' });

    expect(result.isError).toBeUndefined();
    expect(upstream.mutations()).toHaveLength(1);
    expect(upstream.mutations()[0]?.query).toContain('deleteProduct(id: $id)');
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
  });

  it('sends no mutation when the sink refuses the start record of a write', async () => {
    const upstream = graphql();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: upstream.fetchImpl,
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'start') throw new Error('audit store down');
        },
      },
    });

    const result = await gateway.callTool('delete_products', DELETE);

    expect(result.isError).toBe(true);
    expect(upstream.bodies).toEqual([]);
  });
});

describe('redaction of what an instance returns or throws', () => {
  it('redacts the token from a successful result, in its text, its data and its keys', async () => {
    const upstream = graphql({ deleteProduct: { [`key ${TOKEN}`]: `value ${TOKEN}` } });
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: upstream.fetchImpl,
      policy: { enableWrites: true },
    });
    const echo = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse({ data: { __typename: `Query ${TOKEN}` } })),
    });

    const deleted = await gateway.callTool('delete_products', DELETE);
    const checked = await echo.callTool('check_connection');

    expect(deleted.isError).toBeUndefined();
    expect(checked.isError).toBeUndefined();
    expect(everything(deleted, checked)).not.toContain(TOKEN);
    expect(everything(deleted)).toContain('key ‹redacted›');
    expect(checked.structuredContent).toMatchObject({ typename: 'Query ‹redacted›' });
  });

  it('redacts a header value before cutting it short, in the result and in the audit record', async () => {
    const { records, audit } = sink();
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse({ errors: [{ message: 'slow down' }] }, 400, {
          'retry-after': `${'x'.repeat(60)}${TOKEN}`,
          'x-ratelimit-limit': `${'y'.repeat(62)}${TOKEN}`,
          'x-ratelimit-remaining': `${'z'.repeat(63)}${TOKEN}`,
        }),
      ),
      policy: { audit },
    });

    const result = await gateway.callTool('check_connection');

    expect(result.isError).toBe(true);
    for (const piece of [TOKEN, TOKEN.slice(0, 4)]) {
      expect(everything(result.content[0]?.text.replace(/[xyz]{60,}/g, ''), records), piece).not.toContain(piece);
    }
  });

  it('redacts the token from errors about the options before cutting them short', () => {
    const attempts: Array<() => unknown> = [
      () => createOrdrestyringGateway({ apiToken: TOKEN, policy: { disabledTools: [TOKEN] } }),
      () => createOrdrestyringGateway({ apiToken: TOKEN, policy: { disabledTools: [`${'x'.repeat(95)}${TOKEN}`] } }),
      () => createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: `not a url ${TOKEN}` }),
      () => createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: `ftp://${'x'.repeat(190)}${TOKEN}` }),
    ];
    for (const attempt of attempts) {
      let message = '';
      try {
        attempt();
      } catch (error) {
        expect(error).toBeInstanceOf(GatewayConfigError);
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      for (const piece of [TOKEN, TOKEN.slice(0, 5)]) expect(message).not.toContain(piece);
    }
  });

  it('refuses a policy that is not a plain object', () => {
    expect(() => createOrdrestyringGateway({ apiToken: TOKEN, policy: [] as never })).toThrow(GatewayConfigError);
    expect(() => createOrdrestyringGateway({ apiToken: TOKEN, policy: null as never })).toThrow(GatewayConfigError);
  });
});

describe('nesting and concurrency', () => {
  it('a hosted instance created and called inside a policy-less instance’s fetch keeps its own policy and sink', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('ORDRESTYRING_AUDIT_LOG', auditFile);
    vi.stubEnv('ORDRESTYRING_ENABLE_WRITES', 'true');
    const inner = sink();
    const innerUpstream = graphql();
    let innerResult: GatewayToolResult | undefined;
    const outer = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        const hosted = createOrdrestyringGateway({
          apiToken: OTHER,
          baseUrl: BASE,
          fetchImpl: innerUpstream.fetchImpl,
          policy: { enableWrites: false, audit: inner.audit },
        });
        innerResult = await hosted.callTool('delete_products', DELETE, { caller: 'inner' });
        return jsonResponse({ data: { __typename: 'Query' } });
      }),
    });

    const result = await outer.callTool('check_connection', {}, { caller: 'outer' });

    expect(result.isError).toBeUndefined();
    // The inner instance follows its host's policy, not the environment that allows writes.
    expect(innerResult?.isError).toBe(true);
    expect(innerResult?.content[0]?.text).toContain('The embedding host has not enabled writes');
    expect(innerUpstream.bodies).toEqual([]);
    expect(inner.records.map(record => [record.action, record.caller])).toEqual([['policy_denied', 'inner']]);
    // The outer, policy-less instance writes to the environment's audit log, with its own caller only.
    const outerRecords = readFileSync(auditFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(outerRecords.map(record => [record.action, record.caller])).toEqual([
      ['start', 'outer'],
      ['finish', 'outer'],
    ]);
    expect(everything(outerRecords, inner.records)).not.toContain(TOKEN);
    expect(everything(outerRecords, inner.records)).not.toContain(OTHER);
  });

  it('a policy-less instance created and called inside a hosted instance’s sink uses the environment, not that policy', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('ORDRESTYRING_AUDIT_LOG', auditFile);
    const outer = sink();
    let innerResult: GatewayToolResult | undefined;
    const gateway = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: graphql({ __typename: 'Query' }).fetchImpl,
      policy: {
        enableWrites: true,
        audit: async record => {
          outer.audit(record);
          if (record.action === 'start' && innerResult === undefined) {
            const plain = createOrdrestyringGateway({ apiToken: OTHER, baseUrl: BASE, fetchImpl: graphql().fetchImpl });
            innerResult = await plain.callTool('delete_products', DELETE, { caller: 'inner' });
          }
        },
      },
    });

    await gateway.callTool('check_connection', {}, { caller: 'outer' });

    // Writes are off in the environment: the host's enableWrites did not leak into the inner call.
    expect(innerResult?.isError).toBe(true);
    expect(innerResult?.content[0]?.text).toMatch(/ORDRESTYRING_ENABLE_WRITES/);
    expect(outer.records.map(record => record.caller)).toEqual(['outer', 'outer']);
    expect(existsSync(auditFile)).toBe(true);
    const fileRecords = readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(fileRecords.map(record => [record.action, record.caller])).toEqual([['policy_denied', 'inner']]);
  });

  it('keeps different write and disabled-tool rules apart for two tenants calling at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const upstreamA = graphql({ deleteProduct: null }, () => gate);
    const upstreamB = graphql({ __typename: 'Query' }, () => gate);
    const a = sink();
    const b = sink();
    const gatewayA = createOrdrestyringGateway({
      apiToken: TOKEN,
      baseUrl: BASE,
      fetchImpl: upstreamA.fetchImpl,
      policy: { enableWrites: true, audit: a.audit },
    });
    const gatewayB = createOrdrestyringGateway({
      apiToken: OTHER,
      baseUrl: BASE,
      fetchImpl: upstreamB.fetchImpl,
      policy: { enableWrites: false, disabledTools: ['check_connection'], audit: b.audit },
    });

    const calls = Promise.all([
      gatewayA.callTool('delete_products', DELETE, { caller: 'a' }),
      gatewayB.callTool('delete_products', DELETE, { caller: 'b' }),
      gatewayB.callTool('check_connection', {}, { caller: 'b' }),
      gatewayA.callTool('check_connection', {}, { caller: 'a' }),
    ]);
    for (let i = 0; i < 100 && upstreamA.bodies.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
    release();
    const [aDelete, bDelete, bCheck, aCheck] = await calls;

    expect(aDelete.isError).toBeUndefined();
    expect(aCheck.isError).toBeUndefined();
    expect(bDelete.content[0]?.text).toContain('The embedding host has not enabled writes');
    expect(bCheck.content[0]?.text).toContain('disabled on this instance by the embedding host');
    expect(upstreamA.mutations()).toHaveLength(1);
    expect(upstreamB.bodies).toEqual([]);
    expect(upstreamA.bodies.every(body => body.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(a.records.every(record => record.caller === 'a')).toBe(true);
    expect(b.records.every(record => record.caller === 'b')).toBe(true);
    expect(b.records.map(record => record.action)).toEqual(['policy_denied', 'policy_denied']);
  });
});
