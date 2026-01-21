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

// Aircraft types
export type AircraftType = 'fighter' | 'bomber' | 'radar';

// Aircraft entity
export interface Aircraft {
  id: string;
  type: AircraftType;
  ownerId: string;
  airfieldId: string;
  geoPosition: GeoPosition;
  altitude: number;       // Globe units above surface
  heading: number;        // Degrees, 0 = north, 90 = east
  speed: number;          // Degrees per second (angular velocity)
  waypoints: GeoPosition[];
  currentWaypointIndex: number;
  returning: boolean;     // True when heading back to base
  status: 'grounded' | 'flying' | 'destroyed';
  launchTime: number;
  splineProgress?: number;      // 0-1 progress along the spline path
  totalPathLength?: number;     // Total path length in degrees
}

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
  radarCount: number;
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

// Physics-based missile (legacy - being replaced by RailInterceptor)
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
  flameoutPosition?: { x: number; y: number; z: number };  // Position when engine flamed out

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

// ICBM flight phase for hit probability calculation
export type IcbmPhase = 'boost' | 'midcourse' | 'reentry';

// Guided interceptor (proportional navigation system)
// Continuously adjusts course toward predicted intercept point
export interface GuidedInterceptor {
  id: string;
  type: 'guided_interceptor';
  ownerId: string;
  sourceId: string;  // Launching silo

  // Position state (updated each tick)
  geoPosition: GeoPosition;
  altitude: number;  // Globe units above surface

  // Movement state
  heading: number;      // Degrees, 0 = north, 90 = east
  climbAngle: number;   // Degrees, positive = ascending, negative = descending
  speed: number;        // Degrees per second (angular velocity on globe surface)

  // Target information
  targetId: string;            // ICBM being intercepted
  hasGuidance: boolean;        // False = ballistic (lost radar lock)
  trackingRadarIds: string[];  // Radars currently providing guidance

  // Fuel/timing
  launchTime: number;
  fuel: number;           // Remaining fuel in seconds
  maxFuel: number;        // Max fuel capacity (seconds)
  maxFlightTime: number;  // Maximum flight duration before expiration (seconds)

  // Status
  status: 'active' | 'hit' | 'missed' | 'expired' | 'crashed';

  // Compatibility flags for rendering
  intercepted: boolean;   // Always false for interceptors
  detonated: boolean;     // True when status is terminal

  // Cached 3D position (for rendering)
  geoCurrentPosition?: GeoPosition;
  currentAltitude?: number;

  // Legacy compatibility fields
  launchPosition?: Vector2;
  targetPosition?: Vector2;
  currentPosition?: Vector2;
  geoLaunchPosition?: GeoPosition;
  geoTargetPosition?: GeoPosition;
  flightDuration?: number;
  apexHeight?: number;
  progress?: number;  // Estimated progress for UI (0-1)
}

// Type guard for guided interceptors
export function isGuidedInterceptor(m: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor | null | undefined): m is GuidedInterceptor {
  if (!m) return false;
  return m.type === 'guided_interceptor' && 'heading' in m && 'climbAngle' in m;
}

// Rail-based interceptor (new deterministic system)
// Pre-calculates a ballistic arc at launch, flies along it like an ICBM
export interface RailInterceptor {
  id: string;
  type: 'rail_interceptor';
  ownerId: string;
  sourceId: string;  // Launching silo

  // Pre-calculated rail (set at launch, doesn't change)
  rail: {
    startGeo: GeoPosition;       // Launch position
    endGeo: GeoPosition;         // Interception point
    endAltitude: number;         // Altitude at intercept (matches ICBM altitude there)
    apexHeight: number;          // Peak altitude of ballistic arc
    flightDuration: number;      // Total flight time in ms
  };

  // Target information
  targetId: string;                    // ICBM being intercepted
  targetProgressAtIntercept: number;   // Expected ICBM progress when we intercept

  // Radar tracking
  tracking: {
    radarIds: string[];           // Radars currently tracking the ICBM
    hasGuidance: boolean;         // True if at least one radar can see target
    lostGuidanceTime?: number;    // Timestamp when guidance was lost (2s grace period)
  };

