import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPreparedMutationConsistent,
  assertPreparedMutationHash,
  hashPreparedMutation,
  prepareMutation,
  PREPARED_MUTATION_TTL_MS,
} from '../src/ordrestyring/graphql.js';
import { OrdrestyringClient } from '../src/ordrestyring/client.js';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

function prepare() {
  return prepareMutation({
    query: 'mutation($id: Int!) { updateUser(id: $id, input: {}) { id } }',
    variables: { id: 1 },
    reason: 'Approved test.',
  });
}

describe('prepared mutation signature', () => {
  it('sets a 15 minute expiry', () => {
    const prepared = prepare();
    expect(Date.parse(prepared.expiresAt) - Date.parse(prepared.createdAt)).toBe(PREPARED_MUTATION_TTL_MS);
  });

  it('rejects a caller-altered mutation re-hashed without the server key', () => {
    const prepared = prepare();
    const { operationHash: _ignored, ...rest } = prepared;
    const altered = { ...rest, variables: { id: 2 } };
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(altered).sort(([a], [b]) => a.localeCompare(b))));
    const forgedHash = createHash('sha256').update(sorted).digest('hex');
    const forged = { ...altered, operationHash: forgedHash };
    expect(() => assertPreparedMutationHash(forged, forgedHash)).toThrow(/hash mismatch/);
  });

  it('rejects altered variables or expiry with the original hash', () => {
    const prepared = prepare();
    expect(() => assertPreparedMutationHash({ ...prepared, variables: { id: 2 } }, prepared.operationHash)).toThrow(/hash mismatch/);
    const extended = { ...prepared, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    expect(() => assertPreparedMutationHash(extended, prepared.operationHash)).toThrow(/hash mismatch/);
  });

  it('rejects expired preparations', () => {
    const prepared = prepare();
    const later = new Date(Date.parse(prepared.expiresAt) + 1);
    expect(() => assertPreparedMutationHash(prepared, prepared.operationHash, later)).toThrow(/expired/);
  });

  it('is keyed by ORDRESTYRING_PREPARE_SECRET when set', () => {
    process.env.ORDRESTYRING_PREPARE_SECRET = 'secret-a';
    const prepared = prepare();
    expect(() => assertPreparedMutationHash(prepared, prepared.operationHash)).not.toThrow();
    process.env.ORDRESTYRING_PREPARE_SECRET = 'secret-b';
    expect(hashPreparedMutation(prepared)).not.toBe(prepared.operationHash);
    expect(() => assertPreparedMutationHash(prepared, prepared.operationHash)).toThrow(/hash mismatch/);
  });

  it('still checks mutation names against the document', () => {
    const prepared = prepare();
    expect(() => assertPreparedMutationConsistent({ ...prepared, mutationNames: ['other'] })).toThrow(/do not match/);
  });
});

describe('base URL trimming', () => {
  it('handles long runs of trailing slashes quickly', () => {
    const start = Date.now();
    const client = new OrdrestyringClient({ baseUrl: `https://api.example.com${'/'.repeat(100_000)}`, apiToken: 'k' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(client).toBeTruthy();
  });
});
