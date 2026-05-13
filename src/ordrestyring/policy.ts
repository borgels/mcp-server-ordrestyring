import { readFile } from 'node:fs/promises';
import type { PreparedMutation } from './graphql.js';

export interface OrdrestyringPolicy {
  writesEnabled?: boolean;
  allowedMutations?: string[];
  deniedMutationPatterns?: string[];
  maxVariableBytes?: number;
}

export interface OrdrestyringPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'ordrestyring_search_capabilities',
  'ordrestyring_check_connection',
  'ordrestyring_introspect_schema',
  'ordrestyring_search_schema',
  'ordrestyring_get_schema_type',
  'ordrestyring_refresh_schema',
  'ordrestyring_list_cases',
  'ordrestyring_get_case',
  'ordrestyring_search_cases',
  'ordrestyring_get_case_overview',
  'ordrestyring_search_customers',
  'ordrestyring_get_customer_overview',
  'ordrestyring_list_case_time_entries',
  'ordrestyring_summarize_time',
  'ordrestyring_list_case_materials',
  'ordrestyring_get_case_financials',
  'ordrestyring_list_schedule',
  'ordrestyring_list_case_documents',
  'ordrestyring_list_case_quality_checks',
  'ordrestyring_list_invoice_drafts',
  'ordrestyring_get_business_report',
  'ordrestyring_graphql_read',
  'ordrestyring_prepare_mutation',
]);

export function checkToolPolicy(toolName: string): OrdrestyringPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only or dry-run Ordrestyring tool' };
  }

  if (toolName === 'ordrestyring_commit_prepared_mutation') {
    return checkWritesEnabled();
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}

export async function checkMutationPolicy(
  prepared: PreparedMutation,
): Promise<OrdrestyringPolicyDecision> {
  const writesDecision = checkWritesEnabled();
  if (!writesDecision.allowed) {
    return writesDecision;
  }

  const policy = await readPolicy();
  if (policy.writesEnabled === false) {
    return { allowed: false, reason: 'policy file disables writes' };
  }

  const variableBytes = Buffer.byteLength(JSON.stringify(prepared.variables), 'utf8');
  if (policy.maxVariableBytes !== undefined && variableBytes > policy.maxVariableBytes) {
    return {
      allowed: false,
      reason: `mutation variables exceed policy maxVariableBytes=${policy.maxVariableBytes}`,
    };
  }

  for (const pattern of policy.deniedMutationPatterns ?? []) {
    const regex = new RegExp(pattern);
    if (prepared.mutationNames.some(name => regex.test(name))) {
      return { allowed: false, reason: `mutation denied by policy pattern: ${pattern}` };
    }
  }

  if (policy.allowedMutations?.length) {
    const allowed = new Set(policy.allowedMutations);
    const rejected = prepared.mutationNames.filter(name => !allowed.has(name));
    if (rejected.length) {
      return { allowed: false, reason: `mutation not allowlisted: ${rejected.join(', ')}` };
    }
  }

  return { allowed: true, reason: 'mutation allowed by Ordrestyring write policy' };
}

async function readPolicy(): Promise<OrdrestyringPolicy> {
  const policyPath = process.env.ORDRESTYRING_POLICY_PATH;
  if (!policyPath) {
    return {};
  }

  const text = await readFile(policyPath, 'utf8');
  return JSON.parse(text) as OrdrestyringPolicy;
}

function checkWritesEnabled(): OrdrestyringPolicyDecision {
  if (process.env.ORDRESTYRING_ENABLE_WRITES !== 'true') {
    return {
      allowed: false,
      reason: 'writes are disabled. Set ORDRESTYRING_ENABLE_WRITES=true to permit commit tools.',
    };
  }

  return { allowed: true, reason: 'writes enabled by environment' };
}
