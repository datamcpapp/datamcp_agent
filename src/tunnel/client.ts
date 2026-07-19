import * as os from 'os';
import { io, Socket } from 'socket.io-client';

import { AgentConfig } from '../config';
import { DbExecutor } from '../db/executor';
import { Logger } from '../logger';
import {
  AgentExecuteQueryRequest,
  AgentExtractSchemaRequest,
  AgentHeartbeat,
  AgentHealthCheckRequest,
  ConnectedEvent,
} from './protocol';

const AGENT_VERSION = '0.1.0';

interface BootstrapResponse {
  success: boolean;
  data?: {
    connectionId: string;
    anonToken: string;
    claimToken: string;
    expiresAt: string;
  };
  error?: { message?: string } | string;
}

/**
 * Maintains the outbound websocket to the DataMCP cloud (`/agents` namespace),
 * authenticates on the handshake, sends heartbeats, and services `execute_query`
 * requests by running them through the read-only executor.
 */
export class TunnelClient {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private activeQueries = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly executor: DbExecutor,
    private readonly logger: Logger,
  ) {}

  start(): void {
    void this.bootstrapAndConnect();
  }

  private async bootstrapAndConnect(): Promise<void> {
    if (!this.config.connectionId) {
      await this.bootstrapAnonymousConnection();
    }

    if (
      !this.config.connectionId ||
      !(this.config.apiKey || this.config.anonToken || this.config.agentToken)
    ) {
      this.logger.error(
        'Missing cloud credentials. Provide --connection-id plus --api-key, --anon-token, or --agent-token.',
      );
      return;
    }

    const url = `${this.config.cloudUrl}/agents`;
    this.logger.info(
      `Connecting to ${url} (stage=${this.config.stage}, connection=${this.config.connectionId})`,
    );

    // Auth matches the gateway handshake: apiKey OR anonToken, plus connectionId.
    const auth: Record<string, string> = {
      connectionId: this.config.connectionId ?? '',
      agentVersion: AGENT_VERSION,
      hostname: os.hostname(),
    };
    if (this.config.apiKey) auth.apiKey = this.config.apiKey;
    if (this.config.anonToken) auth.anonToken = this.config.anonToken;
    if (this.config.agentToken) auth.agentToken = this.config.agentToken;

    this.socket = io(url, {
      auth,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
    });

    this.registerHandlers(this.socket);
  }

  private async bootstrapAnonymousConnection(): Promise<void> {
    const endpoint = `${this.httpBaseUrl()}/api/agents/bootstrap`;
    this.logger.info(`No connection id provided, bootstrapping at ${endpoint}`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.config.agentName }),
    });
    if (!response.ok) {
      throw new Error(`Bootstrap failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as BootstrapResponse;
    if (!payload.success || !payload.data) {
      const message =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message || 'Bootstrap failed';
      throw new Error(message);
    }

    this.config.connectionId = payload.data.connectionId;
    this.config.anonToken = payload.data.anonToken;

    this.logger.info(`Anonymous tunnel created: ${payload.data.connectionId}`);
    console.log('\nDataMCP claim token');
    console.log(payload.data.claimToken);
    console.log(
      `Paste this token in the Local Agent claim flow before ${payload.data.expiresAt}.\n`,
    );
  }

  private httpBaseUrl(): string {
    if (this.config.cloudUrl.startsWith('wss://')) {
      return `https://${this.config.cloudUrl.slice('wss://'.length)}`;
    }
    if (this.config.cloudUrl.startsWith('ws://')) {
      return `http://${this.config.cloudUrl.slice('ws://'.length)}`;
    }
    return this.config.cloudUrl.replace(/\/$/, '');
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

    socket.on('extract_schema', (req: AgentExtractSchemaRequest) => {
      void this.handleSchema(socket, req);
    });

    socket.on('health_check', (req: AgentHealthCheckRequest) => {
      void this.handleHealth(socket, req);
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
    if (this.activeQueries >= this.config.maxConcurrentQueries) {
      socket.emit('query_result', {
        queryId: req.queryId,
        success: false,
        error: `Agent concurrency limit reached (${this.config.maxConcurrentQueries})`,
        duration: 0,
      });
      return;
    }

    this.activeQueries += 1;
    this.logger.debug(`execute_query ${req.queryId}: ${req.sql.slice(0, 120)}`);
    try {
      const result = await this.executor.execute(req);
      socket.emit('query_result', result);
    } finally {
      this.activeQueries -= 1;
    }
  }

  private async handleSchema(
    socket: Socket,
    req: AgentExtractSchemaRequest,
  ): Promise<void> {
    const started = Date.now();
    try {
      const schema = await this.executor.extractSchema();
      socket.emit('schema_result', {
        requestId: req.requestId,
        success: true,
        schema,
        duration: Date.now() - started,
      });
    } catch (err) {
      socket.emit('schema_result', {
        requestId: req.requestId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        duration: Date.now() - started,
      });
    }
  }

  private async handleHealth(
    socket: Socket,
    req: AgentHealthCheckRequest,
  ): Promise<void> {
    const started = Date.now();
    try {
      await this.executor.verifyConnectivity();
      socket.emit('health_check_result', {
        requestId: req.requestId,
        success: true,
        duration: Date.now() - started,
      });
    } catch (err) {
      socket.emit('health_check_result', {
        requestId: req.requestId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        duration: Date.now() - started,
      });
    }
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
