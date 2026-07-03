/**
 * Assertions for the policy engine — no test framework needed.
 * Run: npm run test:policy
 * Verifies each policy's allow/read-only-transaction decision per statement.
 */
import { decide, parsePolicy, Policy } from './policy';

let failures = 0;
function expect(policy: Policy, sql: string, want: { allow: boolean; ro?: boolean }, label: string): void {
  const d = decide(policy, sql);
  const okAllow = d.allow === want.allow;
  const okRo = want.ro === undefined || d.readOnlyTx === want.ro;
  if (okAllow && okRo) {
    console.log(`  ok  [${policy}] ${label}`);
  } else {
    failures++;
    console.error(`  FAIL [${policy}] ${label}: got allow=${d.allow} ro=${d.readOnlyTx} (${d.reason ?? ''})`);
  }
}

// aliases
console.log(parsePolicy('read-only') === 'ro' && parsePolicy('rwd') === 'rwd' && parsePolicy('full-access') === 'fa'
  ? '  ok  policy aliases' : (failures++, '  FAIL policy aliases'));

// read-only: reads allowed (in RO tx), everything else blocked
expect('ro', 'SELECT * FROM t', { allow: true, ro: true }, 'SELECT');
expect('ro', 'INSERT INTO t VALUES (1)', { allow: false }, 'INSERT blocked');
expect('ro', 'DELETE FROM t', { allow: false }, 'DELETE blocked');
expect('ro', 'WITH d AS (DELETE FROM t RETURNING *) SELECT 1', { allow: false }, 'writable CTE blocked');
expect('ro', 'SELECT * INTO x FROM t', { allow: false }, 'SELECT INTO blocked');
expect('ro', `SELECT "dblink_exec"('','DELETE FROM t')`, { allow: false }, 'quoted dblink blocked');
expect('ro', 'SELECT 1; DELETE FROM t', { allow: false }, 'multi-statement blocked');
expect('ro', 'SELECT writer_fn()', { allow: true, ro: true }, 'function SELECT allowed but read-only (DB blocks its write)');

// read-write-delete: DML allowed (write), reads read-only, DDL blocked
expect('rwd', 'SELECT * FROM t', { allow: true, ro: true }, 'SELECT read-only');
expect('rwd', 'INSERT INTO t VALUES (1)', { allow: true, ro: false }, 'INSERT write');
expect('rwd', 'UPDATE t SET x=1', { allow: true, ro: false }, 'UPDATE write');
expect('rwd', 'DELETE FROM t WHERE id=1', { allow: true, ro: false }, 'DELETE write');
expect('rwd', 'DROP TABLE t', { allow: false }, 'DROP blocked');
expect('rwd', 'ALTER TABLE t ADD COLUMN x int', { allow: false }, 'ALTER blocked');
expect('rwd', 'SELECT 1; DROP TABLE t', { allow: false }, 'multi-statement blocked');
expect('rwd', 'SELECT writer_fn()', { allow: true, ro: true }, 'function SELECT forced read-only (blocks escalation)');
expect('rwd', 'WITH d AS (DELETE FROM t RETURNING *) SELECT 1', { allow: true, ro: true }, 'writable CTE runs read-only (DB blocks its write)');

// full-access: everything, no read-only tx
expect('fa', 'DROP TABLE t', { allow: true, ro: false }, 'DROP allowed');
expect('fa', 'SELECT 1; DROP TABLE t', { allow: true, ro: false }, 'multi-statement allowed');
expect('fa', 'SELECT pg_read_file(\'/etc/passwd\')', { allow: true, ro: false }, 'no function block');

if (failures) { console.error(`\n${failures} policy test(s) FAILED`); process.exit(1); }
console.log('\nAll policy tests passed.');
