import type { OrdrestyringClient } from './client.js';
import {
  connectionSelectionForField,
  extractCollectionItems,
  findQueryField,
  getSchemaCatalog,
  selectionForType,
  type GraphQLField,
  type GraphQLSchemaCatalog,
  namedTypeName,
  typeRefToString,
} from './schema.js';

export interface CollectionReadInput {
  cursor?: string | null;
  limit?: number;
  query?: string;
  status?: string;
  caseId?: number;
  customerId?: number;
  userId?: number;
  employeeId?: number;
  dateFrom?: string;
  dateTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  orderByField?: string;
  orderDirection?: 'ASC' | 'DESC';
}

export interface EntityReadInput {
  id: number;
}

export interface DomainCollectionConfig {
  operationName: string;
  rootCandidates: string[];
  preferredScalars: string[];
  nestedPreferred?: Record<string, string[]>;
  defaultOrderByField?: string;
}

export interface DomainEntityConfig {
  operationName: string;
  rootCandidates: string[];
  idArgCandidates: string[];
  preferredScalars: string[];
  nestedPreferred?: Record<string, string[]>;
}

export async function readDomainCollection(
  client: OrdrestyringClient,
  config: DomainCollectionConfig,
  input: CollectionReadInput,
): Promise<unknown> {
  const catalog = await getSchemaCatalog(client);
  const field = findQueryField(catalog, config.rootCandidates);
  const queryParts = buildCollectionQuery(catalog, field, config, input);
  const data = await client.graphql<Record<string, unknown>>({
    query: queryParts.query,
    variables: queryParts.variables,
  });

  return {
    queryField: field.name,
    selection: queryParts.selection,
    argumentsUsed: queryParts.argumentsUsed,
    result: data.result,
  };
}

export async function readDomainEntity(
  client: OrdrestyringClient,
  config: DomainEntityConfig,
  input: EntityReadInput,
): Promise<unknown> {
  const catalog = await getSchemaCatalog(client);
  const field = findQueryField(catalog, config.rootCandidates);
  const idArg = findArg(field, config.idArgCandidates);
  if (!idArg) {
    throw new Error(
      `Ordrestyring query field ${field.name} does not expose one of these id arguments: ${config.idArgCandidates.join(', ')}`,
    );
  }

  const returnTypeName = namedTypeName(field.type);
  if (!returnTypeName) {
    throw new Error(`Ordrestyring query field ${field.name} has no named return type.`);
  }

  const selection = selectionForType(
    catalog,
    returnTypeName,
    config.preferredScalars,
    config.nestedPreferred ?? {},
  );
  const query = `
    query ${config.operationName}($id: ${typeRefToString(idArg.type)}) {
      result: ${field.name}(${idArg.name}: $id) {
        ${selection}
      }
    }
  `;

  const data = await client.graphql<Record<string, unknown>>({
    query,
    variables: { id: input.id },
  });

  return {
    queryField: field.name,
    selection,
    argumentsUsed: [idArg.name],
    result: data.result,
  };
}

export async function summarizeDomainCollection(
  client: OrdrestyringClient,
  config: DomainCollectionConfig,
  input: CollectionReadInput,
): Promise<unknown> {
  const response = await readDomainCollection(client, config, input);
  const result = (response as { result?: unknown }).result;
  const items = extractCollectionItems(result);
  const totals = summarizeItems(items);

  return {
    ...(response as Record<string, unknown>),
    summary: totals,
  };
}

function buildCollectionQuery(
  catalog: GraphQLSchemaCatalog,
  field: GraphQLField,
  config: DomainCollectionConfig,
  input: CollectionReadInput,
): {
  query: string;
  variables: Record<string, unknown>;
  selection: string;
  argumentsUsed: string[];
} {
  const selection = connectionSelectionForField(
    catalog,
    field,
    config.preferredScalars,
    config.nestedPreferred ?? {},
  );
  const args = buildArguments(field, {
    ...input,
    orderByField: input.orderByField ?? config.defaultOrderByField,
  });
  assertNoUnsupportedRequiredArgs(field, args.argumentsUsed);
  const variableDefinitions = Object.entries(args.variableTypes)
    .map(([name, type]) => `$${name}: ${type}`)
    .join(', ');
  const queryArguments = args.argumentExpressions.length
    ? `(${args.argumentExpressions.join(', ')})`
    : '';
  const query = `
    query ${config.operationName}${variableDefinitions ? `(${variableDefinitions})` : ''} {
      result: ${field.name}${queryArguments} {
        ${selection}
      }
    }
  `;

  return {
    query,
    variables: args.variables,
    selection,
    argumentsUsed: args.argumentsUsed,
  };
}

