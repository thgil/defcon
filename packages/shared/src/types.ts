// Vector2 for positions
export interface Vector2 {
  x: number;
  y: number;
}

// DEFCON levels
export type DefconLevel = 5 | 4 | 3 | 2 | 1;

// Game phases
export type GamePhase = 'lobby' | 'placement' | 'active' | 'ended';

// Player colors
export type PlayerColor = 'green' | 'red' | 'blue' | 'yellow' | 'cyan' | 'magenta';

// Building types
export type BuildingType = 'silo' | 'radar' | 'airfield' | 'satellite_launch_facility';

// Silo modes
export type SiloMode = 'air_defense' | 'icbm';

// Missile types
export type MissileType = 'icbm' | 'interceptor';

// Game configuration
export interface GameConfig {
  maxPlayers: number;
  defconTimings: DefconTimings;
  missileSpeed: number;
  radarRange: number;
  siloRange: number;
  startingUnits: {
    silos: number;
    radars: number;
    airfields: number;
    satellite_launch_facilities: number;
  };
}

export interface DefconTimings {
  defcon5Duration: number; // ms
  defcon4Duration: number;
  defcon3Duration: number;
  defcon2Duration: number;
  defcon1Duration: number;
}

// Player state
export interface Player {
  id: string;
  name: string;
  color: PlayerColor;
  connected: boolean;
  ready: boolean;
  territoryId: string | null;
  score: number;
  populationRemaining: number;
  populationLost: number;
  enemyKills: number;
  isAI?: boolean;
}

// Geographic coordinate (imported from geography for convenience)
export interface GeoPosition {
  lat: number;
  lng: number;
}

// Territory
export interface Territory {
  id: string;
  name: string;
  ownerId: string | null;
  boundaries: Vector2[][];
  centroid: Vector2;
  cities: string[];
  buildings: string[];
  // Geographic data (for 3D globe)
  geoCentroid?: GeoPosition;
  geoBounds?: { north: number; south: number; east: number; west: number };
  geoBoundary?: GeoPosition[];
}

// City
export interface City {
  id: string;
  territoryId: string;
  name: string;
  position: Vector2;
  population: number;
  maxPopulation: number;
  destroyed: boolean;
  // Geographic data (for 3D globe)
  geoPosition?: GeoPosition;
}

// Base building
export interface BuildingBase {
  id: string;
  type: BuildingType;
  territoryId: string;
  ownerId: string;
  position: Vector2;
  health: number;
  destroyed: boolean;
  // Geographic data (for 3D globe)
  geoPosition?: GeoPosition;
}

// Silo building
export interface Silo extends BuildingBase {
  type: 'silo';
  mode: SiloMode;
  modeSwitchCooldown: number;
  missileCount: number;
  airDefenseAmmo: number;
  lastFireTime: number;
  fireCooldown: number;
}

// Radar building
export interface Radar extends BuildingBase {
  type: 'radar';
  range: number;
  active: boolean;
}

// Airfield building
export interface Airfield extends BuildingBase {
  type: 'airfield';
  fighterCount: number;
  bomberCount: number;
}

// Satellite Launch Facility building
export interface SatelliteLaunchFacility extends BuildingBase {
  type: 'satellite_launch_facility';
  satellites: number;        // Available satellites to launch
  launchCooldown: number;    // Cooldown duration in ms
  lastLaunchTime: number;    // Timestamp of last launch
}

export type Building = Silo | Radar | Airfield | SatelliteLaunchFacility;

// Satellite entity (orbits the globe)
export interface Satellite {
  id: string;
  ownerId: string;
  launchFacilityId: string;      // Source building
  launchTime: number;            // Timestamp of launch
  orbitalPeriod: number;         // Time for one complete orbit (ms)
  orbitalAltitude: number;       // Altitude above globe (globe units)
  inclination: number;           // Orbital tilt in degrees (0-90)
  startingLongitude: number;     // Longitude at launch
  progress: number;              // 0-1 position along orbit (wraps)
  destroyed: boolean;
  health: number;
  // Cached position (updated each tick)
  geoPosition?: GeoPosition;
}

// Missile flight phases for interceptors (legacy)
export type InterceptorFlightPhase = 'boost' | 'track';

