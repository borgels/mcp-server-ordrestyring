// One property, proved through every channel at once: no piece of an instance's token (six characters or more)
// reaches a host result, a thrown error or an audit record. The token has a quote and a backslash, so a form that
// is serialised before it is redacted would show; Ordrestyring echoes it whole, in fragments, in object keys, in
// error bodies, GraphQL errors and rate-limit headers, in a redirect's Location, in an over-limit body and in the
// failed sections of a combined read; the environment holds it where a number was expected. And under a host
// policy with an explicit timeout, the instance reads nothing from the environment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAGMENT_LENGTH } from '../src/errors.js';
import { createOrdrestyringGateway, type GatewayToolResult } from '../src/gateway.js';
import { mockSchema } from './schema-fixture.js';

const TOKEN = `tenant"a\\tOkEn-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const FRAGMENT = TOKEN.slice(0, 12);
const BASE = 'https://example.test';
const DELETE = { input: { ids: [14] }, reason: 'Clean placeholders.', idempotencyKey: 'delete-placeholders' };

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['ORDRESTYRING_ENABLE_WRITES', 'ORDRESTYRING_AUDIT_LOG', 'ORDRESTYRING_POLICY_PATH', 'ORDRESTYRING_TIMEOUT_MS']) {
    vi.stubEnv(name, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The pieces of the token found anywhere in `value`, raw or serialised. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (let i = 0; i + FRAGMENT_LENGTH <= TOKEN.length; i += 1) {
    const piece = TOKEN.slice(i, i + FRAGMENT_LENGTH);
    if (texts.some(text => text.includes(piece))) found.add(piece);
  }
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** An Ordrestyring stand-in that answers every non-schema request through `channel`. */
function upstream(channel: () => Response | Promise<Response>): typeof fetch {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    if (body.query?.includes('__schema')) {
      return json({ data: { __schema: mockSchema() } });
    }
    return channel();
  });
}

const CHANNELS: Record<string, () => Response> = {
  echo: () =>
    json({
      data: { __typename: TOKEN, deleteProduct: { [TOKEN]: FRAGMENT, nested: { [`k ${FRAGMENT}`]: [TOKEN] } } },
    }),
  graphqlErrors: () =>
    json({ data: null, errors: [{ message: `Rejected ${TOKEN}`, type: FRAGMENT, path: [FRAGMENT] }] }),
  errorBody: () => json({ message: `Rejected ${TOKEN}`, code: FRAGMENT }, 400),
  headers: () =>
    json({ message: 'slow' }, 429, {
      'retry-after': `${'x'.repeat(60)}${TOKEN}`,
      'x-ratelimit-limit': FRAGMENT,
      'x-ratelimit-remaining': `${TOKEN}`,
    }),
  bigBody: () => new Response(`${' '.repeat(70_000)}${TOKEN}`, { status: 500, headers: { 'content-type': 'text/plain' } }),
  redirect: () => new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${FRAGMENT}?t=${TOKEN}` } }),
  network: () => {
    throw new TypeError(`fetch failed for ${TOKEN}`, { cause: Object.assign(new Error(`connect ${FRAGMENT}`), { code: FRAGMENT }) });
  },
};

describe('no piece of the token leaves an instance', () => {
  it('holds for every channel: results, errors, nested failures and audit records', async () => {
    const results: GatewayToolResult[] = [];
    const records: unknown[] = [];
    for (const [name, channel] of Object.entries(CHANNELS)) {
      const gateway = createOrdrestyringGateway({
        apiToken: TOKEN,
        baseUrl: BASE,
        fetchImpl: upstream(channel),
        policy: { enableWrites: true, audit: record => void records.push(record) },
      });
      const context = { caller: `caller ${TOKEN}`, requestId: FRAGMENT };
      results.push(await gateway.callTool('check_connection', {}, context));
      results.push(await gateway.callTool('delete_products', DELETE, context));
      // A combined read: each failed section is kept inside the result.
      results.push(await gateway.callTool('get_case_health', { caseId: 1 }, context));
      expect(results.at(-3)?.isError, name).toBe(name === 'echo' ? undefined : true);
    }
    const gateway = createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE, fetchImpl: upstream(CHANNELS.echo!) });
    results.push(await gateway.callTool(`check_connection ${TOKEN}`), await gateway.callTool('check_connection', { [TOKEN]: 1 }));

    expect(records.length).toBeGreaterThan(20);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('holds for errors about the environment and the options', () => {
    const messages: string[] = [];
    vi.stubEnv('ORDRESTYRING_TIMEOUT_MS', TOKEN);
    for (const create of [
      () => createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: BASE }),
      () => createOrdrestyringGateway({ apiToken: TOKEN, baseUrl: `not a url ${TOKEN}`, timeoutMs: 1000 }),
      () => createOrdrestyringGateway({ apiToken: TOKEN, policy: { disabledTools: [TOKEN] }, timeoutMs: 1000 }),
    ]) {
      try {
        create();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    expect(leaks(messages)).toEqual([]);
  });
});

describe('under a host policy with an explicit timeout', () => {
  it('reads nothing from the environment, also for an allowed write and its prepared-mutation hash', async () => {
    vi.stubEnv('ORDRESTYRING_PREPARE_SECRET', 'env-prepare-secret-must-not-be-read');
    const reads = new Set<string>();
    const env = process.env;
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string' && property.startsWith('ORDRESTYRING_')) reads.add(property);
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      const gateway = createOrdrestyringGateway({
        apiToken: TOKEN,
        baseUrl: BASE,
        timeoutMs: 5_000,
        fetchImpl: upstream(() => json({ data: { __typename: 'Query', deleteProduct: null } })),
        policy: { enableWrites: true, audit: () => undefined },
      });

      const read = await gateway.callTool('check_connection');
      const write = await gateway.callTool('delete_products', DELETE);

      expect(read.isError).toBeUndefined();
      expect(write.isError).toBeUndefined();
      expect([...reads]).toEqual([]);
    } finally {
      process.env = env;
    }
  });
});
