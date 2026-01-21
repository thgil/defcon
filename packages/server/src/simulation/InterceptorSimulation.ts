/**
 * Interceptor Simulation Test Harness
 *
 * Runs thousands of ICBM vs Interceptor scenarios to measure hit percentages
 * under different conditions and intercept geometries.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Missile,
  PhysicsMissile,
  GeoPosition,
  InterceptorPhase,
  Silo,
  DEFAULT_GAME_CONFIG,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
} from '@defcon/shared';
import {
  geoToCartesian,
  cartesianToGeo,
  greatCircleDistance,
  geoInterpolate,
  vec3Normalize,
  vec3Distance,
  Vector3,
} from '@defcon/shared';
import { InterceptorPhysics, INTERCEPTOR_PHYSICS_CONFIG } from './InterceptorPhysics';

// Globe radius (must match client and InterceptorPhysics)
const GLOBE_RADIUS = 100;

// Simulation constants
const TICK_RATE = 20; // Hz (50ms per tick, matching game)
const MAX_SIMULATION_TIME = 60000; // 60 seconds max

export interface SimulationConfig {
  friendlySiloGeo: GeoPosition;
  targetGeo: GeoPosition;
  enemySiloGeo: GeoPosition;
  interceptorLaunchDelay: number; // ms after ICBM launch
}

export interface SimulationResult {
  outcome: 'hit' | 'miss' | 'ground_collision' | 'timeout';
  icbmProgressAtResolution: number;
  interceptorPhase: InterceptorPhase;
  interceptorFuelRemaining: number;
  totalSimulationTime: number;
}

export interface BatchResult {
  totalRuns: number;
  hits: number;
  misses: number;
  groundCollisions: number;
  timeouts: number;
  hitRate: number;
  averageInterceptProgress: number;
  averageFuelRemaining: number;
  phaseDistribution: Record<InterceptorPhase, number>;
}

export interface ScenarioDefinition {
  name: string;
  description: string;
  config: SimulationConfig;
  expectedHitRateMin: number;
  expectedHitRateMax: number;
}

/**
 * Creates a minimal game state for simulation
 */
function createMinimalGameState(): GameState {
  return {
    id: 'simulation',
    config: DEFAULT_GAME_CONFIG,
    phase: 'active',
    defconLevel: 1,
    defconTimer: 0,
    tick: 0,
    timestamp: 0,
    players: {},
    territories: {},
    cities: {},
    buildings: {},
    missiles: {},
    satellites: {},
    aircraft: {},
  };
}

/**
 * Creates a mock silo at the given geo position
 */
function createMockSilo(geoPosition: GeoPosition): Silo {
  return {
    id: uuidv4(),
    type: 'silo',
    territoryId: 'mock',
    ownerId: 'mock',
    position: { x: 0, y: 0 },
    geoPosition,
    health: 100,
    destroyed: false,
    mode: 'icbm',
    modeSwitchCooldown: 0,
    missileCount: 10,
    airDefenseAmmo: 10,
    lastFireTime: 0,
    fireCooldown: 0,
  };
}

/**
 * Launches an ICBM from a geo position to a target
 */
function launchICBM(
  launchGeo: GeoPosition,
  targetGeo: GeoPosition,
  simTime: number,
  missileSpeed: number
): Missile {
  const angularDistance = greatCircleDistance(launchGeo, targetGeo);
  const distance = angularDistance * 100;
  const flightDuration = Math.max(6000, (distance / missileSpeed) * 1000);

  return {
    id: uuidv4(),
    type: 'icbm',
    ownerId: 'friendly',
    sourceId: 'friendly-silo',
    launchPosition: { x: 0, y: 0 },
    targetPosition: { x: 0, y: 0 },
    currentPosition: { x: 0, y: 0 },
    launchTime: simTime,
    flightDuration,
    progress: 0,
    apexHeight: Math.min(distance * 0.3, 200),
    intercepted: false,
    detonated: false,
    geoLaunchPosition: { ...launchGeo },
    geoTargetPosition: { ...targetGeo },
    geoCurrentPosition: { ...launchGeo },
  };
}

/**
 * Launches a physics-based interceptor targeting an ICBM
 */
