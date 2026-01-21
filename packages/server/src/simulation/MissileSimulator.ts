import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Missile,
  PhysicsMissile,
  Silo,
  Vector2,
  GameEvent,
  GeoPosition,
  MissileImpactEvent,
  CityHitEvent,
  BuildingDestroyedEvent,
  InterceptionEvent,
  pixelToGeo,
  geoInterpolate,
  greatCircleDistance,
  isPhysicsMissile,
  isRailInterceptor,
  geoToCartesian,
  vec3Normalize,
  Vector3,
} from '@defcon/shared';

// Map dimensions for converting pixel to geo coordinates
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Globe radius (must match client)
const GLOBE_RADIUS = 100;

// Interceptor speed multiplier (faster than ICBMs, but not too fast)
const INTERCEPTOR_SPEED_MULTIPLIER = 1.25;
// Base probability of interceptor hitting its target
const INTERCEPTOR_HIT_PROBABILITY = 0.7;
// Interceptor boost phase duration (25% of flight for higher climb)
const INTERCEPTOR_BOOST_DURATION = 0.25;
// How much longer a missed interceptor continues flying (50% extra)
const INTERCEPTOR_MISS_EXTENSION = 1.5;

export class MissileSimulator {
  private missileSpeed: number;

  constructor(missileSpeed: number) {
    this.missileSpeed = missileSpeed;
  }

  /**
   * Launch a physics-based interceptor missile to intercept a target missile.
   * Uses real physics simulation with velocity, thrust, and guidance.
   *
   * Flight phases:
   * - Boost (0-2s): Vertical launch, full thrust upward
   * - Pitch (2-3.5s): Smooth tilt-over toward target
   * - Cruise: Fly toward predicted intercept point
   * - Terminal: Final aggressive guidance near intercept
   * - Coast: No fuel - ballistic trajectory (no steering)
   */
  launchInterceptor(
    silo: Silo,
    targetMissile: Missile,
    ownerId: string,
    detectingRadarId?: string
  ): PhysicsMissile {
    const launchPosition = { ...silo.position };
    const geoLaunchPosition = silo.geoPosition || pixelToGeo(launchPosition, MAP_WIDTH, MAP_HEIGHT);

    // Get launch position in 3D (on globe surface)
    const launchPos3D = geoToCartesian(geoLaunchPosition, 0, GLOBE_RADIUS);

    // Up vector at launch point (for initial heading)
    const up = vec3Normalize(launchPos3D);

    // Estimate flight duration for legacy compatibility
    const targetGeo = targetMissile.geoCurrentPosition || targetMissile.geoLaunchPosition || geoLaunchPosition;
    const angularDistance = greatCircleDistance(geoLaunchPosition, targetGeo);
    const distance = angularDistance * 100;
    const flightDuration = Math.max(6000, (distance / (this.missileSpeed * INTERCEPTOR_SPEED_MULTIPLIER)) * 1000);

    return {
      id: uuidv4(),
      type: 'interceptor',
      ownerId,
      sourceId: silo.id,

      // Physics state - start at silo position, zero velocity, pointing up
      position: { ...launchPos3D },
      velocity: { x: 0, y: 0, z: 0 },
      heading: { ...up },

      // Full fuel tank (8 seconds of burn time)
      fuel: 8,
      maxFuel: 8,
      thrust: 0, // Will be set by physics engine

      // Initial phase
      phase: 'boost',
      targetId: targetMissile.id,

      // Status
      launchTime: Date.now(),
      intercepted: false,
      detonated: false,
      engineFlameout: false,

      // Rendering compatibility
      geoCurrentPosition: { ...geoLaunchPosition },

      // Legacy compatibility fields
      launchPosition,
      targetPosition: { ...targetMissile.currentPosition },
      currentPosition: { ...launchPosition },
      progress: 0,
      flightDuration,
      geoLaunchPosition,
      geoTargetPosition: targetGeo,
    };
  }

  launchMissile(
    silo: Silo,
    targetPosition: Vector2,
    ownerId: string,
    targetId?: string
  ): Missile {
    const launchPosition = { ...silo.position };

    // Calculate geo positions first (needed for distance calc)
    const geoLaunchPosition = silo.geoPosition || pixelToGeo(launchPosition, MAP_WIDTH, MAP_HEIGHT);
    const geoTargetPosition = pixelToGeo(targetPosition, MAP_WIDTH, MAP_HEIGHT);

    // Use great-circle distance (in radians) for consistent speed regardless of direction
    // Convert to approximate "world units" - Earth radius ~6371km, but we use arbitrary units
    const angularDistance = greatCircleDistance(geoLaunchPosition, geoTargetPosition);
    const distance = angularDistance * 100; // Scale to reasonable units (roughly 0-314 for half globe)

    // Flight duration based on distance with a reasonable minimum for short range
    // Minimum 6 seconds ensures short-range missiles are still visible
    const flightDuration = Math.max(8000, (distance / this.missileSpeed) * 1000);

    console.log(`[MISSILE] distance=${distance.toFixed(1)}, duration=${(flightDuration/1000).toFixed(1)}s, speed=${(distance / (flightDuration/1000)).toFixed(2)} units/s`);

    return {
      id: uuidv4(),
      type: 'icbm',
      ownerId,
      sourceId: silo.id,
      launchPosition,
      targetPosition,
      targetId,
      currentPosition: { ...launchPosition },
      launchTime: Date.now(),
      flightDuration,
      progress: 0,
      apexHeight: Math.min(distance * 0.2, 60),
      intercepted: false,
      detonated: false,
      // Geographic data for 3D globe
      geoLaunchPosition,
      geoTargetPosition,
      geoCurrentPosition: { ...geoLaunchPosition },
    };
  }