// Physics-based interceptor phases (new system)
export type InterceptorPhase = 'boost' | 'pitch' | 'cruise' | 'terminal' | 'coast';

// Missile in flight (legacy/ICBM system)
export interface Missile {
  id: string;
  type: MissileType;
  ownerId: string;
  sourceId: string;
  launchPosition: Vector2;
  targetPosition: Vector2;
  targetId?: string;
  currentPosition: Vector2;
  launchTime: number;
  flightDuration: number;
  progress: number;
  apexHeight: number;
  intercepted: boolean;
  detonated: boolean;
  // Geographic data (for 3D globe)
  geoLaunchPosition?: GeoPosition;
  geoTargetPosition?: GeoPosition;
  geoCurrentPosition?: GeoPosition;
  // Enhanced interceptor fields
  detectedByRadarId?: string;        // Which radar detected the target
  launchingSiloId?: string;          // Which silo launched this interceptor
  lastKnownTargetPosition?: GeoPosition;  // For when radar loses track
  flightPhase?: InterceptorFlightPhase;   // Current flight phase
  boostEndProgress?: number;         // When boost ends (default 0.25)
  // Missed interceptor fields
  missedTarget?: boolean;            // True if hit check failed (interceptor continues flying)
  maxFlightDuration?: number;        // Extended flight time for missed interceptors
  missDirection?: GeoPosition;       // Direction to continue flying after missing
}

// Physics-based missile (new system for interceptors)
// Uses real physics simulation instead of progress-based curves
export interface PhysicsMissile {
  id: string;
  type: 'interceptor';
  ownerId: string;
  sourceId: string;

  // Physics state (server-authoritative)
  position: { x: number; y: number; z: number };   // Current 3D position
  velocity: { x: number; y: number; z: number };   // Velocity vector (units/sec)
  heading: { x: number; y: number; z: number };    // Direction missile is pointing

  // Engine/fuel
  fuel: number;                // Remaining burn time (seconds)
  maxFuel: number;             // Starting fuel (e.g., 8 seconds)
  thrust: number;              // Current thrust level

  // Guidance
  phase: InterceptorPhase;
  targetId?: string;
  predictedInterceptPoint?: { x: number; y: number; z: number };
  timeToIntercept?: number;

  // Status
  launchTime: number;
  intercepted: boolean;
  detonated: boolean;
  engineFlameout: boolean;
  flameoutTime?: number;  // Timestamp when engine flamed out

  // For rendering compatibility (derived from position)
  geoCurrentPosition?: GeoPosition;

  // Legacy compatibility fields (for gradual migration)
  launchPosition?: Vector2;
  targetPosition?: Vector2;
  currentPosition?: Vector2;
  progress?: number;
  flightDuration?: number;
  geoLaunchPosition?: GeoPosition;
  geoTargetPosition?: GeoPosition;
  apexHeight?: number;

  // Legacy interceptor fields (maintained for compatibility)
  detectedByRadarId?: string;
  launchingSiloId?: string;
  lastKnownTargetPosition?: GeoPosition;
  flightPhase?: InterceptorFlightPhase;
  boostEndProgress?: number;
  missedTarget?: boolean;
  maxFlightDuration?: number;
  missDirection?: GeoPosition;
}

// Type guard to check if a missile is using the new physics system
export function isPhysicsMissile(m: Missile | PhysicsMissile | null | undefined): m is PhysicsMissile {
  if (!m) return false;
  return 'velocity' in m && 'thrust' in m && 'phase' in m && typeof (m as PhysicsMissile).fuel === 'number';
}

// Combined missile type for game state
export type AnyMissile = Missile | PhysicsMissile;

// Full game state
export interface GameState {
  id: string;
  config: GameConfig;
  phase: GamePhase;
  defconLevel: DefconLevel;
  defconTimer: number;
  tick: number;
  timestamp: number;
  players: Record<string, Player>;
  territories: Record<string, Territory>;
  cities: Record<string, City>;
  buildings: Record<string, Building>;
  missiles: Record<string, Missile | PhysicsMissile>;
  satellites: Record<string, Satellite>;
}

// Lobby info (for lobby browser)
export interface LobbyInfo {
  id: string;
  name: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  config: GameConfig;
}