function launchInterceptor(
  launchGeo: GeoPosition,
  targetMissile: Missile,
  simTime: number,
  missileSpeed: number
): PhysicsMissile {
  // Get launch position in 3D (on globe surface)
  const launchPos3D = geoToCartesian(launchGeo, 0, GLOBE_RADIUS);
  const up = vec3Normalize(launchPos3D);

  // Estimate flight duration for legacy compatibility
  const targetGeo = targetMissile.geoCurrentPosition || targetMissile.geoLaunchPosition || launchGeo;
  const angularDistance = greatCircleDistance(launchGeo, targetGeo);
  const distance = angularDistance * 100;
  const flightDuration = Math.max(6000, (distance / (missileSpeed * 1.25)) * 1000);

  return {
    id: uuidv4(),
    type: 'interceptor',
    ownerId: 'enemy',
    sourceId: 'enemy-silo',

    // Physics state
    position: { ...launchPos3D },
    velocity: { x: 0, y: 0, z: 0 },
    heading: { ...up },

    // Fuel
    fuel: INTERCEPTOR_PHYSICS_CONFIG.maxFuel,
    maxFuel: INTERCEPTOR_PHYSICS_CONFIG.maxFuel,
    thrust: 0,

    // Phase
    phase: 'boost',
    targetId: targetMissile.id,

    // Status
    launchTime: simTime,
    intercepted: false,
    detonated: false,
    engineFlameout: false,

    // Rendering compatibility
    geoCurrentPosition: { ...launchGeo },

    // Legacy fields
    launchPosition: { x: 0, y: 0 },
    targetPosition: { x: 0, y: 0 },
    currentPosition: { x: 0, y: 0 },
    progress: 0,
    flightDuration,
    geoLaunchPosition: launchGeo,
    geoTargetPosition: targetGeo,
  };
}

/**
 * Updates ICBM position based on progress
 */
function updateICBM(icbm: Missile, dt: number): void {
  if (icbm.detonated || icbm.intercepted) return;

  const progressDelta = dt / icbm.flightDuration;
  icbm.progress = Math.min(1, icbm.progress + progressDelta);

  // Update geo position
  if (icbm.geoLaunchPosition && icbm.geoTargetPosition) {
    icbm.geoCurrentPosition = geoInterpolate(
      icbm.geoLaunchPosition,
      icbm.geoTargetPosition,
      icbm.progress
    );
  }
}

/**
 * Get the 3D position of an ICBM at current progress
 */
function getICBMPosition3D(icbm: Missile): Vector3 | null {
  if (!icbm.geoCurrentPosition) return null;

  const progress = icbm.progress;
  const altitude = 4 * (icbm.apexHeight || 30) * progress * (1 - progress);

  return geoToCartesian(icbm.geoCurrentPosition, altitude, GLOBE_RADIUS);
}

/**
 * Main simulation class
 */
export class InterceptorSimulation {
  private interceptorPhysics: InterceptorPhysics;
  private missileSpeed: number;

  constructor() {
    this.interceptorPhysics = new InterceptorPhysics();
    this.missileSpeed = DEFAULT_GAME_CONFIG.missileSpeed;
  }

