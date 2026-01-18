import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Player,
  Building,
  Silo,
  City,
  Vector2,
  GeoPosition,
  PlayerColor,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  geoToPixel,
  pixelToGeo,
} from '@defcon/shared';

// Map dimensions for converting geo to pixel (must match GameRoom)
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// AI behavior configuration
const AI_CONFIG = {
  SILO_COUNT: 6,
  RADAR_COUNT: 3,
  ATTACK_INTERVAL_MIN: 3000,  // Minimum ms between attacks
  ATTACK_INTERVAL_MAX: 6000,  // Maximum ms between attacks
  MISSILES_PER_SALVO: 2,      // How many missiles to launch per attack
};

const PLAYER_COLORS: PlayerColor[] = ['green', 'red', 'blue', 'yellow', 'cyan', 'magenta'];

export interface AIAction {
  type: 'place_building' | 'launch_missile' | 'set_silo_mode';
  buildingType?: 'silo' | 'radar';
  position?: Vector2;
  geoPosition?: GeoPosition;
  siloId?: string;
  targetPosition?: Vector2;
  mode?: 'air_defense' | 'icbm';
}

export class AIPlayer {
  readonly id: string;
  readonly name: string;
  readonly territoryId: string;

  private buildingsPlaced = false;
  private lastAttackTime = 0;
  private nextAttackDelay: number;
  private silosSetToAttack = false;

  constructor(territoryId: string) {
    this.id = `ai-${uuidv4()}`;
    this.name = `AI [${this.getTerritoryName(territoryId)}]`;
    this.territoryId = territoryId;
    this.nextAttackDelay = this.randomAttackDelay();
  }

  private getTerritoryName(territoryId: string): string {
    const data = TERRITORY_GEO_DATA[territoryId];
    return data?.name || territoryId;
  }

  private randomAttackDelay(): number {
    return AI_CONFIG.ATTACK_INTERVAL_MIN +
      Math.random() * (AI_CONFIG.ATTACK_INTERVAL_MAX - AI_CONFIG.ATTACK_INTERVAL_MIN);
  }

  /**
   * Create the Player object for this AI
   */
  createPlayer(colorIndex: number): Player {
    return {
      id: this.id,
      name: this.name,
      color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
      connected: true,
      ready: true,
      territoryId: this.territoryId,
      score: 0,
      populationRemaining: 0,
      populationLost: 0,
      enemyKills: 0,
      isAI: true,
    };
  }

  /**
   * Get initial population for this AI's territory
   */
  getInitialPopulation(): number {
    const cities = CITY_GEO_DATA[this.territoryId];
    if (!cities) return 0;
    return cities.reduce((sum, city) => sum + city.population, 0);
  }

  /**
   * Generate building placements for this AI
   * Called once when AI is enabled during DEFCON 5
   */
  placeBuildings(): AIAction[] {
    if (this.buildingsPlaced) return [];

    const actions: AIAction[] = [];
    const territory = TERRITORY_GEO_DATA[this.territoryId];
    if (!territory) return actions;

    // Generate positions within territory bounds
    const bounds = territory.bounds;
    const positions = this.generateSpreadPositions(
      bounds,
      AI_CONFIG.SILO_COUNT + AI_CONFIG.RADAR_COUNT
    );

    // Place silos
    for (let i = 0; i < AI_CONFIG.SILO_COUNT && i < positions.length; i++) {
      const geo = positions[i];
      actions.push({
        type: 'place_building',
        buildingType: 'silo',
        geoPosition: geo,
        position: geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT),
      });
    }

