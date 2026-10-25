import { io, Socket } from 'socket.io-client';
import {
  AgentConfig,
  QueryRequest,
  QueryResult,
  SchemaRequest,
  HealthCheckRequest,
  HeartbeatData,
} from '../types';
import { logger } from '../utils/logger';
import { DatabaseService } from './database.service';
import * as os from 'os';
import { VERSION } from '../version';

const QUERY_HISTORY_TTL_MS = 11 * 60_000;

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
  private readonly reconnectDelay = 5000;
  private readonly pendingQueryResults = new Map<
    string,
    { result: QueryResult; createdAt: number }
  >();
  private readonly inFlightQueries = new Set<string>();
  private readonly completedQueryIds = new Map<string, number>();
  private isShuttingDown = false;
  private isAuthenticated = false;
  private authenticationRejected = false;
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
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connected', (data: { connectionId?: string; agentId?: string }) => {
      this.agentId = data.agentId ?? null;
      this.reconnectAttempts = 0;
      this.isAuthenticated = true;
      this.authenticationRejected = false;
      logger.info('Connected to DataMCP cloud', { agentId: this.agentId });
      this.startHeartbeat();
      for (const { result } of this.pendingQueryResults.values()) {
        this.socket?.emit('query_result', result);
      }
    });

    this.socket.on('connect_error', (error: Error) => {
      this.reconnectAttempts++;
      logger.error('Connection error', {
        error: error.message,
        attempt: this.reconnectAttempts,
      });
    });

    this.socket.on('disconnect', (reason: string) => {
      logger.warn('Disconnected from DataMCP cloud', { reason });
      this.isAuthenticated = false;
      this.stopHeartbeat();
      if (reason === 'io server disconnect' && !this.authenticationRejected) {
        logger.info('Attempting to reconnect...');
        this.socket?.connect();
      }
    });

    this.socket.on('error', (error: { message: string }) => {
      logger.error('WebSocket error', { error: error.message });
      if (error.message === 'invalid agent token') {
        this.authenticationRejected = true;
        logger.error('Agent token rejected. Update the tunnel credentials and restart the agent.');
        this.socket?.disconnect();
      }
    });

    this.socket.on('execute_query', (request: QueryRequest) => {
      logger.info('Received query execution request', { queryId: request.queryId });
      this.pruneQueryHistory();
      const cached = this.pendingQueryResults.get(request.queryId);
      if (cached) {
        this.sendQueryResult(cached.result);
        return;
      }
      if (this.inFlightQueries.has(request.queryId)) return;
      if (this.completedQueryIds.has(request.queryId)) {
        this.sendQueryResult({
          queryId: request.queryId,
          success: false,
          error: 'Query was already executed; result is no longer available',
          duration: 0,
        });
        return;
      }
      this.inFlightQueries.add(request.queryId);
      void (async () => {
        let result: QueryResult;
        try {
          result = await this.databaseService.executeQuery(request);
        } catch (error) {
          result = {
            queryId: request.queryId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: 0,
          };
        }
        this.inFlightQueries.delete(request.queryId);
        this.completedQueryIds.set(request.queryId, Date.now());
        this.pendingQueryResults.set(request.queryId, {
          result,
          createdAt: Date.now(),
        });
        this.pruneQueryHistory();
        this.sendQueryResult(result);
      })();
    });

    this.socket.on('query_ack', (message: { queryId?: string }) => {
      if (message?.queryId) this.pendingQueryResults.delete(message.queryId);
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

  private sendQueryResult(result: QueryResult): void {
    if (this.isAuthenticated && this.socket?.connected) {
      this.socket.emit('query_result', result);
    }
  }

  private pruneQueryHistory(): void {
    const cutoff = Date.now() - QUERY_HISTORY_TTL_MS;
    for (const [queryId, entry] of this.pendingQueryResults) {
      if (entry.createdAt < cutoff) this.pendingQueryResults.delete(queryId);
    }
    while (this.pendingQueryResults.size > 32) {
      const oldest = this.pendingQueryResults.keys().next().value;
      if (!oldest) break;
      this.pendingQueryResults.delete(oldest);
      logger.warn('Unacknowledged query result evicted', { queryId: oldest });
    }
    for (const [queryId, createdAt] of this.completedQueryIds) {
      if (createdAt < cutoff) this.completedQueryIds.delete(queryId);
    }
    while (this.completedQueryIds.size > 1024) {
      const oldest = this.completedQueryIds.keys().next().value;
      if (!oldest) break;
      this.completedQueryIds.delete(oldest);
    }
  }

  async stop(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isAuthenticated = false;
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
