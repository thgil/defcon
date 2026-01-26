import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Player,
  Building,
  Silo,
  Radar,
  City,
  Territory,
  Satellite,
  PlayerColor,
  DEFAULT_GAME_CONFIG,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  geoToPixel,
  pointInPolygon,
  type GeoPosition,
  type Vector2,
} from '@defcon/shared';

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Demo configuration
const DEMO_CONFIG = {
  SILO_COUNT: 6,
  RADAR_COUNT: 3,
};

const PLAYER_COLORS: PlayerColor[] = ['green', 'red', 'blue'];

interface DemoPlayer {
  id: string;
  name: string;
  territoryId: string;
  color: PlayerColor;
}

/**
 * Generate evenly spread positions within territory bounds, ensuring they're on land
 */
function generateSpreadPositions(
  bounds: { north: number; south: number; east: number; west: number },
  count: number,
  boundaryCoords?: GeoPosition[]
): GeoPosition[] {
  const positions: GeoPosition[] = [];
  const latRange = bounds.north - bounds.south;
  const lngRange = bounds.east - bounds.west;

  // Use a grid-based approach with some randomization
  // Generate more candidates than needed to account for ocean filtering
  const gridSize = Math.ceil(Math.sqrt(count * 3)); // 3x oversampling
  const latStep = latRange / (gridSize + 1);
  const lngStep = lngRange / (gridSize + 1);

  const candidates: GeoPosition[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // Base position on grid
      const baseLat = bounds.south + (row + 1) * latStep;
      const baseLng = bounds.west + (col + 1) * lngStep;

      // Add some randomization (up to 30% of step size)
      const jitterLat = (Math.random() - 0.5) * latStep * 0.6;
      const jitterLng = (Math.random() - 0.5) * lngStep * 0.6;

      const pos: GeoPosition = {
        lat: Math.max(bounds.south + 2, Math.min(bounds.north - 2, baseLat + jitterLat)),
        lng: Math.max(bounds.west + 2, Math.min(bounds.east - 2, baseLng + jitterLng)),
      };

      // Only include if inside the territory boundary (on land)
      if (boundaryCoords && pointInPolygon(pos, boundaryCoords)) {
        candidates.push(pos);
      } else if (!boundaryCoords) {
        // No boundary check available, include all
        candidates.push(pos);
      }
    }
  }

  // Shuffle candidates and take the first 'count' positions
  // This ensures spread even after filtering
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return candidates.slice(0, count);
}

/**
 * Create buildings for a player in their territory
 */
function createBuildingsForPlayer(
  playerId: string,
  territoryId: string
): Record<string, Building> {
  const buildings: Record<string, Building> = {};
  const territory = TERRITORY_GEO_DATA[territoryId];
  if (!territory) return buildings;

  const bounds = territory.bounds;
  const positions = generateSpreadPositions(
    bounds,
    DEMO_CONFIG.SILO_COUNT + DEMO_CONFIG.RADAR_COUNT,
    territory.boundaryCoords // Pass boundary for land validation
  );

  // Create silos
  for (let i = 0; i < DEMO_CONFIG.SILO_COUNT && i < positions.length; i++) {
    const geo = positions[i];
    const id = `silo-${playerId}-${i}`;
    const silo: Silo = {
      id,
      type: 'silo',
      territoryId,
      ownerId: playerId,
      position: geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT),
      health: 100,
      destroyed: false,
      geoPosition: geo,
      mode: 'air_defense', // Start in defense mode
      modeSwitchCooldown: 0,
      missileCount: 10,
      airDefenseAmmo: 20,
      lastFireTime: 0,
      fireCooldown: 0,
    };
    buildings[id] = silo;
  }

  // Create radars
  for (let i = 0; i < DEMO_CONFIG.RADAR_COUNT && i + DEMO_CONFIG.SILO_COUNT < positions.length; i++) {
    const geo = positions[i + DEMO_CONFIG.SILO_COUNT];
    const id = `radar-${playerId}-${i}`;
    const radar: Radar = {
      id,
      type: 'radar',
      territoryId,
      ownerId: playerId,
      position: geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT),
      health: 100,
      destroyed: false,
      geoPosition: geo,
      range: 300,
      active: true,
    };
    buildings[id] = radar;
  }

  return buildings;
}

/**
 * Create cities for a territory
 */
function createCitiesForTerritory(territoryId: string): Record<string, City> {
  const cities: Record<string, City> = {};
  const cityData = CITY_GEO_DATA[territoryId];
  if (!cityData) return cities;

  cityData.forEach((data, index) => {
    const id = `city-${territoryId}-${index}`;
    cities[id] = {
      id,
      territoryId,
      name: data.name,
      position: geoToPixel(data.position, MAP_WIDTH, MAP_HEIGHT),
      population: data.population,
      maxPopulation: data.population,
      destroyed: false,
      geoPosition: data.position,
    };
  });

  return cities;
}

