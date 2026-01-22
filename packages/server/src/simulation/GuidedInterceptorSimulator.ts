import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  GuidedInterceptor,
  Missile,
  GameEvent,
  InterceptionEvent,
  GeoPosition,
  Silo,
  Radar,
  IcbmPhase,
  getMissiles,
  getBuildings,
  isGuidedInterceptor,
  greatCircleDistance,
  geoInterpolate,
  geoToCartesian,
  cartesianToGeo,
  vec3Normalize,
  vec3Subtract,
  vec3Add,
  vec3Scale,
  vec3Cross,
  vec3Magnitude,
  Vector3,
  calculateBearing,
  pixelToGeo,
  getIcbmAltitude,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
} from '@defcon/shared';

// Globe radius (must match client)
const GLOBE_RADIUS = 100;

// Map dimensions for pixel to geo conversion
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

// Guided interceptor configuration
export const GUIDED_INTERCEPTOR_CONFIG = {
  // Speed - interceptors are faster than ICBMs
  speed: 0.8 * GLOBAL_MISSILE_SPEED_MULTIPLIER,  // degrees per second (ICBMs are ~0.5)

  // Maneuverability
  maxTurnRate: 15,     // degrees per second for heading changes (more responsive)
  maxClimbRate: 10,    // degrees per second for climb angle changes (more responsive)
  maxClimbAngle: 60,   // maximum climb/dive angle in degrees
  initialClimbAngle: 45, // moderate initial climb during boost

  // Fuel and timing
  maxFuel: 150,         // seconds of fuel (6x original)
  maxFlightTime: 90,    // maximum total flight time in seconds (3x original)
  boostDuration: 3,     // seconds of boost phase (steep climb)

  // Radar update interval - how often radar sends updated target position
  radarUpdateInterval: 5000,  // 5 seconds between radar updates

  // Hit detection - using 3D Euclidean distance (globe units)
  interceptRadius3D: 0.5,  // globe units - ~32km real-world, visually close

  // Hit probabilities by ICBM phase
  hitProbability: {
    boost: 0.35,      // Hard to hit - fast, accelerating
    midcourse: 0.75,  // Easiest - predictable path
    reentry: 0.50,    // Medium - fast but predictable
  },

  // Modifiers
  multiRadarBonus: 0.05,     // +5% per extra tracking radar
  maxRadarBonus: 0.15,       // Max +15% from radars
  noGuidancePenalty: 0.40,   // -40% if no radar guidance
  lowFuelPenalty: 0.20,      // -20% if fuel < 20%
  lowFuelThreshold: 0.20,    // What counts as "low fuel"

  // Guidance
  guidanceLostGracePeriod: 2000,  // 2 seconds grace period after losing radar

  // Proportional navigation constant (higher = more aggressive turning)
  navigationConstant: 3,

  // Altitude profile
  cruiseAltitude: 15,    // Target altitude during cruise phase (lower than ICBMs)
  terminalAltitude: 10,  // Start terminal guidance when above this altitude
};

export class GuidedInterceptorSimulator {