  /**
   * Run a single simulation scenario
   */
  runSingle(config: SimulationConfig): SimulationResult {
    // Create minimal game state
    const state = createMinimalGameState();

    // Track simulation time (ms)
    let simTime = 0;

    // Override Date.now for the simulation
    const originalDateNow = Date.now;
    let mockTime = originalDateNow();
    Date.now = () => mockTime;

    try {
      // Launch ICBM
      const icbm = launchICBM(
        config.friendlySiloGeo,
        config.targetGeo,
        mockTime,
        this.missileSpeed
      );
      state.missiles[icbm.id] = icbm;

      // Track interceptor (launched after delay)
      let interceptor: PhysicsMissile | null = null;

      const dtMs = 1000 / TICK_RATE; // 50ms per tick
      const dtSec = dtMs / 1000;

      while (simTime < MAX_SIMULATION_TIME) {
        simTime += dtMs;
        mockTime += dtMs;
        state.tick++;
        state.timestamp = mockTime;

        // Launch interceptor after delay
        if (!interceptor && simTime >= config.interceptorLaunchDelay) {
          interceptor = launchInterceptor(
            config.enemySiloGeo,
            icbm,
            mockTime,
            this.missileSpeed
          );
          state.missiles[interceptor.id] = interceptor;
        }

        // Update ICBM
        updateICBM(icbm, dtMs);

        // Update interceptor physics
        if (interceptor && !interceptor.detonated) {
          const events = this.interceptorPhysics.update(interceptor, state, dtSec);

          // Check for interception event
          if (events.some((e) => e.type === 'interception')) {
            return {
              outcome: 'hit',
              icbmProgressAtResolution: icbm.progress,
              interceptorPhase: interceptor.phase,
              interceptorFuelRemaining: interceptor.fuel,
              totalSimulationTime: simTime,
            };
          }

          // Check for ground collision (interceptor detonated without hitting target)
          if (interceptor.detonated && !icbm.intercepted) {
            return {
              outcome: 'ground_collision',
              icbmProgressAtResolution: icbm.progress,
              interceptorPhase: interceptor.phase,
              interceptorFuelRemaining: interceptor.fuel,
              totalSimulationTime: simTime,
            };
          }
        }

        // Check if ICBM reached target
        if (icbm.progress >= 1.0) {
          return {
            outcome: 'miss',
            icbmProgressAtResolution: 1.0,
            interceptorPhase: interceptor?.phase || 'boost',
            interceptorFuelRemaining: interceptor?.fuel || 0,
            totalSimulationTime: simTime,
          };
        }

        // Check if ICBM was intercepted (alternative check)
        if (icbm.intercepted) {
          return {
            outcome: 'hit',
            icbmProgressAtResolution: icbm.progress,
            interceptorPhase: interceptor?.phase || 'terminal',
            interceptorFuelRemaining: interceptor?.fuel || 0,
            totalSimulationTime: simTime,
          };
        }
      }

      // Timeout
      return {
        outcome: 'timeout',
        icbmProgressAtResolution: icbm.progress,
        interceptorPhase: interceptor?.phase || 'boost',
        interceptorFuelRemaining: interceptor?.fuel || 0,
        totalSimulationTime: simTime,
      };
    } finally {
      // Restore Date.now
      Date.now = originalDateNow;
    }
  }

  /**
   * Run a batch of simulations with the same config
   */
  runBatch(config: SimulationConfig, iterations: number): BatchResult {
    const results: SimulationResult[] = [];
    const phaseDistribution: Record<InterceptorPhase, number> = {
      boost: 0,
      pitch: 0,
      cruise: 0,
      terminal: 0,
      coast: 0,
    };

    for (let i = 0; i < iterations; i++) {
      const result = this.runSingle(config);
      results.push(result);
      phaseDistribution[result.interceptorPhase]++;
    }

    const hits = results.filter((r) => r.outcome === 'hit').length;
    const misses = results.filter((r) => r.outcome === 'miss').length;
    const groundCollisions = results.filter((r) => r.outcome === 'ground_collision').length;
    const timeouts = results.filter((r) => r.outcome === 'timeout').length;

    const averageProgress =
      results.reduce((sum, r) => sum + r.icbmProgressAtResolution, 0) / results.length;
    const averageFuel =
      results.reduce((sum, r) => sum + r.interceptorFuelRemaining, 0) / results.length;

    return {
      totalRuns: iterations,
      hits,
      misses,
      groundCollisions,
      timeouts,
      hitRate: hits / iterations,
      averageInterceptProgress: averageProgress,
      averageFuelRemaining: averageFuel,
      phaseDistribution,
    };
  }

