import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMutation } from '../src/ordrestyring/graphql.js';
import { checkMutationPolicy, checkToolPolicy } from '../src/ordrestyring/policy.js';

const originalEnableWrites = process.env.ORDRESTYRING_ENABLE_WRITES;
const originalPolicyPath = process.env.ORDRESTYRING_POLICY_PATH;
let tempDir: string | undefined;

describe('Ordrestyring policy', () => {
  afterEach(async () => {
    restoreEnv('ORDRESTYRING_ENABLE_WRITES', originalEnableWrites);
    restoreEnv('ORDRESTYRING_POLICY_PATH', originalPolicyPath);

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('allowlists read and dry-run tools but blocks commits by default', () => {
    delete process.env.ORDRESTYRING_ENABLE_WRITES;

    expect(checkToolPolicy('ordrestyring_search_schema')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_diagnostics')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_get_invoice_readiness')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_get_billing_pipeline')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_find_billable_cases')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_prepare_operational_mutation')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_prepare_mutation')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('ordrestyring_create_offer')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('ordrestyring_update_product')).toMatchObject({ allowed: false });
    expect(checkToolPolicy('ordrestyring_commit_prepared_mutation')).toMatchObject({
      allowed: false,
    });
    expect(checkToolPolicy('ordrestyring_delete_everything')).toMatchObject({ allowed: false });
  });

  it('allows an explicitly enabled mutation when policy allowlist matches', async () => {
    process.env.ORDRESTYRING_ENABLE_WRITES = 'true';
    process.env.ORDRESTYRING_POLICY_PATH = await writePolicy({
      writesEnabled: true,
      allowedMutations: ['updateUser'],
      maxVariableBytes: 1000,
    });

    await expect(checkMutationPolicy(preparedUpdateUser())).resolves.toMatchObject({
      allowed: true,
    });
    expect(checkToolPolicy('ordrestyring_create_offer')).toMatchObject({ allowed: true });
  });

  it('denies mutations by policy pattern and max variable bytes', async () => {
    process.env.ORDRESTYRING_ENABLE_WRITES = 'true';
    process.env.ORDRESTYRING_POLICY_PATH = await writePolicy({
      writesEnabled: true,
      deniedMutationPatterns: ['^update'],
      maxVariableBytes: 2,
    });

    await expect(checkMutationPolicy(preparedUpdateUser())).resolves.toMatchObject({
      allowed: false,
    });

    process.env.ORDRESTYRING_POLICY_PATH = await writePolicy({
      writesEnabled: true,
      maxVariableBytes: 2,
    });

    await expect(checkMutationPolicy(preparedUpdateUser())).resolves.toMatchObject({
      allowed: false,
    });
  });
});

function preparedUpdateUser() {
  return prepareMutation({
    query: 'mutation($id: Int!, $input: UpdateUserInput!) { updateUser(id: $id, input: $input) { id } }',
    variables: { id: 1, input: { firstName: 'Henrik' } },
    reason: 'Approved update.',
  });
}

async function writePolicy(policy: unknown): Promise<string> {
  tempDir = tempDir ?? (await mkdtemp(join(tmpdir(), 'ordrestyring-policy-')));
  const path = join(tempDir, `policy-${Date.now()}-${Math.random()}.json`);
  await writeFile(path, JSON.stringify(policy), 'utf8');
  return path;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