  /**
   * Launch a guided interceptor at a target ICBM.
   * Uses proportional navigation to continuously track the target.
   */
  launchInterceptor(
    silo: Silo,
    targetMissile: Missile,
    ownerId: string,
    trackingRadarIds: string[]
  ): GuidedInterceptor | null {
    const siloGeo = silo.geoPosition || pixelToGeo(silo.position, MAP_WIDTH, MAP_HEIGHT);

    // Calculate initial heading toward target's predicted position
    const targetGeo = targetMissile.geoCurrentPosition || targetMissile.geoLaunchPosition;
    if (!targetGeo) return null;

    const initialHeading = calculateBearing(siloGeo, targetGeo);

    const config = GUIDED_INTERCEPTOR_CONFIG;
    const now = Date.now();

    // Estimate flight duration for legacy compatibility
    const angularDistance = greatCircleDistance(siloGeo, targetGeo);
    const distanceDegrees = angularDistance * (180 / Math.PI);
    const estimatedFlightDuration = (distanceDegrees / config.speed) * 1000;

    return {
      id: uuidv4(),
      type: 'guided_interceptor',
      ownerId,
      sourceId: silo.id,

      // Position - start at silo
      geoPosition: { ...siloGeo },
      altitude: 0,

      // Movement - initial steep climb toward target
      heading: initialHeading,
      climbAngle: config.initialClimbAngle,
      speed: config.speed,

      // Target
      targetId: targetMissile.id,
      hasGuidance: trackingRadarIds.length > 0,
      trackingRadarIds: [...trackingRadarIds],

      // Fuel/timing
      launchTime: now,
      fuel: config.maxFuel,
      maxFuel: config.maxFuel,
      maxFlightTime: config.maxFlightTime,

      // Status
      status: 'active',
      intercepted: false,
      detonated: false,

      // Prediction accuracy (starts with significant error, improves with radar)
      predictionError: 0.08 + Math.random() * 0.07,  // 8-15% initial error
      lastRadarUpdateTime: now,

      // Error biases - random per interceptor, constant during flight
      // Biased forward (95%) because interceptors need to aim ahead of ICBMs
      progressErrorBias: this.generateBiasedError(0.95),  // 95% forward, 5% behind
      altitudeErrorBias: (Math.random() - 0.5) * 2,       // Keep uniform (no bias needed)
      speedErrorBias: this.generateBiasedError(0.95),     // 95% overspeed, 5% underspeed

      // Cached position
      geoCurrentPosition: { ...siloGeo },
      currentAltitude: 0,

      // Legacy compatibility
      launchPosition: { ...silo.position },
      targetPosition: targetMissile.targetPosition ? { ...targetMissile.targetPosition } : undefined,
      currentPosition: { ...silo.position },
      geoLaunchPosition: siloGeo,
      geoTargetPosition: targetGeo,
      flightDuration: estimatedFlightDuration,
      apexHeight: config.cruiseAltitude,
      progress: 0,
    };
  }

  /**
   * Update all guided interceptors each tick.
   */
  update(state: GameState, deltaSeconds: number): GameEvent[] {
    const events: GameEvent[] = [];
    const now = Date.now();

    for (const missile of getMissiles(state)) {
      if (!isGuidedInterceptor(missile)) continue;

      const interceptor = missile as GuidedInterceptor;

      // Skip if already resolved
      if (interceptor.status !== 'active') {
        continue;
      }

      // Check for expiration
      const flightTime = (now - interceptor.launchTime) / 1000;
      if (flightTime >= interceptor.maxFlightTime || interceptor.fuel <= 0) {
        this.markAsExpired(interceptor);
        continue;
      }

      // Get target ICBM
      const target = state.missiles[interceptor.targetId] as Missile | undefined;

      // Update radar tracking (check which radars can see target)
      this.updateRadarTracking(interceptor, target, state, now);

      // Improve prediction only when radar sends an update (every 5 seconds)
      // This creates tension - interceptor works with stale data between updates
      const timeSinceLastUpdate = now - interceptor.lastRadarUpdateTime;
      const updateInterval = GUIDED_INTERCEPTOR_CONFIG.radarUpdateInterval;

      if (interceptor.hasGuidance && interceptor.trackingRadarIds.length > 0 && timeSinceLastUpdate >= updateInterval) {
        // Radar update received! Improve prediction based on number of tracking radars
        const radarCount = interceptor.trackingRadarIds.length;
        // Each update reduces error significantly (15% per radar per update)
        const errorReduction = 0.15 * radarCount;
        interceptor.predictionError = Math.max(
          0.02,  // Minimum 2% error (never perfect)
          interceptor.predictionError - errorReduction
        );
        interceptor.lastRadarUpdateTime = now;
      }
      // If no guidance or between updates, error stays frozen

      // Update guidance and movement
      if (target && !target.detonated && !target.intercepted) {
        this.updateGuidance(interceptor, target, deltaSeconds);
      } else {
        // Target gone - go ballistic
        interceptor.hasGuidance = false;
        this.updateBallisticFlight(interceptor, deltaSeconds);
      }

      // Update position based on heading and speed
      this.updatePosition(interceptor, deltaSeconds);

      // Consume fuel
      interceptor.fuel = Math.max(0, interceptor.fuel - deltaSeconds);

      // Update progress estimate for UI
      if (interceptor.flightDuration) {
        interceptor.progress = Math.min(1, flightTime / (interceptor.flightDuration / 1000));
      }

      // Check for intercept if we have a target
      if (target && !target.detonated && !target.intercepted) {
        const interceptEvents = this.checkIntercept(interceptor, target, state);
        events.push(...interceptEvents);
      }

      // Check for ground collision
      if (interceptor.altitude <= 0 && interceptor.climbAngle < 0) {
        this.markAsCrashed(interceptor);
      }
    }

    return events;
  }