  /**
   * Run multiple scenarios and return comprehensive results
   */
  runScenarios(scenarios: ScenarioDefinition[], iterationsPerScenario: number): void {
    console.log('\n' + '='.repeat(70));
    console.log('INTERCEPTOR SIMULATION TEST HARNESS');
    console.log('='.repeat(70));
    console.log(`Running ${iterationsPerScenario} iterations per scenario\n`);

    for (const scenario of scenarios) {
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Scenario: ${scenario.name}`);
      console.log(`Description: ${scenario.description}`);
      console.log(`Expected hit rate: ${scenario.expectedHitRateMin * 100}% - ${scenario.expectedHitRateMax * 100}%`);
      console.log('─'.repeat(70));

      const result = this.runBatch(scenario.config, iterationsPerScenario);

      const hitRatePercent = (result.hitRate * 100).toFixed(1);
      const status =
        result.hitRate >= scenario.expectedHitRateMin && result.hitRate <= scenario.expectedHitRateMax
          ? '✓ PASS'
          : '✗ FAIL';

      console.log(`\nResults:`);
      console.log(`  Hits:             ${result.hits}/${result.totalRuns} (${hitRatePercent}%) ${status}`);
      console.log(`  Misses:           ${result.misses}`);
      console.log(`  Ground Collisions: ${result.groundCollisions}`);
      console.log(`  Timeouts:         ${result.timeouts}`);
      console.log(`\nStats:`);
      console.log(`  Avg intercept progress: ${(result.averageInterceptProgress * 100).toFixed(1)}%`);
      console.log(`  Avg fuel remaining:     ${result.averageFuelRemaining.toFixed(2)}s`);
      console.log(`\nPhase at resolution:`);
      for (const [phase, count] of Object.entries(result.phaseDistribution)) {
        if (count > 0) {
          console.log(`  ${phase}: ${count} (${((count / result.totalRuns) * 100).toFixed(1)}%)`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('SIMULATION COMPLETE');
    console.log('='.repeat(70) + '\n');
  }
}

/**
 * Predefined test scenarios
 *
 * Launch delays are tuned based on ICBM flight dynamics:
 * - ICBM flies from (0,0) to (0,30) - about 52 game units
 * - ICBM speed is ~1 unit/sec (with 0.5x multiplier)
 * - Flight duration is ~26 seconds
 * - Interceptor has 8s fuel, ~4 units/sec speed
 *
 * Expected hit rates are based on empirical testing of the physics engine.
 * The physics are intentionally challenging - interceptors have limited fuel
 * and must reach the target while still powered for good accuracy.
 *
 * Key factors affecting hit rate:
 * - Fuel: 8 seconds, after which accuracy drops to 30% of base
 * - Base hit probability: 85% + 10% in terminal phase
 * - Distance factor: closer = better accuracy
 */
export const DEFAULT_SCENARIOS: ScenarioDefinition[] = [
  {
    name: 'Scenario A: Far Position (Low Success)',
    description: 'Enemy silo positioned far from ICBM flight path - interceptor should rarely hit',
    config: {
      friendlySiloGeo: { lat: 0, lng: 0 },
      targetGeo: { lat: 0, lng: 30 },
      enemySiloGeo: { lat: -15, lng: 40 }, // Far south-east, past target
      interceptorLaunchDelay: 8000, // Launch when ICBM is ~30% through flight
    },
    expectedHitRateMin: 0,
    expectedHitRateMax: 0.10, // Very poor geometry - essentially no chance
  },
  {
    name: 'Scenario B: Good Position (Medium Success)',
    description: 'Enemy silo at reasonable intercept angle - fair chance of hitting',
    config: {
      friendlySiloGeo: { lat: 0, lng: 0 },
      targetGeo: { lat: 0, lng: 30 },
      enemySiloGeo: { lat: 5, lng: 15 }, // Slightly north of midpoint
      interceptorLaunchDelay: 5000, // Launch when ICBM is approaching midpoint
    },
    expectedHitRateMin: 0.35,
    expectedHitRateMax: 0.60, // Reasonable but not optimal geometry
  },
  {
    name: 'Scenario C: Optimal Position (High Success)',
    description: 'Enemy silo directly under ICBM flight path - best intercept geometry',
    config: {
      friendlySiloGeo: { lat: 0, lng: 0 },
      targetGeo: { lat: 0, lng: 30 },
      enemySiloGeo: { lat: 0, lng: 15 }, // Directly on flight path midpoint
      interceptorLaunchDelay: 7000, // Optimal timing based on sweep analysis
    },
    expectedHitRateMin: 0.45,
    expectedHitRateMax: 0.70, // Best possible with current physics (~50% reach target with fuel)
  },
];
