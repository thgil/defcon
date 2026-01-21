import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  RailInterceptor,
  Missile,
  GameEvent,
  InterceptionEvent,
  GeoPosition,
  Silo,
  Radar,
  IcbmPhase,
  getMissiles,
  getBuildings,
  isRailInterceptor,
  greatCircleDistance,
  getMissilePosition3D,
  getInterceptorPosition3D,
  geoInterpolate,
  geoToCartesian,
  vec3Subtract,
  vec3Magnitude,
  sphereToGeo,
  pixelToGeo,
  getIcbmAltitude,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
} from '@defcon/shared';

// Globe radius (must match client)
const GLOBE_RADIUS = 100;

// Map dimensions for pixel to geo conversion
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Rail interceptor configuration
export const RAIL_INTERCEPTOR_CONFIG = {
  // Speed and fuel - tuned for realistic interception
  speed: 2.5 * GLOBAL_MISSILE_SPEED_MULTIPLIER,  // 1.25 units/sec (25% faster than ICBMs which use 2.0)
  maxFuel: 50,  // 50 seconds max flight time (enough to reach intercept points)

  // Interception range (as progress on ICBM path)
  minInterceptProgress: 0.15,  // Don't intercept during boost
  maxInterceptProgress: 0.85,  // Don't intercept too close to target

  // Hit probabilities by ICBM phase
  hitProbability: {
    boost: 0.40,      // Hard to hit - fast, accelerating
    midcourse: 0.70,  // Easiest - predictable arc
    reentry: 0.45,    // Hard - fast, steep descent
  },

  // Modifiers
  multiRadarBonus: 0.05,     // +5% per extra tracking radar
  maxRadarBonus: 0.15,       // Max +15% from radars
  lowFuelPenalty: 0.30,      // -30% if fuel < 20%
  lowFuelThreshold: 0.20,    // What counts as "low fuel"
  randomVariance: 0.10,      // ±10% random variance

  // Guidance
  guidanceLostGracePeriod: 2000,  // 2 seconds grace period after losing radar

  // Miss behavior
  missCoastDuration: 3000,  // How long missed interceptor continues (ms)

  // Altitude
  defaultApexHeight: 15,  // Default max altitude for interceptor arc (lower to approach from below)
};

export class RailInterceptorSimulator {

  /**
   * Calculate where on the ICBM's path the interceptor can intercept it.
   * Searches along the ICBM path to find the earliest point where interception is possible.
   * Returns null if interception is not possible.
   */
  calculateInterceptionPoint(
    icbm: Missile,
    siloGeo: GeoPosition,
    maxFuel: number
  ): {
    interceptProgress: number;
    interceptGeo: GeoPosition;
    interceptAltitude: number;
    flightDuration: number;
    apexHeight: number;
  } | null {
    if (!icbm.geoLaunchPosition || !icbm.geoTargetPosition) {
      return null;
    }

    const config = RAIL_INTERCEPTOR_CONFIG;
    const icbmApex = icbm.apexHeight || 30;
    const icbmFlightTimeMs = icbm.flightDuration || 30000;

    // Interceptor speed in degrees per second
    const interceptorSpeedDegPerSec = config.speed * (180 / (Math.PI * GLOBE_RADIUS));

    // Search along ICBM path (15%-85% progress) for earliest reachable interception
    const steps = 20;
    for (let step = 0; step <= steps; step++) {
      const targetProgress = config.minInterceptProgress +
        (step / steps) * (config.maxInterceptProgress - config.minInterceptProgress);

      // Skip if ICBM has already passed this point
      if (targetProgress < icbm.progress + 0.05) continue;

      // Get ICBM position at this progress
      const interceptGeo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, targetProgress);

      // Calculate altitude of ICBM at this progress (asymmetric ballistic arc)
      const icbmAltitude = getIcbmAltitude(targetProgress, icbmApex, 0.6);

      // How long until ICBM reaches target progress?
      const icbmRemainingProgress = targetProgress - icbm.progress;
      const icbmTimeToTargetSec = (icbmRemainingProgress * icbmFlightTimeMs) / 1000;

      // Calculate distance from silo to intercept point
      const distanceRadians = greatCircleDistance(siloGeo, interceptGeo);
      const distanceDegrees = distanceRadians * (180 / Math.PI);

      // Time for interceptor to reach intercept point
      const interceptorTravelTimeSec = distanceDegrees / interceptorSpeedDegPerSec;

      // Can interceptor reach in time AND within fuel limit?
      if (interceptorTravelTimeSec <= icbmTimeToTargetSec && interceptorTravelTimeSec <= maxFuel) {
        // Found a valid interception point!
        // Use the interceptor's actual travel time as flight duration
        const flightDurationMs = interceptorTravelTimeSec * 1000;

        // Calculate apex height - allow higher arcs for high-altitude intercepts
        const apexHeight = Math.max(icbmAltitude * 0.3, Math.min(icbmAltitude * 0.8, distanceDegrees * 0.5));

        // End altitude - match ICBM altitude at intercept point
        const endAltitude = icbmAltitude;

        console.log(`[INTERCEPT CALC] SUCCESS: progress=${targetProgress.toFixed(2)}, ` +
          `dist=${distanceDegrees.toFixed(1)}°, flightTime=${interceptorTravelTimeSec.toFixed(1)}s, ` +
          `apex=${apexHeight.toFixed(1)}, endAlt=${endAltitude.toFixed(1)}`);

        return {
          interceptProgress: targetProgress,
          interceptGeo,
          interceptAltitude: endAltitude,
          flightDuration: flightDurationMs,
          apexHeight,
        };
      }
    }

