/**
 * Agent-side read-only guard — defense in depth on top of the READ ONLY
 * transaction the executor wraps every query in.
 *
 * WHY THIS LIVES ON THE AGENT: on the tunnel path the `pg` client runs HERE, not
 * in the cloud. The cloud validates permissions before dispatch, but the actual
 * database connection is local to the agent, so the hard database-level
 * enforcement (READ ONLY transaction) and this text filter must run agent-side —
 * otherwise the tunnel would reopen the very bypasses the cloud closed.
 *
 * This is a pure-regex port of the cloud's `preParseCheck` (query-validation
 * service), including the quoted-identifier normalization that closed the
 * `SELECT "dblink_exec"(...)` bypass. The READ ONLY transaction is the primary
 * control; this filter blocks classes that escape a transaction entirely
 * (dblink opens a SEPARATE connection) or that a naive check would miss.
 */

/**
 * Functions that must never run: they read/write files, open outbound
 * connections (dblink — escapes the read-only transaction!), or enable DoS.
 */
const DANGEROUS_FUNCTIONS = [
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'lo_import',
  'lo_export',
  'dblink',
  'dblink_exec',
  'dblink_connect',
  'dblink_open',
  'dblink_send_query',
  'dblink_get_result',
  'dblink_fetch',
  'pg_sleep',
  'set_config',
  'pg_reload_conf',
  'pg_rotate_logfile',
];

/** Statement types that are never read-only, matched at the start of the query. */
const BLOCKED_LEADING = [
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'VACUUM', 'REINDEX',
  'CLUSTER', 'COMMENT', 'COPY', 'EXECUTE', 'PREPARE', 'SET', 'SHOW', 'LOAD',
  'DO', 'CALL', 'LOCK', 'DISCARD', 'REASSIGN', 'SECURITY', 'RESET', 'REFRESH',
  'NOTIFY', 'LISTEN', 'UNLISTEN', 'INSERT', 'UPDATE', 'DELETE', 'MERGE',
];

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Returns { allowed: false, reason } if the query is not a safe read.
 * Conservative by design: when in doubt, block.
 */
export function checkReadOnly(sql: string): GuardResult {
  // Strip comments so they can't hide keywords (-- line and /* */ block).
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (!stripped) {
    return { allowed: false, reason: 'empty query' };
  }

  // Quote-normalized form: PostgreSQL treats `"pg_sleep"(...)` identically to
  // `pg_sleep(...)`, but a naive `\bname\(` regex is defeated by the quotes.
  const normalized = stripped.replace(/"/g, '');

  // 1. Reject multi-statement queries outright — the agent only runs single reads.
  //    (A trailing semicolon is fine; an internal one is not.)
  if (/;\s*\S/.test(stripped.replace(/;\s*$/, ''))) {
    return { allowed: false, reason: 'multiple statements are not allowed' };
  }

  // 2. Dangerous functions (check raw AND quote-normalized forms).
  for (const fn of DANGEROUS_FUNCTIONS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (re.test(stripped) || re.test(normalized)) {
      return { allowed: false, reason: `blocked function: ${fn}` };
    }
  }

  // 3. Must read: begin with SELECT / WITH / VALUES / TABLE.
  if (!/^\s*(select|with|values|table)\b/i.test(normalized)) {
    return { allowed: false, reason: 'only read (SELECT/WITH/VALUES/TABLE) queries are allowed' };
  }

  // 4. No write keyword anywhere — covers writable CTEs
  //    (`WITH x AS (DELETE ...) SELECT ...`) and `SELECT ... INTO <table>`.
  const writeWord = new RegExp(`\\b(${BLOCKED_LEADING.join('|')}|into|nextval|setval)\\b`, 'i');
  if (writeWord.test(normalized)) {
    return { allowed: false, reason: 'query contains a write/DDL construct' };
  }

  return { allowed: true };
}
