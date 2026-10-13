import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPreparedMutationConsistent,
  assertPreparedMutationHash,
  assertReadQuery,
  extractTopLevelFields,
  getOperationKind,
  prepareMutation,
} from '../src/ordrestyring/graphql.js';
import { checkMutationPolicy, checkToolPolicy } from '../src/ordrestyring/policy.js';

const originalEnableWrites = process.env.ORDRESTYRING_ENABLE_WRITES;
const originalPolicyPath = process.env.ORDRESTYRING_POLICY_PATH;

describe('Ordrestyring GraphQL guards and policy', () => {
  afterEach(() => {
    restoreEnv('ORDRESTYRING_ENABLE_WRITES', originalEnableWrites);
    restoreEnv('ORDRESTYRING_POLICY_PATH', originalPolicyPath);
  });

  it('detects operation kinds', () => {
    expect(getOperationKind('{ __typename }')).toBe('query');
    expect(getOperationKind('query Cases { cases { nextCursor } }')).toBe('query');
    expect(getOperationKind('mutation Update { updateUser(id: 1, input: {}) { id } }')).toBe(
      'mutation',
    );
  });

  it('rejects mutation documents in read tools', () => {
    expect(() => assertReadQuery('query { __typename }')).not.toThrow();
    expect(() => assertReadQuery('mutation { updateUser(id: 1, input: {}) { id } }')).toThrow(
      /Only GraphQL query/,
    );
  });

  it('extracts top-level mutation fields for policy allowlists', () => {
    expect(
      extractTopLevelFields(`
        mutation UpdateUser($id: Int!, $input: UpdateUserInput!) {
          updateUser(id: $id, input: $input) { id }
          aliasName: updateCase(id: 1, input: {}) { id }
        }
      `),
    ).toEqual(['updateUser', 'updateCase']);
  });

  it('prepares mutations with a stable confirmable hash', () => {
    const prepared = prepareMutation({
      query: 'mutation($id: Int!, $input: UpdateUserInput!) { updateUser(id: $id, input: $input) { id } }',
      variables: { input: { firstName: 'Henrik' }, id: 1 },
      reason: 'Approved user update.',
    });

    expect(prepared.operationHash).toHaveLength(64);
    expect(prepared.mutationNames).toEqual(['updateUser']);
    expect(() => assertPreparedMutationHash(prepared, prepared.operationHash)).not.toThrow();
    expect(() => assertPreparedMutationHash(prepared, 'wrong')).toThrow(/hash mismatch/);
  });

  it('blocks commit policy unless writes are explicitly enabled', async () => {
    const prepared = prepareMutation({
      query: 'mutation { updateUser(id: 1, input: {}) { id } }',
      variables: {},
      reason: 'Approved test.',
    });

    delete process.env.ORDRESTYRING_ENABLE_WRITES;

    expect(checkToolPolicy('ordrestyring_graphql_read')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_commit_prepared_mutation')).toMatchObject({
      allowed: false,
    });
    await expect(checkMutationPolicy(prepared)).resolves.toMatchObject({ allowed: false });
  });

  it('allows mutation policy when writes are enabled', async () => {
    const prepared = prepareMutation({
      query: 'mutation { updateUser(id: 1, input: {}) { id } }',
      variables: {},
      reason: 'Approved test.',
    });
    process.env.ORDRESTYRING_ENABLE_WRITES = 'true';
    delete process.env.ORDRESTYRING_POLICY_PATH;

    await expect(checkMutationPolicy(prepared)).resolves.toMatchObject({ allowed: true });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('GraphQL guard bypasses', () => {
  it("rejects a mutation hidden after a '#' inside a string literal", () => {
    const query =
      'query Q { cases(search: "a#b") { nextCursor } } mutation M { deleteProduct(id: 1) { id } }';
    expect(() => assertReadQuery(query, 'M')).toThrow(/exactly one operation/);
    expect(() => assertReadQuery(query)).toThrow(/exactly one operation/);
  });

  it('rejects multiple operations and mismatched operationName', () => {
    expect(() => assertReadQuery('query A { __typename } query B { __typename }')).toThrow(/exactly one operation/);
    expect(() => assertReadQuery('query A { __typename }', 'B')).toThrow(/operationName must match/);
    expect(() => assertReadQuery('query A { __typename }', 'A')).not.toThrow();
  });

  it('allows "#" and the word mutation inside query string arguments', () => {
    expect(() => assertReadQuery('query { cases(search: "mutation #1") { nextCursor } }')).not.toThrow();
  });

  it('rejects unparseable documents', () => {
    expect(() => assertReadQuery('query { cases(')).toThrow(/Invalid GraphQL document/);
    expect(getOperationKind('query { cases(')).toBeUndefined();
  });

  it('extracts mutation fields through fragments so policy sees them', () => {
    expect(
      extractTopLevelFields(
        'mutation M { ...F ... on Mutation { updateCase(id: 1, input: {}) { id } } } fragment F on Mutation { deleteProduct(id: 1) { id } }',
      ),
    ).toEqual(['deleteProduct', 'updateCase']);
  });

  it('rejects a prepared mutation whose mutationNames were edited by the caller', () => {
    const prepared = prepareMutation({
      query: 'mutation { deleteProduct(id: 1) { id } }',
      reason: 'test',
    });
    expect(() => assertPreparedMutationConsistent(prepared)).not.toThrow();
    const tampered = { ...prepared, mutationNames: ['updateCase'] };
    expect(() => assertPreparedMutationConsistent(tampered)).toThrow(/do not match/);
  });
});
