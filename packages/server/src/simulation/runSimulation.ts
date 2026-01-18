#!/usr/bin/env npx tsx

/**
 * CLI Runner for Interceptor Simulation Test Harness
 *
 * Usage:
 *   npx tsx packages/server/src/simulation/runSimulation.ts
 *
 * Options:
 *   --iterations <n>  Number of iterations per scenario (default: 1000)
 *   --scenario <n>    Run only scenario A, B, or C
 *   --verbose         Show detailed output for each run
 */

import {
  InterceptorSimulation,
  DEFAULT_SCENARIOS,
  ScenarioDefinition,
  SimulationConfig,
} from './InterceptorSimulation';

function parseArgs(): { iterations: number; scenario?: string; verbose: boolean; sweep: boolean } {
  const args = process.argv.slice(2);
  let iterations = 1000;
  let scenario: string | undefined;
  let verbose = false;
  let sweep = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      iterations = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--scenario' && args[i + 1]) {
      scenario = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--sweep') {
      sweep = true;
    } else if (args[i] === '--help') {
      console.log(`
Interceptor Simulation Test Harness

Usage:
  npx tsx packages/server/src/simulation/runSimulation.ts [options]

Options:
  --iterations <n>  Number of iterations per scenario (default: 1000)
  --scenario <A|B|C> Run only a specific scenario
  --verbose         Show detailed output
  --sweep           Sweep launch delays to find optimal timing
  --help            Show this help message

Scenarios:
  A - Far Position:    Enemy silo far from ICBM path (expected: 0-15% hit rate)
  B - Good Position:   Enemy silo at reasonable angle (expected: 40-75% hit rate)
  C - Optimal Position: Enemy silo under flight path (expected: 80-95% hit rate)
      `);
      process.exit(0);
    }
  }

  return { iterations, scenario, verbose, sweep };
}

function runVerboseSingle(sim: InterceptorSimulation, config: SimulationConfig, name: string): void {
  console.log(`\nRunning single ${name} simulation...`);
  const result = sim.runSingle(config);
  console.log(`  Outcome: ${result.outcome}`);
  console.log(`  ICBM progress at resolution: ${(result.icbmProgressAtResolution * 100).toFixed(1)}%`);
  console.log(`  Interceptor phase: ${result.interceptorPhase}`);
  console.log(`  Fuel remaining: ${result.interceptorFuelRemaining.toFixed(2)}s`);
  console.log(`  Total sim time: ${result.totalSimulationTime.toFixed(0)}ms`);
}

function runLaunchDelaySweep(sim: InterceptorSimulation, iterations: number): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  LAUNCH DELAY SWEEP - Finding optimal timing for Scenario C');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const baseConfig: SimulationConfig = {
    friendlySiloGeo: { lat: 0, lng: 0 },
    targetGeo: { lat: 0, lng: 30 },
    enemySiloGeo: { lat: 0, lng: 15 }, // Optimal position (midpoint)
    interceptorLaunchDelay: 0, // Will be varied
  };

  console.log('Delay(ms)  |  Hit Rate  |  Avg Progress  |  Avg Fuel  |  Phase Distribution');
  console.log('─'.repeat(80));

  const delays = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 12000, 15000];

  for (const delay of delays) {
    const config = { ...baseConfig, interceptorLaunchDelay: delay };
    const result = sim.runBatch(config, iterations);

    const hitRateStr = `${(result.hitRate * 100).toFixed(1)}%`.padStart(8);
    const progressStr = `${(result.averageInterceptProgress * 100).toFixed(1)}%`.padStart(12);
    const fuelStr = `${result.averageFuelRemaining.toFixed(2)}s`.padStart(8);

    // Simplified phase distribution
    const terminalPct = ((result.phaseDistribution.terminal / result.totalRuns) * 100).toFixed(0);
    const coastPct = ((result.phaseDistribution.coast / result.totalRuns) * 100).toFixed(0);
    const phaseStr = `T:${terminalPct}% C:${coastPct}%`;

    console.log(`${delay.toString().padStart(8)}  | ${hitRateStr}  | ${progressStr}  | ${fuelStr}  |  ${phaseStr}`);
  }

  console.log('\n');
}

function main(): void {
  const { iterations, scenario, verbose, sweep } = parseArgs();

  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║           INTERCEPTOR SIMULATION TEST HARNESS                      ║');
  console.log('║                                                                    ║');
  console.log('║  Tests ICBM vs Interceptor scenarios to measure hit rates          ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  const sim = new InterceptorSimulation();

  // Filter scenarios if specific one requested
  let scenariosToRun = DEFAULT_SCENARIOS;
  if (scenario) {
    const scenarioIndex = scenario === 'A' ? 0 : scenario === 'B' ? 1 : scenario === 'C' ? 2 : -1;
    if (scenarioIndex === -1) {
      console.error(`Unknown scenario: ${scenario}. Use A, B, or C.`);
      process.exit(1);
    }
    scenariosToRun = [DEFAULT_SCENARIOS[scenarioIndex]];
  }

  if (verbose) {
    // Run single iterations first for each scenario
    for (const s of scenariosToRun) {
      runVerboseSingle(sim, s.config, s.name);
    }
    console.log('\n');
  }

  if (sweep) {
    // Run launch delay sweep to find optimal timing
    runLaunchDelaySweep(sim, iterations);
    return;
  }

  // Run full batch simulations
  sim.runScenarios(scenariosToRun, iterations);

  // Summary table
  console.log('\n┌────────────────────────────┬─────────────┬─────────────┬──────────┐');
  console.log('│ Scenario                   │ Hit Rate    │ Expected    │ Status   │');
  console.log('├────────────────────────────┼─────────────┼─────────────┼──────────┤');

  for (const s of scenariosToRun) {
    const result = sim.runBatch(s.config, iterations);
    const hitRateStr = `${(result.hitRate * 100).toFixed(1)}%`.padStart(10);
    const expectedStr = `${(s.expectedHitRateMin * 100).toFixed(0)}-${(s.expectedHitRateMax * 100).toFixed(0)}%`.padStart(10);
    const status =
      result.hitRate >= s.expectedHitRateMin && result.hitRate <= s.expectedHitRateMax
        ? '   ✓ PASS'
        : '   ✗ FAIL';

    // Extract scenario letter
    const letter = s.name.includes('A') ? 'A' : s.name.includes('B') ? 'B' : 'C';
    const shortName = `Scenario ${letter}`.padEnd(26);

    console.log(`│ ${shortName} │ ${hitRateStr} │ ${expectedStr} │${status} │`);
  }

  console.log('└────────────────────────────┴─────────────┴─────────────┴──────────┘\n');
}

main();