  update(state: GameState, deltaSeconds: number): GameEvent[] {
    const events: GameEvent[] = [];

    // Physics missiles are updated by their own simulator
    // Rail interceptors are updated by RailInterceptorSimulator
    // This method only handles legacy ICBMs

    // Update all ICBM positions (skip interceptors)
    for (const missile of Object.values(state.missiles)) {
      if (missile.detonated || missile.intercepted) continue;

      // Skip physics-based missiles - they're updated by their own simulator
      if (isPhysicsMissile(missile)) continue;

      // Skip rail interceptors - they're updated by RailInterceptorSimulator
      if (isRailInterceptor(missile)) continue;

      // Cast to Missile type (we've eliminated other types)
      const icbm = missile as Missile;

      // Update progress
      const progressDelta = (deltaSeconds * 1000) / icbm.flightDuration;
      icbm.progress = Math.min(1, icbm.progress + progressDelta);

      // Calculate current position along arc (2D)
      icbm.currentPosition = this.calculateArcPosition(icbm);

      // Update geo position along great circle path (3D)
      if (icbm.geoLaunchPosition && icbm.geoTargetPosition) {
        icbm.geoCurrentPosition = geoInterpolate(
          icbm.geoLaunchPosition,
          icbm.geoTargetPosition,
          icbm.progress
        );
      }
    }

    // Check for ICBM impacts (skip interceptors)
    for (const missile of Object.values(state.missiles)) {
      if (missile.detonated || missile.intercepted) continue;

      // Skip physics-based missiles
      if (isPhysicsMissile(missile)) continue;

      // Skip rail interceptors
      if (isRailInterceptor(missile)) continue;

      const icbm = missile as Missile;
      if (icbm.progress >= 1) {
        // ICBM impact
        const impactEvents = this.handleImpact(icbm, state);
        events.push(...impactEvents);
      }
    }

    return events;
  }

  private calculateArcPosition(missile: Missile): Vector2 {
    const { launchPosition, targetPosition, progress, apexHeight } = missile;

    // Linear interpolation for ground position
    const groundX = launchPosition.x + (targetPosition.x - launchPosition.x) * progress;
    const groundY = launchPosition.y + (targetPosition.y - launchPosition.y) * progress;

    // Parabolic arc for altitude: h(t) = 4 * apex * t * (1 - t)
    // Gives 0 at t=0 and t=1, maximum of apex at t=0.5
    const altitude = 4 * apexHeight * progress * (1 - progress);

    return {
      x: groundX,
      y: groundY - altitude, // Subtract because Y increases downward in screen coords
    };
  }

  private handleImpact(missile: Missile, state: GameState): GameEvent[] {
    missile.detonated = true;
    const events: GameEvent[] = [];
    const impactRadius = 50;
    let totalCasualties = 0;

    // Find attacker for scoring
    const attacker = state.players[missile.ownerId];

    // Check cities
    for (const city of Object.values(state.cities)) {
      if (city.destroyed) continue;

      const distance = this.distance(city.position, missile.targetPosition);

      if (distance < impactRadius) {
        const damage = this.calculateDamage(distance, impactRadius, city.population);
        city.population = Math.max(0, city.population - damage);
        totalCasualties += damage;

        // Find city owner for scoring
        const territory = state.territories[city.territoryId];
        if (territory?.ownerId) {
          const defender = state.players[territory.ownerId];
          if (defender) {
            defender.populationLost += damage;
            defender.populationRemaining -= damage;

            // Update attacker's score (enemy kills)
            if (attacker && attacker.id !== defender.id) {
              attacker.enemyKills += damage;
              attacker.score += Math.floor(damage / 1000); // 1 point per 1000 killed
            }
          }
        }

        events.push({
          type: 'city_hit',
          tick: state.tick,
          cityId: city.id,
          casualties: damage,
          remainingPopulation: city.population,
        } as CityHitEvent);

        if (city.population <= 0) {
          city.destroyed = true;
        }
      }
    }

    // Check buildings
    for (const building of Object.values(state.buildings)) {
      if (building.destroyed) continue;

      const distance = this.distance(building.position, missile.targetPosition);
      const buildingRadius = impactRadius / 2; // Buildings are harder to hit

      if (distance < buildingRadius) {
        const damage = this.calculateBuildingDamage(distance, buildingRadius);
        building.health -= damage;

        if (building.health <= 0) {
          building.destroyed = true;
          events.push({
            type: 'building_destroyed',
            tick: state.tick,
            buildingId: building.id,
            buildingType: building.type,
          } as BuildingDestroyedEvent);
        }
      }
    }

    // Add impact event
    events.push({
      type: 'missile_impact',
      tick: state.tick,
      missileId: missile.id,
      position: missile.targetPosition,
      casualties: totalCasualties,
      targetType: missile.targetId ? 'city' : 'ground',
      targetId: missile.targetId,
    } as MissileImpactEvent);

    return events;
  }

  private calculateDamage(distance: number, radius: number, population: number): number {
    // Flat 50% damage to any city within blast radius
    return Math.floor(population * 0.5);
  }

  private calculateBuildingDamage(distance: number, radius: number): number {
    const falloff = 1 - distance / radius;
    return 100 * Math.max(0, falloff); // 100 damage at ground zero
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
}
