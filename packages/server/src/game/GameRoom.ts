import { v4 as uuidv4 } from 'uuid';
import { isPointOnLand } from './landDetection';
import {
  GameState,
  GameConfig,
  Player,
  Territory,
  City,
  Building,
  Silo,
  Radar,
  Airfield,
  SatelliteLaunchFacility,
  Satellite,
  Missile,
  GuidedInterceptor,
  Aircraft,
  AircraftType,
  DefconLevel,
  BuildingType,
  SiloMode,
  Vector2,
  GameEvent,
  PlayerColor,
  GeoPosition,
  HackType,
  getBuildings,
  getTerritories,
  getMissiles,
  getSatellites,
  getAircraft,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  geoToPixel,
  pixelToGeo,
  greatCircleDistance,
  geoInterpolate,
  pointInPolygon,
  isGuidedInterceptor,
  isInterceptor,
} from '@defcon/shared';
import { Lobby, LobbyPlayer } from '../lobby/Lobby';
import { ConnectionManager, Connection } from '../ConnectionManager';
import { MissileSimulator } from '../simulation/MissileSimulator';
import { SatelliteSimulator, SATELLITE_CONFIG } from '../simulation/SatelliteSimulator';
import { GuidedInterceptorSimulator } from '../simulation/GuidedInterceptorSimulator';
import { AircraftSimulator } from '../simulation/AircraftSimulator';
import { AIPlayer, AIAction } from './AIPlayer';
import { HackingSystem } from './HackingSystem';

const TICK_RATE = 20; // 20 Hz
const TICK_INTERVAL = 1000 / TICK_RATE;
const FULL_SYNC_INTERVAL = 5000; // Full state sync every 5 seconds

// Globe radius for satellite calculations (matches client)
const SPHERE_RADIUS = 100;

const PLAYER_COLORS: PlayerColor[] = ['green', 'red', 'blue', 'yellow', 'cyan', 'magenta'];

// Map dimensions for converting geo to pixel coordinates
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Convert geo coordinate to pixel position
function geoToPixelLocal(geo: GeoPosition): Vector2 {
  return geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT);
}

// Convert pixel position to geo coordinate
function pixelToGeoLocal(pixel: Vector2): GeoPosition {
  return pixelToGeo(pixel, MAP_WIDTH, MAP_HEIGHT);
}

// Territory data with both pixel and geo coordinates
interface TerritoryData {
  name: string;
  centroid: Vector2;
  boundaries: Vector2[][];
  geoCentroid: GeoPosition;
  geoBounds: { north: number; south: number; east: number; west: number };
  geoBoundary: GeoPosition[];
}

// Build territory data from geo data
function buildTerritoryData(): Record<string, TerritoryData> {
  const result: Record<string, TerritoryData> = {};

  for (const [id, geoData] of Object.entries(TERRITORY_GEO_DATA)) {
    const pixelCentroid = geoToPixelLocal(geoData.centroid);
    const pixelBoundary = geoData.boundaryCoords.map(geoToPixelLocal);

    result[id] = {
      name: geoData.name,
      centroid: pixelCentroid,
      boundaries: [pixelBoundary],
      geoCentroid: geoData.centroid,
      geoBounds: geoData.bounds,
      geoBoundary: geoData.boundaryCoords,
    };
  }

  return result;
}

// City data with both pixel and geo coordinates
interface CityData {
  name: string;
  position: Vector2;
  population: number;
  geoPosition: GeoPosition;
}

// Build city data from geo data
function buildCityData(): Record<string, CityData[]> {
  const result: Record<string, CityData[]> = {};

  for (const [territoryId, cities] of Object.entries(CITY_GEO_DATA)) {
    result[territoryId] = cities.map((city) => ({
      name: city.name,
      position: geoToPixelLocal(city.position),
      population: city.population,
      geoPosition: city.position,
    }));
  }

  return result;
}

const TERRITORY_DATA = buildTerritoryData();
const CITY_DATA = buildCityData();

export class GameRoom {
  readonly id: string;
  private state: GameState;
  private config: GameConfig;
  private lobby: Lobby;
  private connectionManager: ConnectionManager;
  private missileSimulator: MissileSimulator;
  private satelliteSimulator: SatelliteSimulator;
  private guidedInterceptorSimulator: GuidedInterceptorSimulator;
  private aircraftSimulator: AircraftSimulator;
  private hackingSystem: HackingSystem;
  private aiPlayer: AIPlayer | null = null;

  private tickInterval: NodeJS.Timeout | null = null;
  private lastFullSync = 0;
  private pendingEvents: GameEvent[] = [];
  private previouslyDetonated: Set<string> = new Set();

  constructor(lobby: Lobby, connectionManager: ConnectionManager) {
    this.id = uuidv4();
    this.lobby = lobby;
    this.config = lobby.config;
    this.connectionManager = connectionManager;
    this.missileSimulator = new MissileSimulator(this.config.missileSpeed);
    this.satelliteSimulator = new SatelliteSimulator();
    this.guidedInterceptorSimulator = new GuidedInterceptorSimulator();
    this.aircraftSimulator = new AircraftSimulator();
    this.hackingSystem = new HackingSystem();

    this.state = this.initializeGameState(lobby.getPlayers());
  }

  private initializeGameState(lobbyPlayers: LobbyPlayer[]): GameState {
    const players: Record<string, Player> = {};
    const territories: Record<string, Territory> = {};
    const cities: Record<string, City> = {};
    const buildings: Record<string, Building> = {};

    // Initialize territories
    for (const [id, data] of Object.entries(TERRITORY_DATA)) {
      territories[id] = {
        id,
        name: data.name,
        ownerId: null,
        boundaries: data.boundaries,
        centroid: data.centroid,
        cities: [],
        buildings: [],
        // Geographic data for 3D globe
        geoCentroid: data.geoCentroid,
        geoBounds: data.geoBounds,
        geoBoundary: data.geoBoundary,
      };
    }

    // Initialize players and assign territories
    lobbyPlayers.forEach((lp, index) => {
      const player: Player = {
        id: lp.id,
        name: lp.name,
        color: PLAYER_COLORS[index % PLAYER_COLORS.length],
        connected: true,
        ready: true,
        territoryId: lp.territoryId,
        score: 0,
        populationRemaining: 0,
        populationLost: 0,
        enemyKills: 0,
      };
      players[lp.id] = player;

      // Assign territory to player
      if (lp.territoryId && territories[lp.territoryId]) {
        territories[lp.territoryId].ownerId = lp.id;
      }
    });

    // Initialize cities for owned territories
    for (const territory of Object.values(territories)) {
      if (territory.ownerId && CITY_DATA[territory.id]) {
        for (const cityData of CITY_DATA[territory.id]) {
          const cityId = uuidv4();
          cities[cityId] = {
            id: cityId,
            territoryId: territory.id,
            name: cityData.name,
            position: cityData.position,
            population: cityData.population,
            maxPopulation: cityData.population,
            destroyed: false,
            // Geographic data for 3D globe
            geoPosition: cityData.geoPosition,
          };
          territory.cities.push(cityId);

          // Add to player's population
          players[territory.ownerId].populationRemaining += cityData.population;
        }
      }
    }

    return {
      id: this.id,
      config: this.config,
      phase: 'placement',
      defconLevel: 5,
      defconTimer: this.config.defconTimings.defcon5Duration,
      tick: 0,
      timestamp: Date.now(),
      gameSpeed: 1,
      players,
      territories,
      cities,
      buildings,
      missiles: {},
      satellites: {},
      aircraft: {},
    };
  }

