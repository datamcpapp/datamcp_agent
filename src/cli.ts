import { CliConfig } from './config';
import { parsePolicy, POLICY_LABEL } from './policy';

export interface ParsedCli {
  command: 'run' | 'help' | 'version';
  selftest: boolean;
  cli: CliConfig;
  error?: string;
}

const VERSION = '0.1.0';

export const HELP = `datamcp: self-hosted agent for safe database access via DataMCP

USAGE
  datamcp <policy> <database-url> [options]

POLICY  (the agent's local enforcement ceiling)
  ro | read-only          reads only; every statement in a READ ONLY transaction
  rwd | read-write-delete  reads + INSERT/UPDATE/DELETE; DDL & multi-statement blocked
  fa | full-access         unrestricted; the database role is the only limit

EXAMPLES
  npx @datamcp/agent ro postgres://user:pass@localhost:5432/app
  npx @datamcp/agent ro postgres://user:pass@localhost:5432/app --stage qa
  npx @datamcp/agent rwd localhost:5432/app --name analytics
  npx @datamcp/agent ro postgres://…/app --selftest  # prove the ceiling on your DB
  DATAMCP_STAGE=qa npx @datamcp/agent ro postgres://…/app

OPTIONS
  --name <n>              friendly agent name
  --stage <s>             production | qa | staging | development
  --connection-id <id>    DataMCP connection this agent serves
  --api-key <key>         registered-flow API key
  --anon-token <tok>      anonymous-bootstrap token (claim later in the dashboard)
  --agent-token <tok>     claimed-agent token
  --cloud-url <url>       override the cloud websocket URL
  --statement-timeout <ms>  per-query timeout (default 30000)
  --selftest              connect to the DB, verify the policy holds, and exit
  --help, --version

The agent runs inside your network, keeps DB credentials local, and connects
outbound to the cloud. If no connection id is provided, the agent creates an
anonymous tunnel and prints a claim token for the dashboard. Your database is
never exposed to the internet.`;

const VALUE_FLAGS: Record<string, keyof CliConfig> = {
  '--name': 'name',
  '--stage': 'stage',
  '--connection-id': 'connectionId',
  '--api-key': 'apiKey',
  '--anon-token': 'anonToken',
  '--agent-token': 'agentToken',
  '--cloud-url': 'cloudUrl',
  '--statement-timeout': 'statementTimeoutMs',
};

export function parseArgs(argv: string[]): ParsedCli {
  const out: ParsedCli = { command: 'run', selftest: false, cli: {} };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...out, command: 'help' };
    if (arg === '--version' || arg === '-v') return { ...out, command: 'version' };
    if (arg === '--selftest') { out.selftest = true; continue; }
    if (arg in VALUE_FLAGS) {
      const val = argv[++i];
      if (val === undefined) return { ...out, error: `Missing value for ${arg}` };
      const key = VALUE_FLAGS[arg];
      out.cli[key] = (key === 'statementTimeoutMs' ? Number(val) : val) as never;
      continue;
    }
    if (arg.startsWith('-')) return { ...out, error: `Unknown option: ${arg}` };
    positional.push(arg);
  }

  if (positional.length === 0) return { ...out, command: 'help' };

  const policy = parsePolicy(positional[0]);
  if (!policy) return { ...out, error: `Unknown policy "${positional[0]}". Use: ro | rwd | fa` };
  out.cli.policy = policy;

  if (!positional[1]) return { ...out, error: 'Missing <database-url>' };
  out.cli.databaseUrl = positional[1];

  return out;
}

export function versionString(): string {
  return `datamcp ${VERSION}`;
}

export function policyLabel(p: ReturnType<typeof parsePolicy>): string {
  return p ? POLICY_LABEL[p] : 'unknown';
}
