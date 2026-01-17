import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  ClientMessage,
  ServerMessage,
  serializeMessage,
  parseMessage,
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
        const message = parseMessage(data.toString()) as ClientMessage;
        this.handleMessage(connection, message);
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
          game?.handleDebugCommand(message.command, message.value);
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
