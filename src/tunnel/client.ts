import * as os from 'os';
import { io, Socket } from 'socket.io-client';

import { AgentConfig } from '../config';
import { DbExecutor } from '../db/executor';
import { Logger } from '../logger';
import {
  AgentExecuteQueryRequest,
  AgentHeartbeat,
  ConnectedEvent,
} from './protocol';

const AGENT_VERSION = '0.1.0';

/**
 * Maintains the outbound websocket to the DataMCP cloud (`/agents` namespace),
 * authenticates on the handshake, sends heartbeats, and services `execute_query`
 * requests by running them through the read-only executor.
 */
export class TunnelClient {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly executor: DbExecutor,
    private readonly logger: Logger,
  ) {}

  start(): void {
    const url = `${this.config.cloudUrl}/agents`;
    this.logger.info(
      `Connecting to ${url} (stage=${this.config.stage}, connection=${this.config.connectionId})`,
    );

    // Auth matches the gateway handshake: apiKey OR anonToken, plus connectionId.
    const auth: Record<string, string> = {
      connectionId: this.config.connectionId,
      agentVersion: AGENT_VERSION,
      hostname: os.hostname(),
    };
    if (this.config.apiKey) auth.apiKey = this.config.apiKey;
    if (this.config.anonToken) auth.anonToken = this.config.anonToken;

    this.socket = io(url, {
      auth,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
    });

    this.registerHandlers(this.socket);
  }

  private registerHandlers(socket: Socket): void {
    socket.on('connect', () => {
      this.logger.info(`Socket connected (id=${socket.id})`);
      this.startHeartbeat(socket);
    });

    socket.on('connected', (evt: ConnectedEvent) => {
      this.logger.info(`Registered with cloud (agentId=${evt.agentId})`);
    });

    socket.on('execute_query', (req: AgentExecuteQueryRequest) => {
      void this.handleQuery(socket, req);
    });

    socket.on('error', (payload: { message?: string }) => {
      this.logger.error(`Cloud error: ${payload?.message ?? 'unknown'}`);
    });

    socket.on('disconnect', (reason: string) => {
      this.logger.warn(`Disconnected: ${reason} (will auto-reconnect)`);
      this.stopHeartbeat();
    });

    socket.on('connect_error', (err: Error) => {
      this.logger.warn(`Connect error: ${err.message}`);
    });
  }

  private async handleQuery(
    socket: Socket,
    req: AgentExecuteQueryRequest,
  ): Promise<void> {
    this.logger.debug(`execute_query ${req.queryId}: ${req.sql.slice(0, 120)}`);
    const result = await this.executor.execute(req);
    socket.emit('query_result', result);
  }

  private startHeartbeat(socket: Socket): void {
    this.stopHeartbeat();
    const beat = () => {
      const payload: AgentHeartbeat = {
        version: AGENT_VERSION,
        metadata: {
          hostname: os.hostname(),
          platform: process.platform,
          nodeVersion: process.version,
          uptime: Math.floor(process.uptime()),
        },
      };
      socket.emit('heartbeat', payload);
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  stop(): void {
    this.stopHeartbeat();
    this.socket?.disconnect();
    this.socket = null;
  }
}
