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
 *  - handshake auth: { connectionId, apiKey | agentToken, agentVersion, hostname }
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
      connectionId: this.config.connectionId,
      agentVersion: VERSION,
      hostname: os.hostname(),
    };
    if (this.config.agentToken) auth.agentToken = this.config.agentToken;
    else if (this.config.apiKey) auth.apiKey = this.config.apiKey;

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
