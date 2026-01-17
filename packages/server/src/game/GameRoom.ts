import { v4 as uuidv4 } from 'uuid';
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
  DefconLevel,
  BuildingType,
  SiloMode,
  Vector2,
  GameEvent,
  PlayerColor,
  GeoPosition,
  getBuildings,
  getTerritories,
  getMissiles,
  getSatellites,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  geoToPixel,
  pixelToGeo,
} from '@defcon/shared';
import { Lobby, LobbyPlayer } from '../lobby/Lobby';
import { ConnectionManager } from '../ConnectionManager';
import { MissileSimulator } from '../simulation/MissileSimulator';
import { SatelliteSimulator, SATELLITE_CONFIG } from '../simulation/SatelliteSimulator';

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

  private tickInterval: NodeJS.Timeout | null = null;
  private lastFullSync = 0;
  private pendingEvents: GameEvent[] = [];

  constructor(lobby: Lobby, connectionManager: ConnectionManager) {
    this.id = uuidv4();
    this.lobby = lobby;
    this.config = lobby.config;
    this.connectionManager = connectionManager;
    this.missileSimulator = new MissileSimulator(this.config.missileSpeed);
    this.satelliteSimulator = new SatelliteSimulator();

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
      players,
      territories,
      cities,
      buildings,
      missiles: {},
      satellites: {},
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

    // Update DEFCON timer
    this.updateDefconTimer(TICK_INTERVAL);

    // Update missiles
    const missileEvents = this.missileSimulator.update(
      this.state,
      TICK_INTERVAL / 1000
    );
    this.pendingEvents.push(...missileEvents);

    // Update satellites
    const satelliteEvents = this.satelliteSimulator.update(
      this.state,
      TICK_INTERVAL / 1000,
      SPHERE_RADIUS
    );
    this.pendingEvents.push(...satelliteEvents);

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

    // Check each incoming missile
    for (const missile of getMissiles(this.state)) {
      if (missile.detonated || missile.intercepted) continue;
      if (missile.type === 'interceptor') continue;

      for (const silo of airDefenseSilos) {
        // Only intercept missiles heading toward this player's territory
        const targetTerritory = this.getTerritoryAt(missile.targetPosition);
        if (!targetTerritory || targetTerritory.ownerId !== silo.ownerId) continue;

        // Check if missile is within interception range
        const distance = this.distance(missile.currentPosition, silo.position);
        const interceptionRange = 150;
        if (distance > interceptionRange) continue;

        // Check cooldown
        const now = Date.now();
        if (now - silo.lastFireTime < silo.fireCooldown) continue;

        // Interception probability
        const baseProbability = 0.7;
        const distanceFactor = 1 - distance / interceptionRange;
        const progressFactor = missile.progress > 0.8 ? 0.5 : 1;
        const probability = baseProbability * distanceFactor * progressFactor;

        if (Math.random() < probability) {
          missile.intercepted = true;
          silo.airDefenseAmmo--;
          silo.lastFireTime = now;

          events.push({
            type: 'interception',
            tick: this.state.tick,
            missileId: missile.id,
            interceptorId: silo.id,
            position: { ...missile.currentPosition },
          });

          break;
        }
      }
    }

    return events;
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

    // Check each satellite
    for (const satellite of getSatellites(this.state)) {
      if (satellite.destroyed) continue;

      // Get satellite ground position
      const satPos = satellite.geoPosition;
      if (!satPos) continue;

      for (const silo of airDefenseSilos) {
        // Can only target enemy satellites
        if (silo.ownerId === satellite.ownerId) continue;

        // Check if satellite is within interception range (using geo position)
        const siloGeo = silo.geoPosition || pixelToGeoLocal(silo.position);
        const latDiff = Math.abs(satPos.lat - siloGeo.lat);
        const lngDiff = Math.abs(satPos.lng - siloGeo.lng);
        const angularDistance = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);

        // Satellites can be targeted within ~20 degrees of a silo
        const interceptionRangeDegrees = 20;
        if (angularDistance > interceptionRangeDegrees) continue;

        // Check cooldown
        const now = Date.now();
        if (now - silo.lastFireTime < silo.fireCooldown) continue;

        // Interception probability (lower than missiles due to altitude)
        const baseProbability = 0.3;
        const distanceFactor = 1 - angularDistance / interceptionRangeDegrees;
        const probability = baseProbability * distanceFactor;

        if (Math.random() < probability) {
          silo.airDefenseAmmo--;
          silo.lastFireTime = now;

          // Use the satellite simulator to damage/destroy the satellite
          const destroyEvent = this.satelliteSimulator.damageSatellite(
            satellite,
            SATELLITE_CONFIG.HEALTH, // One hit kill for now
            silo.id,
            this.state.tick
          );

          if (destroyEvent) {
            events.push(destroyEvent);
          }

          break;
        }
      }
    }

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
    // Use geo bounds for more accurate checking
    if (territory.geoBounds) {
      const geo = pixelToGeoLocal(point);
      const bounds = territory.geoBounds;
      return (
        geo.lat >= bounds.south &&
        geo.lat <= bounds.north &&
        geo.lng >= bounds.west &&
        geo.lng <= bounds.east
      );
    }

    // Fallback to simple bounding box check with pixel coordinates
    for (const boundary of territory.boundaries) {
      if (boundary.length < 3) continue;
      const minX = Math.min(...boundary.map((p) => p.x));
      const maxX = Math.max(...boundary.map((p) => p.x));
      const minY = Math.min(...boundary.map((p) => p.y));
      const maxY = Math.max(...boundary.map((p) => p.y));

      if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) {
        return true;
      }
    }
    return false;
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
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

    if (this.pendingEvents.length === 0 && !hasMissiles && !hasSatellites) {
      return;
    }

    // Collect missile updates
    const missileUpdates = Object.values(this.state.missiles).filter(
      (m) => !m.detonated && !m.intercepted
    );

    // Collect removed missiles
    const removedMissileIds = Object.values(this.state.missiles)
      .filter((m) => m.detonated || m.intercepted)
      .map((m) => m.id);

    // Remove detonated/intercepted missiles from state
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
    targetId?: string
  ): void {
    // Only allow at DEFCON 1
    if (this.state.defconLevel !== 1) return;

    const silo = this.state.buildings[siloId] as Silo | undefined;
    if (!silo || silo.type !== 'silo' || silo.ownerId !== playerId) return;
    if (silo.destroyed || silo.mode !== 'icbm' || silo.missileCount <= 0) return;

    // Check cooldown
    const now = Date.now();
    if (now - silo.lastFireTime < silo.fireCooldown) return;

    // Create missile
    const missile = this.missileSimulator.launchMissile(
      silo,
      targetPosition,
      playerId,
      targetId
    );

    this.state.missiles[missile.id] = missile;
    silo.missileCount--;
    silo.lastFireTime = now;

    this.pendingEvents.push({
      type: 'missile_launch',
      tick: this.state.tick,
      missileId: missile.id,
      playerId,
      sourcePosition: silo.position,
      targetPosition,
    });
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

    // Mode switch has a cooldown
    const now = Date.now();
    if (now < silo.modeSwitchCooldown) {
      console.log(`[DEBUG] Mode change on cooldown: now=${now}, cooldown=${silo.modeSwitchCooldown}`);
      return;
    }

    silo.mode = mode;
    silo.modeSwitchCooldown = now + 5000; // 5 second cooldown
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
      this.state.tick
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

  handleDebugCommand(command: string, value?: number): void {
    console.log(`[DEBUG] Command: ${command}, value: ${value}`);

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
    }

    // Send immediate full sync after debug command
    this.sendFullSync();
  }
}
