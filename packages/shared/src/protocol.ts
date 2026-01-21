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
  PhysicsMissile,
  RailInterceptor,
  GuidedInterceptor,
  Satellite,
  AnyMissile,
  Aircraft,
  AircraftType,
  GeoPosition,
  HackType,
  ActiveHack,
  SystemCompromise,
  DetectedBuilding,
  IntrusionAlert,
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
  | LaunchAircraftMessage
  | SetSiloModeMessage
  | PingMessage
  | DebugCommandMessage
  | EnableAIMessage
  | DisableAIMessage
  | RequestInterceptInfoMessage
  | ManualInterceptMessage
  | TerminalEmailMessage
  // Hacking messages
  | HackScanMessage
  | HackStartMessage
  | HackDisconnectMessage
  | HackPurgeMessage
  | HackTraceMessage;

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

export interface LaunchAircraftMessage {
  type: 'launch_aircraft';
  airfieldId: string;
  aircraftType: AircraftType;
  waypoints: GeoPosition[];
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

// Send email to another player via terminal
export interface TerminalEmailMessage {
  type: 'terminal_email';
  toPlayerId: string;
  subject: string;
  body: string;
}

// ============ HACKING CLIENT MESSAGES ============

// Scan for enemy buildings in radar/satellite range
export interface HackScanMessage {
  type: 'hack_scan';
}

// Start hacking a target building
export interface HackStartMessage {
  type: 'hack_start';
  targetId: string;           // Building ID to hack
  hackType: HackType;
  proxyRoute?: string[];      // Building IDs to route through (optional)
}

// Disconnect from an active hack
export interface HackDisconnectMessage {
  type: 'hack_disconnect';
  hackId: string;
}

// Purge detected intrusion from own building
export interface HackPurgeMessage {
  type: 'hack_purge';
  targetId: string;           // Building ID to purge
}

// Request trace status (who is hacking me)
export interface HackTraceMessage {
  type: 'hack_trace';
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
  | InterceptInfoMessage
  | TerminalEmailReceivedMessage
  // Hacking messages
  | HackScanResultMessage
  | HackProgressMessage
  | HackCompleteMessage
  | HackTracedMessage
  | HackDisconnectedMessage
  | SystemCompromisedMessage
  | IntrusionAlertMessage
  | IntrusionStatusMessage;

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
  missileUpdates: AnyMissile[];
  removedMissileIds: string[];
  satelliteUpdates: Satellite[];
  removedSatelliteIds: string[];
  aircraftUpdates?: Aircraft[];
  removedAircraftIds?: string[];
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
  existingInterceptors: Array<{
    interceptorId: string;
    sourceSiloName: string;
    estimatedTimeToIntercept: number; // ms
  }>;
}

// Email received from another player via terminal
export interface TerminalEmailReceivedMessage {
  type: 'terminal_email_received';
  fromPlayerId: string;
  fromPlayerName: string;
  subject: string;
  body: string;
  timestamp: number;
}

// ============ HACKING SERVER MESSAGES ============

// Result of scanning for enemy buildings
export interface HackScanResultMessage {
  type: 'hack_scan_result';
  detectedBuildings: DetectedBuilding[];
}

// Progress update for an active hack
export interface HackProgressMessage {
  type: 'hack_progress';
  hackId: string;
  progress: number;         // 0-100
  traceProgress: number;    // 0-100
  status: 'connecting' | 'active';
}

// Hack completed successfully
export interface HackCompleteMessage {
  type: 'hack_complete';
  hackId: string;
  targetId: string;
  hackType: HackType;
  compromise: SystemCompromise;
}

// Player was traced during hack attempt
export interface HackTracedMessage {
  type: 'hack_traced';
  hackId: string;
  targetId: string;
  revealedToEnemy: boolean;  // True if position revealed to target
}

// Hack was disconnected (by player or interrupted)
export interface HackDisconnectedMessage {
  type: 'hack_disconnected';
  hackId: string;
  reason: 'player' | 'building_destroyed' | 'connection_lost';
}

// A building has been compromised (sent to victim)
export interface SystemCompromisedMessage {
  type: 'system_compromised';
  targetId: string;
  hackType: HackType;
  expiresAt: number;
  attackerRevealed?: string;  // Attacker ID if traced
}

// Alert: someone is hacking your building
export interface IntrusionAlertMessage {
  type: 'intrusion_alert';
  alert: IntrusionAlert;
}

// Response to trace request - current intrusions on your buildings
export interface IntrusionStatusMessage {
  type: 'intrusion_status';
  activeIntrusions: IntrusionAlert[];
  compromisedBuildings: SystemCompromise[];
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
