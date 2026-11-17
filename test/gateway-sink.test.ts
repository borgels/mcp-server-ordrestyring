// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the token.
// Every output is checked in its final form; the round-7 counterexamples and tokens spliced from real outputs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrdrestyringGateway } from '../src/gateway.js';
import { nestedFailuresAsStatus } from '../src/errors.js';
import { visibleTexts } from '../src/key-admission.js';
import { mockSchema } from './schema-fixture.js';

const BASE = 'https://example.test';
let dir: string;

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['ORDRESTYRING_ENABLE_WRITES', 'ORDRESTYRING_AUDIT_LOG', 'ORDRESTYRING_POLICY_PATH', 'ORDRESTYRING_TIMEOUT_MS']) {
    vi.stubEnv(name, '');
  }
  dir = mkdtempSync(join(tmpdir(), 'ord-sink-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const upstream: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  const operation = /query\s+(\w+)/.exec(body.query ?? '')?.[1] ?? '';
  if (operation === 'OrdrestyringMcpFullIntrospection') return json({ data: { __schema: mockSchema() } });
  return json({ data: { __typename: 'Query' } });
};

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(token: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(token).filter(piece => texts.some(text => text.includes(piece)));
}

/** Every output of a normal session with this token, or the refusal when it is not admitted. */
async function outputs(apiToken: string, viaFile = false): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  if (viaFile) vi.stubEnv('ORDRESTYRING_AUDIT_LOG', auditPath);
  let gw: ReturnType<typeof createOrdrestyringGateway>;
  try {
    gw = createOrdrestyringGateway({
      apiToken,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream,
      ...(viaFile ? {} : { policy: { audit: (record: Record<string, unknown>) => void records.push(record) } }),
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('check_connection', {}, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('get_case_health', { caseId: 1 }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('check_connection', { unknown: 1 }),
  ];
  let lines = '';
  try {
    lines = readFileSync(auditPath, 'utf8');
  } catch {
    lines = '';
  }
  return { outputs: [gw.tools, ...results, ...records, lines] };
}

describe('the sink check', () => {
  it('holds for the round-7 counterexamples, through the audit sink and the audit file', async () => {
    for (const apiToken of [
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'URI malformedQz7pX2vK9mWb\uD800',
      'x"ok": y-0123456789',
    ]) {
      for (const viaFile of [false, true]) {
        const { refused, outputs: seen } = await outputs(apiToken, viaFile);
        if (refused !== undefined) expect(refused, apiToken).toMatch(/key was refused/);
        expect(leaked(apiToken, seen), `${apiToken} ${viaFile}`).toEqual([]);
      }
    }
  });

  it('refuses a token that is not printable ASCII before anything is built from it', () => {
    for (const apiToken of ['URI malformedQz7pX2vK9mWb\uD800', 'Zq7pX2vK9mWb4TnRé', 'Zq7pX2 vK9mWb4TnR8y']) {
      expect(() => createOrdrestyringGateway({ apiToken, baseUrl: BASE }), apiToken).toThrow(/key was refused/);
    }
    expect(() => createOrdrestyringGateway({ apiToken: 'riskLevelQz7pX2vK9mWb', baseUrl: BASE })).toThrow(/key was refused/);
  });

  it('holds for tokens spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU', true);
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output))).filter(text => text.length >= 6);
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 40; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiToken = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiToken, round % 2 === 0);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiToken, seen), apiToken).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

describe('failure texts', () => {
  it('replaces texts in failure lists inside the data, and keeps texts elsewhere', () => {
    expect(
      nestedFailuresAsStatus({ data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'], amount: '12.00', name: 'kept' } }),
    ).toEqual({
      data: { failures: ['Ordrestyring reported a failure.'], errors: ['Ordrestyring reported a failure.'], amount: '12.00', name: 'kept' },
    });
  });
});
