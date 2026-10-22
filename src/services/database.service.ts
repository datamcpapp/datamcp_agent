import { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import {
  QueryRequest,
  QueryResult as AgentQueryResult,
  SchemaRequest,
  SchemaResult,
  SchemaData,
  TableSchema,
  HealthCheckRequest,
  HealthCheckResult,
} from '../types';
import { logger } from '../utils/logger';
import {
  boundReadQuery,
  capAgentRows,
  resolveMaxRows,
} from './query-result-policy';

interface TableRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  column_comment: string | null;
}

interface PrimaryKeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface ForeignKeyRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
}

interface IndexRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
}

/**
 * One DatabaseService instance owns one pg.Pool, bound to the agent's --db URL.
 * The cloud never sends DB credentials over the wire — it only sends a
 * connectionId in the WS handshake.
 */
export class DatabaseService {
  private pool: Pool | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly readOnlyCeiling = false,
  ) {}

  private getPool(): Pool {
    if (!this.pool) {
      logger.debug('Creating connection pool for local database');
      this.pool = new Pool({
        connectionString: this.databaseUrl,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      this.pool.on('error', (err) => {
        logger.warn(`Pool background error: ${err.message}`);
      });
    }
    return this.pool;
  }

  async preflight(): Promise<void> {
    const client = await this.getPool().connect();
    try {
      const r = await client.query('SELECT 1 as ok');
      if (r.rows[0]?.ok !== 1) throw new Error('unexpected query result');
    } finally {
      client.release();
    }
  }

  async executeQuery(request: QueryRequest): Promise<AgentQueryResult> {
    const startTime = Date.now();
    const { queryId, sql, params, timeoutMs = 30000 } = request;
    const readOnly = this.readOnlyCeiling || request.readOnly !== false;
    const maxRows = resolveMaxRows(request.maxRows);

    logger.info(`Executing query ${queryId}`);
    let client: PoolClient | undefined;
    try {
      client = await this.getPool().connect();
      const clampedTimeout = Math.max(
        1000,
        Math.min(600_000, Math.floor(timeoutMs)),
      );
      if (readOnly) {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${clampedTimeout}`);
      } else {
        await client.query(`SET statement_timeout = ${clampedTimeout}`);
      }

      const queryConfig: QueryConfig & { queryMode: 'extended' } = {
        text: readOnly ? boundReadQuery(sql, maxRows) : sql,
        values: params ?? [],
        queryMode: 'extended',
      };
      const result: QueryResult = await client.query(queryConfig);
      const capped = capAgentRows(result.rows, maxRows);

      const duration = Date.now() - startTime;
      logger.info(`Query ${queryId} ok`, { duration, rowCount: result.rowCount });

      return {
        queryId,
        success: true,
        rows: capped.rows,
        fields: (result.fields ?? []).map((f) => ({ name: f.name })),
        rowCount: readOnly ? capped.rows.length : (result.rowCount ?? 0),
        truncated: capped.truncated,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Query ${queryId} failed`, { error: errorMessage, duration });
      return {
        queryId,
        success: false,
        error: errorMessage,
        duration,
      };
    } finally {
      if (client) {
        await client
          .query(readOnly ? 'ROLLBACK' : 'RESET statement_timeout')
          .catch(() => {});
        client.release();
      }
    }
  }

  async extractSchema(request: SchemaRequest): Promise<SchemaResult> {
    const startTime = Date.now();
    const { requestId } = request;
    logger.info(`Extracting schema (request=${requestId})`);

    try {
      const pool = this.getPool();
      const client = await pool.connect();
      try {
        const tables = await this.extractTables(client);
        const duration = Date.now() - startTime;
        logger.info(`Schema extraction completed`, { duration, tableCount: tables.length });

        const schema: SchemaData = {
          tables,
          extractedAt: new Date().toISOString(),
        };
        return { requestId, success: true, schema, duration };
      } finally {
        client.release();
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Schema extraction failed`, { error: errorMessage });
      return { requestId, success: false, error: errorMessage, duration };
    }
  }

  async checkHealth(request: HealthCheckRequest): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const { requestId } = request;

    try {
      const client = await this.getPool().connect();
      try {
        await client.query('SELECT 1');
        const latency = Date.now() - startTime;
        return { requestId, success: true, latency };
      } finally {
        client.release();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { requestId, success: false, error: errorMessage };
    }
  }

  private async extractTables(client: PoolClient): Promise<TableSchema[]> {
    const tablesQuery = `
      SELECT
        t.table_schema,
        t.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        pgd.description as column_comment
      FROM information_schema.tables t
      JOIN information_schema.columns c
        ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
      LEFT JOIN pg_catalog.pg_statio_all_tables st
        ON st.schemaname = t.table_schema
        AND st.relname = t.table_name
      LEFT JOIN pg_catalog.pg_description pgd
        ON pgd.objoid = st.relid
        AND pgd.objsubid = c.ordinal_position
      WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_schema, t.table_name, c.ordinal_position
    `;

    const result = await client.query<TableRow>(tablesQuery);
    const tablesMap = new Map<string, TableSchema>();

    for (const row of result.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      if (!tablesMap.has(tableKey)) {
        tablesMap.set(tableKey, {
          name: row.table_name,
          schema: row.table_schema,
          columns: [],
        });
      }
      const table = tablesMap.get(tableKey)!;
      table.columns.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        default: row.column_default || undefined,
        comment: row.column_comment || undefined,
      });
    }

    const pkResult = await client.query<PrimaryKeyRow>(`
      SELECT tc.table_schema, tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position
    `);
    for (const row of pkResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tablesMap.get(tableKey);
      if (table) {
        if (!table.primaryKey) table.primaryKey = [];
        table.primaryKey.push(row.column_name);
      }
    }

    const fkResult = await client.query<ForeignKeyRow>(`
      SELECT tc.table_schema, tc.table_name, tc.constraint_name,
             kcu.column_name,
             ccu.table_name AS referenced_table,
             ccu.column_name AS referenced_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_name
    `);
    const fkMap = new Map<
      string,
      Map<string, { columns: string[]; referencedTable: string; referencedColumns: string[] }>
    >();
    for (const row of fkResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      if (!fkMap.has(tableKey)) fkMap.set(tableKey, new Map());
      const tableFks = fkMap.get(tableKey)!;
      if (!tableFks.has(row.constraint_name)) {
        tableFks.set(row.constraint_name, {
          columns: [],
          referencedTable: row.referenced_table,
          referencedColumns: [],
        });
      }
      const fk = tableFks.get(row.constraint_name)!;
      fk.columns.push(row.column_name);
      fk.referencedColumns.push(row.referenced_column);
    }
    for (const [tableKey, tableFks] of fkMap.entries()) {
      const table = tablesMap.get(tableKey);
      if (table) {
        table.foreignKeys = Array.from(tableFks.entries()).map(([name, fk]) => ({
          name,
          columns: fk.columns,
          referencedTable: fk.referencedTable,
          referencedColumns: fk.referencedColumns,
        }));
      }
    }

    const indexResult = await client.query<IndexRow>(`
      SELECT schemaname, tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename, indexname
    `);
    for (const row of indexResult.rows) {
      const tableKey = `${row.schemaname}.${row.tablename}`;
      const table = tablesMap.get(tableKey);
      if (table) {
        if (!table.indexes) table.indexes = [];
        const match = row.indexdef.match(/\((.*?)\)/);
        const columns = match ? match[1].split(',').map((c) => c.trim()) : [];
        table.indexes.push({
          name: row.indexname,
          columns,
          unique: row.indexdef.includes('UNIQUE'),
        });
      }
    }

    return Array.from(tablesMap.values());
  }

  async closeAll(): Promise<void> {
    if (!this.pool) return;
    logger.info('Closing local database pool');
    try {
      await this.pool.end();
    } catch (error) {
      logger.error(`Error closing pool`, { error });
    }
    this.pool = null;
  }
}