  /**
   * Update guidance using proportional navigation.
   * Continuously adjusts heading toward predicted intercept point.
   */
  private updateGuidance(
    interceptor: GuidedInterceptor,
    target: Missile,
    deltaSeconds: number
  ): void {
    const config = GUIDED_INTERCEPTOR_CONFIG;

    if (!interceptor.hasGuidance) {
      // No guidance - fly ballistic
      this.updateBallisticFlight(interceptor, deltaSeconds);
      return;
    }

    // Predict where ICBM will be when we can reach it
    const predictedIntercept = this.predictInterceptPoint(interceptor, target);
    if (!predictedIntercept) {
      // Can't reach target - go ballistic
      this.updateBallisticFlight(interceptor, deltaSeconds);
      return;
    }

    // Calculate desired heading toward predicted intercept point
    const desiredHeading = calculateBearing(interceptor.geoPosition, predictedIntercept.geo);

    // Smooth turn toward desired heading (limited turn rate)
    const headingDiff = this.normalizeAngle(desiredHeading - interceptor.heading);
    const maxTurn = config.maxTurnRate * deltaSeconds;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, headingDiff));
    interceptor.heading = this.normalizeAngle(interceptor.heading + turn);

    // Calculate desired climb angle based on altitude difference
    const altitudeDiff = predictedIntercept.altitude - interceptor.altitude;
    const distanceToTarget = greatCircleDistance(interceptor.geoPosition, predictedIntercept.geo);
    const distanceDegrees = distanceToTarget * (180 / Math.PI);

    // Desired climb angle to reach target altitude
    let desiredClimbAngle: number;
    if (distanceDegrees < 0.1) {
      // Very close - level off
      desiredClimbAngle = 0;
    } else {
      // Calculate climb angle needed
      // Convert altitude diff to "degrees" equivalent for angle calculation
      const altitudeInDegrees = altitudeDiff / GLOBE_RADIUS * (180 / Math.PI);
      desiredClimbAngle = Math.atan2(altitudeInDegrees, distanceDegrees) * (180 / Math.PI);
    }

    // Clamp to maximum climb angle
    desiredClimbAngle = Math.max(-config.maxClimbAngle, Math.min(config.maxClimbAngle, desiredClimbAngle));

    // Smooth climb angle adjustment
    const climbDiff = desiredClimbAngle - interceptor.climbAngle;
    const maxClimbChange = config.maxClimbRate * deltaSeconds;
    const climbChange = Math.max(-maxClimbChange, Math.min(maxClimbChange, climbDiff));
    interceptor.climbAngle = interceptor.climbAngle + climbChange;
  }

  /**
   * Update ballistic flight when guidance is lost.
   * Interceptor continues on current heading, gradually descending.
   */
  private updateBallisticFlight(interceptor: GuidedInterceptor, deltaSeconds: number): void {
    const config = GUIDED_INTERCEPTOR_CONFIG;

    // Gradually pitch down (gravity effect)
    const gravityPitchRate = 1; // degrees per second
    interceptor.climbAngle = Math.max(
      -config.maxClimbAngle,
      interceptor.climbAngle - gravityPitchRate * deltaSeconds
    );
  }

  /**
   * Predict where the ICBM will be when the interceptor can reach it.
   * Applies prediction error to progress, altitude, and speed based on radar tracking quality.
   *
   * Error components:
   * - Speed error: Radar thinks ICBM is faster/slower than it is
   * - Progress error: Radar thinks ICBM is ahead/behind where it actually is
   * - Altitude error: Radar thinks ICBM is higher/lower than it is
   */
  private predictInterceptPoint(
    interceptor: GuidedInterceptor,
    target: Missile
  ): { geo: GeoPosition; altitude: number } | null {
    if (!target.geoLaunchPosition || !target.geoTargetPosition || !target.flightDuration) {
      return null;
    }

    const errorMagnitude = interceptor.predictionError;

    // Apply speed error: radar's estimate of ICBM speed
    // At 20% error with bias of +1, thinks ICBM is 20% faster than it is
    // This affects how far ahead we aim
    const speedErrorFactor = 1 + (errorMagnitude * interceptor.speedErrorBias * 0.5);
    const perceivedIcbmFlightDuration = target.flightDuration / speedErrorFactor;

    // Apply progress error: radar's estimate of where ICBM currently is on its path
    // At 20% error with bias of +1, thinks ICBM is 0.07 (7%) further along than it is
    const progressError = errorMagnitude * interceptor.progressErrorBias * 0.35;
    const perceivedIcbmProgress = Math.max(0, Math.min(1, target.progress + progressError));

    // Iteratively find intercept point using perceived (erroneous) values
    const currentDistance = greatCircleDistance(interceptor.geoPosition, target.geoCurrentPosition!);
    const distanceDegrees = currentDistance * (180 / Math.PI);
    let timeToIntercept = distanceDegrees / interceptor.speed;

    // Refine estimate through iteration
    for (let i = 0; i < 5; i++) {
      // Where will ICBM be after timeToIntercept? (using perceived speed)
      const icbmProgress = Math.min(1, perceivedIcbmProgress + (timeToIntercept * 1000 / perceivedIcbmFlightDuration));
      const icbmFutureGeo = geoInterpolate(target.geoLaunchPosition, target.geoTargetPosition, icbmProgress);

      // How long to reach that point?
      const distToFuture = greatCircleDistance(interceptor.geoPosition, icbmFutureGeo);
      const distToFutureDegrees = distToFuture * (180 / Math.PI);
      timeToIntercept = distToFutureDegrees / interceptor.speed;

      // Early termination if converged
      if (i > 0 && Math.abs(distToFutureDegrees - distanceDegrees) < 0.1) break;
    }

    // Final predicted position (using perceived values)
    const predictedIcbmProgress = Math.min(1, perceivedIcbmProgress + (timeToIntercept * 1000 / perceivedIcbmFlightDuration));

    // Check if we can reach it before ICBM hits target
    if (predictedIcbmProgress >= 0.98) {
      return null; // Can't catch it
    }

    // Calculate intercept geo position
    const interceptGeo = geoInterpolate(target.geoLaunchPosition, target.geoTargetPosition, predictedIcbmProgress);

    // Calculate altitude with error
    // True altitude at this progress point
    const trueAltitude = getIcbmAltitude(predictedIcbmProgress, target.apexHeight, 0.6);
    // Apply altitude error: at 20% error with bias of +1, thinks ICBM is 20% of apex higher
    const altitudeError = errorMagnitude * interceptor.altitudeErrorBias * (target.apexHeight || 30) * 0.3;
    const perceivedAltitude = Math.max(0, trueAltitude + altitudeError);

    return { geo: interceptGeo, altitude: perceivedAltitude };
  }

  /**
   * Update interceptor position based on heading, climb angle, and speed.
   */
  private updatePosition(interceptor: GuidedInterceptor, deltaSeconds: number): void {
    // Convert speed from degrees/sec to radians/sec
    const speedRadians = interceptor.speed * (Math.PI / 180);

    // Calculate horizontal movement based on heading
    const headingRadians = interceptor.heading * (Math.PI / 180);
    const climbRadians = interceptor.climbAngle * (Math.PI / 180);

    // Horizontal speed component
    const horizontalSpeed = speedRadians * Math.cos(climbRadians);

    // Calculate new position
    const lat = interceptor.geoPosition.lat;
    const lng = interceptor.geoPosition.lng;

    // Move in heading direction
    const dLat = Math.cos(headingRadians) * horizontalSpeed * (180 / Math.PI) * deltaSeconds;
    const dLng = Math.sin(headingRadians) * horizontalSpeed * (180 / Math.PI) / Math.cos(lat * Math.PI / 180) * deltaSeconds;

    interceptor.geoPosition = {
      lat: Math.max(-90, Math.min(90, lat + dLat)),
      lng: ((lng + dLng + 180) % 360) - 180,
    };

    // Update altitude based on climb angle
    // Vertical speed in globe units per second
    const verticalSpeed = interceptor.speed * GLOBE_RADIUS * (Math.PI / 180) * Math.sin(climbRadians);
    interceptor.altitude = Math.max(0, interceptor.altitude + verticalSpeed * deltaSeconds);

    // Update cached position
    interceptor.geoCurrentPosition = { ...interceptor.geoPosition };
    interceptor.currentAltitude = interceptor.altitude;
  }

  /**
   * Update radar tracking status for the interceptor.
   */
  private updateRadarTracking(
    interceptor: GuidedInterceptor,
    target: Missile | undefined,
    state: GameState,
    now: number
  ): void {
    if (!target || !target.geoCurrentPosition) {
      interceptor.hasGuidance = false;
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

    interceptor.trackingRadarIds = trackingRadars;
    interceptor.hasGuidance = trackingRadars.length > 0;
  }

  /**
   * Check if interceptor is close enough to attempt interception.
   */
  private checkIntercept(
    interceptor: GuidedInterceptor,
    target: Missile,
    state: GameState
  ): GameEvent[] {
    const events: GameEvent[] = [];
    const config = GUIDED_INTERCEPTOR_CONFIG;

    if (!target.geoCurrentPosition) return events;

    // Calculate target altitude
    const targetAltitude = target.apexHeight
      ? getIcbmAltitude(target.progress, target.apexHeight, 0.6)
      : 0;

    // Calculate 3D Euclidean distance (proper distance regardless of altitude)
    const interceptorPos3D = geoToCartesian(interceptor.geoPosition, interceptor.altitude, GLOBE_RADIUS);
    const targetPos3D = geoToCartesian(target.geoCurrentPosition, targetAltitude, GLOBE_RADIUS);
    const distance3D = vec3Magnitude(vec3Subtract(interceptorPos3D, targetPos3D));

    // Debug: log distance periodically
    if (Math.random() < 0.05) {
      console.log(`[GUIDED] Distance: ${distance3D.toFixed(1)} units (need <${config.interceptRadius3D}), altitudes: int=${interceptor.altitude.toFixed(1)}, tgt=${targetAltitude.toFixed(1)}`);
    }

    // Check if close enough for intercept attempt (using 3D distance in globe units)
    if (distance3D <= config.interceptRadius3D) {
      // Attempt intercept
      const hitProbability = this.calculateHitProbability(interceptor, target);
      const roll = Math.random();

      if (roll < hitProbability) {
        // HIT!
        console.log(`[GUIDED INTERCEPTOR] HIT! (${(hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);

        target.intercepted = true;
        interceptor.status = 'hit';
        interceptor.detonated = true;

        // Update target position to match intercept point
        target.geoCurrentPosition = { ...interceptor.geoPosition };

        events.push({
          type: 'interception',
          tick: state.tick,
          missileId: target.id,
          interceptorId: interceptor.id,
          position: target.currentPosition || { x: 0, y: 0 },
        } as InterceptionEvent);
      } else {
        // MISS - one shot, mark as missed (no retry)
        console.log(`[GUIDED INTERCEPTOR] MISS! (${(hitProbability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)})`);
        this.markAsMissed(interceptor);
      }
    }

    return events;
  }

  /**
   * Calculate hit probability based on ICBM phase and modifiers.
   */
  private calculateHitProbability(interceptor: GuidedInterceptor, target: Missile): number {
    const config = GUIDED_INTERCEPTOR_CONFIG;

    // Determine ICBM phase based on progress
    const phase = this.getIcbmPhase(target.progress);

    // Base probability by phase
    let probability = config.hitProbability[phase];

    // No guidance penalty
    if (!interceptor.hasGuidance) {
      probability -= config.noGuidancePenalty;
    } else {
      // Multi-radar bonus
      const extraRadars = Math.max(0, interceptor.trackingRadarIds.length - 1);
      const radarBonus = Math.min(config.maxRadarBonus, extraRadars * config.multiRadarBonus);
      probability += radarBonus;
    }

    // Low fuel penalty
    if (interceptor.fuel / interceptor.maxFuel < config.lowFuelThreshold) {
      probability -= config.lowFuelPenalty;
    }

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
   * Mark interceptor as expired (out of fuel/time).
   */
  private markAsExpired(interceptor: GuidedInterceptor): void {
    interceptor.status = 'expired';
    interceptor.detonated = true;
    console.log(`[GUIDED INTERCEPTOR] Expired - out of fuel/time`);
  }

  /**
   * Mark interceptor as crashed (hit ground).
   */
  private markAsCrashed(interceptor: GuidedInterceptor): void {
    interceptor.status = 'crashed';
    interceptor.detonated = true;
    console.log(`[GUIDED INTERCEPTOR] Crashed`);
  }

  /**
   * Mark interceptor as missed (failed hit roll, no retry).
   */
  private markAsMissed(interceptor: GuidedInterceptor): void {
    interceptor.status = 'missed';
    interceptor.detonated = true;
    console.log(`[GUIDED INTERCEPTOR] Marked as missed`);
  }

  /**
   * Normalize angle to -180 to 180 range.
   */
  private normalizeAngle(angle: number): number {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
  }

  /**
   * Generate a biased random value between -1 and 1.
   * @param forwardBias Probability (0-1) that the value will be positive
   */
  private generateBiasedError(forwardBias: number): number {
    if (Math.random() < forwardBias) {
      // Positive bias (forward/overspeed)
      return Math.random(); // 0 to 1
    } else {
      // Negative bias (behind/underspeed)
      return -Math.random(); // -1 to 0
    }
  }

  /**
   * Estimate hit probability for UI display.
   */
  estimateHitProbability(
    silo: Silo,
    targetMissile: Missile,
    trackingRadarCount: number
  ): number {
    const config = GUIDED_INTERCEPTOR_CONFIG;

    // Estimate phase at likely intercept point
    const estimatedInterceptProgress = Math.max(0.15, Math.min(0.8, targetMissile.progress + 0.2));
    const phase = this.getIcbmPhase(estimatedInterceptProgress);

    let probability = config.hitProbability[phase];

    // Multi-radar bonus
    const extraRadars = Math.max(0, trackingRadarCount - 1);
    const radarBonus = Math.min(config.maxRadarBonus, extraRadars * config.multiRadarBonus);
    probability += radarBonus;

    return Math.max(0.05, Math.min(0.95, probability));
  }
}