  // State
  fuel: number;           // Remaining fuel (seconds), used for hit probability penalty
  maxFuel: number;        // Max fuel capacity (e.g., 10 seconds)
  launchTime: number;     // When launched
  progress: number;       // 0-1 along rail
  status: 'active' | 'missed' | 'hit' | 'crashed';

  // Compatibility flags for rendering (derived from status)
  intercepted: boolean;   // Always false for interceptors (they intercept, not get intercepted)
  detonated: boolean;     // True when status is 'hit' or 'crashed'

  // Current position (derived from progress along rail)
  geoCurrentPosition?: GeoPosition;
  currentAltitude?: number;

  // Miss trajectory (when status = 'missed')
  missBehavior?: {
    missStartTime: number;   // When the miss was determined
    missStartProgress: number; // Progress along rail when miss occurred
    endGeo: GeoPosition;     // Where the missile will crash
    duration: number;        // How long until crash (ms)
  };

  // Legacy compatibility fields for rendering
  launchPosition?: Vector2;
  targetPosition?: Vector2;
  currentPosition?: Vector2;
  geoLaunchPosition?: GeoPosition;
  geoTargetPosition?: GeoPosition;

  // Compatibility fields (mirrors rail data for easier access)
  flightDuration?: number;  // Same as rail.flightDuration
  apexHeight?: number;      // Same as rail.apexHeight
}

// Type guard to check if a missile is using the old physics system
export function isPhysicsMissile(m: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor | null | undefined): m is PhysicsMissile {
  if (!m) return false;
  return 'velocity' in m && 'thrust' in m && 'phase' in m && typeof (m as PhysicsMissile).fuel === 'number';
}

// Type guard to check if a missile is a rail-based interceptor
export function isRailInterceptor(m: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor | null | undefined): m is RailInterceptor {
  if (!m) return false;
  return m.type === 'rail_interceptor' && 'rail' in m && 'tracking' in m;
}

// Type guard to check if a missile is any kind of interceptor
export function isInterceptor(m: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor | null | undefined): boolean {
  if (!m) return false;
  return m.type === 'interceptor' || m.type === 'rail_interceptor' || m.type === 'guided_interceptor';
}

// Combined missile type for game state
export type AnyMissile = Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor;

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
  missiles: Record<string, Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor>;
  satellites: Record<string, Satellite>;
  aircraft: Record<string, Aircraft>;
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
  missiles: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor;
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

export function getMissiles(state: GameState): (Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor)[] {
  return Object.values(state.missiles);
}

export function getSatellites(state: GameState): Satellite[] {
  return Object.values(state.satellites);
}

export function getAircraft(state: GameState): Aircraft[] {
  return state.aircraft ? Object.values(state.aircraft) : [];
}

// Global missile speed multiplier - affects all missiles (ICBMs and interceptors)
// 1.0 = normal speed, 0.5 = half speed, 2.0 = double speed
export const GLOBAL_MISSILE_SPEED_MULTIPLIER = 0.5;

// ============ HACKING SYSTEM TYPES ============

// Types of hacks that can be performed
export type HackType =
  | 'blind_radar'      // Radar shows nothing for duration
  | 'spoof_radar'      // Radar shows false contacts
  | 'lock_silo'        // Silo cannot change modes
  | 'delay_silo'       // Silo fire cooldown increased
  | 'disable_satellite' // Satellite stops detecting launches
  | 'intercept_comms'  // Intercepted emails visible to attacker
  | 'forge_alert';     // Send fake system alert to target

// Status of an active hack attempt
export type HackStatus = 'connecting' | 'active' | 'completed' | 'traced' | 'disconnected';

// An active hack in progress
export interface ActiveHack {
  id: string;
  attackerId: string;
  targetId: string;           // Building ID being hacked
  targetOwnerId: string;      // Player who owns the target
  hackType: HackType;
  progress: number;           // 0-100, hack completion
  traceProgress: number;      // 0-100, if reaches 100 = caught
  startTime: number;
  status: HackStatus;
  proxyRoute?: string[];      // Building IDs used as proxies
}