    // No valid intercept point found
    return null;
  }

  /**
   * Launch a rail-based interceptor at a target ICBM.
   */
  launchInterceptor(
    silo: Silo,
    targetMissile: Missile,
    ownerId: string,
    trackingRadarIds: string[]
  ): RailInterceptor | null {
    const siloGeo = silo.geoPosition || pixelToGeo(silo.position, MAP_WIDTH, MAP_HEIGHT);

    // Calculate interception point
    const intercept = this.calculateInterceptionPoint(
      targetMissile,
      siloGeo,
      RAIL_INTERCEPTOR_CONFIG.maxFuel
    );

    if (!intercept) {
      return null;
    }

    const now = Date.now();

    return {
      id: uuidv4(),
      type: 'rail_interceptor',
      ownerId,
      sourceId: silo.id,

      // Pre-calculated rail
      rail: {
        startGeo: siloGeo,
        endGeo: intercept.interceptGeo,
        endAltitude: intercept.interceptAltitude,
        apexHeight: intercept.apexHeight,
        flightDuration: intercept.flightDuration,
      },

      // Target
      targetId: targetMissile.id,
      targetProgressAtIntercept: intercept.interceptProgress,

      // Radar tracking
      tracking: {
        radarIds: trackingRadarIds,
        hasGuidance: trackingRadarIds.length > 0,
      },

      // State
      fuel: RAIL_INTERCEPTOR_CONFIG.maxFuel,
      maxFuel: RAIL_INTERCEPTOR_CONFIG.maxFuel,
      launchTime: now,
      progress: 0,
      status: 'active',

      // Compatibility flags
      intercepted: false,
      detonated: false,

      // Current position (will be updated each tick)
      geoCurrentPosition: { ...siloGeo },
      currentAltitude: 0,

      // Legacy compatibility
      launchPosition: { ...silo.position },
      targetPosition: targetMissile.targetPosition ? { ...targetMissile.targetPosition } : undefined,
      currentPosition: { ...silo.position },
      geoLaunchPosition: siloGeo,
      geoTargetPosition: intercept.interceptGeo,

      // Compatibility fields (mirrors rail data)
      flightDuration: intercept.flightDuration,
      apexHeight: intercept.apexHeight,
    };
  }

  /**
   * Update all rail interceptors each tick.
   */
  update(state: GameState, deltaSeconds: number): GameEvent[] {
    const events: GameEvent[] = [];
    const now = Date.now();

    for (const missile of getMissiles(state)) {
      if (!isRailInterceptor(missile)) continue;

      const interceptor = missile as RailInterceptor;

      // Skip if already resolved
      if (interceptor.status !== 'active' && interceptor.status !== 'missed') {
        continue;
      }

      // Handle missed interceptors
      if (interceptor.status === 'missed') {
        const missEvents = this.updateMissedInterceptor(interceptor, state, now);
        events.push(...missEvents);
        continue;
      }

      // Update progress along rail
      const progressDelta = (deltaSeconds * 1000) / interceptor.rail.flightDuration;
      interceptor.progress = Math.min(1, interceptor.progress + progressDelta);

      // Update fuel consumption
      interceptor.fuel = Math.max(0, interceptor.fuel - deltaSeconds);

      // Update position based on progress
      this.updatePosition(interceptor);

      // Update radar tracking
      this.updateRadarTracking(interceptor, state, now);

      // Check if we've reached the intercept point AND the ICBM has reached the intercept progress
      if (interceptor.progress >= 1) {
        const target = state.missiles[interceptor.targetId] as Missile | undefined;

        // Wait for the ICBM to reach the intercept point (with some tolerance)
        if (target && target.progress < interceptor.targetProgressAtIntercept - 0.05) {
          // ICBM hasn't arrived yet - interceptor waits at position
          // Keep progress at 1.0, don't attempt intercept yet
          continue;
        }

        const interceptEvents = this.attemptIntercept(interceptor, state);
        events.push(...interceptEvents);
      }
    }

    return events;
  }

  /**
   * Update the interceptor's current position based on progress along rail.
   */
  private updatePosition(interceptor: RailInterceptor): void {
    const pos3d = getInterceptorPosition3D(
      interceptor.rail.startGeo,
      interceptor.rail.endGeo,
      interceptor.progress,
      interceptor.rail.apexHeight,
      interceptor.rail.endAltitude,
      GLOBE_RADIUS
    );

    const geoWithAlt = sphereToGeo(pos3d, GLOBE_RADIUS);
    interceptor.geoCurrentPosition = { lat: geoWithAlt.lat, lng: geoWithAlt.lng };
    interceptor.currentAltitude = Math.sqrt(
      pos3d.x * pos3d.x + pos3d.y * pos3d.y + pos3d.z * pos3d.z
    ) - GLOBE_RADIUS;
  }

  /**
   * Update radar tracking status for the interceptor.
   */
  private updateRadarTracking(
    interceptor: RailInterceptor,
    state: GameState,
    now: number
  ): void {
    // Get the target ICBM
    const target = state.missiles[interceptor.targetId] as Missile | undefined;
    if (!target || !target.geoCurrentPosition) {
      // Target gone - this will be handled by attemptIntercept
      return;
    }

    // Find all radars that can see the target
    const trackingRadars: string[] = [];

    const radars = getBuildings(state).filter(
      (b): b is Radar =>
        b.type === 'radar' &&
        !b.destroyed &&
        b.active &&
        b.ownerId === interceptor.ownerId
    );

    for (const radar of radars) {
      const radarGeo = radar.geoPosition || pixelToGeo(radar.position, MAP_WIDTH, MAP_HEIGHT);
      const angularDistanceRadians = greatCircleDistance(radarGeo, target.geoCurrentPosition);
      const angularDistanceDegrees = angularDistanceRadians * (180 / Math.PI);
      const radarRangeDegrees = (radar.range / 100) * 9;

      if (angularDistanceDegrees <= radarRangeDegrees) {
        trackingRadars.push(radar.id);
      }
    }

    interceptor.tracking.radarIds = trackingRadars;

    if (trackingRadars.length > 0) {
      // Has guidance
      interceptor.tracking.hasGuidance = true;
      interceptor.tracking.lostGuidanceTime = undefined;
    } else {
      // Lost guidance
      if (interceptor.tracking.hasGuidance) {
        // Just lost it - start grace period
        interceptor.tracking.lostGuidanceTime = now;
      }

      // Check if grace period expired
      if (interceptor.tracking.lostGuidanceTime) {
        const timeSinceLost = now - interceptor.tracking.lostGuidanceTime;
        if (timeSinceLost > RAIL_INTERCEPTOR_CONFIG.guidanceLostGracePeriod) {
          interceptor.tracking.hasGuidance = false;
        }
      }
    }
  }

  /**
   * Attempt to intercept the target when we reach the intercept point.
   */
  private attemptIntercept(
    interceptor: RailInterceptor,
    state: GameState
  ): GameEvent[] {
    const events: GameEvent[] = [];

    // Get the target ICBM
    const target = state.missiles[interceptor.targetId] as Missile | undefined;

    if (!target || target.detonated || target.intercepted) {
      // Target is gone - missile becomes a miss
      this.markAsMissed(interceptor, state);
      return events;
    }

    // Check if we still have guidance
    if (!interceptor.tracking.hasGuidance) {
      console.log('[RAIL INTERCEPTOR] Lost guidance - automatic miss');
      this.markAsMissed(interceptor, state);
      return events;
    }

    // CRITICAL: Check actual proximity to target using 3D Euclidean distance
    // The intercept point was calculated at launch, but ICBM timing may vary
    const interceptorPos = interceptor.geoCurrentPosition;
    const targetPos = target.geoCurrentPosition;

    if (interceptorPos && targetPos) {
      // Get altitudes
      const interceptorAltitude = interceptor.currentAltitude || 0;
      const targetAltitude = target.apexHeight
        ? getIcbmAltitude(target.progress, target.apexHeight, 0.6)
        : 0;

      // Calculate 3D positions and Euclidean distance
      const interceptorPos3D = geoToCartesian(interceptorPos, interceptorAltitude, GLOBE_RADIUS);
      const targetPos3D = geoToCartesian(targetPos, targetAltitude, GLOBE_RADIUS);
      const distance3D = vec3Magnitude(vec3Subtract(interceptorPos3D, targetPos3D));
      const INTERCEPT_RADIUS_3D = 0.5; // globe units - ~32km real-world, visually close

      if (distance3D > INTERCEPT_RADIUS_3D) {
        // Miss - interceptor and ICBM are too far apart
        console.log(`[RAIL INTERCEPTOR] MISS - Too far apart: ${distance3D.toFixed(1)} units > ${INTERCEPT_RADIUS_3D} units`);
        this.markAsMissed(interceptor, state);
        return events;
      }

      console.log(`[RAIL INTERCEPTOR] Proximity check passed: ${distance3D.toFixed(1)} units (within ${INTERCEPT_RADIUS_3D} units)`);
    }

    // Calculate hit probability
    const hitProbability = this.calculateHitProbability(interceptor, target);

    // Roll for hit
    const roll = Math.random();

    if (roll < hitProbability) {
      // HIT!
      console.log(`[RAIL INTERCEPTOR] HIT! (${(hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);

      target.intercepted = true;
      interceptor.status = 'hit';
      interceptor.detonated = true;

      // Update target position to match intercept point
      if (interceptor.geoCurrentPosition) {
        target.geoCurrentPosition = { ...interceptor.geoCurrentPosition };
      }

      events.push({
        type: 'interception',
        tick: state.tick,
        missileId: target.id,
        interceptorId: interceptor.id,
        position: target.currentPosition || { x: 0, y: 0 },
      } as InterceptionEvent);
    } else {
      // MISS!
      console.log(`[RAIL INTERCEPTOR] MISS! (${(hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);
      this.markAsMissed(interceptor, state);
    }

    return events;
  }

  /**
   * Calculate hit probability based on ICBM phase and modifiers.
   */
  private calculateHitProbability(interceptor: RailInterceptor, target: Missile): number {
    const config = RAIL_INTERCEPTOR_CONFIG;

    // Determine ICBM phase based on progress
    const phase = this.getIcbmPhase(target.progress);

    // Base probability by phase
    let probability = config.hitProbability[phase];

    // Multi-radar bonus
    const extraRadars = Math.max(0, interceptor.tracking.radarIds.length - 1);
    const radarBonus = Math.min(config.maxRadarBonus, extraRadars * config.multiRadarBonus);
    probability += radarBonus;

    // Low fuel penalty
    if (interceptor.fuel / interceptor.maxFuel < config.lowFuelThreshold) {
      probability -= config.lowFuelPenalty;
    }

    // Random variance
    probability += (Math.random() - 0.5) * 2 * config.randomVariance;

    // Clamp to [0.05, 0.95]
    return Math.max(0.05, Math.min(0.95, probability));
  }

  /**
   * Determine ICBM flight phase based on progress.
   */
  private getIcbmPhase(progress: number): IcbmPhase {
    if (progress < 0.15) return 'boost';
    if (progress > 0.80) return 'reentry';
    return 'midcourse';
  }

  /**
   * Mark an interceptor as missed and set up its coast trajectory.
   */
  private markAsMissed(interceptor: RailInterceptor, state: GameState): void {
    interceptor.status = 'missed';

    const now = Date.now();

    // Calculate where the missile will crash
    // Continue in roughly the same direction for a few seconds, then arc down
    const coastDistance = 0.1;  // Continue ~10% further along original path
    const crashGeo = geoInterpolate(
      interceptor.rail.startGeo,
      interceptor.rail.endGeo,
      1.0 + coastDistance
    );

    interceptor.missBehavior = {
      missStartTime: now,
      missStartProgress: interceptor.progress,
      endGeo: crashGeo,
      duration: RAIL_INTERCEPTOR_CONFIG.missCoastDuration,
    };
  }

  /**
   * Update a missed interceptor as it coasts to crash.
   */
  private updateMissedInterceptor(
    interceptor: RailInterceptor,
    state: GameState,
    now: number
  ): GameEvent[] {
    const events: GameEvent[] = [];

    if (!interceptor.missBehavior) {
      interceptor.status = 'crashed';
      return events;
    }

    const elapsed = now - interceptor.missBehavior.missStartTime;
    const coastProgress = Math.min(1, elapsed / interceptor.missBehavior.duration);

    // Interpolate position from miss point to crash point
    const missGeo = geoInterpolate(
      interceptor.rail.startGeo,
      interceptor.rail.endGeo,
      interceptor.missBehavior.missStartProgress
    );

    const currentGeo = geoInterpolate(
      missGeo,
      interceptor.missBehavior.endGeo,
      coastProgress
    );

    // Altitude decreases during coast (parabolic descent)
    const startAltitude = interceptor.currentAltitude || interceptor.rail.endAltitude;
    const altitude = startAltitude * (1 - coastProgress) * (1 - coastProgress);

    interceptor.geoCurrentPosition = currentGeo;
    interceptor.currentAltitude = altitude;

    // Check if crashed (altitude near 0 or coast complete)
    if (altitude < 1 || coastProgress >= 1) {
      interceptor.status = 'crashed';
      interceptor.detonated = true;
      // Could emit a small ground explosion event here if desired
    }

    return events;
  }

  /**
   * Estimate hit probability for UI display (without random variance).
   */
  estimateHitProbability(
    silo: Silo,
    targetMissile: Missile,
    trackingRadarCount: number
  ): number {
    const config = RAIL_INTERCEPTOR_CONFIG;

    // Determine phase at likely intercept point
    // Estimate we'll intercept around 40-60% progress
    const estimatedInterceptProgress = Math.max(
      config.minInterceptProgress,
      Math.min(0.6, targetMissile.progress + 0.2)
    );

    const phase = this.getIcbmPhase(estimatedInterceptProgress);
    let probability = config.hitProbability[phase];

    // Multi-radar bonus
    const extraRadars = Math.max(0, trackingRadarCount - 1);
    const radarBonus = Math.min(config.maxRadarBonus, extraRadars * config.multiRadarBonus);
    probability += radarBonus;

    return Math.max(0.05, Math.min(0.95, probability));
  }
}
