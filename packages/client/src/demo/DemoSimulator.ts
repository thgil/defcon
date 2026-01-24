import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Missile,
  Silo,
  City,
  Building,
  GeoPosition,
  Vector2,
  geoToPixel,
  greatCircleDistance,
  geoInterpolate,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
} from '@defcon/shared';
import { createDemoState, getDemoPlayerIds } from './createDemoState';

// In the demo, USA (demo-player-1) and Europe (demo-player-3) are allies
// Only Russia (demo-player-2) is the enemy of both
const ALLIED_PLAYERS = ['demo-player-1', 'demo-player-3'];

function getDemoEnemyPlayerIds(playerId: string): string[] {
  // If player is in the allied group, their only enemy is Russia
  if (ALLIED_PLAYERS.includes(playerId)) {
    return ['demo-player-2'];
  }
  // Russia's enemies are both USA and Europe
  if (playerId === 'demo-player-2') {
    return ['demo-player-1', 'demo-player-3'];
  }
  return [];
}

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Demo AI behavior configuration
const DEMO_AI_CONFIG = {
  ATTACK_INTERVAL_MIN: 4000,   // Minimum ms between attacks
  ATTACK_INTERVAL_MAX: 8000,   // Maximum ms between attacks
  MISSILES_PER_SALVO: 2,       // How many missiles to launch per attack
  INTERCEPT_RANGE_DEGREES: 10, // Range for interceptors to engage
  INTERCEPT_DELAY: 500,        // Delay before intercepting (ms)
  MISSILE_SPEED: 2 * GLOBAL_MISSILE_SPEED_MULTIPLIER, // Base missile speed
};

export type DemoEventCallback = (state: GameState) => void;

export class DemoSimulator {
  private gameState: GameState;
  private animationFrame: number | null = null;
  private lastTime: number = 0;
  private onStateUpdate: DemoEventCallback;

  // AI attack timing per player
  private lastAttackTime: Map<string, number> = new Map();
  private nextAttackDelay: Map<string, number> = new Map();

  // Missile tracking
  private missileSeeds: Map<string, number> = new Map();

  // Running state
  private running: boolean = false;

  // Game speed control
  private gameSpeed: number = 5; // Start at 5x speed
  private gameTimeElapsed: number = 0; // Simulated game time in ms
  private startTime: number = 0; // Real time when simulation started
  private readonly SPEEDUP_DURATION = 8000; // 8 seconds of fast-forward

  constructor(onStateUpdate: DemoEventCallback) {
    this.onStateUpdate = onStateUpdate;
    this.gameState = createDemoState();
    this.startTime = performance.now();

    // Initialize AI timers for each player
    const playerIds = getDemoPlayerIds(this.gameState);
    playerIds.forEach(id => {
      this.lastAttackTime.set(id, 0);
      this.nextAttackDelay.set(id, this.randomAttackDelay());
    });

    // Set some silos to attack mode
    this.initializeSiloModes();

    // Launch initial missiles so there's action from the start
    this.launchInitialMissiles();
  }

  /**
   * Initialize silos - set half to ICBM mode for attacking
   */
  private initializeSiloModes(): void {
    const playerIds = getDemoPlayerIds(this.gameState);

    playerIds.forEach(playerId => {
      const silos = Object.values(this.gameState.buildings).filter(
        (b): b is Silo => b.type === 'silo' && b.ownerId === playerId
      );

      // Set half the silos to ICBM mode
      const icbmCount = Math.floor(silos.length / 2);
      silos.slice(0, icbmCount).forEach(silo => {
        silo.mode = 'icbm';
      });
    });
  }

  /**
   * Launch initial missiles so there's action from the start
   */
  private launchInitialMissiles(): void {
    const playerIds = getDemoPlayerIds(this.gameState);

    // Each player launches a salvo
    playerIds.forEach(playerId => {
      this.launchAttack(playerId);
    });
  }

