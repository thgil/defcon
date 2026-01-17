import { GameConfig, LobbyInfo } from '@defcon/shared';
import { Connection, ConnectionManager } from '../ConnectionManager';

export interface LobbyPlayer {
  id: string;
  connectionId: string;
  name: string;
  ready: boolean;
  territoryId: string | null;
  isHost: boolean;
}

export class Lobby {
  readonly id: string;
  readonly name: string;
  readonly config: GameConfig;
  private players = new Map<string, LobbyPlayer>();
  private availableTerritories: Set<string>;
  private inGame = false;
  private connectionManager: ConnectionManager;

  constructor(
    id: string,
    name: string,
    config: GameConfig,
    territories: string[],
    connectionManager: ConnectionManager
  ) {
    this.id = id;
    this.name = name;
    this.config = config;
    this.availableTerritories = new Set(territories);
    this.connectionManager = connectionManager;
  }

  addPlayer(
    connection: Connection,
    playerId: string,
    name: string,
    isHost: boolean
  ): void {
    this.players.set(playerId, {
      id: playerId,
      connectionId: connection.id,
      name,
      ready: false,
      territoryId: null,
      isHost,
    });
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      // Return territory to available pool
      if (player.territoryId) {
        this.availableTerritories.add(player.territoryId);
      }
      this.players.delete(playerId);

      // If host left, assign new host
      if (player.isHost && this.players.size > 0) {
        const newHost = this.players.values().next().value;
        if (newHost) {
          newHost.isHost = true;
        }
      }
    }
  }

  setPlayerReady(playerId: string, ready: boolean): void {
    const player = this.players.get(playerId);
    if (player) {
      player.ready = ready;
    }
  }

  selectTerritory(playerId: string, territoryId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    // Check if territory is available
    if (!this.availableTerritories.has(territoryId)) {
      // Check if player already has this territory
      if (player.territoryId === territoryId) {
        return true;
      }
      return false;
    }

    // Release old territory
    if (player.territoryId) {
      this.availableTerritories.add(player.territoryId);
    }

    // Claim new territory
    this.availableTerritories.delete(territoryId);
    player.territoryId = territoryId;

    return true;
  }

  isHost(playerId: string): boolean {
    return this.players.get(playerId)?.isHost ?? false;
  }

  isFull(): boolean {
    return this.players.size >= this.config.maxPlayers;
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  isInGame(): boolean {
    return this.inGame;
  }

  setInGame(value: boolean): void {
    this.inGame = value;
  }

  canStart(): boolean {
    // Allow single player for testing
    if (this.players.size < 1) return false;

    for (const player of this.players.values()) {
      if (!player.ready || !player.territoryId) {
        return false;
      }
    }

    return true;
  }

  getPlayers(): LobbyPlayer[] {
    return Array.from(this.players.values());
  }

  getPlayer(playerId: string): LobbyPlayer | undefined {
    return this.players.get(playerId);
  }

  getInfo(): LobbyInfo {
    return {
      id: this.id,
      name: this.name,
      hostName: this.getHostName(),
      playerCount: this.players.size,
      maxPlayers: this.config.maxPlayers,
      config: this.config,
    };
  }

  private getHostName(): string {
    for (const player of this.players.values()) {
      if (player.isHost) {
        return player.name;
      }
    }
    return 'Unknown';
  }

  sendLobbyUpdate(): void {
    const players = this.getPlayers().map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      territoryId: p.territoryId,
    }));

    for (const player of this.players.values()) {
      const connection = this.connectionManager.getConnection(player.connectionId);
      if (connection) {
        this.connectionManager.send(connection, {
          type: 'lobby_update',
          lobby: this.getInfo(),
          playerId: player.id,
          players,
          availableTerritories: Array.from(this.availableTerritories),
          isHost: player.isHost,
        });
      }
    }
  }
}