/**
 * Create a territory from geo data
 */
function createTerritory(
  territoryId: string,
  ownerId: string | null
): Territory {
  const geoData = TERRITORY_GEO_DATA[territoryId];
  return {
    id: territoryId,
    name: geoData?.name || territoryId,
    ownerId,
    boundaries: [],
    centroid: geoToPixel(geoData?.centroid || { lat: 0, lng: 0 }, MAP_WIDTH, MAP_HEIGHT),
    cities: [],
    buildings: [],
    geoCentroid: geoData?.centroid,
    geoBounds: geoData?.bounds,
    geoBoundary: geoData?.boundaryCoords,
  };
}

/**
 * Create the initial demo game state with three AI players
 */
export function createDemoState(): GameState {
  // Define the three demo players
  const demoPlayers: DemoPlayer[] = [
    {
      id: 'demo-player-1',
      name: 'UNITED STATES',
      territoryId: 'north_america',
      color: 'green',
    },
    {
      id: 'demo-player-2',
      name: 'RUSSIA',
      territoryId: 'russia',
      color: 'red',
    },
    {
      id: 'demo-player-3',
      name: 'EUROPE',
      territoryId: 'europe',
      color: 'blue',
    },
  ];

  // Create player records
  const players: Record<string, Player> = {};
  demoPlayers.forEach((dp, index) => {
    const cities = CITY_GEO_DATA[dp.territoryId] || [];
    const population = cities.reduce((sum, c) => sum + c.population, 0);

    players[dp.id] = {
      id: dp.id,
      name: dp.name,
      color: dp.color,
      connected: true,
      ready: true,
      territoryId: dp.territoryId,
      score: 0,
      populationRemaining: population,
      populationLost: 0,
      enemyKills: 0,
      isAI: true,
    };
  });

  // Create territories
  const territories: Record<string, Territory> = {};
  demoPlayers.forEach((dp) => {
    territories[dp.territoryId] = createTerritory(dp.territoryId, dp.id);
  });

  // Create cities for each territory
  let cities: Record<string, City> = {};
  demoPlayers.forEach((dp) => {
    const territoryCities = createCitiesForTerritory(dp.territoryId);
    cities = { ...cities, ...territoryCities };

    // Update territory city references
    territories[dp.territoryId].cities = Object.keys(territoryCities);
  });

  // Create buildings for each player
  let buildings: Record<string, Building> = {};
  demoPlayers.forEach((dp) => {
    const playerBuildings = createBuildingsForPlayer(dp.id, dp.territoryId);
    buildings = { ...buildings, ...playerBuildings };

    // Update territory building references
    territories[dp.territoryId].buildings = Object.keys(playerBuildings);
  });

  // Create demo satellites
  const satellites: Record<string, Satellite> = {};

  // US spy satellite in polar orbit
  const usSatellite: Satellite = {
    id: 'demo-satellite-us-1',
    ownerId: 'demo-player-1',
    launchFacilityId: 'demo-facility',
    launchTime: Date.now() - 60000, // Launched 1 minute ago
    orbitalPeriod: 90000, // 90 second orbit (fast for demo)
    orbitalAltitude: 50, // Globe units above surface
    inclination: 65, // High inclination for good coverage
    startingLongitude: -100, // Start over North America
    progress: 0.1, // Already in orbit
    destroyed: false,
    health: 100,
  };
  satellites[usSatellite.id] = usSatellite;

  // Create the game state
  const gameState: GameState = {
    id: 'demo-game',
    config: {
      ...DEFAULT_GAME_CONFIG,
      // Shorter durations for demo
      defconTimings: {
        defcon5Duration: 10000,
        defcon4Duration: 10000,
        defcon3Duration: 10000,
        defcon2Duration: 10000,
        defcon1Duration: 600000,
      },
    },
    phase: 'active',
    defconLevel: 1, // Start at DEFCON 1 for immediate action
    defconTimer: 0,
    tick: 0,
    timestamp: Date.now(),
    gameSpeed: 1,
    players,
    territories,
    cities,
    buildings,
    missiles: {},
    satellites,
    aircraft: {},
    falloutClouds: {},
  };

  return gameState;
}

/**
 * Get player IDs from demo state
 */
export function getDemoPlayerIds(state: GameState): string[] {
  return Object.keys(state.players);
}

/**
 * Get enemy player ID for a given player (returns first enemy for backwards compatibility)
 */
export function getEnemyPlayerId(state: GameState, playerId: string): string | null {
  const playerIds = getDemoPlayerIds(state);
  const enemy = playerIds.find(id => id !== playerId);
  return enemy || null;
}

/**
 * Get all enemy player IDs for a given player
 */
export function getEnemyPlayerIds(state: GameState, playerId: string): string[] {
  const playerIds = getDemoPlayerIds(state);
  return playerIds.filter(id => id !== playerId);
}
