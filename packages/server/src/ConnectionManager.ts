import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  ClientMessage,
  ServerMessage,
  serializeMessage,
  parseMessage,
  HackType,
} from '@defcon/shared';
import { LobbyManager } from './lobby/LobbyManager';

export interface Connection {
  id: string;
  ws: WebSocket;
  playerId: string | null;
  playerName: string | null;
  lobbyId: string | null;
  gameId: string | null;
}

export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private lobbyManager: LobbyManager;

  constructor(lobbyManager: LobbyManager) {
    this.lobbyManager = lobbyManager;
    this.lobbyManager.setConnectionManager(this);
  }

  handleConnection(ws: WebSocket): void {
    const connectionId = uuidv4();
    const connection: Connection = {
      id: connectionId,
      ws,
      playerId: null,
      playerName: null,
      lobbyId: null,
      gameId: null,
    };

    this.connections.set(connectionId, connection);
    console.log(`Client connected: ${connectionId}`);

    // Send lobby list on connect
    this.send(connection, {
      type: 'lobby_list',
      lobbies: this.lobbyManager.getLobbies(),
    });

    ws.on('message', (data) => {
      try {
        const message = parseMessage(data.toString());
        if (!message) {
          this.send(connection, {
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Failed to parse message: invalid JSON',
          });
          return;
        }
        // Validate that this is a client message (has a type property)
        if (!('type' in message) || typeof message.type !== 'string') {
          this.send(connection, {
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Invalid message format',
          });
          return;
        }
        this.handleMessage(connection, message as ClientMessage);
      } catch (error) {
        console.error('Failed to parse message:', error);
        this.send(connection, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Failed to parse message',
        });
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(connection);
    });

    ws.on('error', (error) => {
      console.error(`Connection ${connectionId} error:`, error);
    });
  }

  private handleMessage(connection: Connection, message: ClientMessage): void {
    switch (message.type) {
      case 'create_lobby':
        this.lobbyManager.createLobby(
          connection,
          message.playerName,
          message.lobbyName,
          message.config
        );
        break;

      case 'join_lobby':
        this.lobbyManager.joinLobby(
          connection,
          message.lobbyId,
          message.playerName
        );
        break;

      case 'leave_lobby':
        this.lobbyManager.leaveLobby(connection);
        break;

      case 'set_ready':
        this.lobbyManager.setReady(connection, message.ready);
        break;

      case 'select_territory':
        this.lobbyManager.selectTerritory(connection, message.territoryId);
        break;

      case 'start_game':
        this.lobbyManager.startGame(connection);
        break;

      case 'place_building':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handlePlaceBuilding(
            connection.playerId!,
            message.buildingType,
            message.position
          );
        }
        break;

      case 'launch_missile':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleLaunchMissile(
            connection.playerId!,
            message.siloId,
            message.targetPosition,
            message.targetId
          );
        }
        break;

      case 'set_silo_mode':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleSetSiloMode(
            connection.playerId!,
            message.siloId,
            message.mode
          );
        }
        break;

      case 'set_game_speed':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleSetGameSpeed(message.speed);
        }
        break;

      case 'launch_satellite':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleLaunchSatellite(
            connection.playerId!,
            message.facilityId,
            message.inclination
          );
        }
        break;

      case 'launch_aircraft':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleLaunchAircraft(
            connection.playerId!,
            message.airfieldId,
            message.aircraftType,
            message.waypoints
          );
        }
        break;

      case 'ping':
        this.send(connection, {
          type: 'pong',
          clientTime: message.clientTime,
          serverTime: Date.now(),
        });
        break;

      case 'debug':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleDebugCommand(message.command, message.value, message.targetRegion);
        }
        break;

      case 'enable_ai':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleEnableAI(message.region);
        }
        break;

      case 'disable_ai':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleDisableAI();
        }
        break;

      case 'request_intercept_info':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleRequestInterceptInfo(
            connection,
            connection.playerId!,
            message.targetMissileId
          );
        }
        break;

      case 'manual_intercept':
        if (connection.gameId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleManualIntercept(
            connection.playerId!,
            message.targetMissileId,
            message.siloIds
          );
        }
        break;

      case 'terminal_email':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleTerminalEmail(
            connection.playerId,
            message.toPlayerId,
            message.subject,
            message.body
          );
        }
        break;

      // Hacking messages
      case 'hack_scan':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleHackScan(connection.playerId);
        }
        break;

      case 'hack_start':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleHackStart(
            connection.playerId,
            message.targetId,
            message.hackType,
            message.proxyRoute
          );
        }
        break;

      case 'hack_disconnect':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleHackDisconnect(connection.playerId, message.hackId);
        }
        break;

      case 'hack_purge':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleHackPurge(connection.playerId, message.targetId);
        }
        break;

      case 'hack_trace':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleHackTrace(connection.playerId);
        }
        break;

      // Network warfare messages
      case 'launch_decoy':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleLaunchDecoy(
            connection.playerId,
            message.siloId,
            message.targetPosition,
            message.count
          );
        }
        break;

      case 'set_silo_target':
        if (connection.gameId && connection.playerId) {
          const game = this.lobbyManager.getGame(connection.gameId);
          game?.handleSetSiloTarget(
            connection.playerId,
            message.siloId,
            message.targetPosition
          );
        }
        break;
    }
  }

  private handleDisconnect(connection: Connection): void {
    console.log(`Client disconnected: ${connection.id}`);

    if (connection.lobbyId) {
      this.lobbyManager.leaveLobby(connection);
    }

    this.connections.delete(connection.id);
  }

  send(connection: Connection, message: ServerMessage): void {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(serializeMessage(message));
    }
  }

  broadcast(message: ServerMessage, connectionIds?: string[]): void {
    const serialized = serializeMessage(message);
    const targets = connectionIds
      ? connectionIds.map((id) => this.connections.get(id)).filter(Boolean)
      : Array.from(this.connections.values());

    for (const connection of targets) {
      if (connection && connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(serialized);
      }
    }
  }

  getConnection(id: string): Connection | undefined {
    return this.connections.get(id);
  }
}
