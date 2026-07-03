/**
 * Agent-side access policy — the LOCAL enforcement ceiling for this agent
 * instance, chosen on the command line (`datamcp ro|rwd|fa <db-url>`).
 *
 * This mirrors the DataMCP MCP-link preset semantics, but is enforced right here
 * at the database connection, independent of (and in addition to) whatever the
 * cloud link permits. Effective access = intersection of the two, so the agent
 * can never exceed its ceiling even if a link is misconfigured.
 *
 *   ro  (read-only)         every statement runs inside BEGIN TRANSACTION READ ONLY
 *   rwd (read-write-delete)  SELECT/other → read-only tx; INSERT/UPDATE/DELETE → write;
 *                            DDL, multi-statement, and dangerous functions blocked
 *   fa  (full-access)        unrestricted — the database role is the only limit
 *
 * Why SELECTs run read-only even under rwd: a SELECT never legitimately writes,
 * so forcing it read-only blocks `SELECT malicious_writer()` escalation —
 * PostgreSQL rejects writes inside a read-only transaction, even ones a called
 * function attempts. Identical to the cloud's read-write behavior.
 */

export type Policy = 'ro' | 'rwd' | 'fa';

const POLICY_ALIASES: Record<string, Policy> = {
  ro: 'ro', 'read-only': 'ro', readonly: 'ro', r: 'ro',
  rwd: 'rwd', rw: 'rwd', 'read-write': 'rwd', 'read-write-delete': 'rwd', write: 'rwd',
  fa: 'fa', full: 'fa', 'full-access': 'fa', fullaccess: 'fa',
};

export function parsePolicy(input: string | undefined): Policy | null {
  if (!input) return null;
  return POLICY_ALIASES[input.toLowerCase()] ?? null;
}

export const POLICY_LABEL: Record<Policy, string> = {
  ro: 'read-only',
  rwd: 'read-write-delete',
  fa: 'full-access',
};

/** Functions that read/write files, open outbound connections (dblink escapes
 *  the read-only transaction!), or enable DoS. Blocked under ro and rwd. */
const DANGEROUS_FUNCTIONS = [
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_read_file', 'pg_read_binary_file',
  'pg_ls_dir', 'lo_import', 'lo_export', 'dblink', 'dblink_exec', 'dblink_connect',
  'dblink_open', 'dblink_send_query', 'dblink_get_result', 'dblink_fetch',
  'pg_sleep', 'set_config', 'pg_reload_conf', 'pg_rotate_logfile',
];

const DDL_LEADING = /^\s*(create|drop|alter|truncate|grant|revoke|comment|reindex|vacuum|cluster|refresh|security|reassign)\b/i;

function strip(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
}

export function isMultiStatement(sql: string): boolean {
  const noLiterals = strip(sql)
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '')
    .replace(/"(?:[^"]|"")*"/g, '""');
  return /;/.test(noLiterals.replace(/;\s*$/, ''));
}

function hasDangerousFunction(sql: string): string | null {
  const s = strip(sql);
  const normalized = s.replace(/"/g, ''); // defeat quoted-identifier evasion
  for (const fn of DANGEROUS_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (re.test(s) || re.test(normalized)) return fn;
  }
  return null;
}

function isSelectInto(sql: string): boolean {
  return /^\s*(with\b[\s\S]+?\)\s*)?select\b[\s\S]*?\binto\s+(temp\s+|temporary\s+|unlogged\s+)?(table\s+)?["a-z_]/i.test(strip(sql));
}

export type Op = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'DDL' | 'OTHER';

export function classify(sql: string): Op {
  const s = strip(sql).replace(/"/g, '');
  if (DDL_LEADING.test(s)) return 'DDL';
  if (/^\s*insert\b/i.test(s)) return 'INSERT';
  if (/^\s*update\b/i.test(s)) return 'UPDATE';
  if (/^\s*delete\b/i.test(s)) return 'DELETE';
  if (/^\s*(select|with|values|table)\b/i.test(s)) return 'SELECT';
  return 'OTHER';
}

export interface Decision {
  allow: boolean;
  /** Run inside BEGIN TRANSACTION READ ONLY. */
  readOnlyTx: boolean;
  reason?: string;
}

/**
 * Decide how a statement executes under the agent's policy.
 * The database-level read-only transaction is the real enforcement; the text
 * checks here fail fast and block escapes a transaction cannot (dblink).
 */
export function decide(policy: Policy, sql: string): Decision {
  if (policy === 'fa') return { allow: true, readOnlyTx: false };

  if (isMultiStatement(sql)) {
    return { allow: false, readOnlyTx: false, reason: 'multiple statements are not allowed' };
  }
  const danger = hasDangerousFunction(sql);
  if (danger) return { allow: false, readOnlyTx: false, reason: `blocked function: ${danger}` };

  const op = classify(sql);

  if (policy === 'ro') {
    if (op !== 'SELECT' && op !== 'OTHER') {
      return { allow: false, readOnlyTx: true, reason: `read-only: ${op} not allowed` };
    }
    if (isSelectInto(sql)) return { allow: false, readOnlyTx: true, reason: 'SELECT INTO not allowed' };
    // Belt (on top of the read-only transaction): reject any embedded write
    // construct so writable CTEs like `WITH x AS (DELETE ...) SELECT ...` are
    // blocked at the text level too, not only by the transaction.
    if (/\b(insert|update|delete|merge|truncate|drop|create|alter|grant|revoke|copy)\b/i.test(strip(sql).replace(/"/g, ''))) {
      return { allow: false, readOnlyTx: true, reason: 'read-only: write construct not allowed' };
    }
    return { allow: true, readOnlyTx: true };
  }

  // rwd
  if (op === 'DDL') {
    return { allow: false, readOnlyTx: false, reason: 'DDL not allowed under read-write-delete (use full-access)' };
  }
  if (op === 'INSERT' || op === 'UPDATE' || op === 'DELETE') {
    return { allow: true, readOnlyTx: false }; // genuine data write
  }
  if (isSelectInto(sql)) return { allow: false, readOnlyTx: true, reason: 'SELECT INTO not allowed' };
  // SELECT / OTHER → read-only tx (blocks disguised writes & function escalation)
  return { allow: true, readOnlyTx: true };
}
