import * as os from 'os';
import { logger } from '../utils/logger';
import { VERSION } from '../version';

export interface AnonymousBootstrapResponse {
  connectionId: string;
  anonToken: string;
  claimToken: string;
  mcpUrl: string;
  claimUrl: string;
  expiresAt: string;
  scope: 'read_only';
  limits: {
    maxQueriesPer24h: number;
    maxResponseBytes: number;
  };
}

/**
 * Anonymous bootstrap — calls cloud's POST /api/agents/anonymous to get
 * connectionId + tokens. Plan §10.1.
 *
 * The cloud-side WS URL is wss://api.datamcp.app, but bootstrap is HTTP — so
 * we map ws:// → http:// (and wss:// → https://) before calling.
 */
export async function anonymousBootstrap(
  cloudUrl: string,
): Promise<AnonymousBootstrapResponse> {
  const httpUrl = cloudUrl
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/+$/, '');
  const endpoint = `${httpUrl}/api/agents/anonymous`;

  const body = {
    hostname: os.hostname(),
    agentVersion: VERSION,
    fingerprint: makeFingerprint(),
  };

  logger.debug('Calling anonymous bootstrap', { endpoint });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        `Rate limit reached for this IP (5 anonymous tunnels per hour). ` +
          `Try later or use --api-key for an account-bound tunnel.`,
      );
    }
    throw new Error(`Bootstrap failed: HTTP ${res.status} ${text.substring(0, 200)}`);
  }

  return (await res.json()) as AnonymousBootstrapResponse;
}

/**
 * Coarse host fingerprint — sha256 of (hostname + platform + node version).
 * Enables NAT-fallback rate-limit later (plan §10.8). Best-effort, not
 * security-sensitive.
 */
function makeFingerprint(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto');
  const seed = `${os.hostname()}|${os.platform()}|${process.version}`;
  return crypto.createHash('sha256').update(seed).digest('hex').substring(0, 32);
}

export function printBootstrapResult(result: AnonymousBootstrapResponse): void {
  // Plain console output — this is the user-facing surface, not logger noise.
  console.log('');
  console.log('✅ Connected (read-only, expires in 24h)');
  console.log('');
  console.log('📋 MCP URL (paste into Cursor / Claude):');
  console.log(`   ${result.mcpUrl}`);
  console.log('');
  console.log('💾 Claim this connection (one-time, save now — won\'t show again):');
  console.log(`   ${result.claimUrl}`);
  console.log('   ⚠️  Anyone with this claim URL can take ownership.');
  console.log('');
}