  start(): void {
    // Send initial state to all players
    for (const player of this.lobby.getPlayers()) {
      const connection = this.connectionManager.getConnection(player.connectionId);
      if (connection) {
        this.connectionManager.send(connection, {
          type: 'game_start',
          gameId: this.id,
          playerId: player.id,
          initialState: this.state,
        });
      }
    }

    // Start game loop
    this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    this.state.tick++;
    this.state.timestamp = now;

    // Apply game speed multiplier to delta time
    const gameSpeed = this.state.gameSpeed || 1;
    const scaledTickInterval = TICK_INTERVAL * gameSpeed;
    const deltaSeconds = scaledTickInterval / 1000;

    // Update DEFCON timer
    this.updateDefconTimer(scaledTickInterval);

    // Update ICBMs (legacy missiles)
    const missileEvents = this.missileSimulator.update(
      this.state,
      deltaSeconds
    );
    this.pendingEvents.push(...missileEvents);

    // Update guided interceptors (proportional navigation with radar-improved prediction)
    const guidedInterceptorEvents = this.guidedInterceptorSimulator.update(
      this.state,
      deltaSeconds
    );
    this.pendingEvents.push(...guidedInterceptorEvents);

    // Update satellites
    const satelliteEvents = this.satelliteSimulator.update(
      this.state,
      deltaSeconds,
      SPHERE_RADIUS
    );
    this.pendingEvents.push(...satelliteEvents);

    // Update aircraft
    const aircraftEvents = this.aircraftSimulator.update(
      this.state,
      deltaSeconds
    );
    this.pendingEvents.push(...aircraftEvents);

    // Update AI player
    if (this.aiPlayer) {
      const aiActions = this.aiPlayer.update(this.state, now);
      this.executeAIActions(aiActions);
    }

    // Update hacking system
    const hackingResult = this.hackingSystem.update(this.state, deltaSeconds);
    this.processHackingResults(hackingResult);

    // Check for interceptions
    const interceptionEvents = this.checkInterceptions();
    this.pendingEvents.push(...interceptionEvents);

    // Check for satellite destruction by interceptors
    const satelliteDestructionEvents = this.checkSatelliteInterceptions();
    this.pendingEvents.push(...satelliteDestructionEvents);

    // Check game end conditions
    this.checkGameEnd();

    // Send delta update
    this.sendDeltaUpdate();

    // Periodic full sync
    if (now - this.lastFullSync > FULL_SYNC_INTERVAL) {
      this.sendFullSync();
      this.lastFullSync = now;
    }
  }

  private updateDefconTimer(deltaMs: number): void {
    this.state.defconTimer -= deltaMs;

    if (this.state.defconTimer <= 0) {
      if (this.state.defconLevel > 1) {
        this.state.defconLevel = (this.state.defconLevel - 1) as DefconLevel;

        // Set next timer
        const timings = this.config.defconTimings;
        switch (this.state.defconLevel) {
          case 4:
            this.state.defconTimer = timings.defcon4Duration;
            break;
          case 3:
            this.state.defconTimer = timings.defcon3Duration;
            break;
          case 2:
            this.state.defconTimer = timings.defcon2Duration;
            break;
          case 1:
            this.state.defconTimer = timings.defcon1Duration;
            this.state.phase = 'active';
            break;
        }

        this.pendingEvents.push({
          type: 'defcon_change',
          tick: this.state.tick,
          newLevel: this.state.defconLevel,
        });

        console.log(`DEFCON ${this.state.defconLevel}`);
      }
    }
  }

  private checkInterceptions(): GameEvent[] {
    const events: GameEvent[] = [];

    // Get all silos in air defense mode
    const airDefenseSilos = getBuildings(this.state).filter(
      (b): b is Silo =>
        b.type === 'silo' &&
        !b.destroyed &&
        (b as Silo).mode === 'air_defense' &&
        (b as Silo).airDefenseAmmo > 0
    );

    // Track which missiles already have interceptors targeting them
    const missilesBeingTargeted = new Set<string>();
    for (const missile of getMissiles(this.state)) {
      if (isInterceptor(missile) && (missile as any).targetId) {
        missilesBeingTargeted.add((missile as any).targetId);
      }
    }

    const now = Date.now();

    // Check each incoming missile
    for (const missile of getMissiles(this.state)) {
      if (missile.detonated || missile.intercepted) continue;
      if (isInterceptor(missile)) continue;

      // Don't launch multiple interceptors at the same missile (auto-fire)
      if (missilesBeingTargeted.has(missile.id)) continue;

      // Don't launch if missile is too close (won't have time to intercept)
      const icbmMissile = missile as Missile;
      if (icbmMissile.progress > 0.75) continue;

      // Collect all valid silos that can engage this missile, with their scores
      const candidateSilos: Array<{ silo: Silo; score: number; radarIds: string[] }> = [];

      for (const silo of airDefenseSilos) {
        // Only intercept missiles heading toward this player's territory
        const targetTerritory = this.getTerritoryAt(icbmMissile.targetPosition);
        if (!targetTerritory || targetTerritory.ownerId !== silo.ownerId) continue;

        // RADAR REQUIREMENT: Find all radars that can see the missile
        const trackingRadarIds = this.findAllTrackingRadars(icbmMissile, silo.ownerId);
        if (trackingRadarIds.length === 0) continue;


        // Check cooldown (scaled by game speed)
        const effectiveCooldown = silo.fireCooldown / (this.state.gameSpeed || 1);
        if (now - silo.lastFireTime < effectiveCooldown) continue;

        // Score this silo based on geometry
        const score = this.scoreSiloForIntercept(silo, icbmMissile);
        candidateSilos.push({ silo, score, radarIds: trackingRadarIds });
      }

      // No valid silos for this missile
      if (candidateSilos.length === 0) continue;

      // Sort by score (higher is better) and select the best
      candidateSilos.sort((a, b) => b.score - a.score);
      const best = candidateSilos[0];
      const silo = best.silo;

      // Launch guided interceptor
      const interceptor = this.guidedInterceptorSimulator.launchInterceptor(
        silo,
        icbmMissile,
        silo.ownerId,
        best.radarIds
      );

      if (!interceptor) {
        // Could not calculate valid intercept - skip this missile
        continue;
      }

      this.state.missiles[interceptor.id] = interceptor;
      silo.airDefenseAmmo--;
      silo.lastFireTime = now;

      // Track that this missile is now being targeted
      missilesBeingTargeted.add(icbmMissile.id);

      events.push({
        type: 'missile_launch',
        tick: this.state.tick,
        missileId: interceptor.id,
        playerId: silo.ownerId,
        sourcePosition: silo.position,
        targetPosition: interceptor.geoTargetPosition
          ? geoToPixel(interceptor.geoTargetPosition, MAP_WIDTH, MAP_HEIGHT)
          : silo.position,
      });
    }

    return events;
  }

  /**
   * Score a silo for intercepting a missile.
   * Higher score = better choice for interception.
   */
  private scoreSiloForIntercept(silo: Silo, missile: Missile): number {
    const siloGeo = silo.geoPosition || pixelToGeoLocal(silo.position);
    const missileGeo = missile.geoCurrentPosition || pixelToGeoLocal(missile.currentPosition);

    // Calculate distance from silo to missile's current position (in radians)
    const distanceToMissile = greatCircleDistance(siloGeo, missileGeo);

    // Also consider distance to missile's target (closer silos have better geometry)
    const targetGeo = missile.geoTargetPosition || pixelToGeoLocal(missile.targetPosition);
    const distanceToTarget = greatCircleDistance(siloGeo, targetGeo);

    // Closer silos score higher (invert distance)
    // Use weighted combination: prioritize distance to current missile position
    const distanceScore = 1 / (1 + distanceToMissile * 10 + distanceToTarget * 5);

    // More ammo = slightly better (preserve silos with low ammo for later)
    const ammoScore = silo.airDefenseAmmo / 20;

    return distanceScore * 0.8 + ammoScore * 0.2;
  }

  private checkSatelliteInterceptions(): GameEvent[] {
    const events: GameEvent[] = [];

    // Get all silos in air defense mode that can target satellites
    const airDefenseSilos = getBuildings(this.state).filter(
      (b): b is Silo =>
        b.type === 'silo' &&
        !b.destroyed &&
        (b as Silo).mode === 'air_defense' &&
        (b as Silo).airDefenseAmmo > 0
    );

    // Satellites orbit at high altitude (120 units) - well above interceptor missile range (~50 units)
    // They cannot be shot down by ground-based air defense silos
    // This section is disabled - satellites are immune to interception

    return events;
  }

  private getTerritoryAt(position: Vector2): Territory | null {
    for (const territory of getTerritories(this.state)) {
      if (this.isPointInTerritory(position, territory)) {
        return territory;
      }
    }
    return null;
  }

