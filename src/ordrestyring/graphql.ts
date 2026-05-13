import { createHash } from 'node:crypto';
export type OperationKind = 'query' | 'mutation' | 'subscription';

export interface PreparedMutation {
  type: 'ordrestyring_prepared_mutation';
  createdAt: string;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
  reason: string;
  mutationNames: string[];
  operationHash: string;
}

export function getOperationKind(query: string): OperationKind | undefined {
  const normalized = stripGraphqlComments(query).trimStart();

  if (normalized.startsWith('{')) {
    return 'query';
  }

  const match = /^(query|mutation|subscription)\b/i.exec(normalized);
  return match?.[1]?.toLowerCase() as OperationKind | undefined;
}

export function assertReadQuery(query: string): void {
  const kind = getOperationKind(query);

  if (kind !== 'query') {
    throw new Error('Only GraphQL query operations are allowed by this tool.');
  }

  if (/\bmutation\b/i.test(stripGraphqlComments(query))) {
    throw new Error('Read tool rejected a document containing a mutation operation.');
  }
}

export function assertMutation(query: string): void {
  const kind = getOperationKind(query);

  if (kind !== 'mutation') {
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
  assertMutation(input.query);

  const preparedWithoutHash = {
    type: 'ordrestyring_prepared_mutation' as const,
    createdAt: new Date().toISOString(),
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
  return stableHash(payload);
}

export function assertPreparedMutationHash(prepared: PreparedMutation, confirmOperationHash: string): void {
  const actualHash = hashPreparedMutation(prepared);
  if (actualHash !== prepared.operationHash || actualHash !== confirmOperationHash) {
    throw new Error('Prepared mutation hash mismatch. Re-run preparation and inspect the operation.');
  }
}

export function extractTopLevelFields(query: string): string[] {
  const body = topLevelSelectionBody(stripGraphqlComments(query));
  const fields = new Set<string>();
  let depth = 0;
  let current = '';
  let readingName = false;
  let quote: '"' | undefined;
  let escaped = false;

  for (const char of body) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"') {
      quote = char;
      continue;
    }

    if (char === '{' || char === '(') {
      if (depth === 0 && current && readingName) {
        fields.add(current);
      }
      depth += 1;
      current = '';
      readingName = false;
      continue;
    }

    if (char === '}' || char === ')') {
      depth -= 1;
      current = '';
      readingName = false;
      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (/[A-Za-z_]/.test(char) && !readingName) {
      readingName = true;
      current = char;
      continue;
    }

    if (readingName && /[A-Za-z0-9_]/.test(char)) {
      current += char;
      continue;
    }

    if (readingName && char === ':') {
      current = '';
      readingName = false;
      continue;
    }

    if (readingName && /\s/.test(char)) {
      fields.add(current);
      current = '';
      readingName = false;
    }
  }

  if (current && readingName) {
    fields.add(current);
  }

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

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stripGraphqlComments(query: string): string {
  return query
    .split('\n')
    .map(line => line.replace(/#.*/, ''))
    .join('\n');
}

function topLevelSelectionBody(query: string): string {
  const start = query.indexOf('{');
  if (start === -1) {
    return '';
  }

  let depth = 0;
  let quote: '"' | undefined;
  let escaped = false;

  for (let index = start; index < query.length; index += 1) {
    const char = query[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return query.slice(start + 1, index);
      }
    }
  }

  return query.slice(start + 1);
}
