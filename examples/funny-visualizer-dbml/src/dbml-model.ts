import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout, type RefEndpoint } from '@dbml/parse';

export type DbmlColumn = {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  notNull?: boolean;
  note?: string;
  /** FK column referencing another table (derived from Ref). */
  fk?: boolean;
  fkTarget?: string;
};

export type DbmlTable = {
  name: string;
  columns: DbmlColumn[];
  headerColor?: string;
  note?: string;
};

export type DbmlRef = {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
};

export type DbmlModel = {
  tables: DbmlTable[];
  refs: DbmlRef[];
};

function refEndpointsToEdge(endpoints: RefEndpoint[]): DbmlRef | null {
  if (endpoints.length < 2) return null;
  const [a, b] = endpoints;
  const aCol = a.fieldNames[0];
  const bCol = b.fieldNames[0];
  if (!aCol || !bCol) return null;

  const aMany = a.relation === '*';
  const bMany = b.relation === '*';

  if (aMany && !bMany) {
    return {
      sourceTable: a.tableName,
      sourceColumn: aCol,
      targetTable: b.tableName,
      targetColumn: bCol,
    };
  }
  if (bMany && !aMany) {
    return {
      sourceTable: b.tableName,
      sourceColumn: bCol,
      targetTable: a.tableName,
      targetColumn: aCol,
    };
  }

  return {
    sourceTable: a.tableName,
    sourceColumn: aCol,
    targetTable: b.tableName,
    targetColumn: bCol,
  };
}

function formatCompileErrors(errors: { message: string }[]): string {
  return errors.map((e) => e.message).join('; ') || 'Invalid DBML';
}

/**
 * Parse DBML into a plain model for React Flow. Uses @dbml/parse (dbdiagram.io v2 parser).
 */
export function parseDbml(source: string): DbmlModel {
  const layout = new MemoryProjectLayout({ [DEFAULT_ENTRY]: source.trim() });
  const compiler = new Compiler(layout);
  const report = compiler.interpretFile(DEFAULT_ENTRY);
  const errors = report.getErrors();
  if (errors.length > 0) {
    throw new Error(formatCompileErrors(errors));
  }

  const db = report.getValue();
  if (!db) {
    throw new Error('Invalid DBML');
  }

  const refs: DbmlRef[] = [];
  for (const ref of db.refs) {
    const edge = refEndpointsToEdge(ref.endpoints);
    if (edge) refs.push(edge);
  }

  const fkByColumn = new Map<string, DbmlRef>();
  for (const ref of refs) {
    fkByColumn.set(`${ref.sourceTable}.${ref.sourceColumn}`, ref);
  }

  const tables: DbmlTable[] = db.tables.map((table) => ({
    name: table.name,
    headerColor: table.headerColor,
    note: table.note?.value,
    columns: table.fields.map((field) => {
      const fkRef = fkByColumn.get(`${table.name}.${field.name}`);
      return {
        name: field.name,
        type: field.type.type_name,
        pk: field.pk,
        unique: field.unique,
        notNull: field.not_null,
        note: field.note?.value,
        fk: fkRef !== undefined,
        fkTarget: fkRef ? `${fkRef.targetTable}.${fkRef.targetColumn}` : undefined,
      };
    }),
  }));

  return { tables, refs };
}