  private isPointInTerritory(point: Vector2, territory: Territory): boolean {
    const geo = pixelToGeoLocal(point);

    // Use polygon containment if boundary exists
    if (territory.geoBoundary && territory.geoBoundary.length >= 3) {
      return pointInPolygon(geo, territory.geoBoundary);
    }

    // Fallback to bounds check (shouldn't happen with proper data)
    if (territory.geoBounds) {
      const bounds = territory.geoBounds;
      return (
        geo.lat >= bounds.south &&
        geo.lat <= bounds.north &&
        geo.lng >= bounds.west &&
        geo.lng <= bounds.east
      );
    }

    return false;
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /**
   * Find a radar that can detect the given missile.
   * Uses the radar's range property and great-circle distance.
   * Returns the radar that can see the missile, or null if none can.
   */
  private findDetectingRadar(missile: Missile, ownerId: string): Radar | null {
    const radars = getBuildings(this.state).filter(
      (b): b is Radar =>
        b.type === 'radar' &&
        !b.destroyed &&
        b.active &&
        b.ownerId === ownerId
    );

    if (radars.length === 0) return null;

    const missileGeo = missile.geoCurrentPosition || pixelToGeoLocal(missile.currentPosition);

    for (const radar of radars) {
      const radarGeo = radar.geoPosition || pixelToGeoLocal(radar.position);

      // Calculate angular distance in degrees
      const angularDistanceRadians = greatCircleDistance(radarGeo, missileGeo);
      const angularDistanceDegrees = angularDistanceRadians * (180 / Math.PI);

      // Radar range is configured in game config (default ~300 units which is ~27 degrees)
      // Convert radar range to degrees (9 degrees per 100 units - slightly smaller than fog of war visual)
      const radarRangeDegrees = (radar.range / 100) * 9;

      if (angularDistanceDegrees <= radarRangeDegrees) {
        return radar;
      }
    }

    return null;
  }

  /**
   * Find all radars that can track the given missile.
   * Used for multi-radar bonus calculation in interceptors.
   * Returns array of radar IDs that can see the missile.
   *
   * IMPORTANT: Requires actual radar contact with the missile's CURRENT position
   * before allowing interceptor launch. This ensures realistic gameplay where
   * missiles must be detected before they can be engaged.
   */
  private findAllTrackingRadars(missile: Missile, ownerId: string): string[] {
    const radars = getBuildings(this.state).filter(
      (b): b is Radar =>
        b.type === 'radar' &&
        !b.destroyed &&
        b.active &&
        b.ownerId === ownerId
    );

    if (radars.length === 0) return [];

    // Use the missile's CURRENT position - must have actual radar contact
    const currentGeo = missile.geoCurrentPosition || pixelToGeoLocal(missile.currentPosition);

    const trackingRadarIds: string[] = [];

    for (const radar of radars) {
      const radarGeo = radar.geoPosition || pixelToGeoLocal(radar.position);

      const angularDistanceRadians = greatCircleDistance(radarGeo, currentGeo);
      const angularDistanceDegrees = angularDistanceRadians * (180 / Math.PI);
      const radarRangeDegrees = (radar.range / 100) * 9;

      if (angularDistanceDegrees <= radarRangeDegrees) {
        trackingRadarIds.push(radar.id);
      }
    }

    return trackingRadarIds;
  }

  /**
   * Check if any enemy satellites can see a launch at the given position.
   * Returns LaunchDetectedEvent for each player who detects the launch.
   */
  private checkSatelliteLaunchDetection(
    launchPosition: GeoPosition,
    launchingPlayerId: string
  ): GameEvent[] {
    const events: GameEvent[] = [];
    const satellites = getSatellites(this.state);

    // Satellite vision range in degrees
    const visionRangeDegrees = SATELLITE_CONFIG.VISION_RANGE_DEGREES;

    // Track which players have already detected (only one alert per player)
    const detectingPlayers = new Set<string>();

    for (const satellite of satellites) {
      if (satellite.destroyed) continue;
      // Only enemy satellites detect launches
      if (satellite.ownerId === launchingPlayerId) continue;
      // Don't alert the same player twice
      if (detectingPlayers.has(satellite.ownerId)) continue;

      const satPos = satellite.geoPosition;
      if (!satPos) continue;

      // Calculate angular distance between satellite and launch position
      const angularDistanceRadians = greatCircleDistance(satPos, launchPosition);
      const angularDistanceDegrees = angularDistanceRadians * (180 / Math.PI);

      if (angularDistanceDegrees <= visionRangeDegrees) {
        detectingPlayers.add(satellite.ownerId);

        // Add some randomness to the position (approximate detection)
        const jitterDegrees = 2; // +/- 2 degrees of uncertainty
        const approximatePosition: GeoPosition = {
          lat: launchPosition.lat + (Math.random() - 0.5) * jitterDegrees * 2,
          lng: launchPosition.lng + (Math.random() - 0.5) * jitterDegrees * 2,
        };

        // Find the territory name if possible
        let regionName: string | undefined;
        for (const territory of getTerritories(this.state)) {
          if (territory.ownerId === launchingPlayerId) {
            regionName = territory.name;
            break;
          }
        }

        events.push({
          type: 'launch_detected',
          tick: this.state.tick,
          detectedByPlayerId: satellite.ownerId,
          launchingPlayerId,
          approximatePosition,
          regionName,
          satelliteId: satellite.id,
        });

        console.log(`[SATELLITE] Launch detected by ${satellite.ownerId}'s satellite over ${regionName || 'unknown region'}`);
      }
    }

    return events;
  }

  private checkGameEnd(): void {
    if (this.state.phase === 'ended') return;

    const allPlayers = Object.values(this.state.players);

    // Single player mode - don't end game based on player count
    if (allPlayers.length === 1) {
      // Only end if the single player has no population
      if (allPlayers[0].populationRemaining <= 0) {
        this.state.phase = 'ended';
        this.pendingEvents.push({
          type: 'game_end',
          tick: this.state.tick,
          winner: null,
          scores: { [allPlayers[0].id]: allPlayers[0].score },
        });
        this.stop();
      }
      return;
    }

    // Check if only one player has population remaining (multiplayer)
    const playersWithPopulation = allPlayers.filter(
      (p) => p.populationRemaining > 0
    );

    if (playersWithPopulation.length <= 1) {
      this.state.phase = 'ended';
      const winner = playersWithPopulation[0] || null;

      this.pendingEvents.push({
        type: 'game_end',
        tick: this.state.tick,
        winner: winner?.id || null,
        scores: Object.fromEntries(
          allPlayers.map((p) => [p.id, p.score])
        ),
      });

      this.stop();
    }
  }

  private sendDeltaUpdate(): void {
    const hasMissiles = Object.keys(this.state.missiles).length > 0;
    const hasSatellites = Object.keys(this.state.satellites).length > 0;
    const hasAircraft = Object.keys(this.state.aircraft).length > 0;

    if (this.pendingEvents.length === 0 && !hasMissiles && !hasSatellites && !hasAircraft) {
      return;
    }

    // Collect missile updates - include ALL missiles, even detonated/intercepted ones
    // so the client can see the detonated/intercepted flag and show the explosion
    const missileUpdates = Object.values(this.state.missiles);

    // Track missiles that detonated THIS tick (not previously seen by client)
    const justDetonated = new Set<string>();
    for (const missile of Object.values(this.state.missiles)) {
      if ((missile.detonated || missile.intercepted) && !this.previouslyDetonated.has(missile.id)) {
        justDetonated.add(missile.id);
      }
    }

    // Only remove missiles that were detonated LAST tick (client has already seen them)
    const removedMissileIds = Object.values(this.state.missiles)
      .filter((m) => (m.detonated || m.intercepted) && this.previouslyDetonated.has(m.id))
      .map((m) => m.id);

    // Update tracking set for next tick
    this.previouslyDetonated = justDetonated;

    // Remove detonated/intercepted missiles from state (only those the client has seen)
    for (const id of removedMissileIds) {
      delete this.state.missiles[id];
    }

    // Collect satellite updates
    const satelliteUpdates = Object.values(this.state.satellites).filter(
      (s) => !s.destroyed
    );

    // Collect removed satellites
    const removedSatelliteIds = Object.values(this.state.satellites)
      .filter((s) => s.destroyed)
      .map((s) => s.id);

    // Remove destroyed satellites from state
    for (const id of removedSatelliteIds) {
      delete this.state.satellites[id];
    }

    // Collect aircraft updates
    const aircraftUpdates = Object.values(this.state.aircraft).filter(
      (a) => a.status === 'flying'
    );

    // Collect removed aircraft (grounded or destroyed)
    const removedAircraftIds = Object.values(this.state.aircraft)
      .filter((a) => a.status === 'grounded' || a.status === 'destroyed')
      .map((a) => a.id);

    // Remove grounded/destroyed aircraft from state
    for (const id of removedAircraftIds) {
      delete this.state.aircraft[id];
    }

    // Collect building updates from events
    const buildingUpdates: Building[] = [];
    const includedBuildingIds = new Set<string>();

    for (const event of this.pendingEvents) {
      if (event.type === 'building_placed') {
        buildingUpdates.push(event.building);
        includedBuildingIds.add(event.building.id);
      } else if (event.type === 'missile_launch') {
        // Include the silo that launched the missile (missileCount changed)
        const sourceBuilding = Object.values(this.state.buildings).find(
          (b) => b.type === 'silo' && b.position.x === event.sourcePosition.x && b.position.y === event.sourcePosition.y
        );
        if (sourceBuilding && !includedBuildingIds.has(sourceBuilding.id)) {
          buildingUpdates.push(sourceBuilding);
          includedBuildingIds.add(sourceBuilding.id);
        }
      } else if (event.type === 'mode_change') {
        // Include the silo that changed mode
        const silo = this.state.buildings[event.siloId];
        if (silo && !includedBuildingIds.has(silo.id)) {
          buildingUpdates.push(silo);
          includedBuildingIds.add(silo.id);
        }
      } else if (event.type === 'satellite_launch') {
        // Include the facility that launched the satellite
        const facility = this.state.buildings[event.facilityId];
        if (facility && !includedBuildingIds.has(facility.id)) {
          buildingUpdates.push(facility);
          includedBuildingIds.add(facility.id);
        }
      }
    }

    const delta = {
      type: 'game_delta' as const,
      tick: this.state.tick,
      timestamp: this.state.timestamp,
      events: this.pendingEvents,
      buildingUpdates,
      missileUpdates,
      removedMissileIds,
      satelliteUpdates,
      removedSatelliteIds,
      aircraftUpdates,
      removedAircraftIds,
    };

    if (this.pendingEvents.some(e => e.type === 'mode_change')) {
      console.log(`[DEBUG] Sending delta with mode_change event, buildingUpdates: ${buildingUpdates.length}, events: ${this.pendingEvents.length}`);
    }
    this.broadcastToPlayers(delta);
    this.pendingEvents = [];
  }

  private sendFullSync(): void {
    this.broadcastToPlayers({
      type: 'game_state',
      tick: this.state.tick,
      timestamp: this.state.timestamp,
      state: this.state,
    });
  }

  private broadcastToPlayers(message: any): void {
    for (const player of this.lobby.getPlayers()) {
      const connection = this.connectionManager.getConnection(player.connectionId);
      if (connection) {
        this.connectionManager.send(connection, message);
      }
    }
  }

  // Player action handlers

  handlePlaceBuilding(
    playerId: string,
    buildingType: BuildingType,
    position: Vector2
  ): void {
    // Only allow during DEFCON 5
    if (this.state.defconLevel !== 5) return;

    const player = this.state.players[playerId];
    if (!player || !player.territoryId) return;

    const territory = this.state.territories[player.territoryId];
    if (!territory) return;

    // Check if position is in player's territory
    if (!this.isPointInTerritory(position, territory)) return;

    // Check if position is on land (not ocean)
    const geoPos = pixelToGeoLocal(position);
    if (!isPointOnLand(geoPos)) return;

    // Check building limits
    const playerBuildings = Object.values(this.state.buildings).filter(
      (b) => b.ownerId === playerId && b.type === buildingType
    );

    const limits = this.config.startingUnits;
    const limit = buildingType === 'silo' ? limits.silos :
                  buildingType === 'radar' ? limits.radars :
                  buildingType === 'airfield' ? limits.airfields :
                  limits.satellite_launch_facilities;

    if (playerBuildings.length >= limit) return;

    // Create building
    const buildingId = uuidv4();
    const geoPosition = pixelToGeoLocal(position);
    let building: Building;

    switch (buildingType) {
      case 'silo':
        building = {
          id: buildingId,
          type: 'silo',
          territoryId: territory.id,
          ownerId: playerId,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          mode: 'air_defense',
          modeSwitchCooldown: 0,
          missileCount: 10,
          airDefenseAmmo: 20,
          lastFireTime: 0,
          fireCooldown: 2000,
        };
        break;

      case 'radar':
        building = {
          id: buildingId,
          type: 'radar',
          territoryId: territory.id,
          ownerId: playerId,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          range: this.config.radarRange,
          active: true,
        };
        break;

      case 'airfield':
        building = {
          id: buildingId,
          type: 'airfield',
          territoryId: territory.id,
          ownerId: playerId,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          fighterCount: 5,
          bomberCount: 2,
          radarCount: 1,
        };
        break;

      case 'satellite_launch_facility':
        building = {
          id: buildingId,
          type: 'satellite_launch_facility',
          territoryId: territory.id,
          ownerId: playerId,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          satellites: SATELLITE_CONFIG.STARTING_SATELLITES,
          launchCooldown: SATELLITE_CONFIG.LAUNCH_COOLDOWN,
          lastLaunchTime: 0,
        };
        break;
    }

    this.state.buildings[buildingId] = building;
    territory.buildings.push(buildingId);

    this.pendingEvents.push({
      type: 'building_placed',
      tick: this.state.tick,
      building,
    });
  }

  handleLaunchMissile(
    playerId: string,
    siloId: string,
    targetPosition: Vector2,
    targetId?: string,
    isDecoy: boolean = false
  ): void {
    // Only allow at DEFCON 1
    if (this.state.defconLevel !== 1) return;

    const silo = this.state.buildings[siloId] as Silo | undefined;
    if (!silo || silo.type !== 'silo' || silo.ownerId !== playerId) return;
    if (silo.destroyed || silo.mode !== 'icbm' || silo.missileCount <= 0) return;

    // For decoys, require air defense ammo instead of missiles
    if (isDecoy && silo.airDefenseAmmo < 3) return;

    // Check cooldown (scaled by game speed)
    const now = Date.now();
    const effectiveCooldown = silo.fireCooldown / (this.state.gameSpeed || 1);
    if (now - silo.lastFireTime < effectiveCooldown) return;

    // Check for launch warning monitoring
    const monitorStatus = this.hackingSystem.isSiloMonitored(siloId);
    if (monitorStatus.monitored && monitorStatus.attackerId) {
      this.sendLaunchWarning(monitorStatus.attackerId, playerId, siloId, targetPosition);
    }

    // Create missile
    const missile = this.missileSimulator.launchMissile(
      silo,
      targetPosition,
      playerId,
      targetId
    );

    // Mark as decoy if applicable
    if (isDecoy) {
      missile.isDecoy = true;
      silo.airDefenseAmmo -= 3; // Decoys cost 3 air defense ammo
    } else {
      silo.missileCount--;
    }

    this.state.missiles[missile.id] = missile;
    silo.lastFireTime = now;

    this.pendingEvents.push({
      type: 'missile_launch',
      tick: this.state.tick,
      missileId: missile.id,
      playerId,
      sourcePosition: silo.position,
      targetPosition,
    });

    // Check if any enemy satellites can detect this launch
    const launchGeoPos = silo.geoPosition || pixelToGeoLocal(silo.position);
    const detectionEvents = this.checkSatelliteLaunchDetection(launchGeoPos, playerId);
    this.pendingEvents.push(...detectionEvents);
  }

  /**
   * Send launch warning to monitoring player
   */
  private sendLaunchWarning(
    attackerId: string,
    launchingPlayerId: string,
    siloId: string,
    targetPosition: Vector2
  ): void {
    const connection = this.getPlayerConnection(attackerId);
    if (!connection) return;

    const launchingPlayer = this.state.players[launchingPlayerId];
    const silo = this.state.buildings[siloId] as Silo;
    if (!silo || !launchingPlayer) return;

    // Calculate approximate direction to target
    const siloGeo = silo.geoPosition || pixelToGeoLocal(silo.position);
    const targetGeo = pixelToGeoLocal(targetPosition);

    // Calculate heading (0 = north, 90 = east)
    const dLng = targetGeo.lng - siloGeo.lng;
    const dLat = targetGeo.lat - siloGeo.lat;
    const heading = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;

    this.connectionManager.send(connection, {
      type: 'launch_warning',
      fromPlayerId: launchingPlayerId,
      fromPlayerName: launchingPlayer.name,
      siloId,
      approximateDirection: Math.round(heading),
      countdown: 5,
    });

    console.log(`[LAUNCH WARNING] ${attackerId} warned about launch from ${siloId} heading ${Math.round(heading)}°`);
  }

  handleSetSiloMode(playerId: string, siloId: string, mode: SiloMode): void {
    console.log(`[DEBUG] handleSetSiloMode called: siloId=${siloId}, mode=${mode}`);
    const silo = this.state.buildings[siloId] as Silo | undefined;
    if (!silo || silo.type !== 'silo' || silo.ownerId !== playerId) {
      console.log(`[DEBUG] Silo validation failed: silo=${!!silo}, type=${silo?.type}, owner=${silo?.ownerId}, player=${playerId}`);
      return;
    }
    if (silo.destroyed || silo.mode === mode) {
      console.log(`[DEBUG] Mode change rejected: destroyed=${silo.destroyed}, currentMode=${silo.mode}, requestedMode=${mode}`);
      return;
    }

    // Check if silo mode is locked by hacking
    if (this.isSiloModeLocked(siloId)) {
      console.log(`[DEBUG] Mode change blocked: silo ${siloId} is hacked (mode locked)`);
      return;
    }

    // Mode switch has a cooldown (scaled by game speed)
    const now = Date.now();
    if (now < silo.modeSwitchCooldown) {
      console.log(`[DEBUG] Mode change on cooldown: now=${now}, cooldown=${silo.modeSwitchCooldown}`);
      return;
    }

    silo.mode = mode;
    const modeCooldownMs = 5000 / (this.state.gameSpeed || 1);
    silo.modeSwitchCooldown = now + modeCooldownMs;
    console.log(`[DEBUG] Mode changed successfully to ${mode}, pendingEvents will have ${this.pendingEvents.length + 1} events`);

    this.pendingEvents.push({
      type: 'mode_change',
      tick: this.state.tick,
      siloId,
      newMode: mode,
    });
  }

  handleLaunchSatellite(
    playerId: string,
    facilityId: string,
    inclination: number
  ): void {
    // Can launch satellites at any DEFCON level after placement phase
    if (this.state.defconLevel === 5) return;

    const facility = this.state.buildings[facilityId] as SatelliteLaunchFacility | undefined;
    if (!facility || facility.type !== 'satellite_launch_facility' || facility.ownerId !== playerId) {
      console.log(`[SATELLITE] Launch failed: facility validation failed`);
      return;
    }
    if (facility.destroyed) {
      console.log(`[SATELLITE] Launch failed: facility destroyed`);
      return;
    }

    // Use the satellite simulator to launch
    const result = this.satelliteSimulator.launchSatellite(
      facility,
      inclination,
      playerId,
      this.state.tick,
      this.state.gameSpeed || 1
    );

    if (!result) return;

    // Add satellite to state
    this.state.satellites[result.satellite.id] = result.satellite;

    // Update facility
    facility.satellites--;
    facility.lastLaunchTime = Date.now();

    // Add event
    this.pendingEvents.push(result.event);
  }

  handleLaunchAircraft(
    playerId: string,
    airfieldId: string,
    aircraftType: AircraftType,
    waypoints: GeoPosition[]
  ): void {
    // Can launch aircraft at DEFCON 3 or lower (during combat)
    if (this.state.defconLevel > 3) {
      console.log('[AIRCRAFT] Launch failed: DEFCON too high');
      return;
    }

    const airfield = this.state.buildings[airfieldId] as Airfield | undefined;
    if (!airfield || airfield.type !== 'airfield' || airfield.ownerId !== playerId) {
      console.log('[AIRCRAFT] Launch failed: airfield validation failed');
      return;
    }
    if (airfield.destroyed) {
      console.log('[AIRCRAFT] Launch failed: airfield destroyed');
      return;
    }

    // Use the aircraft simulator to launch
    const aircraft = this.aircraftSimulator.launchAircraft(
      airfield,
      aircraftType,
      waypoints,
      playerId
    );

    if (!aircraft) return;

    // Add aircraft to state
    this.state.aircraft[aircraft.id] = aircraft;

    // Decrement aircraft count
    if (aircraftType === 'fighter') {
      airfield.fighterCount--;
    } else if (aircraftType === 'radar') {
      airfield.radarCount = (airfield.radarCount ?? 1) - 1;
    } else {
      airfield.bomberCount--;
    }

    console.log(`[AIRCRAFT] ${playerId} launched ${aircraftType} from ${airfieldId}`);
  }

  handleSetGameSpeed(speed: 1 | 2 | 5): void {
    if (speed === 1 || speed === 2 || speed === 5) {
      this.state.gameSpeed = speed;
      console.log(`[GAME] Speed set to ${speed}x`);
      this.sendFullSync();
    }
  }

  handleDebugCommand(command: string, value?: number, targetRegion?: string): void {
    console.log(`[DEBUG] Command: ${command}, value: ${value}, targetRegion: ${targetRegion}`);

    switch (command) {
      case 'advance_defcon':
        if (this.state.defconLevel > 1) {
          this.state.defconTimer = 0; // Force timer to expire
        }
        break;

      case 'set_defcon':
        if (value && value >= 1 && value <= 5) {
          this.state.defconLevel = value as DefconLevel;
          const timings = this.config.defconTimings;
          switch (value) {
            case 5:
              this.state.defconTimer = timings.defcon5Duration;
              this.state.phase = 'placement';
              break;
            case 4:
              this.state.defconTimer = timings.defcon4Duration;
              break;
            case 3:
              this.state.defconTimer = timings.defcon3Duration;
              break;
            case 2:
              this.state.defconTimer = timings.defcon2Duration;
              break;
            case 1:
              this.state.defconTimer = timings.defcon1Duration;
              this.state.phase = 'active';
              break;
          }
          this.pendingEvents.push({
            type: 'defcon_change',
            tick: this.state.tick,
            newLevel: this.state.defconLevel,
          });
          console.log(`[DEBUG] Set DEFCON to ${value}`);
        }
        break;

      case 'skip_timer':
        this.state.defconTimer = 1000; // Set to 1 second
        break;

      case 'add_missiles':
        // Add missiles to all player silos
        for (const building of getBuildings(this.state)) {
          if (building.type === 'silo') {
            (building as Silo).missileCount = 10;
            (building as Silo).airDefenseAmmo = 20;
          }
        }
        console.log('[DEBUG] Replenished all silo ammo');
        break;

      case 'launch_test_missiles':
        this.launchTestMissiles(value || 5, targetRegion);
        break;
    }

    // Send immediate full sync after debug command
    this.sendFullSync();
  }

  private launchTestMissiles(count: number, targetRegion?: string): void {
    // Test missiles only allowed at DEFCON 1 (like regular missiles)
    if (this.state.defconLevel !== 1) {
      console.log('[DEBUG] Test missiles only available at DEFCON 1');
      return;
    }

    // Get all silos that have missiles
    const allSilos = Object.values(this.state.buildings).filter(
      (b): b is Silo => b.type === 'silo' && !b.destroyed && (b as Silo).missileCount > 0
    );

    if (allSilos.length === 0) {
      console.log('[DEBUG] No silos with missiles available');
      return;
    }

    // Get all cities, optionally filtered by target region
    const allCities: { position: Vector2; geoPosition: GeoPosition; name: string; territoryId: string }[] = [];

    for (const [territoryId, cities] of Object.entries(CITY_DATA)) {
      // If targetRegion is specified, only include cities from that territory
      if (targetRegion && territoryId !== targetRegion) continue;

      for (const city of cities) {
        allCities.push({
          position: city.position,
          geoPosition: city.geoPosition,
          name: city.name,
          territoryId,
        });
      }
    }

    if (allCities.length === 0) {
      console.log(`[DEBUG] No target cities available${targetRegion ? ` in ${targetRegion}` : ''}`);
      return;
    }

    // Launch missiles from random silos to random cities
    const launchCount = Math.min(count, allSilos.length * 2); // Cap at 2 missiles per silo
    console.log(`[DEBUG] Launching ${launchCount} test missiles${targetRegion ? ` toward ${targetRegion}` : ''}`);

    for (let i = 0; i < launchCount; i++) {
      // Pick a random silo that still has missiles
      const availableSilos = allSilos.filter(s => s.missileCount > 0);
      if (availableSilos.length === 0) break;

      const silo = availableSilos[Math.floor(Math.random() * availableSilos.length)];

      // Pick a random city that's not in the silo owner's territory
      const targetCities = allCities.filter(c => {
        const territory = this.state.territories[c.territoryId];
        return !territory || territory.ownerId !== silo.ownerId;
      });

      if (targetCities.length === 0) continue;

      const target = targetCities[Math.floor(Math.random() * targetCities.length)];

      // Create missile
      const missile = this.missileSimulator.launchMissile(
        silo,
        target.position,
        silo.ownerId,
        undefined
      );

      this.state.missiles[missile.id] = missile;
      silo.missileCount--;

      this.pendingEvents.push({
        type: 'missile_launch',
        tick: this.state.tick,
        missileId: missile.id,
        playerId: silo.ownerId,
        sourcePosition: silo.position,
        targetPosition: target.position,
      });

      console.log(`[DEBUG] Test missile ${i + 1}: ${target.name}`);
    }
  }

  // AI-related methods

  handleEnableAI(region: string): void {
    // Check if territory exists and isn't already taken
    const territory = this.state.territories[region];
    if (!territory) {
      console.log(`[AI] Invalid territory: ${region}`);
      return;
    }

    if (territory.ownerId) {
      console.log(`[AI] Territory already owned: ${region}`);
      return;
    }

    // Remove existing AI if any
    if (this.aiPlayer) {
      this.handleDisableAI();
    }

    // Create new AI player
    this.aiPlayer = new AIPlayer(region);
    const playerCount = Object.keys(this.state.players).length;
    const aiPlayerData = this.aiPlayer.createPlayer(playerCount);

    // Add AI player to game state
    this.state.players[this.aiPlayer.id] = aiPlayerData;

    // Assign territory to AI
    territory.ownerId = this.aiPlayer.id;

    // Add cities for AI territory
    if (CITY_DATA[region]) {
      for (const cityData of CITY_DATA[region]) {
        const cityId = uuidv4();
        this.state.cities[cityId] = {
          id: cityId,
          territoryId: region,
          name: cityData.name,
          position: cityData.position,
          population: cityData.population,
          maxPopulation: cityData.population,
          destroyed: false,
          geoPosition: cityData.geoPosition,
        };
        territory.cities.push(cityId);
        aiPlayerData.populationRemaining += cityData.population;
      }
    }

    console.log(`[AI] Enabled AI player ${this.aiPlayer.name} with territory ${region}`);

    // If we're at DEFCON 5, immediately place buildings
    if (this.state.defconLevel === 5) {
      const actions = this.aiPlayer.placeBuildings();
      this.executeAIActions(actions);
    }

    // Send full sync to update all clients
    this.sendFullSync();
  }

  handleDisableAI(): void {
    if (!this.aiPlayer) return;

    const aiId = this.aiPlayer.id;
    console.log(`[AI] Disabling AI player ${this.aiPlayer.name}`);

    // Remove AI player
    delete this.state.players[aiId];

    // Remove AI territory ownership
    for (const territory of Object.values(this.state.territories)) {
      if (territory.ownerId === aiId) {
        territory.ownerId = null;
      }
    }

    // Remove AI buildings
    const buildingsToRemove: string[] = [];
    for (const [id, building] of Object.entries(this.state.buildings)) {
      if (building.ownerId === aiId) {
        buildingsToRemove.push(id);
      }
    }
    for (const id of buildingsToRemove) {
      delete this.state.buildings[id];
    }

    // Remove AI cities
    const citiesToRemove: string[] = [];
    for (const [id, city] of Object.entries(this.state.cities)) {
      const territory = this.state.territories[city.territoryId];
      if (territory && !territory.ownerId) {
        citiesToRemove.push(id);
      }
    }
    for (const id of citiesToRemove) {
      delete this.state.cities[id];
    }

    // Clear territory city references
    for (const territory of Object.values(this.state.territories)) {
      if (!territory.ownerId) {
        territory.cities = [];
        territory.buildings = [];
      }
    }

    // Remove AI missiles
    const missilesToRemove: string[] = [];
    for (const [id, missile] of Object.entries(this.state.missiles)) {
      if (missile.ownerId === aiId) {
        missilesToRemove.push(id);
      }
    }
    for (const id of missilesToRemove) {
      delete this.state.missiles[id];
    }

    this.aiPlayer = null;

    // Send full sync
    this.sendFullSync();
  }

  private executeAIActions(actions: AIAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case 'place_building':
          if (action.buildingType && action.position && action.geoPosition) {
            this.placeAIBuilding(action.buildingType, action.position, action.geoPosition);
          }
          break;

        case 'launch_missile':
          if (action.siloId && action.targetPosition) {
            this.handleLaunchMissile(
              this.aiPlayer!.id,
              action.siloId,
              action.targetPosition
            );
          }
          break;

        case 'set_silo_mode':
          if (action.siloId && action.mode) {
            this.handleSetSiloMode(
              this.aiPlayer!.id,
              action.siloId,
              action.mode
            );
          }
          break;
      }
    }
  }

  private placeAIBuilding(
    buildingType: 'silo' | 'radar',
    position: Vector2,
    geoPosition: GeoPosition
  ): void {
    if (!this.aiPlayer) return;

    const territory = this.state.territories[this.aiPlayer.territoryId];
    if (!territory) return;

    const buildingId = uuidv4();
    let building: Building;

    switch (buildingType) {
      case 'silo':
        building = {
          id: buildingId,
          type: 'silo',
          territoryId: territory.id,
          ownerId: this.aiPlayer.id,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          mode: 'air_defense',  // Start in defense mode
          modeSwitchCooldown: 0,
          missileCount: 10,
          airDefenseAmmo: 20,
          lastFireTime: 0,
          fireCooldown: 2000,
        };
        break;

      case 'radar':
        building = {
          id: buildingId,
          type: 'radar',
          territoryId: territory.id,
          ownerId: this.aiPlayer.id,
          position,
          health: 100,
          destroyed: false,
          geoPosition,
          range: this.config.radarRange,
          active: true,
        };
        break;
    }

    this.state.buildings[buildingId] = building;
    territory.buildings.push(buildingId);

    this.pendingEvents.push({
      type: 'building_placed',
      tick: this.state.tick,
      building,
    });

    console.log(`[AI] Placed ${buildingType} at (${position.x.toFixed(0)}, ${position.y.toFixed(0)})`);
  }

  // Manual intercept handlers

  /**
   * Handle request for intercept info - returns available silos and hit probabilities
   */
  handleRequestInterceptInfo(
    connection: { id: string; ws: unknown },
    playerId: string,
    targetMissileId: string
  ): void {
    const missile = this.state.missiles[targetMissileId] as Missile | undefined;
    if (!missile || missile.detonated || missile.intercepted || isInterceptor(missile)) {
      // Invalid target - send empty response
      this.connectionManager.send(connection as any, {
        type: 'intercept_info',
        targetMissileId,
        availableSilos: [],
        existingInterceptors: [],
      });
      return;
    }

    // Get all silos owned by this player in air defense mode
    const silos = getBuildings(this.state).filter(
      (b): b is Silo =>
        b.type === 'silo' &&
        !b.destroyed &&
        b.ownerId === playerId &&
        (b as Silo).mode === 'air_defense' &&
        (b as Silo).airDefenseAmmo > 0
    );

    const now = Date.now();
    const availableSilos: Array<{
      siloId: string;
      siloName: string;
      hitProbability: number;
      estimatedInterceptProgress: number;
      ammoRemaining: number;
    }> = [];

    for (const silo of silos) {
      // Check cooldown (scaled by game speed)
      const effectiveCooldown = silo.fireCooldown / (this.state.gameSpeed || 1);
      if (now - silo.lastFireTime < effectiveCooldown) continue;

      // Find all radars that can see the missile
      const trackingRadarIds = this.findAllTrackingRadars(missile, playerId);
      if (trackingRadarIds.length === 0) continue;

      // Calculate hit probability using the guided interceptor simulator
      const hitProbability = this.guidedInterceptorSimulator.estimateHitProbability(silo, missile, trackingRadarIds.length);

      // Estimate where the intercept would occur
      const interceptProgress = this.estimateInterceptProgress(silo, missile);

      // Get a name for the silo based on its territory
      const territory = this.state.territories[silo.territoryId];
      const siloName = territory ? `${territory.name} Silo` : 'Silo';

      availableSilos.push({
        siloId: silo.id,
        siloName,
        hitProbability,
        estimatedInterceptProgress: interceptProgress,
        ammoRemaining: silo.airDefenseAmmo,
      });
    }

    // Sort by hit probability (best first)
    availableSilos.sort((a, b) => b.hitProbability - a.hitProbability);

    // Find interceptors already targeting this missile
    const existingInterceptors = getMissiles(this.state)
      .filter(m => isInterceptor(m) && (m as any).targetId === targetMissileId && !m.detonated && !m.intercepted)
      .map(m => {
        const sourceSilo = this.state.buildings[m.sourceId] as Silo | undefined;
        const territory = sourceSilo ? this.state.territories[sourceSilo.territoryId] : null;
        // Estimate time to intercept based on guided interceptor's remaining flight time
        let estimatedTimeToIntercept = 5000;  // Default
        if (isGuidedInterceptor(m)) {
          const guidedInterceptor = m as GuidedInterceptor;
          if (guidedInterceptor.flightDuration && guidedInterceptor.progress !== undefined) {
            const remainingProgress = 1 - guidedInterceptor.progress;
            estimatedTimeToIntercept = remainingProgress * guidedInterceptor.flightDuration;
          }
        }
        return {
          interceptorId: m.id,
          sourceSiloName: territory ? `${territory.name} Silo` : 'Silo',
          estimatedTimeToIntercept,
        };
      });

    this.connectionManager.send(connection as any, {
      type: 'intercept_info',
      targetMissileId,
      availableSilos,
      existingInterceptors,
    });
  }

  /**
   * Handle manual intercept request - launch interceptors from specified silos
   */
  handleManualIntercept(
    playerId: string,
    targetMissileId: string,
    siloIds: string[]
  ): void {
    const missile = this.state.missiles[targetMissileId] as Missile | undefined;
    if (!missile || missile.detonated || missile.intercepted || isInterceptor(missile)) {
      return; // Invalid target
    }

    const now = Date.now();

    for (const siloId of siloIds) {
      const silo = this.state.buildings[siloId] as Silo | undefined;
      if (!silo || silo.type !== 'silo' || silo.ownerId !== playerId) continue;
      if (silo.destroyed || silo.mode !== 'air_defense' || silo.airDefenseAmmo <= 0) continue;

      // Check cooldown (scaled by game speed)
      const effectiveCooldown = silo.fireCooldown / (this.state.gameSpeed || 1);
      if (now - silo.lastFireTime < effectiveCooldown) continue;

      // Find all radars that can see the missile
      const trackingRadarIds = this.findAllTrackingRadars(missile, playerId);
      if (trackingRadarIds.length === 0) continue;

      // Launch guided interceptor
      const interceptor = this.guidedInterceptorSimulator.launchInterceptor(
        silo,
        missile,
        playerId,
        trackingRadarIds
      );

      if (!interceptor) {
        console.log(`[MANUAL INTERCEPT] Could not calculate intercept from silo ${siloId}`);
        continue;
      }

      this.state.missiles[interceptor.id] = interceptor;
      silo.airDefenseAmmo--;
      silo.lastFireTime = now;

      this.pendingEvents.push({
        type: 'missile_launch',
        tick: this.state.tick,
        missileId: interceptor.id,
        playerId,
        sourcePosition: silo.position,
        targetPosition: interceptor.geoTargetPosition
          ? geoToPixel(interceptor.geoTargetPosition, MAP_WIDTH, MAP_HEIGHT)
          : silo.position,
      });

      console.log(`[MANUAL INTERCEPT] Player ${playerId} launched guided interceptor from silo ${siloId} at ICBM ${targetMissileId}`);
    }
  }

  /**
   * Calculate estimated hit probability for a silo engaging a missile
   */
  private calculateHitProbability(silo: Silo, missile: Missile): number {
    // Base probability
    let probability = 0.7;

    // Factor in distance - closer silos have better geometry
    const siloGeo = silo.geoPosition || pixelToGeoLocal(silo.position);
    const missileGeo = missile.geoCurrentPosition || pixelToGeoLocal(missile.currentPosition);
    const distance = greatCircleDistance(siloGeo, missileGeo);

    // Reduce probability for distant intercepts
    const distancePenalty = Math.min(0.3, distance * 5);
    probability -= distancePenalty;

    // Factor in missile progress - later intercepts are harder
    if (missile.progress > 0.5) {
      probability -= (missile.progress - 0.5) * 0.4;
    }

    return Math.max(0.1, Math.min(0.9, probability));
  }

  /**
   * Estimate where on the missile's trajectory the intercept would occur
   */
  private estimateInterceptProgress(silo: Silo, missile: Missile): number {
    // Rough estimate based on current missile progress and relative positions
    const siloGeo = silo.geoPosition || pixelToGeoLocal(silo.position);
    const targetGeo = missile.geoTargetPosition || pixelToGeoLocal(missile.targetPosition);

    // Time for interceptor to reach target area (rough estimate)
    const siloToTarget = greatCircleDistance(siloGeo, targetGeo);
    const missileToTarget = 1 - missile.progress;

    // If silo is closer to target than missile's remaining distance, intercept happens closer to target
    const interceptProgress = Math.min(0.95, missile.progress + missileToTarget * 0.5);

    return interceptProgress;
  }

  /**
   * Handle terminal email from one player to another
   */
  handleTerminalEmail(
    fromPlayerId: string,
    toPlayerId: string,
    subject: string,
    body: string
  ): void {
    const fromPlayer = this.state.players[fromPlayerId];
    const toPlayer = this.state.players[toPlayerId];

    if (!fromPlayer || !toPlayer) {
      console.log(`[EMAIL] Invalid sender or recipient`);
      return;
    }

    // Find the recipient's connection
    const lobbyPlayer = this.lobby.getPlayers().find(p => p.id === toPlayerId);
    if (!lobbyPlayer) {
      console.log(`[EMAIL] Recipient ${toPlayerId} not found in lobby`);
      return;
    }

    const connection = this.connectionManager.getConnection(lobbyPlayer.connectionId);
    if (!connection) {
      console.log(`[EMAIL] Recipient ${toPlayerId} not connected`);
      return;
    }

    // Send email to recipient
    this.connectionManager.send(connection, {
      type: 'terminal_email_received',
      fromPlayerId,
      fromPlayerName: fromPlayer.name,
      subject,
      body,
      timestamp: Date.now(),
    });

    console.log(`[EMAIL] ${fromPlayer.name} -> ${toPlayer.name}: ${subject}`);
  }

  // ============ HACKING SYSTEM METHODS ============

  /**
   * Process results from hacking system update
   */
  private processHackingResults(result: import('./HackingSystem').HackTickResult): void {
    // Send progress updates to attackers
    for (const update of result.progressUpdates) {
      const hack = this.hackingSystem.getHack(update.hackId);
      if (!hack) continue;

      const attackerConnection = this.getPlayerConnection(hack.attackerId);
      if (attackerConnection) {
        this.connectionManager.send(attackerConnection, {
          type: 'hack_progress',
          hackId: update.hackId,
          progress: update.progress,
          traceProgress: update.traceProgress,
          status: hack.status as 'connecting' | 'active',
        });
      }
    }

    // Handle completed hacks
    for (const { hack, compromise } of result.completedHacks) {
      // Notify attacker of success
      const attackerConnection = this.getPlayerConnection(hack.attackerId);
      if (attackerConnection) {
        this.connectionManager.send(attackerConnection, {
          type: 'hack_complete',
          hackId: hack.id,
          targetId: hack.targetId,
          hackType: hack.hackType,
          compromise,
        });
      }

      // Notify victim of compromise
      const victimConnection = this.getPlayerConnection(hack.targetOwnerId);
      if (victimConnection) {
        this.connectionManager.send(victimConnection, {
          type: 'system_compromised',
          targetId: hack.targetId,
          hackType: hack.hackType,
          expiresAt: compromise.expiresAt,
        });
      }

      console.log(`[HACK] ${hack.attackerId} successfully hacked ${hack.targetId} with ${hack.hackType}`);
    }

    // Handle traced hacks
    for (const hack of result.tracedHacks) {
      // Notify attacker they were caught
      const attackerConnection = this.getPlayerConnection(hack.attackerId);
      if (attackerConnection) {
        this.connectionManager.send(attackerConnection, {
          type: 'hack_traced',
          hackId: hack.id,
          targetId: hack.targetId,
          revealedToEnemy: true,
        });
      }

      // Notify victim with attacker info
      const victimConnection = this.getPlayerConnection(hack.targetOwnerId);
      if (victimConnection) {
        const attacker = this.state.players[hack.attackerId];
        this.connectionManager.send(victimConnection, {
          type: 'intrusion_alert',
          alert: {
            id: hack.id,
            targetId: hack.targetId,
            detectedAt: hack.startTime,
            traceProgress: 100,
            attackerRevealed: hack.attackerId,
          },
        });
      }

      console.log(`[HACK] ${hack.attackerId} was traced while hacking ${hack.targetId}`);
    }
  }

  /**
   * Get connection for a player
   */
  private getPlayerConnection(playerId: string): Connection | null {
    const lobbyPlayer = this.lobby.getPlayers().find((p) => p.id === playerId);
    if (!lobbyPlayer) return null;
    return this.connectionManager.getConnection(lobbyPlayer.connectionId) || null;
  }

  /**
   * Handle scan request from player
   */
  handleHackScan(playerId: string): void {
    const detectedBuildings = this.hackingSystem.scanForBuildings(this.state, playerId);

    const connection = this.getPlayerConnection(playerId);
    if (connection) {
      this.connectionManager.send(connection, {
        type: 'hack_scan_result',
        detectedBuildings,
      });
    }

    console.log(`[HACK] ${playerId} scanned, found ${detectedBuildings.length} enemy buildings`);
  }

  /**
   * Handle hack start request from player
   */
  handleHackStart(
    playerId: string,
    targetId: string,
    hackType: HackType,
    proxyRoute?: string[]
  ): void {
    const result = this.hackingSystem.startHack(
      this.state,
      playerId,
      targetId,
      hackType,
      proxyRoute
    );

    const connection = this.getPlayerConnection(playerId);
    if (!connection) return;

    if (result.success && result.hack) {
      const targetBuilding = getBuildings(this.state).find(b => b.id === targetId);

      // Send hack_started with full info so client can initialize activeHack
      this.connectionManager.send(connection, {
        type: 'hack_started',
        hackId: result.hack.id,
        targetId: targetId,
        targetName: targetBuilding?.id || 'Unknown',
        hackType: hackType,
      });

      // Send initial progress update
      this.connectionManager.send(connection, {
        type: 'hack_progress',
        hackId: result.hack.id,
        progress: 0,
        traceProgress: 0,
        status: 'connecting',
      });

      console.log(`[HACK] ${playerId} started ${hackType} hack on ${targetId}`);
    } else {
      // Send error
      this.connectionManager.send(connection, {
        type: 'error',
        code: 'hack_failed',
        message: result.error || 'Hack failed',
      });
    }
  }

  /**
   * Handle hack disconnect request from player
   */
  handleHackDisconnect(playerId: string, hackId: string): void {
    const success = this.hackingSystem.disconnectHack(hackId, playerId);

    const connection = this.getPlayerConnection(playerId);
    if (connection && success) {
      this.connectionManager.send(connection, {
        type: 'hack_disconnected',
        hackId,
        reason: 'player',
      });
    }

    console.log(`[HACK] ${playerId} disconnected from hack ${hackId}`);
  }

  /**
   * Handle purge request from player
   */
  handleHackPurge(playerId: string, targetId: string): void {
    const success = this.hackingSystem.purgeCompromise(targetId, playerId);

    if (success) {
      console.log(`[HACK] ${playerId} purged compromise from ${targetId}`);
    }
  }

  /**
   * Handle trace request from player - returns current intrusion status
   */
  handleHackTrace(playerId: string): void {
    const connection = this.getPlayerConnection(playerId);
    if (!connection) return;

    const alerts = this.hackingSystem.getIntrusionAlerts(playerId);
    const compromises = this.hackingSystem.getCompromisesForPlayer(playerId);

    this.connectionManager.send(connection, {
      type: 'intrusion_status',
      activeIntrusions: alerts,
      compromisedBuildings: compromises,
    });
  }

  /**
   * Check if a radar is blinded by hacking
   */
  isRadarBlinded(radarId: string): boolean {
    return this.hackingSystem.isCompromised(radarId, 'blind_radar');
  }

  /**
   * Check if a silo mode is locked by hacking
   */
  isSiloModeLocked(siloId: string): boolean {
    return this.hackingSystem.isCompromised(siloId, 'lock_silo');
  }

  /**
   * Get hacking system for external access
   */
  getHackingSystem(): HackingSystem {
    return this.hackingSystem;
  }

  // ============ NETWORK WARFARE HANDLERS ============

  /**
   * Handle decoy missile launch
   * Decoys cost 3 air defense ammo and do no damage
   */
  handleLaunchDecoy(
    playerId: string,
    siloId: string,
    targetPosition: Vector2,
    count: number = 1
  ): void {
    // Limit count to 3
    const actualCount = Math.min(3, Math.max(1, count));

    for (let i = 0; i < actualCount; i++) {
      // Add slight position offset for each decoy
      const offsetPosition = {
        x: targetPosition.x + (Math.random() - 0.5) * 20,
        y: targetPosition.y + (Math.random() - 0.5) * 20,
      };
      this.handleLaunchMissile(playerId, siloId, offsetPosition, undefined, true);
    }

    console.log(`[DECOY] ${playerId} launched ${actualCount} decoy missiles from ${siloId}`);
  }

  /**
   * Handle setting silo target (for target_intel hack)
   */
  handleSetSiloTarget(
    playerId: string,
    siloId: string,
    targetPosition: GeoPosition
  ): void {
    const silo = this.state.buildings[siloId] as Silo | undefined;
    if (!silo || silo.type !== 'silo' || silo.ownerId !== playerId) return;
    if (silo.destroyed) return;

    silo.targetedPosition = targetPosition;
    console.log(`[SILO TARGET] ${playerId} set silo ${siloId} target to (${targetPosition.lat.toFixed(2)}, ${targetPosition.lng.toFixed(2)})`);
  }

  /**
   * Check if a player can see through a tapped radar
   * Returns the radar's coverage area for fog-of-war
   */
  getTappedRadarCoverage(playerId: string): Array<{ radarId: string; position: GeoPosition; range: number }> {
    const tappedRadarIds = this.hackingSystem.getRadarsTappedByPlayer(playerId);
    const coverage: Array<{ radarId: string; position: GeoPosition; range: number }> = [];

    for (const radarId of tappedRadarIds) {
      const radar = this.state.buildings[radarId] as Radar | undefined;
      if (!radar || radar.destroyed || !radar.geoPosition) continue;

      // Check if radar is blinded - if so, tapped player also sees nothing
      if (this.isRadarBlinded(radarId)) continue;

      coverage.push({
        radarId: radar.id,
        position: radar.geoPosition,
        range: (radar.range / 100) * 9, // Convert to degrees
      });
    }

    return coverage;
  }

  /**
   * Check if a player can see through a hijacked satellite
   * Returns the satellite's vision area for fog-of-war
   */
  getHijackedSatelliteVision(playerId: string): Array<{ satelliteId: string; position: GeoPosition; range: number }> {
    const hijackedSatIds = this.hackingSystem.getSatellitesHijackedByPlayer(playerId);
    const vision: Array<{ satelliteId: string; position: GeoPosition; range: number }> = [];

    for (const satId of hijackedSatIds) {
      const satellite = this.state.satellites[satId];
      if (!satellite || satellite.destroyed || !satellite.geoPosition) continue;

      // Check if satellite is disabled - if so, hijacker also sees nothing
      if (this.hackingSystem.isCompromised(`sat:${satId}`, 'disable_satellite')) continue;

      vision.push({
        satelliteId: satellite.id,
        position: satellite.geoPosition,
        range: 30, // Satellite vision range in degrees
      });
    }

    return vision;
  }

  /**
   * Get target intel for a silo (if attacker has completed target_intel hack)
   */
  getTargetIntel(siloId: string, attackerId: string): { targetPosition?: GeoPosition; targetCityName?: string } | null {
    // Check if attacker has completed a target_intel hack on this silo
    const compromise = this.hackingSystem.getCompromise(siloId, 'target_intel');
    if (!compromise || compromise.attackerId !== attackerId) return null;

    const silo = this.state.buildings[siloId] as Silo | undefined;
    if (!silo) return null;

    const targetPosition = silo.targetedPosition;
    if (!targetPosition) return { targetPosition: undefined };

    // Try to find the targeted city name
    let targetCityName: string | undefined;
    for (const city of Object.values(this.state.cities)) {
      if (!city.geoPosition) continue;
      const dist = greatCircleDistance(targetPosition, city.geoPosition);
      if (dist < 0.05) { // Within ~5.5km
        targetCityName = city.name;
        break;
      }
    }

    return { targetPosition, targetCityName };
  }
}
