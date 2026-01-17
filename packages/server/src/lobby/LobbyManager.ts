import { v4 as uuidv4 } from 'uuid';
import {
  GameConfig,
  LobbyInfo,
  DEFAULT_GAME_CONFIG,
} from '@defcon/shared';
import { Connection, ConnectionManager } from '../ConnectionManager';
import { Lobby } from './Lobby';
import { GameRoom } from '../game/GameRoom';

// Default territories
const DEFAULT_TERRITORIES = [
  'north_america',
  'south_america',
  'europe',
  'russia',
  'africa',
  'asia',
];

export class LobbyManager {
  private lobbies = new Map<string, Lobby>();
  private games = new Map<string, GameRoom>();
  private connectionManager!: ConnectionManager;

  setConnectionManager(cm: ConnectionManager): void {
    this.connectionManager = cm;
  }

  getLobbies(): LobbyInfo[] {
    return Array.from(this.lobbies.values()).map((lobby) => lobby.getInfo());
  }

  createLobby(
    connection: Connection,
    playerName: string,
    lobbyName: string,
    configOverrides?: Partial<GameConfig>
  ): void {
    // Leave current lobby if in one
    if (connection.lobbyId) {
      this.leaveLobby(connection);
    }

    const lobbyId = uuidv4();
    const playerId = uuidv4();
    const config = { ...DEFAULT_GAME_CONFIG, ...configOverrides };

    const lobby = new Lobby(
      lobbyId,
      lobbyName,
      config,
      DEFAULT_TERRITORIES,
      this.connectionManager
    );

    lobby.addPlayer(connection, playerId, playerName, true);
    this.lobbies.set(lobbyId, lobby);

    connection.lobbyId = lobbyId;
    connection.playerId = playerId;
    connection.playerName = playerName;

    // Notify the player
    lobby.sendLobbyUpdate();

    // Broadcast updated lobby list to all connected clients
    this.broadcastLobbyList();

    console.log(`Lobby created: ${lobbyName} (${lobbyId}) by ${playerName}`);
  }

  joinLobby(
    connection: Connection,
    lobbyId: string,
    playerName: string
  ): void {
    const lobby = this.lobbies.get(lobbyId);

    if (!lobby) {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Lobby not found',
      });
      return;
    }

    if (lobby.isFull()) {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Lobby is full',
      });
      return;
    }

    if (lobby.isInGame()) {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Game already in progress',
      });
      return;
    }

    // Leave current lobby if in one
    if (connection.lobbyId) {
      this.leaveLobby(connection);
    }

    const playerId = uuidv4();
    lobby.addPlayer(connection, playerId, playerName, false);

    connection.lobbyId = lobbyId;
    connection.playerId = playerId;
    connection.playerName = playerName;

    lobby.sendLobbyUpdate();
    this.broadcastLobbyList();

    console.log(`${playerName} joined lobby ${lobbyId}`);
  }

  leaveLobby(connection: Connection): void {
    if (!connection.lobbyId) return;

    const lobby = this.lobbies.get(connection.lobbyId);
    if (!lobby) return;

    lobby.removePlayer(connection.playerId!);

    const wasInGame = connection.gameId;
    connection.lobbyId = null;
    connection.playerId = null;
    connection.gameId = null;

    // If lobby is empty, delete it
    if (lobby.isEmpty()) {
      this.lobbies.delete(lobby.id);
      console.log(`Lobby ${lobby.id} deleted (empty)`);
    } else {
      lobby.sendLobbyUpdate();
    }

    this.broadcastLobbyList();
  }

  setReady(connection: Connection, ready: boolean): void {
    if (!connection.lobbyId) return;

    const lobby = this.lobbies.get(connection.lobbyId);
    if (!lobby) return;

    lobby.setPlayerReady(connection.playerId!, ready);
    lobby.sendLobbyUpdate();
  }

  selectTerritory(connection: Connection, territoryId: string): void {
    if (!connection.lobbyId) return;

    const lobby = this.lobbies.get(connection.lobbyId);
    if (!lobby) return;

    const success = lobby.selectTerritory(connection.playerId!, territoryId);
    if (success) {
      lobby.sendLobbyUpdate();
    } else {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Territory not available',
      });
    }
  }

  startGame(connection: Connection): void {
    if (!connection.lobbyId) return;

    const lobby = this.lobbies.get(connection.lobbyId);
    if (!lobby) return;

    if (!lobby.isHost(connection.playerId!)) {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Only the host can start the game',
      });
      return;
    }

    if (!lobby.canStart()) {
      this.connectionManager.send(connection, {
        type: 'lobby_error',
        message: 'Not all players are ready or have selected territories',
      });
      return;
    }

    // Create game room
    const game = new GameRoom(lobby, this.connectionManager);
    this.games.set(game.id, game);

    // Update connections with game ID
    for (const player of lobby.getPlayers()) {
      const conn = this.connectionManager.getConnection(player.connectionId);
      if (conn) {
        conn.gameId = game.id;
      }
    }

    lobby.setInGame(true);
    game.start();

    this.broadcastLobbyList();

    console.log(`Game started for lobby ${lobby.id}`);
  }

  getGame(gameId: string): GameRoom | undefined {
    return this.games.get(gameId);
  }

  private broadcastLobbyList(): void {
    const lobbies = this.getLobbies();
    this.connectionManager.broadcast({
      type: 'lobby_list',
      lobbies,
    });
  }
}
