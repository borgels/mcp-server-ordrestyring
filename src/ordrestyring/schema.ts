import type { OrdrestyringClient } from './client.js';

export interface GraphQLTypeRef {
  kind: string;
  name?: string | null;
  ofType?: GraphQLTypeRef | null;
}

export interface GraphQLInputValue {
  name: string;
  description?: string | null;
  defaultValue?: string | null;
  type: GraphQLTypeRef;
}

export interface GraphQLField {
  name: string;
  description?: string | null;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
  args: GraphQLInputValue[];
  type: GraphQLTypeRef;
}

export interface GraphQLEnumValue {
  name: string;
  description?: string | null;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

export interface GraphQLType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: GraphQLField[] | null;
  inputFields?: GraphQLInputValue[] | null;
  enumValues?: GraphQLEnumValue[] | null;
}

export interface GraphQLSchemaCatalog {
  queryTypeName: string;
  mutationTypeName?: string;
  types: GraphQLType[];
  typeByName: Map<string, GraphQLType>;
  queryFields: GraphQLField[];
  mutationFields: GraphQLField[];
}

export interface SchemaSearchResult {
  kind: 'type' | 'query' | 'mutation' | 'field';
  name: string;
  parent?: string;
  description?: string | null;
  type?: string;
  args?: Array<{ name: string; type: string; description?: string | null }>;
}

const schemaCache = new WeakMap<OrdrestyringClient, Promise<GraphQLSchemaCatalog>>();

export async function getSchemaCatalog(client: OrdrestyringClient): Promise<GraphQLSchemaCatalog> {
  const cached = schemaCache.get(client);
  if (cached) {
    return cached;
  }

  const promise = fetchSchemaCatalog(client);
  schemaCache.set(client, promise);
  return promise;
}

export async function refreshSchemaCatalog(client: OrdrestyringClient): Promise<GraphQLSchemaCatalog> {
  schemaCache.delete(client);
  return getSchemaCatalog(client);
}

export function searchSchema(
  catalog: GraphQLSchemaCatalog,
  query: string,
  limit = 20,
): SchemaSearchResult[] {
  const normalized = query.trim().toLowerCase();
  const results: Array<{ result: SchemaSearchResult; score: number }> = [];

  for (const type of catalog.types) {
    if (type.name.startsWith('__')) {
      continue;
    }

    pushScored(results, normalized, {
      kind: 'type',
      name: type.name,
      description: type.description,
      type: type.kind,
    });

    for (const field of type.fields ?? []) {
      pushScored(results, normalized, {
        kind: type.name === catalog.queryTypeName ? 'query' : type.name === catalog.mutationTypeName ? 'mutation' : 'field',
        name: field.name,
        parent: type.name,
        description: field.description,
        type: typeRefToString(field.type),
        args: field.args.map(arg => ({
          name: arg.name,
          type: typeRefToString(arg.type),
          description: arg.description,
        })),
      });
    }
  }

  return results
    .filter(item => !normalized || item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.name.localeCompare(b.result.name))
    .slice(0, limit)
    .map(item => item.result);
}

export function getSchemaType(catalog: GraphQLSchemaCatalog, typeName: string): GraphQLType {
  const type = catalog.typeByName.get(typeName);
  if (!type) {
    throw new Error(`Ordrestyring schema type not found: ${typeName}`);
  }

  return type;
}

export function findQueryField(
  catalog: GraphQLSchemaCatalog,
  candidates: string[],
): GraphQLField {
  const field = firstFieldByCandidates(catalog.queryFields, candidates);
  if (!field) {
    throw new Error(
      `Ordrestyring schema does not expose any of these query fields: ${candidates.join(', ')}`,
    );
  }

  return field;
}

export function firstFieldByCandidates(
  fields: GraphQLField[],
  candidates: string[],
): GraphQLField | undefined {
  const byLowerName = new Map(fields.map(field => [field.name.toLowerCase(), field]));

  for (const candidate of candidates) {
    const exact = byLowerName.get(candidate.toLowerCase());
    if (exact) {
      return exact;
    }
  }

  return fields.find(field =>
    candidates.some(candidate => field.name.toLowerCase().includes(candidate.toLowerCase())),
  );
}

export function namedTypeName(ref: GraphQLTypeRef): string | undefined {
  if (ref.name) {
    return ref.name;
  }

  return ref.ofType ? namedTypeName(ref.ofType) : undefined;
}

export function namedTypeKind(ref: GraphQLTypeRef): string | undefined {
  if (ref.kind !== 'NON_NULL' && ref.kind !== 'LIST') {
    return ref.kind;
  }

  return ref.ofType ? namedTypeKind(ref.ofType) : undefined;
}

export function typeRefToString(ref: GraphQLTypeRef): string {
  if (ref.kind === 'NON_NULL' && ref.ofType) {
    return `${typeRefToString(ref.ofType)}!`;
  }

  if (ref.kind === 'LIST' && ref.ofType) {
    return `[${typeRefToString(ref.ofType)}]`;
  }

  return ref.name ?? ref.kind;
}

export function isListType(ref: GraphQLTypeRef): boolean {
  if (ref.kind === 'LIST') {
    return true;
  }

  return ref.ofType ? isListType(ref.ofType) : false;
}

