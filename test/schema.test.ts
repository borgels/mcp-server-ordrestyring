import { describe, expect, it } from 'vitest';
import {
  connectionSelectionForField,
  getSchemaType,
  refreshSchemaCatalog,
  searchSchema,
  selectionForType,
  type GraphQLField,
  type GraphQLSchemaCatalog,
  type GraphQLType,
  type GraphQLTypeRef,
} from '../src/ordrestyring/schema.js';

describe('Ordrestyring schema helpers', () => {
  it('searches types and fields', () => {
    const results = searchSchema(mockCatalog(), 'case customer', 10);

    expect(results.map(result => result.name)).toContain('cases');
    expect(results.map(result => result.name)).toContain('Customer');
  });

  it('builds scalar and nested selections from live type metadata', () => {
    expect(
      selectionForType(mockCatalog(), 'Case', ['id', 'caseNumber'], {
        customer: ['id', 'name'],
      }),
    ).toBe('id\ncaseNumber\ncustomer { id name }');
  });

  it('builds cursor connection selections', () => {
    const catalog = mockCatalog();
    const casesField = getSchemaType(catalog, 'Query').fields?.find(field => field.name === 'cases');
    if (!casesField) {
      throw new Error('cases field missing');
    }

    expect(connectionSelectionForField(catalog, casesField, ['id', 'caseNumber'])).toContain(
      'items { id\ncaseNumber }',
    );
  });

  it('can refresh the per-client schema cache', async () => {
    let calls = 0;
    const client = {
      graphql: async () => {
        calls += 1;
        return { __schema: mockCatalogSource() };
      },
    };

    await refreshSchemaCatalog(client as never);
    await refreshSchemaCatalog(client as never);

    expect(calls).toBe(2);
  });
});

function mockCatalog(): GraphQLSchemaCatalog {
  const types = mockCatalogSource().types;
  const typeByName = new Map(types.map(type => [type.name, type]));
  return {
    queryTypeName: 'Query',
    mutationTypeName: 'Mutation',
    types,
    typeByName,
    queryFields: typeByName.get('Query')?.fields ?? [],
    mutationFields: typeByName.get('Mutation')?.fields ?? [],
  };
}

function mockCatalogSource(): {
  queryType: { name: string };
  mutationType: { name: string };
  types: GraphQLType[];
} {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      objectType('Query', [field('cases', named('CaseConnection'))]),
      objectType('Mutation', []),
      objectType('CaseConnection', [
        field('items', list(named('Case'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Case', [
        field('id', named('Int')),
        field('caseNumber', named('String')),
        field('customer', named('Customer')),
      ]),
      objectType('Customer', [field('id', named('Int')), field('name', named('String'))]),
    ],
  };
}

function objectType(name: string, fields: GraphQLField[]): GraphQLType {
  return { kind: 'OBJECT', name, fields, inputFields: null, enumValues: null };
}

function field(name: string, type: GraphQLTypeRef): GraphQLField {
  return { name, description: null, isDeprecated: false, deprecationReason: null, args: [], type };
}

function named(name: string): GraphQLTypeRef {
  const scalarNames = new Set(['Int', 'String', 'Boolean', 'Float', 'ID']);
  return { kind: scalarNames.has(name) ? 'SCALAR' : 'OBJECT', name, ofType: null };
}

function list(ofType: GraphQLTypeRef): GraphQLTypeRef {
  return { kind: 'LIST', name: null, ofType };
}
