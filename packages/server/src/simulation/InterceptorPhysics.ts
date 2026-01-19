import {
  GameState,
  PhysicsMissile,
  Missile,
  InterceptorPhase,
  GameEvent,
  InterceptionEvent,
  GeoPosition,
  getMissiles,
  isPhysicsMissile,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
} from '@defcon/shared';
import {
  Vector3,
  vec3Add,
  vec3Subtract,
  vec3Scale,
  vec3Normalize,
  vec3Magnitude,
  vec3Lerp,
  vec3Distance,
  vec3RotateToward,
  geoToCartesian,
  cartesianToGeo,
  getUpVector,
} from '@defcon/shared';

// Globe radius (must match client)
const GLOBE_RADIUS = 100;

// Physics configuration (thrust and speed scaled by global multiplier)
export const INTERCEPTOR_PHYSICS_CONFIG = {
  // Thrust and propulsion (scaled by global multiplier)
  maxThrust: 5.0 * GLOBAL_MISSILE_SPEED_MULTIPLIER,   // Units/sec^2 acceleration
  maxFuel: 8,              // Seconds of burn time

  // Flight phases (in seconds from launch)
  boostDuration: 2.0,      // Seconds of vertical boost
  pitchDuration: 1.5,      // Seconds to pitch toward target

  // Terminal guidance
  terminalRange: 3.0,      // Seconds before estimated intercept to enter terminal phase

  // Steering
  maxTurnRate: 45,         // Degrees/second max steering rate (increased from 30)

  // Gravity (toward globe center)
  gravity: 0.015,          // Acceleration toward globe center (units/sec^2)

  // Interception
  interceptRadius: 5.0,    // Units - proximity for interception check (increased for reliability)
  hitProbability: 0.85,    // Base probability of successful intercept

  // Speed limits (scaled by global multiplier)
  maxSpeed: 8.0 * GLOBAL_MISSILE_SPEED_MULTIPLIER,    // Maximum velocity magnitude (units/sec)

  // Lifetime limits (prevent missiles flying forever) - scaled inversely for slower missiles
  maxFlightTime: 30 / GLOBAL_MISSILE_SPEED_MULTIPLIER,  // Maximum total flight time in seconds
  coastTimeout: 15 / GLOBAL_MISSILE_SPEED_MULTIPLIER,   // Max seconds of coasting after flameout before despawn
};

export class InterceptorPhysics {
  /**
   * Update a physics-based interceptor missile each tick
   */
  update(missile: PhysicsMissile, state: GameState, dt: number): GameEvent[] {
    const events: GameEvent[] = [];

    if (missile.detonated || missile.intercepted) {
      return events;
    }

    // 1. Update phase based on elapsed time and conditions
    this.updatePhase(missile, state);

    // 2. Calculate guidance command (desired heading)
    const desiredHeading = this.calculateGuidance(missile, state);

    // 3. Apply thrust and steering (if fuel > 0)
    if (missile.fuel > 0) {
      this.applyThrust(missile, desiredHeading, dt);
      missile.fuel -= dt;
      if (missile.fuel <= 0) {
        missile.fuel = 0;
        missile.engineFlameout = true;
        missile.flameoutTime = Date.now();
        missile.flameoutPosition = { ...missile.position };  // Store position at flameout
        missile.phase = 'coast';
      }
    }

    // 4. Apply gravity (always active)
    this.applyGravity(missile, dt);

    // 5. Clamp velocity to max speed
    const speed = vec3Magnitude(missile.velocity);
    if (speed > INTERCEPTOR_PHYSICS_CONFIG.maxSpeed) {
      missile.velocity = vec3Scale(
        vec3Normalize(missile.velocity),
        INTERCEPTOR_PHYSICS_CONFIG.maxSpeed
      );
    }

    // 6. Integrate position
    missile.position = vec3Add(missile.position, vec3Scale(missile.velocity, dt));

    // 7. Check for ground collision
    const altitude = vec3Magnitude(missile.position) - GLOBE_RADIUS;
    if (altitude < 0) {
      // Hit the ground
      missile.position = vec3Scale(vec3Normalize(missile.position), GLOBE_RADIUS);
      missile.detonated = true;
    }

    // 7b. Check flight timeout - despawn missiles that have coasted too long
    if (missile.engineFlameout && missile.flameoutTime) {
      const coastTime = (Date.now() - missile.flameoutTime) / 1000;
      if (coastTime > INTERCEPTOR_PHYSICS_CONFIG.coastTimeout) {
        missile.detonated = true;
        return events; // Missile timed out
      }
    }

    // 7c. Check total flight time limit (hard cap)
    const totalFlightTime = (Date.now() - missile.launchTime) / 1000;
    if (totalFlightTime > INTERCEPTOR_PHYSICS_CONFIG.maxFlightTime) {
      missile.detonated = true;
      return events; // Missile exceeded max flight time
    }

    // 8. Update geoCurrentPosition for rendering
    const geoWithAlt = cartesianToGeo(missile.position, GLOBE_RADIUS);
    missile.geoCurrentPosition = { lat: geoWithAlt.lat, lng: geoWithAlt.lng };

    // 9. Update legacy progress field for compatibility (approximate)
    if (missile.flightDuration && missile.flightDuration > 0) {
      const elapsed = (Date.now() - missile.launchTime) / 1000;
      missile.progress = Math.min(1.5, elapsed / (missile.flightDuration / 1000));
    }

    // 10. Check for interception
    const interceptionEvents = this.checkInterception(missile, state);
    events.push(...interceptionEvents);

    return events;
  }

