import type {
  GameState,
  GameConfig,
  GameEvent,
  LobbyInfo,
  BuildingType,
  SiloMode,
  Vector2,
  Building,
  Missile,
  Satellite,
} from './types';

// ============ CLIENT -> SERVER ============

export type ClientMessage =
  | CreateLobbyMessage
  | JoinLobbyMessage
  | LeaveLobbyMessage
  | SetReadyMessage
  | StartGameMessage
  | SelectTerritoryMessage
  | PlaceBuildingMessage
  | LaunchMissileMessage
  | LaunchSatelliteMessage
  | SetSiloModeMessage
  | PingMessage
  | DebugCommandMessage
  | EnableAIMessage
  | DisableAIMessage
  | RequestInterceptInfoMessage
  | ManualInterceptMessage;

export interface CreateLobbyMessage {
  type: 'create_lobby';
  playerName: string;
  lobbyName: string;
  config?: Partial<GameConfig>;
}

export interface JoinLobbyMessage {
  type: 'join_lobby';
  lobbyId: string;
  playerName: string;
}

export interface LeaveLobbyMessage {
  type: 'leave_lobby';
}

export interface SetReadyMessage {
  type: 'set_ready';
  ready: boolean;
}

export interface StartGameMessage {
  type: 'start_game';
}

export interface SelectTerritoryMessage {
  type: 'select_territory';
  territoryId: string;
}

export interface PlaceBuildingMessage {
  type: 'place_building';
  buildingType: BuildingType;
  position: Vector2;
}

export interface LaunchMissileMessage {
  type: 'launch_missile';
  siloId: string;
  targetPosition: Vector2;
  targetId?: string;
}

export interface LaunchSatelliteMessage {
  type: 'launch_satellite';
  facilityId: string;
  inclination: number;  // 0-90 degrees
}

export interface SetSiloModeMessage {
  type: 'set_silo_mode';
  siloId: string;
  mode: SiloMode;
}

export interface PingMessage {
  type: 'ping';
  clientTime: number;
}

export interface DebugCommandMessage {
  type: 'debug';
  command: 'advance_defcon' | 'set_defcon' | 'add_missiles' | 'skip_timer' | 'launch_test_missiles';
  value?: number;
  targetRegion?: string; // For launch_test_missiles: target region ID
}

export interface EnableAIMessage {
  type: 'enable_ai';
  region: string;
}

export interface DisableAIMessage {
  type: 'disable_ai';
}

// Request intercept info for a target missile (manual intercept UI)
export interface RequestInterceptInfoMessage {
  type: 'request_intercept_info';
  targetMissileId: string;
}

// Launch manual intercept from selected silos
export interface ManualInterceptMessage {
  type: 'manual_intercept';
  targetMissileId: string;
  siloIds: string[];
}

// ============ SERVER -> CLIENT ============

export type ServerMessage =
  | LobbyListMessage
  | LobbyUpdateMessage
  | LobbyErrorMessage
  | GameStartMessage
  | GameStateMessage
  | GameDeltaMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | GameEndMessage
  | ErrorMessage
  | PongMessage
  | InterceptInfoMessage;

export interface LobbyListMessage {
  type: 'lobby_list';
  lobbies: LobbyInfo[];
}

export interface LobbyUpdateMessage {
  type: 'lobby_update';
  lobby: LobbyInfo;
  playerId: string;
  players: Array<{
    id: string;
    name: string;
    ready: boolean;
    territoryId: string | null;
  }>;
  availableTerritories: string[];
  isHost: boolean;
}

export interface LobbyErrorMessage {
  type: 'lobby_error';
  message: string;
}

export interface GameStartMessage {
  type: 'game_start';
  gameId: string;
  playerId: string;
  initialState: GameState;
}

export interface GameStateMessage {
  type: 'game_state';
  tick: number;
  timestamp: number;
  state: GameState;
}

export interface GameDeltaMessage {
  type: 'game_delta';
  tick: number;
  timestamp: number;
  events: GameEvent[];
  buildingUpdates: Building[];
  missileUpdates: Missile[];
  removedMissileIds: string[];
  satelliteUpdates: Satellite[];
  removedSatelliteIds: string[];
}

export interface PlayerJoinedMessage {
  type: 'player_joined';
  playerId: string;
  playerName: string;
}

export interface PlayerLeftMessage {
  type: 'player_left';
  playerId: string;
}

export interface GameEndMessage {
  type: 'game_end';
  winner: string | null;
  scores: Record<string, number>;
  stats: Record<string, PlayerStats>;
}

export interface PlayerStats {
  populationLost: number;
  enemyKills: number;
  missilesLaunched: number;
  missilesIntercepted: number;
  buildingsDestroyed: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
  clientTime: number;
  serverTime: number;
}

// Response to RequestInterceptInfoMessage - available silos for manual intercept
export interface InterceptInfoMessage {
  type: 'intercept_info';
  targetMissileId: string;
  availableSilos: Array<{
    siloId: string;
    siloName: string;
    hitProbability: number;
    estimatedInterceptProgress: number;  // 0-1, where on the missile's path the intercept would occur
    ammoRemaining: number;
  }>;
}

// Helper to serialize messages
export function serializeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

// Helper to parse messages
export function parseMessage(data: string): ClientMessage | ServerMessage | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
