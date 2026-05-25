import type { OrdrestyringClient } from './client.js';
import {
  connectionSelectionForField,
  extractCollectionItems,
  findQueryField,
  getSchemaCatalog,
  getSchemaType,
  isListType,
  selectionForType,
  type GraphQLField,
  type GraphQLSchemaCatalog,
  namedTypeName,
  typeRefToString,
} from './schema.js';

export interface CollectionReadInput {
  page?: number;
  cursor?: string | null;
  limit?: number;
  query?: string;
  status?: string;
  statusId?: number;
  statusIds?: number[];
  caseId?: number;
  customerId?: number;
  userId?: number;
  employeeId?: number;
  productType?: string;
  requireCase?: boolean;
  allHourTypes?: boolean;
  hourTypeId?: number;
  materialType?: string;
  isInvoiced?: boolean;
  isAddedToDraft?: boolean;
  includeSubCases?: boolean;
  hoursPending?: boolean;
  invoiceCreated?: boolean;
  invoiceSent?: boolean;
  currentUserAssigned?: boolean;
  dateFrom?: string;
  dateTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  orderByField?: string;
  orderDirection?: 'ASC' | 'DESC';
}

export interface EntityReadInput {
  id: number | string;
}

export interface DomainCollectionConfig {
  operationName: string;
  rootCandidates: string[];
  preferredScalars: string[];
  nestedPreferred?: Record<string, string[]>;
  defaultOrderByField?: string;
  searchFields?: string[];
  argumentDefaults?: Record<string, unknown>;
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
  }, catalog, config);
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
  catalog: GraphQLSchemaCatalog,
  config: DomainCollectionConfig,
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
    const defaultValue = config.argumentDefaults?.[arg.name];
    if (arg.name === 'pagination') {
      variableTypes.pagination = typeRefToString(arg.type);
      variables.pagination = {
        limit: input.limit ?? 20,
      };
      if (input.cursor !== undefined && input.cursor !== null) {
        (variables.pagination as Record<string, unknown>).cursor = input.cursor;
      } else if (input.page !== undefined) {
        (variables.pagination as Record<string, unknown>).page = input.page;
      } else {
        (variables.pagination as Record<string, unknown>).cursor = null;
      }
      argumentExpressions.push('pagination: $pagination');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'orderBy' && input.orderByField) {
      variableTypes.orderBy = typeRefToString(arg.type);
      const orderBy = {
        field: input.orderByField,
        direction: input.orderDirection ?? 'DESC',
      };
      variables.orderBy = isListType(arg.type) ? [orderBy] : orderBy;
      argumentExpressions.push('orderBy: $orderBy');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'search' && input.query) {
      variableTypes.search = typeRefToString(arg.type);
      variables.search = buildSearchValue(arg, input.query, config.searchFields);
      argumentExpressions.push('search: $search');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'type' && input.productType) {
      variableTypes.type = typeRefToString(arg.type);
      variables.type = input.productType;
      argumentExpressions.push('type: $type');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'requireCase' && input.requireCase !== undefined) {
      variableTypes.requireCase = typeRefToString(arg.type);
      variables.requireCase = input.requireCase;
      argumentExpressions.push('requireCase: $requireCase');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'allHourTypes' && input.allHourTypes !== undefined) {
      variableTypes.allHourTypes = typeRefToString(arg.type);
      variables.allHourTypes = input.allHourTypes;
      argumentExpressions.push('allHourTypes: $allHourTypes');
      argumentsUsed.push(arg.name);
      continue;
    }

    if (arg.name === 'filters') {
      const filters = buildFilters(catalog, arg, input);
      if (filters && Object.keys(filters).length) {
        variableTypes.filters = typeRefToString(arg.type);
        variables.filters = filters;
        argumentExpressions.push('filters: $filters');
        argumentsUsed.push(arg.name);
      }
      continue;
    }

    if (arg.name === 'between') {
      const between = buildBetween(catalog, arg, input);
      if (between) {
        variableTypes.between = typeRefToString(arg.type);
        variables.between = between;
        argumentExpressions.push('between: $between');
        argumentsUsed.push(arg.name);
      }
      continue;
    }

    const value = valueForArg(arg.name, input) ?? defaultValue;
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
    searchTerm: input.query,
    text: input.query,
    status: input.status,
    statusId: input.statusId,
    caseId: input.caseId,
    customerId: input.customerId,
    userId: input.userId,
    employeeId: input.employeeId,
    type: input.materialType,
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

function buildSearchValue(
  arg: GraphQLField['args'][number],
  query: string,
  searchFields: string[] | undefined,
): unknown {
  const typeName = namedTypeName(arg.type);
  if (typeName !== 'Search') {
    return query;
  }

  return {
    query,
    fields: searchFields?.length ? searchFields : ['name', 'caseNumber', 'customerNumber', 'description'],
  };
}