function buildArguments(
  field: GraphQLField,
  input: CollectionReadInput,
): {
  variableTypes: Record<string, string>;
  variables: Record<string, unknown>;
  argumentExpressions: string[];
  argumentsUsed: string[];
} {
  const variableTypes: Record<string, string> = {};
  const variables: Record<string, unknown> = {};
  const argumentExpressions: string[] = [];
  const argumentsUsed: string[] = [];

  for (const arg of field.args) {
    if (arg.name === 'pagination') {
      variableTypes.pagination = typeRefToString(arg.type);
      variables.pagination = {
        cursor: input.cursor ?? null,
        limit: input.limit ?? 20,
      };
      argumentExpressions.push('pagination: $pagination');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'orderBy' && input.orderByField) {
      variableTypes.orderBy = typeRefToString(arg.type);
      variables.orderBy = {
        field: input.orderByField,
        direction: input.orderDirection ?? 'DESC',
      };
      argumentExpressions.push('orderBy: $orderBy');
      argumentsUsed.push(arg.name);
      continue;
    }

    const value = valueForArg(arg.name, input);
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const variableName = safeVariableName(arg.name);
    variableTypes[variableName] = typeRefToString(arg.type);
    variables[variableName] = value;
    argumentExpressions.push(`${arg.name}: $${variableName}`);
    argumentsUsed.push(arg.name);
  }

  return { variableTypes, variables, argumentExpressions, argumentsUsed };
}

function valueForArg(name: string, input: CollectionReadInput): unknown {
  const values: Record<string, unknown> = {
    query: input.query,
    search: input.query,
    searchTerm: input.query,
    text: input.query,
    status: input.status,
    caseId: input.caseId,
    customerId: input.customerId,
    userId: input.userId,
    employeeId: input.employeeId,
    cursor: input.cursor,
    limit: input.limit,
    first: input.limit,
    from: input.dateFrom,
    to: input.dateTo,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    fromDate: input.dateFrom,
    toDate: input.dateTo,
    startDate: input.dateFrom,
    endDate: input.dateTo,
    updatedFrom: input.updatedFrom,
    updatedTo: input.updatedTo,
  };

  return values[name];
}

function assertNoUnsupportedRequiredArgs(field: GraphQLField, argumentsUsed: string[]): void {
  const used = new Set(argumentsUsed);
  const unsupportedRequired = field.args
    .filter(arg => typeRefToString(arg.type).endsWith('!'))
    .filter(arg => !used.has(arg.name));

  if (unsupportedRequired.length) {
    throw new Error(
      `Ordrestyring query field ${field.name} requires unsupported arguments: ${unsupportedRequired
        .map(arg => `${arg.name}: ${typeRefToString(arg.type)}`)
        .join(', ')}`,
    );
  }
}

function findArg(field: GraphQLField, candidates: string[]): GraphQLField['args'][number] | undefined {
  return candidates
    .map(candidate => field.args.find(arg => arg.name === candidate))
    .find(Boolean);
}

function summarizeItems(items: unknown[]): Record<string, unknown> {
  const numericTotals: Record<string, number> = {};
  const itemCount = items.length;

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (typeof value !== 'number') {
        continue;
      }

      if (/hour|hours|quantity|amount|total|price|cost|minutes|duration|time/i.test(key)) {
        numericTotals[key] = (numericTotals[key] ?? 0) + value;
      }
    }
  }

  return {
    itemCount,
    numericTotals,
  };
}

function safeVariableName(value: string): string {
  return value.replace(/[^_0-9A-Za-z]/g, '_');
}
