import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Missile,
  Silo,
  Vector2,
  GameEvent,
  GeoPosition,
  MissileImpactEvent,
  CityHitEvent,
  BuildingDestroyedEvent,
  pixelToGeo,
  geoInterpolate,
  greatCircleDistance,
} from '@defcon/shared';

// Map dimensions for converting pixel to geo coordinates
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

export class MissileSimulator {
  private missileSpeed: number;

  constructor(missileSpeed: number) {
    this.missileSpeed = missileSpeed;
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

    // Flight duration purely based on distance - no minimum floor
    // This ensures consistent angular velocity regardless of distance
    const flightDuration = Math.max(3000, (distance / this.missileSpeed) * 1000);

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
      apexHeight: Math.min(distance * 0.3, 200),
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

    for (const missile of Object.values(state.missiles)) {
      if (missile.detonated || missile.intercepted) continue;

      // Update progress
      const progressDelta = (deltaSeconds * 1000) / missile.flightDuration;
      missile.progress = Math.min(1, missile.progress + progressDelta);

      // Calculate current position along arc (2D)
      missile.currentPosition = this.calculateArcPosition(missile);

      // Update geo position along great circle path (3D)
      if (missile.geoLaunchPosition && missile.geoTargetPosition) {
        missile.geoCurrentPosition = geoInterpolate(
          missile.geoLaunchPosition,
          missile.geoTargetPosition,
          missile.progress
        );
      }

      // Check for impact
      if (missile.progress >= 1) {
        const impactEvents = this.handleImpact(missile, state);
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
    // Damage falls off with distance squared (inverse square law)
    const falloff = 1 - Math.pow(distance / radius, 2);
    const baseDamage = population * 0.5; // 50% casualties at ground zero
    return Math.floor(baseDamage * Math.max(0, falloff));
  }

  private calculateBuildingDamage(distance: number, radius: number): number {
    const falloff = 1 - distance / radius;
    return 100 * Math.max(0, falloff); // 100 damage at ground zero
  }

  private distance(a: Vector2, b: Vector2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
}