export function isScalarLike(ref: GraphQLTypeRef): boolean {
  const kind = namedTypeKind(ref);
  return kind === 'SCALAR' || kind === 'ENUM';
}

export function scalarFieldNames(
  catalog: GraphQLSchemaCatalog,
  typeName: string,
  preferred: string[],
  fallbackLimit = 12,
): string[] {
  const type = getSchemaType(catalog, typeName);
  const fields = type.fields ?? [];
  const selected = new Set<string>();

  for (const name of preferred) {
    const field = fields.find(item => item.name === name);
    if (field && isScalarLike(field.type)) {
      selected.add(field.name);
    }
  }

  for (const field of fields) {
    if (selected.size >= fallbackLimit) {
      break;
    }

    if (isScalarLike(field.type)) {
      selected.add(field.name);
    }
  }

  return [...selected];
}

export function selectionForType(
  catalog: GraphQLSchemaCatalog,
  typeName: string,
  preferredScalars: string[],
  nestedPreferred: Record<string, string[]> = {},
): string {
  const type = getSchemaType(catalog, typeName);
  const fields = type.fields ?? [];
  const selected = new Set(scalarFieldNames(catalog, typeName, preferredScalars));
  const lines = [...selected];

  for (const [fieldName, nestedFields] of Object.entries(nestedPreferred)) {
    const field = fields.find(item => item.name === fieldName);
    const nestedTypeName = field ? namedTypeName(field.type) : undefined;
    if (!field || !nestedTypeName || isScalarLike(field.type) || isListType(field.type)) {
      continue;
    }

    const nestedSelection = scalarFieldNames(catalog, nestedTypeName, nestedFields, 6);
    if (nestedSelection.length) {
      lines.push(`${field.name} { ${nestedSelection.join(' ')} }`);
    }
  }

  if (!lines.length) {
    throw new Error(`Ordrestyring schema type ${typeName} has no scalar fields to select.`);
  }

  return lines.join('\n');
}

export function connectionSelectionForField(
  catalog: GraphQLSchemaCatalog,
  field: GraphQLField,
  preferredScalars: string[],
  nestedPreferred: Record<string, string[]> = {},
): string {
  const returnTypeName = namedTypeName(field.type);
  if (!returnTypeName) {
    throw new Error(`Ordrestyring field ${field.name} has no named return type.`);
  }

  if (isListType(field.type)) {
    return selectionForType(catalog, returnTypeName, preferredScalars, nestedPreferred);
  }

  const returnType = getSchemaType(catalog, returnTypeName);
  const itemsField = returnType.fields?.find(item => item.name === 'items');
  const itemTypeName = itemsField ? namedTypeName(itemsField.type) : undefined;
  if (itemsField && itemTypeName) {
    const cursorFields = ['nextCursor', 'previousCursor']
      .filter(name => returnType.fields?.some(item => item.name === name))
      .join('\n');
    return [
      `items { ${selectionForType(catalog, itemTypeName, preferredScalars, nestedPreferred)} }`,
      cursorFields,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return selectionForType(catalog, returnTypeName, preferredScalars, nestedPreferred);
}

export function extractCollectionItems(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    return record.items;
  }

  return [];
}

async function fetchSchemaCatalog(client: OrdrestyringClient): Promise<GraphQLSchemaCatalog> {
  const data = await client.graphql<{
    __schema: {
      queryType: { name: string };
      mutationType?: { name: string } | null;
      types: GraphQLType[];
    };
  }>({
    query: fullIntrospectionQuery(),
  });

  const typeByName = new Map(data.__schema.types.map(type => [type.name, type]));
  const queryType = typeByName.get(data.__schema.queryType.name);
  const mutationType = data.__schema.mutationType?.name
    ? typeByName.get(data.__schema.mutationType.name)
    : undefined;

  return {
    queryTypeName: data.__schema.queryType.name,
    mutationTypeName: data.__schema.mutationType?.name,
    types: data.__schema.types,
    typeByName,
    queryFields: queryType?.fields ?? [],
    mutationFields: mutationType?.fields ?? [],
  };
}

function pushScored(
  results: Array<{ result: SchemaSearchResult; score: number }>,
  normalizedQuery: string,
  result: SchemaSearchResult,
): void {
  const haystack = [
    result.kind,
    result.name,
    result.parent,
    result.description,
    result.type,
    ...(result.args ?? []).map(arg => `${arg.name} ${arg.type} ${arg.description ?? ''}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const score = normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);

  results.push({ result, score });
}

function fullIntrospectionQuery(): string {
  return `
    query OrdrestyringMcpFullIntrospection {
      __schema {
        queryType { name }
        mutationType { name }
        types {
          kind
          name
          description
          fields(includeDeprecated: true) {
            name
            description
            isDeprecated
            deprecationReason
            args {
              name
              description
              defaultValue
              type { ...TypeRef }
            }
            type { ...TypeRef }
          }
          inputFields {
            name
            description
            defaultValue
            type { ...TypeRef }
          }
          enumValues(includeDeprecated: true) {
            name
            description
            isDeprecated
            deprecationReason
          }
        }
      }
    }

    fragment TypeRef on __Type {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  `;
}
