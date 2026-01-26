import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  GuidedInterceptor,
  Missile,
  GameEvent,
  InterceptionEvent,
  Silo,
  getMissiles,
  isGuidedInterceptor,
  greatCircleDistance,
  pixelToGeo,
  geoToSphere,
  sphereToGeo,
  getMissilePosition3D,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
  GLOBE_RADIUS,
} from '@defcon/shared';

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Simplified interceptor configuration
export const GUIDED_INTERCEPTOR_CONFIG = {
  speedDegPerSec: 0.8,      // 0.8 deg/s angular speed (ICBM is ~1.0 deg/s)
  hitProbability: 0.70,      // 70% base hit chance
  interceptRadius: 2.0,      // degrees - proximity threshold for hit check
  apexHeight: 25,            // legacy arc height (kept for compatibility)
  maxProgress: 0.95,         // must intercept before ICBM reaches 95%
  initialAccuracy: 0.3,      // radar tracking starts at 30% accuracy
  errorRadius: 5,            // max initial error in globe units
  maxFlightDistance: 60,     // max distance in globe units before expiry
};

// Convert interceptRadius from degrees to globe units
const INTERCEPT_RADIUS_GLOBE = GUIDED_INTERCEPTOR_CONFIG.interceptRadius * GLOBE_RADIUS * Math.PI / 180;

// Convert speed from deg/s to globe units/s
const SPEED_GLOBE_UNITS = GUIDED_INTERCEPTOR_CONFIG.speedDegPerSec * GLOBE_RADIUS * Math.PI / 180;