// Game events
export type GameEvent =
  | DefconChangeEvent
  | MissileLaunchEvent
  | MissileImpactEvent
  | InterceptionEvent
  | BuildingDestroyedEvent
  | CityHitEvent
  | BuildingPlacedEvent
  | ModeChangeEvent
  | GameEndEvent
  | SatelliteLaunchEvent
  | SatelliteDestroyedEvent
  | LaunchDetectedEvent;

export interface DefconChangeEvent {
  type: 'defcon_change';
  tick: number;
  newLevel: DefconLevel;
}

export interface MissileLaunchEvent {
  type: 'missile_launch';
  tick: number;
  missileId: string;
  playerId: string;
  sourcePosition: Vector2;
  targetPosition: Vector2;
}

export interface MissileImpactEvent {
  type: 'missile_impact';
  tick: number;
  missileId: string;
  position: Vector2;
  casualties: number;
  targetType: 'city' | 'building' | 'ground';
  targetId?: string;
}

export interface InterceptionEvent {
  type: 'interception';
  tick: number;
  missileId: string;
  interceptorId: string;
  position: Vector2;
}

export interface BuildingDestroyedEvent {
  type: 'building_destroyed';
  tick: number;
  buildingId: string;
  buildingType: BuildingType;
}

export interface CityHitEvent {
  type: 'city_hit';
  tick: number;
  cityId: string;
  casualties: number;
  remainingPopulation: number;
}

export interface BuildingPlacedEvent {
  type: 'building_placed';
  tick: number;
  building: Building;
}

export interface ModeChangeEvent {
  type: 'mode_change';
  tick: number;
  siloId: string;
  newMode: SiloMode;
}

export interface GameEndEvent {
  type: 'game_end';
  tick: number;
  winner: string | null;
  scores: Record<string, number>;
}

export interface SatelliteLaunchEvent {
  type: 'satellite_launch';
  tick: number;
  satelliteId: string;
  playerId: string;
  facilityId: string;
  inclination: number;
}

export interface SatelliteDestroyedEvent {
  type: 'satellite_destroyed';
  tick: number;
  satelliteId: string;
  destroyedBy?: string;  // Interceptor missile ID or undefined if other cause
}

export interface LaunchDetectedEvent {
  type: 'launch_detected';
  tick: number;
  detectedByPlayerId: string;   // Player who detected the launch (has the satellite)
  launchingPlayerId: string;    // Player who launched the missile
  approximatePosition: GeoPosition;  // Approximate launch location
  regionName?: string;          // Name of the region/territory if known
  satelliteId: string;          // Satellite that detected it
}

// Helper types for better Object.values() inference
export type GameStateRecords = {
  players: Player;
  territories: Territory;
  cities: City;
  buildings: Building;
  missiles: Missile | PhysicsMissile;
  satellites: Satellite;
};

// Helper functions to get typed arrays from game state records
export function getPlayers(state: GameState): Player[] {
  return Object.values(state.players);
}

export function getTerritories(state: GameState): Territory[] {
  return Object.values(state.territories);
}

export function getCities(state: GameState): City[] {
  return Object.values(state.cities);
}

export function getBuildings(state: GameState): Building[] {
  return Object.values(state.buildings);
}

export function getMissiles(state: GameState): (Missile | PhysicsMissile)[] {
  return Object.values(state.missiles);
}

export function getSatellites(state: GameState): Satellite[] {
  return Object.values(state.satellites);
}

// Global missile speed multiplier - affects all missiles (ICBMs and interceptors)
// 1.0 = normal speed, 0.5 = half speed, 2.0 = double speed
export const GLOBAL_MISSILE_SPEED_MULTIPLIER = 0.5;

// Default game config
export const DEFAULT_GAME_CONFIG: GameConfig = {
  maxPlayers: 6,
  defconTimings: {
    defcon5Duration: 180000, // 3 minutes
    defcon4Duration: 180000,
    defcon3Duration: 180000,
    defcon2Duration: 180000,
    defcon1Duration: 600000, // 10 minutes
  },
  missileSpeed: 2 * GLOBAL_MISSILE_SPEED_MULTIPLIER, // units per second - adjusted by global multiplier
  radarRange: 300,
  siloRange: 400,
  startingUnits: {
    silos: 6,
    radars: 4,
    airfields: 2,
    satellite_launch_facilities: 1,
  },
};