    // Place radars
    for (let i = 0; i < AI_CONFIG.RADAR_COUNT && i + AI_CONFIG.SILO_COUNT < positions.length; i++) {
      const geo = positions[i + AI_CONFIG.SILO_COUNT];
      actions.push({
        type: 'place_building',
        buildingType: 'radar',
        geoPosition: geo,
        position: geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT),
      });
    }

    this.buildingsPlaced = true;
    return actions;
  }

  /**
   * Generate evenly spread positions within territory bounds
   */
  private generateSpreadPositions(
    bounds: { north: number; south: number; east: number; west: number },
    count: number
  ): GeoPosition[] {
    const positions: GeoPosition[] = [];
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;

    // Use a grid-based approach with some randomization
    const gridSize = Math.ceil(Math.sqrt(count));
    const latStep = latRange / (gridSize + 1);
    const lngStep = lngRange / (gridSize + 1);

    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / gridSize);
      const col = i % gridSize;

      // Base position on grid
      const baseLat = bounds.south + (row + 1) * latStep;
      const baseLng = bounds.west + (col + 1) * lngStep;

      // Add some randomization (up to 30% of step size)
      const jitterLat = (Math.random() - 0.5) * latStep * 0.6;
      const jitterLng = (Math.random() - 0.5) * lngStep * 0.6;

      positions.push({
        lat: Math.max(bounds.south + 2, Math.min(bounds.north - 2, baseLat + jitterLat)),
        lng: Math.max(bounds.west + 2, Math.min(bounds.east - 2, baseLng + jitterLng)),
      });
    }

    return positions;
  }

  /**
   * Main update tick - called every game tick
   * Returns actions the AI wants to take
   */
  update(state: GameState, now: number): AIAction[] {
    const actions: AIAction[] = [];

    // During DEFCON 5: place buildings if not done
    if (state.defconLevel === 5 && !this.buildingsPlaced) {
      return this.placeBuildings();
    }

    // During DEFCON 1: attack!
    if (state.defconLevel === 1) {
      // First, switch all silos to attack mode
      if (!this.silosSetToAttack) {
        const siloActions = this.switchSilosToAttack(state);
        actions.push(...siloActions);
        this.silosSetToAttack = true;
        return actions;
      }

      // Check if it's time to attack
      if (now - this.lastAttackTime >= this.nextAttackDelay) {
        const attackActions = this.selectTargetsAndAttack(state);
        actions.push(...attackActions);
        this.lastAttackTime = now;
        this.nextAttackDelay = this.randomAttackDelay();
      }
    }

    return actions;
  }

  /**
   * Switch all AI silos to ICBM mode
   */
  private switchSilosToAttack(state: GameState): AIAction[] {
    const actions: AIAction[] = [];

    for (const building of Object.values(state.buildings)) {
      if (building.ownerId !== this.id) continue;
      if (building.type !== 'silo') continue;

      const silo = building as Silo;
      if (silo.mode !== 'icbm') {
        actions.push({
          type: 'set_silo_mode',
          siloId: silo.id,
          mode: 'icbm',
        });
      }
    }

    return actions;
  }

  /**
   * Select enemy targets and launch missiles
   */
  private selectTargetsAndAttack(state: GameState): AIAction[] {
    const actions: AIAction[] = [];

    // Get AI silos that can fire
    const availableSilos = Object.values(state.buildings).filter(
      (b): b is Silo =>
        b.type === 'silo' &&
        b.ownerId === this.id &&
        !b.destroyed &&
        (b as Silo).mode === 'icbm' &&
        (b as Silo).missileCount > 0
    );

    if (availableSilos.length === 0) return actions;

    // Get enemy cities, prioritized by population
    const enemyCities: Array<{ city: City; position: Vector2 }> = [];

    for (const city of Object.values(state.cities)) {
      if (city.destroyed) continue;

      // Find city's owner
      const territory = state.territories[city.territoryId];
      if (!territory?.ownerId) continue;

      // Skip our own cities
      if (territory.ownerId === this.id) continue;

      // Skip cities of other AI players (if any)
      const owner = state.players[territory.ownerId];
      if (owner?.isAI) continue;

      enemyCities.push({
        city,
        position: city.position,
      });
    }

    if (enemyCities.length === 0) return actions;

    // Weight cities by population for random selection (bigger cities = more likely targets)
    const totalPopulation = enemyCities.reduce((sum, ec) => sum + ec.city.population, 0);

    // Helper to pick a random weighted target
    const pickRandomTarget = (): { city: City; position: Vector2 } => {
      // If no population (all cities have 0), fall back to uniform random selection
      if (totalPopulation <= 0) {
        return enemyCities[Math.floor(Math.random() * enemyCities.length)];
      }

      const rand = Math.random() * totalPopulation;
      let cumulative = 0;
      for (const target of enemyCities) {
        cumulative += target.city.population;
        if (rand <= cumulative) {
          return target;
        }
      }
      // Fallback to last city (for floating point edge cases)
      return enemyCities[enemyCities.length - 1];
    };

    // Launch missiles - each silo picks its own random target
    const missilesToLaunch = Math.min(AI_CONFIG.MISSILES_PER_SALVO, availableSilos.length, enemyCities.length);

    for (let i = 0; i < missilesToLaunch; i++) {
      const silo = availableSilos[i % availableSilos.length];
      const target = pickRandomTarget();

      actions.push({
        type: 'launch_missile',
        siloId: silo.id,
        targetPosition: target.position,
      });
    }

    return actions;
  }

  /**
   * Reset AI state (called when AI is disabled and re-enabled)
   */
  reset(): void {
    this.buildingsPlaced = false;
    this.lastAttackTime = 0;
    this.silosSetToAttack = false;
    this.nextAttackDelay = this.randomAttackDelay();
  }
}