  /**
   * Update the flight phase based on elapsed time and conditions
   */
  private updatePhase(missile: PhysicsMissile, state: GameState): void {
    const elapsed = (Date.now() - missile.launchTime) / 1000;
    const config = INTERCEPTOR_PHYSICS_CONFIG;

    // Already in coast phase (no fuel) - stay there
    if (missile.phase === 'coast' || missile.engineFlameout) {
      missile.phase = 'coast';
      return;
    }

    // Boost phase: first N seconds
    if (elapsed < config.boostDuration) {
      missile.phase = 'boost';
      return;
    }

    // Pitch phase: transitioning from vertical to toward target
    if (elapsed < config.boostDuration + config.pitchDuration) {
      missile.phase = 'pitch';
      return;
    }

    // Check for terminal phase based on time to intercept
    if (missile.timeToIntercept !== undefined && missile.timeToIntercept < config.terminalRange) {
      missile.phase = 'terminal';
      return;
    }

    // Default: cruise phase
    missile.phase = 'cruise';
  }

  /**
   * Calculate the desired heading based on current phase
   */
  private calculateGuidance(missile: PhysicsMissile, state: GameState): Vector3 {
    switch (missile.phase) {
      case 'boost':
        // Point straight up (radially outward from globe)
        return getUpVector(missile.position);

      case 'pitch': {
        // Blend from vertical to toward target
        const up = getUpVector(missile.position);
        const toIntercept = this.getInterceptDirection(missile, state);
        const elapsed = (Date.now() - missile.launchTime) / 1000;
        const pitchProgress = (elapsed - INTERCEPTOR_PHYSICS_CONFIG.boostDuration)
          / INTERCEPTOR_PHYSICS_CONFIG.pitchDuration;
        // Smooth easing
        const smoothProgress = pitchProgress * pitchProgress * (3 - 2 * pitchProgress);
        return vec3Normalize(vec3Lerp(up, toIntercept, smoothProgress));
      }

      case 'cruise':
      case 'terminal':
        // Head toward predicted intercept point
        return this.getInterceptDirection(missile, state);

      case 'coast':
        // No guidance - maintain current velocity direction
        if (vec3Magnitude(missile.velocity) > 0.01) {
          return vec3Normalize(missile.velocity);
        }
        return missile.heading;

      default:
        return missile.heading;
    }
  }

  /**
   * Get direction to the predicted intercept point
   */
  private getInterceptDirection(missile: PhysicsMissile, state: GameState): Vector3 {
    // Get target ICBM
    const target = missile.targetId ? state.missiles[missile.targetId] : null;
    if (!target || isPhysicsMissile(target)) {
      // Can't target another physics missile or no target
      return missile.heading;
    }

    // Predict where target will be when we arrive
    const interceptPoint = this.predictIntercept(missile, target as Missile, state);
    if (!interceptPoint) {
      return missile.heading;
    }

    missile.predictedInterceptPoint = interceptPoint;
    const direction = vec3Subtract(interceptPoint, missile.position);
    const mag = vec3Magnitude(direction);
    if (mag < 0.1) {
      return missile.heading;
    }

    return vec3Normalize(direction);
  }

  /**
   * Predict the intercept point using iterative solver
   */
  private predictIntercept(
    interceptor: PhysicsMissile,
    target: Missile,
    state: GameState
  ): Vector3 | null {
    // Get target's current position and velocity
    const targetPos = this.getTargetPosition(target);
    const targetVel = this.getTargetVelocity(target);

    if (!targetPos || !targetVel) {
      return null;
    }

    // Interceptor speed (current or estimated)
    let speed = vec3Magnitude(interceptor.velocity);
    if (speed < 1) {
      // If not moving yet (boost phase), use max speed as estimate
      speed = INTERCEPTOR_PHYSICS_CONFIG.maxSpeed;
    }

    // Iterative solver: find time T where interceptor reaches target's position at T
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const futureTargetPos = vec3Add(targetPos, vec3Scale(targetVel, t));
      const dist = vec3Distance(futureTargetPos, interceptor.position);
      t = dist / Math.max(speed, 0.1);
    }