function buildFilters(
  catalog: GraphQLSchemaCatalog,
  arg: GraphQLField['args'][number],
  input: CollectionReadInput,
): Record<string, unknown> | undefined {
  const typeName = namedTypeName(arg.type);
  if (!typeName) {
    return undefined;
  }

  const type = getSchemaType(catalog, typeName);
  const fields = type.inputFields ?? [];
  const filters: Record<string, unknown> = {};
  const setIfPresent = (name: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '' && fields.some(field => field.name === name)) {
      filters[name] = value;
    }
  };

  const statusIds = input.statusIds ?? parseStatusIds(input.status, input.statusId);
  setIfPresent('statuses', statusIds);
  setIfPresent('customers', input.customerId ? [input.customerId] : undefined);
  setIfPresent('customerIds', input.customerId ? [input.customerId] : undefined);
  setIfPresent('caseIds', input.caseId ? [input.caseId] : undefined);
  setIfPresent('case', input.caseId);
  setIfPresent('users', firstNumberArray(input.userId, input.employeeId));
  setIfPresent('user', input.userId);
  setIfPresent('hourTypes', input.hourTypeId ? [input.hourTypeId] : undefined);
  setIfPresent('isInvoiced', input.isInvoiced);
  setIfPresent('isAddedToDraft', input.isAddedToDraft);
  setIfPresent('draft', input.isAddedToDraft);
  setIfPresent('hoursPending', input.hoursPending);
  setIfPresent('invoiceCreated', input.invoiceCreated);
  setIfPresent('invoiceSent', input.invoiceSent);
  setIfPresent('currentUserAssigned', input.currentUserAssigned);

  const nestedCase = fields.find(field => field.name === 'case');
  if (nestedCase && namedTypeName(nestedCase.type) === 'CaseFilterIncludingSubCaseInput' && input.caseId) {
    filters.case = {
      id: input.caseId,
      includeSubcases: input.includeSubCases ?? true,
    };
  }

  const updatedAt = buildTimestampRange(input.updatedFrom, input.updatedTo);
  if (updatedAt && fields.some(field => field.name === 'updatedAt')) {
    filters.updatedAt = updatedAt;
  }

  const createdAt = buildTimestampRange(input.dateFrom, input.dateTo);
  if (createdAt && fields.some(field => field.name === 'createdAt')) {
    filters.createdAt = createdAt;
  }

  return Object.keys(filters).length ? filters : undefined;
}

function buildBetween(
  catalog: GraphQLSchemaCatalog,
  arg: GraphQLField['args'][number],
  input: CollectionReadInput,
): Record<string, unknown> | undefined {
  const typeName = namedTypeName(arg.type);
  if (!typeName) {
    return undefined;
  }

  const type = getSchemaType(catalog, typeName);
  const fields = type.inputFields ?? [];
  const hasField = fields.some(field => field.name === 'field');
  const range = buildTimestampRange(input.dateFrom ?? input.updatedFrom, input.dateTo ?? input.updatedTo);
  if (!range) {
    return undefined;
  }

  if (!hasField) {
    return range;
  }

  const enumName = namedTypeName(fields.find(field => field.name === 'field')?.type ?? { kind: 'SCALAR' });
  const enumValues = enumName ? getSchemaType(catalog, enumName).enumValues?.map(value => value.name) ?? [] : [];
  const preferredField = firstPresent(enumValues, [
    input.dateFrom || input.dateTo ? 'startTime' : 'updatedAt',
    'updatedAt',
    'createdAt',
    'date',
    'id',
  ]);
  if (!preferredField) {
    return undefined;
  }

  return {
    field: preferredField,
    ...range,
  };
}

function buildTimestampRange(from?: string, to?: string): Record<string, number> | undefined {
  if (!from && !to) {
    return undefined;
  }

  return {
    ...(from ? { from: isoDateToUnix(from) } : {}),
    ...(to ? { to: isoDateToUnix(to, true) } : {}),
  };
}

function isoDateToUnix(value: string, endExclusive = false): number {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }

  if (endExclusive) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  return Math.floor(date.getTime() / 1000);
}

function parseStatusIds(status?: string, statusId?: number): number[] | undefined {
  if (statusId) {
    return [statusId];
  }

  if (!status || !/^\d+$/.test(status)) {
    return undefined;
  }

  return [Number(status)];
}

function firstNumberArray(...values: Array<number | undefined>): number[] | undefined {
  const value = values.find(item => item !== undefined);
  return value === undefined ? undefined : [value];
}

function firstPresent(values: string[], candidates: string[]): string | undefined {
  return candidates.find(candidate => values.includes(candidate));
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
