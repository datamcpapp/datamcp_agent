import { parseArgs } from './cli';
import { redactSensitive } from './logger';

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

const parsed = parseArgs([
  'ro',
  'postgres://user:pass@localhost:5432/app',
  '--max-result-rows',
  '25',
  '--max-result-bytes',
  '2048',
  '--max-concurrent-queries',
  '2',
]);

assert(parsed.cli.maxResultRows === 25, 'parses max-result-rows');
assert(parsed.cli.maxResultBytes === 2048, 'parses max-result-bytes');
assert(parsed.cli.maxConcurrentQueries === 2, 'parses max-concurrent-queries');

const redacted = redactSensitive(
  'postgres://user:secret@host/db sk_live_abc agent_secret anon_secret claim_secret key=abc password=secret apiKey=secret agentToken=secret anonToken=secret',
);

assert(!redacted.includes('secret'), 'redacts secret literals');
assert(!redacted.includes('sk_live_abc'), 'redacts API keys');
assert(!redacted.includes('agent_secret'), 'redacts agent tokens');
assert(!redacted.includes('anon_secret'), 'redacts anonymous tokens');
assert(!redacted.includes('claim_secret'), 'redacts claim tokens');
assert(!redacted.includes('key=abc'), 'redacts MCP link keys');
assert(!redacted.includes('postgres://user:'), 'redacts database URLs');

if (failures) {
  console.error(`\n${failures} security test(s) FAILED`);
  process.exit(1);
}

console.log('\nAll security tests passed.');