    interceptor.timeToIntercept = t;
    return vec3Add(targetPos, vec3Scale(targetVel, t));
  }

  /**
   * Get the target ICBM's current 3D position
   */
  private getTargetPosition(target: Missile): Vector3 | null {
    if (!target.geoCurrentPosition) {
      return null;
    }

    // Estimate altitude based on progress (parabolic arc)
    // Altitude = 4 * apex * progress * (1 - progress)
    const progress = target.progress;
    const altitude = 4 * (target.apexHeight || 30) * progress * (1 - progress);

    return geoToCartesian(target.geoCurrentPosition, altitude, GLOBE_RADIUS);
  }

  /**
   * Estimate the target ICBM's velocity
   */
  private getTargetVelocity(target: Missile): Vector3 | null {
    if (!target.geoLaunchPosition || !target.geoTargetPosition) {
      return null;
    }

    // Get start and end positions at altitude
    const startAlt = 0;
    const endAlt = 0;
    const progress = target.progress;
    const currentAlt = 4 * (target.apexHeight || 30) * progress * (1 - progress);

    const start = geoToCartesian(target.geoLaunchPosition, startAlt, GLOBE_RADIUS);
    const end = geoToCartesian(target.geoTargetPosition, endAlt, GLOBE_RADIUS);

    // Calculate approximate velocity as (end - start) / flightDuration
    const flightDurationSec = (target.flightDuration || 30000) / 1000;
    const displacement = vec3Subtract(end, start);
    const velocity = vec3Scale(displacement, 1 / flightDurationSec);

    // Adjust for vertical component (derivative of parabola)
    // d/dt[4*h*t*(1-t)] = 4*h*(1 - 2t)
    const verticalVelFactor = 4 * (target.apexHeight || 30) * (1 - 2 * progress) / flightDurationSec;
    const targetPos = this.getTargetPosition(target);
    if (!targetPos) {
      return velocity;
    }
    const up = getUpVector(targetPos);
    const verticalVel = vec3Scale(up, verticalVelFactor);

    return vec3Add(velocity, verticalVel);
  }

  /**
   * Apply thrust in the desired direction (with steering limits)
   */
  private applyThrust(missile: PhysicsMissile, desiredHeading: Vector3, dt: number): void {
    const config = INTERCEPTOR_PHYSICS_CONFIG;

    // Calculate max turn angle this frame
    const maxTurnAngle = (config.maxTurnRate * Math.PI / 180) * dt;

    // Rotate heading toward desired heading (limited by turn rate)
    missile.heading = vec3RotateToward(missile.heading, desiredHeading, maxTurnAngle);

    // Apply thrust along current heading
    const thrustForce = vec3Scale(missile.heading, config.maxThrust);
    const acceleration = vec3Scale(thrustForce, dt);
    missile.velocity = vec3Add(missile.velocity, acceleration);
    missile.thrust = config.maxThrust;
  }

  /**
   * Apply gravity (toward globe center)
   */
  private applyGravity(missile: PhysicsMissile, dt: number): void {
    const down = vec3Scale(getUpVector(missile.position), -1);
    const gravityAccel = vec3Scale(down, INTERCEPTOR_PHYSICS_CONFIG.gravity);
    missile.velocity = vec3Add(missile.velocity, vec3Scale(gravityAccel, dt));
  }

  /**
   * Check if the interceptor is close enough to intercept the target
   */
  private checkInterception(missile: PhysicsMissile, state: GameState): GameEvent[] {
    const events: GameEvent[] = [];

    const target = missile.targetId ? state.missiles[missile.targetId] : null;
    if (!target || target.detonated || target.intercepted || isPhysicsMissile(target)) {
      return events;
    }

    const targetPos = this.getTargetPosition(target as Missile);
    if (!targetPos) {
      return events;
    }

    const distance = vec3Distance(missile.position, targetPos);
    const config = INTERCEPTOR_PHYSICS_CONFIG;

    if (distance <= config.interceptRadius) {
      // Within interception range - roll for hit
      // Adjust probability based on closing speed and phase
      let hitProb = config.hitProbability;

      // Terminal phase has better accuracy
      if (missile.phase === 'terminal') {
        hitProb += 0.1;
      }

      // Coast phase (no fuel) has worse accuracy
      if (missile.phase === 'coast') {
        hitProb *= 0.3;
      }

      // Distance factor - closer is better
      const distanceFactor = 1 - (distance / config.interceptRadius);
      hitProb *= (0.5 + 0.5 * distanceFactor);

      // Clamp hit probability to valid range [0, 1]
      hitProb = Math.max(0, Math.min(1, hitProb));

      if (Math.random() < hitProb) {
        // Successful interception!
        target.intercepted = true;
        missile.detonated = true;

        // Update target position to match intercept point
        const geoWithAlt = cartesianToGeo(missile.position, GLOBE_RADIUS);
        target.geoCurrentPosition = { lat: geoWithAlt.lat, lng: geoWithAlt.lng };

        events.push({
          type: 'interception',
          tick: state.tick,
          missileId: target.id,
          interceptorId: missile.id,
          position: target.currentPosition || { x: 0, y: 0 },
        } as InterceptionEvent);
      } else {
        // Miss! The interceptor continues flying past
        // Mark as missed so we don't check again
        missile.targetId = undefined;
      }
    }

    return events;
  }
}