// A successful hack effect applied to a building
export interface SystemCompromise {
  id: string;
  targetId: string;           // Building ID that is compromised
  targetOwnerId: string;      // Player who owns the compromised building
  attackerId: string;         // Player who performed the hack
  hackType: HackType;
  appliedAt: number;          // Timestamp when effect started
  expiresAt: number;          // Timestamp when effect ends (0 = permanent)
  hasBackdoor?: boolean;      // If true, attacker has persistent access
}

// Detected enemy building (from radar/satellite intel)
export interface DetectedBuilding {
  id: string;
  ownerId: string;
  type: BuildingType;
  geoPosition?: GeoPosition;
  detectedAt: number;
  lastSeenAt: number;
  vulnerabilities?: HackType[]; // Known exploits for this building
}

// Intrusion alert when being hacked
export interface IntrusionAlert {
  id: string;
  targetId: string;           // Building being targeted
  detectedAt: number;
  traceProgress: number;      // How close to tracing the attacker
  attackerRevealed?: string;  // Attacker player ID if traced
}

// Hacking configuration per DEFCON level
export interface HackingConfig {
  scanEnabled: boolean;       // Can scan for enemy buildings
  hackingEnabled: boolean;    // Can initiate hacks
  allowedTargets: BuildingType[]; // What can be hacked at this level
  traceSpeed: number;         // Multiplier for trace speed (higher = faster trace)
  hackSpeed: number;          // Multiplier for hack speed
}

// Default hacking configs per DEFCON level
export const DEFCON_HACKING_CONFIG: Record<DefconLevel, HackingConfig> = {
  5: { scanEnabled: false, hackingEnabled: false, allowedTargets: [], traceSpeed: 0, hackSpeed: 0 },
  4: { scanEnabled: true, hackingEnabled: false, allowedTargets: [], traceSpeed: 0, hackSpeed: 0 },
  3: { scanEnabled: true, hackingEnabled: true, allowedTargets: ['radar'], traceSpeed: 1, hackSpeed: 1 },
  2: { scanEnabled: true, hackingEnabled: true, allowedTargets: ['radar', 'silo', 'satellite_launch_facility'], traceSpeed: 1.2, hackSpeed: 1.1 },
  1: { scanEnabled: true, hackingEnabled: true, allowedTargets: ['radar', 'silo', 'satellite_launch_facility', 'airfield'], traceSpeed: 1.5, hackSpeed: 1.2 },
};

// Hack effect durations in milliseconds
export const HACK_DURATIONS: Record<HackType, number> = {
  blind_radar: 60000,      // 60 seconds
  spoof_radar: 45000,      // 45 seconds
  lock_silo: 90000,        // 90 seconds
  delay_silo: 30000,       // 30 seconds
  disable_satellite: 120000, // 120 seconds
  intercept_comms: 0,      // Permanent until discovered
  forge_alert: 0,          // One-time effect
};

// Detection risk levels (affects trace speed)
export const HACK_RISK_LEVELS: Record<HackType, number> = {
  blind_radar: 1.0,        // Medium
  spoof_radar: 1.5,        // High
  lock_silo: 1.0,          // Medium
  delay_silo: 0.7,         // Low
  disable_satellite: 1.5,  // High
  intercept_comms: 0.5,    // Low
  forge_alert: 2.0,        // Very High
};

// Time to complete each hack type (ms at base speed)
export const HACK_COMPLETION_TIME: Record<HackType, number> = {
  blind_radar: 8000,
  spoof_radar: 12000,
  lock_silo: 10000,
  delay_silo: 6000,
  disable_satellite: 15000,
  intercept_comms: 5000,
  forge_alert: 20000,
};

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
  radarRange: 300,  // ~33 degrees coverage
  siloRange: 400,
  startingUnits: {
    silos: 6,
    radars: 4,
    airfields: 2,
    satellite_launch_facilities: 1,
  },
};
