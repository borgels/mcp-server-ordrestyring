// The Ordrestyring schema fixture from tools.test.ts, shared with the gateway tests.

export function mockSchema() {
  return {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      objectType('Query', [
        field('cases', named('CaseConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
          arg('filters', named('CaseFilterInput')),
        ]),
        field('hours', named('HourConnection'), [
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('between', named('HourBetweenInput')),
          arg('filters', named('HoursFilterInput')),
        ]),
        field('caseMaterials', named('CaseMaterialConnection'), [
          arg('caseId', named('Int')),
          arg('type', nonNull(named('AddedBy'))),
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('filters', named('CaseMaterialsFilterInput')),
        ]),
        field('creditors', named('CreditorConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
        ]),
        field('creditor', named('Creditor'), [arg('number', nonNull(named('String')))]),
        field('products', named('ProductConnection'), [
          arg('pagination', nonNull(named('PaginationInput'))),
          arg('orderBy', list(named('OrderByInput'))),
          arg('type', named('ProductTypeEnum')),
          arg('search', named('Search')),
        ]),
        field('product', named('Product'), [arg('id', nonNull(named('Int')))]),
        field('hourTypes', named('HourTypeConnection'), [
          arg('pagination', named('PaginationInput')),
          arg('orderBy', list(named('OrderByInput'))),
          arg('search', named('Search')),
          arg('requireCase', named('Boolean')),
          arg('allHourTypes', named('Boolean')),
        ]),
      ]),
      objectType('Mutation', [
        field('createCase', named('Case'), [arg('input', nonNull(named('CreateCaseInput')))]),
        field('createOffer', named('Offer'), [arg('input', nonNull(named('CreateOfferInput')))]),
        field('createProduct', named('Product'), [arg('input', nonNull(named('CreateProductInput')))]),
        field('updateProduct', named('Product'), [
          arg('id', nonNull(named('Int'))),
          arg('input', nonNull(named('UpdateProductInput'))),
        ]),
        field('deleteProduct', named('Null'), [arg('id', list(nonNull(named('Int'))))]),
        field('createHourType', named('HourType'), [arg('input', nonNull(named('CreateHourTypeInput')))]),
        field('updateHourType', named('HourType'), [
          arg('id', nonNull(named('Int'))),
          arg('input', nonNull(named('UpdateHourTypeInput'))),
        ]),
      ]),
      objectType('CaseConnection', [
        field('items', list(named('Case'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Case', [
        field('id', named('Int')),
        field('caseNumber', named('String')),
        field('status', named('String')),
        field('customer', named('Customer')),
      ]),
      objectType('HourConnection', [
        field('items', list(named('Hour'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Hour', [
        field('id', named('Int')),
        field('description', named('String')),
        field('startTime', named('Int')),
        field('billableHours', named('Float')),
      ]),
      objectType('CaseMaterialConnection', [
        field('items', list(named('CaseMaterial'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('CaseMaterial', [
        field('id', named('Int')),
        field('description', named('String')),
        field('quantity', named('Float')),
        field('type', named('AddedBy')),
      ]),
      objectType('CreditorConnection', [
        field('items', list(named('Creditor'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Creditor', [
        field('id', named('String')),
        field('number', named('String')),
        field('name', named('String')),
        field('address', named('String')),
        field('postalCode', named('String')),
        field('city', named('String')),
        field('vatNumber', named('String')),
      ]),
      objectType('ProductConnection', [
        field('items', list(named('Product'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('Product', [
        field('id', named('Int')),
        field('number', named('String')),
        field('description', named('String')),
        field('isHour', named('Boolean')),
        field('costPrice', named('Float')),
        field('listPrice', named('Float')),
      ]),
      objectType('HourTypeConnection', [
        field('items', list(named('HourType'))),
        field('nextCursor', named('String')),
        field('previousCursor', named('String')),
      ]),
      objectType('HourType', [
        field('id', named('Int')),
        field('name', named('String')),
        field('requireCase', named('Boolean')),
        field('color', named('String')),
        field('sortOrder', named('Int')),
        field('product', named('Product')),
      ]),
      objectType('Customer', [field('id', named('Int')), field('name', named('String'))]),
      objectType('Offer', [
        field('id', named('Int')),
        field('number', named('String')),
        field('description', named('String')),
      ]),
      inputType('PaginationInput', [inputField('cursor', named('String')), inputField('limit', nonNull(named('Int')))]),
      inputType('OrderByInput', [inputField('field', nonNull(named('String'))), inputField('direction', nonNull(named('Direction')))]),
      inputType('Search', [inputField('query', named('String')), inputField('fields', nonNull(list(named('String'))))]),
      inputType('CaseFilterInput', [inputField('statuses', list(named('Int'))), inputField('customers', list(named('Int')))]),
      inputType('HoursFilterInput', [inputField('case', named('Int')), inputField('users', list(named('Int')))]),
      inputType('HourBetweenInput', [
        inputField('field', nonNull(named('HourBetweenColumn'))),
        inputField('from', named('Int')),
        inputField('to', named('Int')),
      ]),
      inputType('CaseMaterialsFilterInput', [inputField('caseIds', list(named('Int')))]),
      inputType('CreateCaseInput', [
        inputField('customerId', nonNull(named('Int'))),
        inputField('description', nonNull(named('String'))),
        inputField('statusId', nonNull(named('Int'))),
      ]),
      inputType('CreateOfferInput', [
        inputField('customerId', nonNull(named('Int'))),
        inputField('description', named('String')),
      ]),
      inputType('CreateProductInput', [
        inputField('number', nonNull(named('String'))),
        inputField('description', nonNull(named('String'))),
        inputField('costPrice', nonNull(named('Float'))),
        inputField('listPrice', nonNull(named('Float'))),
        inputField('isHour', nonNull(named('Boolean'))),
      ]),
      inputType('UpdateProductInput', [
        inputField('number', named('String')),
        inputField('description', named('String')),
        inputField('costPrice', named('Float')),
        inputField('listPrice', named('Float')),
      ]),
      inputType('CreateHourTypeInput', [
        inputField('name', nonNull(named('String'))),
        inputField('productNumber', named('String')),
        inputField('requireCase', nonNull(named('Boolean'))),
        inputField('color', nonNull(named('String'))),
      ]),
      inputType('UpdateHourTypeInput', [
        inputField('name', named('String')),
        inputField('productNumber', named('String')),
        inputField('color', named('String')),
        inputField('sortOrder', named('Int')),
      ]),
      enumType('Direction', ['ASC', 'DESC']),
      enumType('ProductTypeEnum', ['ITEMS', 'HOURS']),
      enumType('HourBetweenColumn', ['id', 'startTime', 'createdAt', 'updatedAt']),
      enumType('AddedBy', ['MATERIAL', 'OFFER']),
      scalarType('Boolean'),
      scalarType('Float'),
      scalarType('Int'),
      scalarType('Null'),
      scalarType('String'),
    ],
  };
}

function objectType(name: string, fields: unknown[]) {
  return { kind: 'OBJECT', name, fields, inputFields: null, enumValues: null };
}

function inputType(name: string, inputFields: unknown[] = []) {
  return { kind: 'INPUT_OBJECT', name, fields: null, inputFields, enumValues: null };
}

function enumType(name: string, values: string[]) {
  return {
    kind: 'ENUM',
    name,
    fields: null,
    inputFields: null,
    enumValues: values.map(value => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })),
  };
}

function scalarType(name: string) {
  return { kind: 'SCALAR', name, fields: null, inputFields: null, enumValues: null };
}

function field(name: string, type: unknown, args: unknown[] = []) {
  return { name, description: null, isDeprecated: false, deprecationReason: null, args, type };
}

function arg(name: string, type: unknown) {
  return { name, description: null, defaultValue: null, type };
}

function inputField(name: string, type: unknown) {
  return { name, description: null, defaultValue: null, type };
}

function named(name: string) {
  const scalarNames = new Set(['Int', 'String', 'Boolean', 'Float', 'ID', 'Null']);
  return { kind: scalarNames.has(name) ? 'SCALAR' : 'OBJECT', name, ofType: null };
}

function list(ofType: unknown) {
  return { kind: 'LIST', name: null, ofType };
}

function nonNull(ofType: unknown) {
  return { kind: 'NON_NULL', name: null, ofType };
}