function vec3Sub(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vec3Add(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec3Scale(v: { x: number; y: number; z: number }, s: number) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vec3Length(v: { x: number; y: number; z: number }) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vec3Normalize(v: { x: number; y: number; z: number }) {
  const len = vec3Length(v);
  if (len < 0.00001) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vec3Lerp(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

// Track total distance traveled per interceptor
const distanceTraveled = new Map<string, number>();

export class GuidedInterceptorSimulator {

  /**
   * Launch a guided interceptor at a target ICBM.
   * Computes initial 3D position at silo and noisy radar estimate of ICBM position.
   */
  launchInterceptor(
    silo: Silo,
    targetMissile: Missile,
    ownerId: string,
    _trackingRadarIds: string[]
  ): GuidedInterceptor | null {
    const siloGeo = silo.geoPosition || pixelToGeo(silo.position, MAP_WIDTH, MAP_HEIGHT);

    if (!targetMissile.geoCurrentPosition || !targetMissile.geoLaunchPosition || !targetMissile.geoTargetPosition) {
      return null;
    }

    // Compute silo 3D position (on globe surface)
    const silo3d = geoToSphere(siloGeo, GLOBE_RADIUS);

    // Compute ICBM true 3D position
    const icbmApex = targetMissile.apexHeight || 30;
    const icbmProgress = targetMissile.progress || 0;
    const trueIcbmPos = getMissilePosition3D(
      targetMissile.geoLaunchPosition,
      targetMissile.geoTargetPosition,
      icbmProgress,
      icbmApex,
      GLOBE_RADIUS,
    );

    // Add initial radar error: offset by random 3D vector scaled by (1 - accuracy) * errorRadius
    const accuracy = GUIDED_INTERCEPTOR_CONFIG.initialAccuracy;
    const errorMag = (1 - accuracy) * GUIDED_INTERCEPTOR_CONFIG.errorRadius;
    // Random unit vector
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    const errorVec = {
      x: errorMag * Math.sin(phi) * Math.cos(theta),
      y: errorMag * Math.sin(phi) * Math.sin(theta),
      z: errorMag * Math.cos(phi),
    };
    const noisyIcbmPos = vec3Add(trueIcbmPos, errorVec);

    // Speed in globe units per second (adjusted by global multiplier)
    const speed3d = SPEED_GLOBE_UNITS * GLOBAL_MISSILE_SPEED_MULTIPLIER;

    // Flight duration estimate (for legacy fields)
    const distRadians = greatCircleDistance(siloGeo, targetMissile.geoCurrentPosition);
    const distDegrees = distRadians * (180 / Math.PI);
    const flightDuration = Math.max(4000, (distDegrees / (GUIDED_INTERCEPTOR_CONFIG.speedDegPerSec * GLOBAL_MISSILE_SPEED_MULTIPLIER)) * 1000);

    console.log(`[INTERCEPTOR] Launching 3D toward ICBM: dist=${distDegrees.toFixed(1)}°, speed=${speed3d.toFixed(1)} gu/s`);

    const now = Date.now();

    // Initialize distance tracking
    const id = uuidv4();
    distanceTraveled.set(id, 0);

    return {
      id,
      type: 'guided_interceptor',
      ownerId,
      sourceId: silo.id,
      targetId: targetMissile.id,

      geoPosition: { ...siloGeo },
      geoLaunchPosition: { ...siloGeo },
      geoTargetPosition: { ...targetMissile.geoCurrentPosition },
      geoCurrentPosition: { ...siloGeo },
      progress: 0,
      flightDuration,
      launchTime: now,
      apexHeight: GUIDED_INTERCEPTOR_CONFIG.apexHeight,

      status: 'active',
      intercepted: false,
      detonated: false,

      // 3D position-based fields
      pos3d: { ...silo3d },
      velocity3d: vec3Normalize(vec3Sub(noisyIcbmPos, silo3d)),
      estimatedTargetPos3d: { ...noisyIcbmPos },
      trackingAccuracy: accuracy,
      speed3d,

      launchPosition: { ...silo.position },
      targetPosition: targetMissile.targetPosition ? { ...targetMissile.targetPosition } : undefined,
      currentPosition: { ...silo.position },
    };
  }

  /**
   * Update all guided interceptors each tick.
   * Uses direct 3D Cartesian movement toward radar-estimated ICBM position.
   */
  update(state: GameState, deltaSeconds: number): GameEvent[] {
    const events: GameEvent[] = [];

    for (const missile of getMissiles(state)) {
      if (!isGuidedInterceptor(missile)) continue;

      const interceptor = missile as GuidedInterceptor;
      if (interceptor.status !== 'active') continue;

      // Ensure 3D fields exist (backward compat for interceptors created before this change)
      if (!interceptor.pos3d || !interceptor.speed3d) {
        // Fallback: advance using legacy progress-based approach
        const progressDelta = (deltaSeconds * 1000) / interceptor.flightDuration;
        interceptor.progress = Math.min(1, interceptor.progress + progressDelta);
        if (interceptor.progress >= 1) {
          interceptor.status = 'expired';
          interceptor.detonated = true;
        }
        continue;
      }

      // Check if target ICBM still exists and is active
      const target = state.missiles[interceptor.targetId] as Missile | undefined;

      if (!target || target.detonated || target.intercepted) {
        interceptor.status = 'expired';
        interceptor.detonated = true;
        console.log(`[INTERCEPTOR] Target gone - expiring`);
        distanceTraveled.delete(interceptor.id);
        continue;
      }

      // Compute ICBM's true 3D position
      let trueIcbmPos: { x: number; y: number; z: number } | null = null;
      if (target.geoLaunchPosition && target.geoTargetPosition) {
        const icbmApex = target.apexHeight || 30;
        const icbmProgress = target.progress || 0;
        trueIcbmPos = getMissilePosition3D(
          target.geoLaunchPosition,
          target.geoTargetPosition,
          icbmProgress,
          icbmApex,
          GLOBE_RADIUS,
        );
      }

      // Refine radar estimate (continuous tracking since radar is required for launch)
      if (trueIcbmPos && interceptor.estimatedTargetPos3d) {
        // Exponential convergence: accuracy approaches 1
        const prevAccuracy = interceptor.trackingAccuracy || 0.3;
        interceptor.trackingAccuracy = 1 - (1 - prevAccuracy) * Math.exp(-2.0 * deltaSeconds);

        // Lerp estimated position toward true position
        interceptor.estimatedTargetPos3d = vec3Lerp(
          interceptor.estimatedTargetPos3d,
          trueIcbmPos,
          interceptor.trackingAccuracy
        );
      }

      // Move interceptor toward estimated target
      if (interceptor.estimatedTargetPos3d && interceptor.pos3d) {
        const toTarget = vec3Sub(interceptor.estimatedTargetPos3d, interceptor.pos3d);
        const direction = vec3Normalize(toTarget);

        const moveDistance = interceptor.speed3d * deltaSeconds;
        interceptor.pos3d = vec3Add(interceptor.pos3d, vec3Scale(direction, moveDistance));
        interceptor.velocity3d = direction;

        // Track distance traveled
        const traveled = (distanceTraveled.get(interceptor.id) || 0) + moveDistance;
        distanceTraveled.set(interceptor.id, traveled);

        // Update progress estimate (for legacy rendering and trail computation)
        const maxDist = GUIDED_INTERCEPTOR_CONFIG.maxFlightDistance;
        interceptor.progress = Math.min(1, traveled / maxDist);

        // Convert back to geo for legacy fields
        const geo = sphereToGeo(interceptor.pos3d, GLOBE_RADIUS);
        interceptor.geoCurrentPosition = { lat: geo.lat, lng: geo.lng };
        interceptor.geoPosition = { ...interceptor.geoCurrentPosition };

        // Also update geoTargetPosition for client prediction line
        if (interceptor.estimatedTargetPos3d) {
          const targetGeo = sphereToGeo(interceptor.estimatedTargetPos3d, GLOBE_RADIUS);
          interceptor.geoTargetPosition = { lat: targetGeo.lat, lng: targetGeo.lng };
        }
      }

      // 3D proximity check (use TRUE position, not estimate)
      if (trueIcbmPos && interceptor.pos3d) {
        const dist = vec3Length(vec3Sub(interceptor.pos3d, trueIcbmPos));

        if (dist < INTERCEPT_RADIUS_GLOBE) {
          // Roll hit/miss
          const roll = Math.random();
          if (roll < GUIDED_INTERCEPTOR_CONFIG.hitProbability) {
            // HIT
            console.log(`[INTERCEPTOR] HIT! dist=${dist.toFixed(1)} gu (${(GUIDED_INTERCEPTOR_CONFIG.hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);
            target.intercepted = true;
            interceptor.status = 'hit';
            interceptor.detonated = true;
            target.geoCurrentPosition = interceptor.geoCurrentPosition ? { ...interceptor.geoCurrentPosition } : undefined;

            events.push({
              type: 'interception',
              tick: state.tick,
              missileId: target.id,
              interceptorId: interceptor.id,
              position: target.currentPosition || { x: 0, y: 0 },
            } as InterceptionEvent);

            distanceTraveled.delete(interceptor.id);
          } else {
            // MISS
            console.log(`[INTERCEPTOR] MISS! dist=${dist.toFixed(1)} gu (${(GUIDED_INTERCEPTOR_CONFIG.hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);
            interceptor.status = 'missed';
            interceptor.detonated = true;
            distanceTraveled.delete(interceptor.id);
          }
          continue;
        }
      }

      // Expire if traveled too far
      const traveled = distanceTraveled.get(interceptor.id) || 0;
      if (traveled > GUIDED_INTERCEPTOR_CONFIG.maxFlightDistance) {
        interceptor.status = 'expired';
        interceptor.detonated = true;
        console.log(`[INTERCEPTOR] Expired - max flight distance reached (${traveled.toFixed(1)} gu)`);
        distanceTraveled.delete(interceptor.id);
      }
    }

    return events;
  }

  /**
   * Estimate hit probability for UI display.
   */
  estimateHitProbability(
    _silo: Silo,
    _targetMissile: Missile,
    _trackingRadarCount: number
  ): number {
    return GUIDED_INTERCEPTOR_CONFIG.hitProbability;
  }
}
