/**
 * Standalone assertions for the read-only guard — no test framework needed.
 * Run: npm run test:guard
 * Covers the exact bypasses confirmed against the cloud during red-teaming.
 */
import { checkReadOnly } from './read-only-guard';

let failures = 0;

function expectBlocked(sql: string, label: string): void {
  const r = checkReadOnly(sql);
  if (r.allowed) {
    console.error(`FAIL (should block) [${label}]: ${sql}`);
    failures++;
  } else {
    console.log(`ok  blocked  [${label}] -> ${r.reason}`);
  }
}

function expectAllowed(sql: string, label: string): void {
  const r = checkReadOnly(sql);
  if (!r.allowed) {
    console.error(`FAIL (should allow) [${label}]: ${sql} -> ${r.reason}`);
    failures++;
  } else {
    console.log(`ok  allowed  [${label}]`);
  }
}

// --- must be blocked (the bypasses we found + classic writes) ---
expectBlocked('SELECT * INTO evil FROM users', 'SELECT INTO');
expectBlocked('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d', 'writable CTE');
expectBlocked(`SELECT "dblink_exec"('h','DELETE FROM users')`, 'quoted dblink_exec');
expectBlocked('SELECT "pg_sleep"(10)', 'quoted pg_sleep');
expectBlocked('SELECT pg_read_file(\'/etc/passwd\')', 'pg_read_file');
expectBlocked('SELECT 1; DELETE FROM users', 'multi-statement');
expectBlocked('DELETE FROM users', 'plain DELETE');
expectBlocked('UPDATE users SET x=1', 'plain UPDATE');
expectBlocked('DROP TABLE users', 'DROP');
expectBlocked('MERGE INTO users t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET x=1', 'MERGE');
expectBlocked('/*x*/ SELECT * INTO evil FROM users', 'comment-hidden INTO');

// --- must be allowed (legit reads) ---
expectAllowed('SELECT * FROM users WHERE id = $1', 'parameterized select');
expectAllowed('SELECT current_database(), current_user', 'multi-function select');
expectAllowed('WITH t AS (SELECT 1 AS n) SELECT * FROM t', 'read-only CTE');
expectAllowed('SELECT count(*) FROM orders;', 'trailing semicolon');
expectAllowed('VALUES (1),(2),(3)', 'VALUES');

if (failures > 0) {
  console.error(`\n${failures} guard test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll guard tests passed.');
