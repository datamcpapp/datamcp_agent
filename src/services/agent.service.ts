import { io, Socket } from 'socket.io-client';
import {
  AgentConfig,
  QueryRequest,
  SchemaRequest,
  HealthCheckRequest,
  HeartbeatData,
} from '../types';
import { logger } from '../utils/logger';
import { DatabaseService } from './database.service';
import * as os from 'os';
import { VERSION } from '../version';

/**
 * WebSocket client that connects this agent to api.datamcp.app/agents.
 *
 * Wire protocol (see docs/LOCAL_AGENT_PLAN.md §4):
 *  - path: '/agents'
 *  - handshake auth: { connectionId, apiKey | anonToken, agentVersion, hostname }
 *  - cloud → agent: 'execute_query' / 'extract_schema' / 'health_check'
 *  - agent → cloud: 'query_result' / 'schema_result' / 'health_check_result' / 'heartbeat'
 */
export class AgentService {
  private socket: Socket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelay = 5000;
  private isShuttingDown = false;
  private agentId: string | null = null;

  constructor(
    private config: AgentConfig,
    private databaseService: DatabaseService,
  ) {}

  start(): void {
    if (!this.config.connectionId) {
      throw new Error(
        'connectionId not set — anonymous bootstrap or --connection-id is required before start()',
      );
    }
    logger.info('Starting DataMCP Agent', {
      name: this.config.agentName,
      cloudUrl: this.config.cloudUrl,
      connectionId: this.config.connectionId,
    });
    this.connect();
  }

  private connect(): void {
    if (this.isShuttingDown) return;

    logger.info('Connecting to DataMCP cloud...');
    const auth: Record<string, string> = {
      connectionId: this.config.connectionId!,
      agentVersion: VERSION,
      hostname: os.hostname(),
    };
    // Prefer agentToken (post-claim) > apiKey > anonToken. The server checks
    // them in the same priority order, see agent.gateway.ts handleConnection.
    if (this.config.agentToken) auth.agentToken = this.config.agentToken;
    else if (this.config.apiKey) auth.apiKey = this.config.apiKey;
    else if (this.config.anonToken) auth.anonToken = this.config.anonToken;

    // socket.io: namespace is part of the URL ('/agents'), not the `path` option.
    // `path` is the HTTP endpoint (default '/socket.io') — leaving it default.
    const namespacedUrl = this.config.cloudUrl.replace(/\/+$/, '') + '/agents';
    this.socket = io(namespacedUrl, {
      transports: ['websocket', 'polling'],
      auth,
      reconnection: true,
      reconnectionDelay: this.reconnectDelay,
      reconnectionAttempts: this.maxReconnectAttempts,
      timeout: 10000,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connected', (data: { connectionId?: string; agentId?: string }) => {
      this.agentId = data.agentId ?? null;
      this.reconnectAttempts = 0;
      logger.info('Connected to DataMCP cloud', { agentId: this.agentId });
      this.startHeartbeat();
    });

    this.socket.on('connect_error', (error: Error) => {
      this.reconnectAttempts++;
      logger.error('Connection error', {
        error: error.message,
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
      });
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached. Exiting...');
        void this.stop().then(() => process.exit(1));
      }
    });

    this.socket.on('disconnect', (reason: string) => {
      logger.warn('Disconnected from DataMCP cloud', { reason });
      this.stopHeartbeat();
      if (reason === 'io server disconnect') {
        logger.info('Attempting to reconnect...');
        this.socket?.connect();
      }
    });

    this.socket.on('error', (error: { message: string }) => {
      logger.error('WebSocket error', { error: error.message });
    });

    this.socket.on('execute_query', (request: QueryRequest) => {
      logger.info('Received query execution request', { queryId: request.queryId });
      void (async () => {
        try {
          const result = await this.databaseService.executeQuery(request);
          this.socket?.emit('query_result', result);
        } catch (error) {
          this.socket?.emit('query_result', {
            queryId: request.queryId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: 0,
          });
        }
      })();
    });

    this.socket.on('extract_schema', (request: SchemaRequest) => {
      logger.info('Received schema extraction request', { requestId: request.requestId });
      void (async () => {
        try {
          const result = await this.databaseService.extractSchema(request);
          this.socket?.emit('schema_result', result);
        } catch (error) {
          this.socket?.emit('schema_result', {
            requestId: request.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: 0,
          });
        }
      })();
    });

    this.socket.on('health_check', (request: HealthCheckRequest) => {
      void (async () => {
        try {
          const result = await this.databaseService.checkHealth(request);
          this.socket?.emit('health_check_result', result);
        } catch (error) {
          this.socket?.emit('health_check_result', {
            requestId: request.requestId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      })();
    });

    // Plan §10.6: claim happened — rotate to the long-lived agent token,
    // surface the permanent MCP URL, and reconnect with the new auth.
    this.socket.on(
      'connection:claimed',
      (payload: {
        connectionId?: string;
        newAgentToken?: string;
        permanentMcpUrl?: string;
        graceUntil?: string;
      }) => {
        if (!payload.newAgentToken) {
          logger.warn('connection:claimed missing newAgentToken — ignoring');
          return;
        }
        logger.info('Connection claimed', { graceUntil: payload.graceUntil });

        // Drop the anonymous credential — it's about to be deactivated server-side.
        this.config.anonToken = null;
        this.config.agentToken = payload.newAgentToken;
        if (payload.connectionId) this.config.connectionId = payload.connectionId;

        // Reconnect with the new auth. socket.io picks up the new auth on
        // connect because we re-read this.config inside connect().
        this.socket?.disconnect();
        this.connect();

        console.log('');
        console.log('✅ Connection saved to your account.');
        console.log('📋 New permanent MCP URL:');
        console.log(`   ${payload.permanentMcpUrl ?? '(not provided)'}`);
        if (payload.graceUntil) {
          console.log(`   The old anonymous URL keeps working until ${payload.graceUntil}.`);
        }
        console.log('');
      },
    );

    this.socket.on(
      'force_reconnect_with',
      (payload: { newAgentToken?: string; connectionId?: string }) => {
        if (!payload.newAgentToken) return;
        logger.info('force_reconnect_with received — rotating credentials');
        this.config.anonToken = null;
        this.config.agentToken = payload.newAgentToken;
        if (payload.connectionId) this.config.connectionId = payload.connectionId;
        this.socket?.disconnect();
        this.connect();
      },
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.sendHeartbeat();
    this.heartbeatInterval = setInterval(
      () => this.sendHeartbeat(),
      this.config.heartbeatInterval,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.socket?.connected) return;
    const heartbeat: HeartbeatData = {
      version: VERSION,
      metadata: {
        hostname: os.hostname(),
        platform: os.platform(),
        nodeVersion: process.version,
        uptime: process.uptime(),
      },
    };
    this.socket.emit('heartbeat', heartbeat);
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.info('Stopping DataMCP Agent...');
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    await this.databaseService.closeAll();
    logger.info('Agent stopped');
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getAgentId(): string | null {
    return this.agentId;
  }
}