  private randomAttackDelay(): number {
    return DEMO_AI_CONFIG.ATTACK_INTERVAL_MIN +
      Math.random() * (DEMO_AI_CONFIG.ATTACK_INTERVAL_MAX - DEMO_AI_CONFIG.ATTACK_INTERVAL_MIN);
  }

  /**
   * Get the current game state
   */
  getState(): GameState {
    return this.gameState;
  }

  /**
   * Start the simulation
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.startTime = performance.now();
    this.gameTimeElapsed = 0;
    this.gameSpeed = 5; // Reset to 5x speed
    this.animate();
  }

  /**
   * Stop the simulation
   */
  stop(): void {
    this.running = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Check if simulation is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Animation loop
   */
  private animate = (): void => {
    if (!this.running) return;

    const now = performance.now();
    const realDeltaMs = now - this.lastTime;
    this.lastTime = now;

    // Update game speed based on elapsed real time
    const realTimeElapsed = now - this.startTime;
    if (realTimeElapsed < this.SPEEDUP_DURATION) {
      // During speedup: start at 5x, gradually slow to 1x
      const speedupProgress = realTimeElapsed / this.SPEEDUP_DURATION;
      this.gameSpeed = 5 - (4 * speedupProgress); // 5x -> 1x
    } else {
      this.gameSpeed = 1;
    }

    // Calculate game time delta (scaled by game speed)
    const gameDeltaMs = realDeltaMs * this.gameSpeed;
    this.gameTimeElapsed += gameDeltaMs;

    this.update(gameDeltaMs, this.gameTimeElapsed);
    this.onStateUpdate(this.gameState);

    this.animationFrame = requestAnimationFrame(this.animate);
  };

  /**
   * Main update tick
   */
  private update(deltaMs: number, gameTime: number): void {
    // Update game timestamp
    this.gameState.timestamp = Date.now();
    this.gameState.tick++;

    // Update missiles with game time
    this.updateMissiles(deltaMs, gameTime);

    // AI attack logic (use game time for AI timing)
    this.updateAIAttacks(gameTime);

    // AI defense logic
    this.updateAIDefense(gameTime);
  }

  /**
   * Update missile positions and check for impacts/interceptions
   */
  private updateMissiles(deltaMs: number, gameTime: number): void {
    const missilesToRemove: string[] = [];

    // First pass: update ICBM positions
    for (const missile of Object.values(this.gameState.missiles)) {
      if (missile.type !== 'icbm') continue;

      // Update progress based on game time elapsed since launch
      // launchTime stores the game time when launched (not real time)
      const elapsed = gameTime - missile.launchTime;
      missile.progress = elapsed / missile.flightDuration;

      // Update current position based on progress
      if (missile.geoLaunchPosition && missile.geoTargetPosition) {
        const t = Math.min(1, missile.progress);
        missile.geoCurrentPosition = this.interpolateGeo(
          missile.geoLaunchPosition,
          missile.geoTargetPosition,
          t
        );
      }

      // Check for impact (ICBM reached target)
      if (missile.progress >= 1 && !missile.intercepted && !missile.detonated) {
        missile.detonated = true;
        this.handleMissileImpact(missile);
        missilesToRemove.push(missile.id);
      }
    }

    // Second pass: update interceptors using pursuit trajectory
    for (const missile of Object.values(this.gameState.missiles)) {
      if (missile.type !== 'interceptor') continue;
      if (missile.detonated || missile.intercepted) continue;

      // Find target ICBM
      const targetIcbm = missile.targetId ? this.gameState.missiles[missile.targetId] : null;

      // If target no longer exists or is already destroyed, remove this interceptor immediately
      if (!targetIcbm || targetIcbm.intercepted || targetIcbm.detonated) {
        console.log(`[DEMO] Orphan cleanup: interceptor ${missile.id.split('-')[1]?.substring(0,8)} - target ${missile.targetId?.split('-')[1]?.substring(0,8) || 'none'} gone`);
        missile.detonated = true;
        missilesToRemove.push(missile.id);
        continue;
      }

      // Update progress based on game time
      const elapsed = gameTime - missile.launchTime;
      missile.progress = elapsed / missile.flightDuration;

      // Initialize current position if not set
      if (!missile.geoCurrentPosition && missile.geoLaunchPosition) {
        missile.geoCurrentPosition = { ...missile.geoLaunchPosition };
      }

      // For interceptors: use progress-based interpolation (renderer handles pursuit display)
      if (missile.geoLaunchPosition && missile.geoTargetPosition) {
        const t = Math.min(1, missile.progress);
        missile.geoCurrentPosition = this.interpolateGeo(
          missile.geoLaunchPosition,
          missile.geoTargetPosition,
          t
        );
      }

      // Check for interception by comparing to target ICBM position
      if (targetIcbm && targetIcbm.geoCurrentPosition && missile.geoCurrentPosition && !targetIcbm.intercepted && !targetIcbm.detonated) {
        const distToTarget = greatCircleDistance(missile.geoCurrentPosition, targetIcbm.geoCurrentPosition);
        if (distToTarget < 2 && missile.progress > 0.2) {
          targetIcbm.intercepted = true;
          missile.detonated = true;
          missilesToRemove.push(targetIcbm.id, missile.id);
        }
      }

      // Check for interceptor expiration (flew too long without hitting anything)
      // Use time-based check since progress is clamped to 1.0
      const flightTime = gameTime - missile.launchTime;
      if (flightTime > missile.flightDuration * 1.5 && !missile.detonated) {
        missile.detonated = true;
        missilesToRemove.push(missile.id);
      }
    }

    // Remove processed missiles
    missilesToRemove.forEach(id => {
      delete this.gameState.missiles[id];
      this.missileSeeds.delete(id);
    });
  }

  /**
   * Handle missile impact - damage nearby cities
   */
  private handleMissileImpact(missile: Missile): void {
    if (!missile.geoTargetPosition) return;

    const impactRadius = 1.5; // degrees (~167km, more reasonable for nuclear blast)
    for (const city of Object.values(this.gameState.cities)) {
      if (city.destroyed || !city.geoPosition) continue;

      const dist = greatCircleDistance(missile.geoTargetPosition, city.geoPosition);
      if (dist < impactRadius) {
        // Damage proportional to distance
        const damageFactor = 1 - (dist / impactRadius);
        const casualties = Math.floor(city.population * damageFactor * 0.5);
        city.population -= casualties;

        if (city.population <= 0) {
          city.population = 0;
          city.destroyed = true;
        }

        // Update player score/population
        const territory = this.gameState.territories[city.territoryId];
        if (territory?.ownerId) {
          const player = this.gameState.players[territory.ownerId];
          if (player) {
            player.populationLost += casualties;
            player.populationRemaining -= casualties;
          }

          // Award kills to attacker
          if (missile.ownerId !== territory.ownerId) {
            const attacker = this.gameState.players[missile.ownerId];
            if (attacker) {
              attacker.enemyKills += casualties;
              attacker.score += Math.floor(casualties / 100000);
            }
          }
        }
      }
    }
  }

  /**
   * AI attack logic - launch missiles at enemy cities
   */
  private updateAIAttacks(now: number): void {
    const playerIds = getDemoPlayerIds(this.gameState);

    playerIds.forEach(playerId => {
      const lastAttack = this.lastAttackTime.get(playerId) || 0;
      let nextDelay = this.nextAttackDelay.get(playerId);
      if (nextDelay === undefined) {
        nextDelay = this.randomAttackDelay();
        this.nextAttackDelay.set(playerId, nextDelay);
      }

      if (now - lastAttack >= nextDelay) {
        this.launchAttack(playerId);
        this.lastAttackTime.set(playerId, now);
        this.nextAttackDelay.set(playerId, this.randomAttackDelay());
      }
    });
  }

  /**
   * Launch missiles at enemy cities
   */
  private launchAttack(playerId: string): void {
    const enemyIds = getDemoEnemyPlayerIds(playerId);
    if (enemyIds.length === 0) return;

    // Pick a random enemy to attack
    const enemyId = enemyIds[Math.floor(Math.random() * enemyIds.length)];

    // Get available silos in ICBM mode
    const silos = Object.values(this.gameState.buildings).filter(
      (b): b is Silo =>
        b.type === 'silo' &&
        b.ownerId === playerId &&
        !b.destroyed &&
        b.mode === 'icbm' &&
        b.missileCount > 0
    );

    if (silos.length === 0) return;

    // Get enemy cities sorted by population (prioritize bigger cities)
    const enemyTerritoryId = this.gameState.players[enemyId]?.territoryId;
    const enemyCities = Object.values(this.gameState.cities)
      .filter(c => !c.destroyed && c.territoryId === enemyTerritoryId)
      .sort((a, b) => b.population - a.population);

    if (enemyCities.length === 0) return;

    // Launch missiles
    const missilesToLaunch = Math.min(
      DEMO_AI_CONFIG.MISSILES_PER_SALVO,
      silos.length,
      enemyCities.length
    );

    for (let i = 0; i < missilesToLaunch; i++) {
      const silo = silos[i % silos.length];
      const targetCity = this.pickWeightedTarget(enemyCities);

      if (silo.geoPosition && targetCity.geoPosition) {
        this.launchMissile(silo, targetCity.geoPosition, playerId);
      }
    }
  }

  /**
   * Pick a random target weighted by population
   */
  private pickWeightedTarget(cities: City[]): City {
    const totalPop = cities.reduce((sum, c) => sum + c.population, 0);
    if (totalPop <= 0) return cities[0];

    const rand = Math.random() * totalPop;
    let cumulative = 0;
    for (const city of cities) {
      cumulative += city.population;
      if (rand <= cumulative) return city;
    }
    return cities[cities.length - 1];
  }

  /**
   * Launch a missile from a silo
   */
  private launchMissile(silo: Silo, targetGeo: GeoPosition, ownerId: string): void {
    if (!silo.geoPosition) return;

    const missileId = `missile-${uuidv4()}`;

    // Calculate flight duration based on distance (matching real game calculation)
    const angularDistance = greatCircleDistance(silo.geoPosition, targetGeo);
    const distance = angularDistance * 100; // Scale to reasonable units (matches MissileSimulator)
    // Minimum 8 seconds ensures missiles are visible, matches real game
    const flightDuration = Math.max(8000, (distance / DEMO_AI_CONFIG.MISSILE_SPEED) * 1000);

    const missile: Missile = {
      id: missileId,
      type: 'icbm',
      ownerId,
      sourceId: silo.id,
      launchPosition: silo.position,
      targetPosition: geoToPixel(targetGeo, MAP_WIDTH, MAP_HEIGHT),
      currentPosition: silo.position,
      launchTime: this.gameTimeElapsed, // Use game time, not real time
      flightDuration,
      progress: 0,
      apexHeight: Math.min(distance * 0.2, 60), // Matches real game formula
      intercepted: false,
      detonated: false,
      geoLaunchPosition: silo.geoPosition,
      geoTargetPosition: targetGeo,
      geoCurrentPosition: silo.geoPosition,
    };

    this.gameState.missiles[missileId] = missile;
    this.missileSeeds.set(missileId, Math.random() * 10000);

    console.log(`[DEMO] Launched ICBM ${missileId.split('-')[1]?.substring(0,8)}, dist=${angularDistance.toFixed(1)}°, flight=${(flightDuration/1000).toFixed(1)}s`);

    // Decrement silo ammo
    silo.missileCount--;
    silo.lastFireTime = this.gameTimeElapsed;
  }

  /**
   * AI defense logic - launch interceptors at incoming missiles
   */
  private updateAIDefense(now: number): void {
    // Disabled for now - interceptors causing issues
    return;

    const playerIds = getDemoPlayerIds(this.gameState);

    playerIds.forEach(playerId => {
      // Find incoming missiles from actual enemies targeting this player's territory
      const playerTerritoryId = this.gameState.players[playerId]?.territoryId;
      if (!playerTerritoryId) return;

      // Determine who this player considers enemies
      // USA (demo-player-1) and Europe (demo-player-3) are allies - only enemy is Russia
      // Russia (demo-player-2) - enemies are USA and Europe
      const isRussia = playerId === 'demo-player-2';

      const incomingMissiles = Object.values(this.gameState.missiles).filter(
        (m): m is Missile => {
          if (m.type !== 'icbm') return false;
          if (m.ownerId === playerId) return false; // Never intercept own missiles

          // Check if missile owner is an enemy
          if (isRussia) {
            // Russia's enemies: USA and Europe
            if (m.ownerId !== 'demo-player-1' && m.ownerId !== 'demo-player-3') return false;
          } else {
            // USA/Europe's only enemy: Russia
            if (m.ownerId !== 'demo-player-2') return false;
          }

          if (m.intercepted || m.detonated) return false;
          if (m.progress >= 0.7 || m.progress <= 0.1) return false; // Can only intercept mid-flight
          return this.isMissileTargetingTerritory(m, playerTerritoryId);
        }
      );

      // Get available defense silos
      const defenseSilos = Object.values(this.gameState.buildings).filter(
        (b): b is Silo =>
          b.type === 'silo' &&
          b.ownerId === playerId &&
          !b.destroyed &&
          b.mode === 'air_defense' &&
          b.airDefenseAmmo > 0 &&
          (this.gameTimeElapsed - b.lastFireTime) > 2000 // Cooldown between shots (game time)
      );


      // Check if missiles already have interceptors assigned
      const targetedMissiles = new Set(
        Object.values(this.gameState.missiles)
          .filter(m => m.type === 'interceptor')
          .map(m => (m as Missile).targetId)
          .filter(Boolean)
      );

      // Launch interceptors at untargeted missiles
      for (const icbm of incomingMissiles) {
        if (targetedMissiles.has(icbm.id)) continue;
        if (defenseSilos.length === 0) break;

        // Find closest defense silo to intercept point
        const predictedInterceptGeo = this.predictInterceptPoint(icbm);
        if (!predictedInterceptGeo) continue;

        let closestSilo: Silo | null = null;
        let closestDist = Infinity;

        for (const silo of defenseSilos) {
          if (!silo.geoPosition) continue;
          const dist = greatCircleDistance(silo.geoPosition, predictedInterceptGeo);
          if (dist < closestDist && dist < DEMO_AI_CONFIG.INTERCEPT_RANGE_DEGREES) {
            closestDist = dist;
            closestSilo = silo;
          }
        }

        if (closestSilo) {
          this.launchInterceptor(closestSilo, icbm, playerId);
          // Remove silo from available list
          const idx = defenseSilos.indexOf(closestSilo);
          if (idx > -1) defenseSilos.splice(idx, 1);
        }
      }
    });
  }

  /**
   * Predict where to intercept a missile
   */
  private predictInterceptPoint(icbm: Missile): GeoPosition | null {
    if (!icbm.geoLaunchPosition || !icbm.geoTargetPosition) return null;

    // Intercept at ~50% of remaining flight
    const interceptProgress = icbm.progress + (1 - icbm.progress) * 0.5;
    return this.interpolateGeo(icbm.geoLaunchPosition, icbm.geoTargetPosition, interceptProgress);
  }

  /**
   * Launch an interceptor missile
   */
  private launchInterceptor(silo: Silo, targetMissile: Missile, ownerId: string): void {
    // Verify target still exists and is valid before launching
    const currentTarget = this.gameState.missiles[targetMissile.id];
    if (!currentTarget || currentTarget.intercepted || currentTarget.detonated) {
      console.log(`[DEMO] Rejected launch - target ${targetMissile.id.split('-')[1]?.substring(0,8)} invalid: exists=${!!currentTarget}, intercepted=${currentTarget?.intercepted}, detonated=${currentTarget?.detonated}`);
      return; // Target no longer valid, don't launch
    }

    if (!silo.geoPosition || !targetMissile.geoTargetPosition) return;

    const interceptorId = `interceptor-${uuidv4()}`;

    // Interceptor targets the intercept point
    const interceptGeo = this.predictInterceptPoint(targetMissile);
    if (!interceptGeo) return;

    // Calculate flight duration (interceptors are faster, matching real game scaling)
    const angularDistance = greatCircleDistance(silo.geoPosition, interceptGeo);
    const distance = angularDistance * 100; // Scale to match real game
    // Interceptors are 1.5x faster, minimum 5 seconds
    const flightDuration = Math.max(5000, (distance / (DEMO_AI_CONFIG.MISSILE_SPEED * 1.5)) * 1000);

    const interceptor: Missile = {
      id: interceptorId,
      type: 'interceptor',
      ownerId,
      sourceId: silo.id,
      targetId: targetMissile.id,
      launchPosition: silo.position,
      targetPosition: geoToPixel(interceptGeo, MAP_WIDTH, MAP_HEIGHT),
      currentPosition: silo.position,
      launchTime: this.gameTimeElapsed, // Use game time, not real time
      flightDuration,
      progress: 0,
      apexHeight: Math.min(distance * 0.15, 40), // Lower arc than ICBMs
      intercepted: false,
      detonated: false,
      geoLaunchPosition: silo.geoPosition,
      geoTargetPosition: interceptGeo,
      geoCurrentPosition: silo.geoPosition,
    };

    this.gameState.missiles[interceptorId] = interceptor;
    this.missileSeeds.set(interceptorId, Math.random() * 10000);

    console.log(`[DEMO] Launched interceptor at ICBM ${targetMissile.id.split('-')[1]?.substring(0,8)}, progress=${targetMissile.progress.toFixed(2)}, dist=${angularDistance.toFixed(1)}°, flight=${(flightDuration/1000).toFixed(1)}s`);

    // Decrement silo ammo
    silo.airDefenseAmmo--;
    silo.lastFireTime = this.gameTimeElapsed;
  }

  /**
   * Check if a missile is targeting a specific territory
   */
  private isMissileTargetingTerritory(missile: Missile, territoryId: string): boolean {
    if (!missile.geoTargetPosition) return false;

    // Check if the target position is near any city in the territory
    const territoryCities = Object.values(this.gameState.cities).filter(
      c => c.territoryId === territoryId && c.geoPosition
    );

    for (const city of territoryCities) {
      if (!city.geoPosition) continue;
      const dist = greatCircleDistance(missile.geoTargetPosition, city.geoPosition);
      if (dist < 5) { // Within 5 degrees of a city in the territory
        return true;
      }
    }

    return false;
  }

  /**
   * Interpolate between two geo positions using great-circle path
   */
  private interpolateGeo(start: GeoPosition, end: GeoPosition, t: number): GeoPosition {
    return geoInterpolate(start, end, Math.max(0, Math.min(1, t)));
  }

  /**
   * Trigger a missile salvo for scroll demo
   */
  triggerMissileSalvo(): void {
    const playerIds = getDemoPlayerIds(this.gameState);
    playerIds.forEach(playerId => {
      this.launchAttack(playerId);
    });
  }

  /**
   * Reset the simulation with fresh state
   */
  reset(): void {
    this.gameState = createDemoState();
    this.initializeSiloModes();

    const playerIds = getDemoPlayerIds(this.gameState);
    playerIds.forEach(id => {
      this.lastAttackTime.set(id, 0);
      this.nextAttackDelay.set(id, this.randomAttackDelay());
    });

    this.missileSeeds.clear();

    // Reset game time
    this.gameTimeElapsed = 0;
    this.startTime = performance.now();
    this.gameSpeed = 5;

    // Launch initial missiles
    this.launchInitialMissiles();
  }
}
