import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  Kind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
export type OperationKind = 'query' | 'mutation' | 'subscription';

export interface PreparedMutation {
  type: 'ordrestyring_prepared_mutation';
  createdAt: string;
  expiresAt: string;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  reason: string;
  mutationNames: string[];
  operationHash: string;
}

export const PREPARED_MUTATION_TTL_MS = 15 * 60 * 1000;

/** Random per-process key, used when ORDRESTYRING_PREPARE_SECRET is not set. */
const processSecret = randomBytes(32);

/**
 * Key for the prepared-mutation HMAC. Set ORDRESTYRING_PREPARE_SECRET when
 * several instances must accept each other's preparations (or across
 * restarts); otherwise a random per-process key is used.
 */
function prepareSecret(): Buffer {
  const configured = process.env.ORDRESTYRING_PREPARE_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

interface ParsedOperation {
  document: DocumentNode;
  operation: OperationDefinitionNode;
}

/**
 * Parses the document with graphql-js and requires exactly one operation, so
 * the operation we validate is the one the server executes. If operationName
 * is given it must name that operation.
 */
function parseSingleOperation(query: string, operationName?: string): ParsedOperation {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    throw new Error(`Invalid GraphQL document: ${error instanceof Error ? error.message : String(error)}`);
  }

  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1) {
    throw new Error('GraphQL documents must contain exactly one operation.');
  }

  const operation = operations[0]!;
  if (operationName !== undefined && operation.name?.value !== operationName) {
    throw new Error('operationName must match the single operation in the document.');
  }

  return { document, operation };
}

export function getOperationKind(query: string, operationName?: string): OperationKind | undefined {
  try {
    return parseSingleOperation(query, operationName).operation.operation as OperationKind;
  } catch {
    return undefined;
  }
}

export function assertReadQuery(query: string, operationName?: string): void {
  const { operation } = parseSingleOperation(query, operationName);

  if (operation.operation !== 'query') {
    throw new Error('Only GraphQL query operations are allowed by this tool.');
  }
}

export function assertMutation(query: string, operationName?: string): void {
  const { operation } = parseSingleOperation(query, operationName);

  if (operation.operation !== 'mutation') {
    throw new Error('This tool only prepares GraphQL mutation operations.');
  }

  if (/\bUpload\b/.test(query)) {
    throw new Error('Multipart Upload mutations are not supported by this MCP server.');
  }
}

export function prepareMutation(input: {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  reason: string;
}): PreparedMutation {
  assertMutation(input.query, input.operationName);

  const createdAt = new Date();
  const preparedWithoutHash = {
    type: 'ordrestyring_prepared_mutation' as const,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PREPARED_MUTATION_TTL_MS).toISOString(),
    query: input.query,
    variables: input.variables ?? {},
    operationName: input.operationName,
    reason: input.reason,
    mutationNames: extractTopLevelFields(input.query),
  };

  return {
    ...preparedWithoutHash,
    operationHash: hashPreparedMutation(preparedWithoutHash),
  };
}

export function hashPreparedMutation(
  prepared: Omit<PreparedMutation, 'operationHash'> | PreparedMutation,
): string {
  const { operationHash: _operationHash, ...payload } = prepared as PreparedMutation;
  return createHmac('sha256', prepareSecret()).update(stableJson(payload)).digest('hex');
}

/**
 * Verifies the server's HMAC over the prepared mutation (so it cannot have
 * been forged or altered by the caller), that the caller echoed the same
 * hash, and that the preparation has not expired.
 */
export function assertPreparedMutationHash(
  prepared: PreparedMutation,
  confirmOperationHash: string,
  now: Date = new Date(),
): void {
  const expected = Buffer.from(hashPreparedMutation(prepared), 'hex');
  const given = Buffer.from(String(prepared.operationHash ?? ''), 'hex');
  const confirmed = Buffer.from(String(confirmOperationHash ?? ''), 'hex');
  const signatureOk = expected.length === given.length && timingSafeEqual(expected, given);
  const confirmOk = expected.length === confirmed.length && timingSafeEqual(expected, confirmed);
  if (!signatureOk || !confirmOk) {
    throw new Error(
      'Prepared mutation hash mismatch: it was altered, prepared by another server instance, or the confirmation does not match. Re-run preparation and inspect the operation.',
    );
  }
  const expiresAt = Date.parse(prepared.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    throw new Error('Prepared mutation has expired (15 minutes). Re-run preparation.');
  }
}


/**
 * Re-validates a prepared mutation at commit time. The prepared object comes
 * back from the caller, so mutationNames (which the policy checks) must be
 * derived from the query itself rather than trusted.
 */
export function assertPreparedMutationConsistent(prepared: PreparedMutation): void {
  assertMutation(prepared.query, prepared.operationName);
  const actual = [...extractTopLevelFields(prepared.query)].sort();
  const claimed = [...prepared.mutationNames].sort();
  if (actual.length !== claimed.length || actual.some((name, index) => name !== claimed[index])) {
    throw new Error('Prepared mutation names do not match the mutation document. Re-run preparation.');
  }
}

/** Top-level field names (not aliases) of the single operation, following fragments. */
export function extractTopLevelFields(query: string): string[] {
  const { document, operation } = parseSingleOperation(query);
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  const fields = new Set<string>();
  const visited = new Set<string>();
  const collect = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        fields.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet);
      } else {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (fragment && !visited.has(name)) {
          visited.add(name);
          collect(fragment.selectionSet);
        }
      }
    }
  };
  collect(operation.selectionSet);

  return [...fields].filter(field => !field.startsWith('__'));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

