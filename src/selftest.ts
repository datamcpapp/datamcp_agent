import { Client } from 'pg';

import { AgentConfig } from './config';
import { DbExecutor } from './db/executor';
import { Logger } from './logger';
import { POLICY_LABEL, Policy } from './policy';

const T = '__datamcp_selftest';
let q = 0;
const req = (sql: string) => ({ queryId: `st-${++q}`, sql, params: [], timeoutMs: 10_000 });

interface Case { label: string; sql: string; want: 'ok' | 'blocked'; }

function casesFor(policy: Policy): Case[] {
  const common: Case[] = [
    { label: 'SELECT (read)', sql: `SELECT count(*) FROM ${T}`, want: 'ok' },
    { label: 'multi-statement', sql: `SELECT 1; DROP TABLE ${T}`, want: 'blocked' },
    { label: 'writable CTE', sql: `WITH d AS (DELETE FROM ${T} RETURNING *) SELECT count(*) FROM d`, want: 'blocked' },
    { label: 'SELECT INTO', sql: `SELECT * INTO ${T}_copy FROM ${T}`, want: 'blocked' },
    { label: 'quoted dblink', sql: `SELECT "dblink_exec"('','DELETE FROM ${T}')`, want: 'blocked' },
    { label: 'SELECT writer_fn() escalation', sql: `SELECT ${T}_writer()`, want: 'blocked' },
  ];
  if (policy === 'ro') {
    return [...common,
      { label: 'INSERT', sql: `INSERT INTO ${T} VALUES (9,'x')`, want: 'blocked' },
      { label: 'UPDATE', sql: `UPDATE ${T} SET note='x'`, want: 'blocked' },
      { label: 'DELETE', sql: `DELETE FROM ${T}`, want: 'blocked' },
    ];
  }
  if (policy === 'rwd') {
    return [...common,
      { label: 'INSERT', sql: `INSERT INTO ${T} VALUES (9,'x')`, want: 'ok' },
      { label: 'UPDATE', sql: `UPDATE ${T} SET note='y' WHERE id=9`, want: 'ok' },
      { label: 'DELETE', sql: `DELETE FROM ${T} WHERE id=9`, want: 'ok' },
      { label: 'DROP (DDL)', sql: `DROP TABLE ${T}_nope`, want: 'blocked' },
      { label: 'ALTER (DDL)', sql: `ALTER TABLE ${T} ADD COLUMN z int`, want: 'blocked' },
    ];
  }
  // fa
  return [
    { label: 'SELECT', sql: `SELECT count(*) FROM ${T}`, want: 'ok' },
    { label: 'INSERT', sql: `INSERT INTO ${T} VALUES (9,'x')`, want: 'ok' },
    { label: 'DELETE', sql: `DELETE FROM ${T} WHERE id=9`, want: 'ok' },
    { label: 'ALTER (DDL allowed)', sql: `ALTER TABLE ${T} ADD COLUMN z int`, want: 'ok' },
    { label: 'DROP (DDL allowed)', sql: `DROP TABLE IF EXISTS ${T}_x`, want: 'ok' },
  ];
}

export async function runSelftest(config: AgentConfig, logger: Logger): Promise<boolean> {
  const url = new URL(config.databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  const admin = new Client({
    connectionString: config.databaseUrl,
    ssl: sslmode === 'disable' ? undefined : { rejectUnauthorized: false },
  });
  const executor = new DbExecutor(config, new Logger('error'));

  console.log(`\nSelf-test: policy "${config.policy}" (${POLICY_LABEL[config.policy]}) on ${url.host}${url.pathname}\n`);
  let allPass = true;
  try {
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${T}, ${T}_copy CASCADE`);
    await admin.query(`CREATE TABLE ${T} (id int primary key, note text)`);
    await admin.query(`INSERT INTO ${T} VALUES (1,'a'),(2,'b'),(3,'c')`);
    await admin.query(`CREATE OR REPLACE FUNCTION ${T}_writer() RETURNS int LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO ${T} VALUES (99,'pwn'); RETURN 1; END $$`);

    for (const c of casesFor(config.policy)) {
      const before = (await admin.query(`SELECT count(*)::int n FROM ${T}`)).rows[0].n;
      const res = await executor.execute(req(c.sql));
      const after = (await admin.query(`SELECT count(*)::int n FROM ${T}`)).rows[0].n;
      const got: 'ok' | 'blocked' = res.success ? 'ok' : 'blocked';
      // A "blocked" case must also have caused no data change.
      const wroteWhenBlocked = c.want === 'blocked' && after !== before;
      const ok = got === c.want && !wroteWhenBlocked;
      if (!ok) allPass = false;
      const mark = ok ? '✓' : '✗';
      const detail = res.success ? '' : `  (${(res.error || '').split('\n')[0].slice(0, 54)})`;
      console.log(`  ${mark} ${c.label.padEnd(30)} want=${c.want.padEnd(7)} got=${got}${detail}`);
    }
  } catch (e) {
    console.error('  self-test error:', e instanceof Error ? e.message : e);
    allPass = false;
  } finally {
    await admin.query(`DROP TABLE IF EXISTS ${T}, ${T}_copy CASCADE`).catch(() => {});
    await admin.query(`DROP FUNCTION IF EXISTS ${T}_writer()`).catch(() => {});
    await admin.end().catch(() => {});
    await executor.close().catch(() => {});
  }
  console.log(`\n${allPass ? 'PASS — policy ceiling holds on your database.' : 'FAIL — see failures above.'}\n`);
  return allPass;
}
