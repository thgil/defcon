import { useCallback } from 'react';
import { useTerminalStore } from '../stores/terminalStore';
import { useGameStore } from '../stores/gameStore';
import { useNetworkStore } from '../stores/networkStore';
import {
  getBuildings,
  getCities,
  type Building,
  type Silo,
  type Radar,
  type Airfield,
  type SatelliteLaunchFacility,
  type SiloMode,
  type HackType,
  type DetectedBuilding,
  DEFCON_HACKING_CONFIG,
  HACK_RISK_LEVELS,
} from '@defcon/shared';

interface CommandResult {
  output: string[];
  isError?: boolean;
}

// Generate installation names
function getBuildingName(building: Building, index: number): string {
  switch (building.type) {
    case 'silo':
      return `SILO-${String(index + 1).padStart(2, '0')}`;
    case 'radar':
      return `RADAR-${String(index + 1).padStart(2, '0')}`;
    case 'airfield':
      return `AFB-${String(index + 1).padStart(2, '0')}`;
    case 'satellite_launch_facility':
      return `SAT-${String(index + 1).padStart(2, '0')}`;
  }
}

export function useTerminalCommands() {
  const executeCommand = useTerminalStore((s) => s.executeCommand);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const clearHistory = useTerminalStore((s) => s.clearHistory);
  const getUnreadCount = useTerminalStore((s) => s.getUnreadCount);
  const detectedBuildings = useTerminalStore((s) => s.detectedBuildings);
  const activeHack = useTerminalStore((s) => s.activeHack);
  const setActiveHack = useTerminalStore((s) => s.setActiveHack);
  const intrusionAlerts = useTerminalStore((s) => s.intrusionAlerts);
  const compromisedBuildings = useTerminalStore((s) => s.compromisedBuildings);

  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const selectBuilding = useGameStore((s) => s.selectBuilding);

  const setSiloMode = useNetworkStore((s) => s.setSiloMode);
  const launchMissile = useNetworkStore((s) => s.launchMissile);
  const hackScan = useNetworkStore((s) => s.hackScan);
  const hackStart = useNetworkStore((s) => s.hackStart);
  const hackDisconnect = useNetworkStore((s) => s.hackDisconnect);
  const hackPurge = useNetworkStore((s) => s.hackPurge);
  const hackTrace = useNetworkStore((s) => s.hackTrace);

  const getMyBuildings = useCallback(() => {
    if (!gameState || !playerId) return [];
    return getBuildings(gameState).filter(
      (b) => b.ownerId === playerId && !b.destroyed
    );
  }, [gameState, playerId]);

  const getBuildingByName = useCallback(
    (name: string): { building: Building; displayName: string } | null => {
      const buildings = getMyBuildings();
      const typeGroups: Record<string, Building[]> = {
        silo: [],
        radar: [],
        airfield: [],
        satellite_launch_facility: [],
      };

      for (const b of buildings) {
        typeGroups[b.type].push(b);
      }

      const upperName = name.toUpperCase();

      // Check each type
      for (const [type, group] of Object.entries(typeGroups)) {
        for (let i = 0; i < group.length; i++) {
          const displayName = getBuildingName(group[i], i);
          if (displayName === upperName || displayName.includes(upperName)) {
            return { building: group[i], displayName };
          }
        }
      }

      return null;
    },
    [getMyBuildings]
  );

  const commands: Record<string, (args: string[]) => CommandResult> = {
    help: () => ({
      output: [
        '┌─────────────────────────────────────────────────────────┐',
        '│ NORAD DEFENSE TERMINAL - COMMAND REFERENCE             │',
        '├─────────────────────────────────────────────────────────┤',
        '│ help              Show this help message               │',
        '│ status            Display game status summary          │',
        '│ defcon            Show current DEFCON level            │',
        '│ email             Check unread emails                  │',
        '│ clear             Clear command history                │',
        '│                                                        │',
        '│ list [type]       List installations (silos/radars/...)│',
        '│ select <name>     Select installation on globe         │',
        '│ mode <name> <m>   Set silo mode (attack/defend)        │',
        '│ launch <name> <c> Launch missile at lat,lng            │',
        '│                                                        │',
        '│ population        Show population statistics           │',
        '│ score             Show current scores                  │',
        '├─────────────────────────────────────────────────────────┤',
        '│ CYBER WARFARE (DEFCON 4+)                              │',
        '├─────────────────────────────────────────────────────────┤',
        '│ scan              Scan for enemy systems               │',
        '│ hack <id> <type>  Initiate hack on target              │',
        '│ disconnect        Abort current hack                   │',
        '│ trace             Check for intrusions                 │',
        '│ purge <id>        Remove intrusion from building       │',
        '│ network           Open NETWORK topology view           │',
        '└─────────────────────────────────────────────────────────┘',
      ],
    }),

    status: () => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const buildings = getMyBuildings();
      const silos = buildings.filter((b) => b.type === 'silo') as Silo[];
      const radars = buildings.filter((b) => b.type === 'radar');
      const airfields = buildings.filter((b) => b.type === 'airfield');

      const totalMissiles = silos.reduce((sum, s) => sum + s.missileCount, 0);
      const totalInterceptors = silos.reduce(
        (sum, s) => sum + s.airDefenseAmmo,
        0
      );

      const player = playerId ? gameState.players[playerId] : null;

      return {
        output: [
          '┌───────────────────────────────────────┐',
          '│ STRATEGIC STATUS REPORT               │',
          '├───────────────────────────────────────┤',
          `│ DEFCON Level:    ${String(gameState.defconLevel).padEnd(21)}│`,
          `│ Game Phase:      ${gameState.phase.toUpperCase().padEnd(21)}│`,
          '│                                       │',
          `│ Silos Online:    ${String(silos.length).padEnd(21)}│`,
          `│ Radars Online:   ${String(radars.length).padEnd(21)}│`,
          `│ Airfields:       ${String(airfields.length).padEnd(21)}│`,
          '│                                       │',
          `│ ICBMs Available: ${String(totalMissiles).padEnd(21)}│`,
          `│ Interceptors:    ${String(totalInterceptors).padEnd(21)}│`,
          '│                                       │',
          `│ Population:      ${(player ? player.populationRemaining.toLocaleString() : 'N/A').padEnd(21)}│`,
          `│ Casualties:      ${(player ? player.populationLost.toLocaleString() : 'N/A').padEnd(21)}│`,
          '└───────────────────────────────────────┘',
        ],
      };
    },

    defcon: () => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const level = gameState.defconLevel;
      const bars = '█'.repeat(6 - level) + '░'.repeat(level - 1);
      const status = ['PEACE', 'FADE OUT', 'ROUND HOUSE', 'FAST PACE', 'COCKED PISTOL'][5 - level];

      return {
        output: [
          '',
          `  ████ DEFCON ${level} ████`,
          '',
          `  [${bars}]`,
          '',
          `  Status: ${status}`,
          '',
        ],
      };
    },

    email: () => {
      const unread = getUnreadCount();
      setActiveTab('email');
      return {
        output: [
          unread > 0
            ? `You have ${unread} unread message${unread !== 1 ? 's' : ''}.`
            : 'No unread messages.',
          'Switching to EMAIL tab...',
        ],
      };
    },

    clear: () => {
      clearHistory();
      return { output: ['Terminal cleared.'] };
    },

    list: (args) => {
      const type = args[0]?.toLowerCase();
      const buildings = getMyBuildings();

      const typeGroups: Record<string, Building[]> = {
        silo: buildings.filter((b) => b.type === 'silo'),
        radar: buildings.filter((b) => b.type === 'radar'),
        airfield: buildings.filter((b) => b.type === 'airfield'),
        satellite_launch_facility: buildings.filter(
          (b) => b.type === 'satellite_launch_facility'
        ),
      };

      const output: string[] = [];

      const listGroup = (groupType: string, group: Building[]) => {
        if (group.length === 0) return;

        output.push('');
        output.push(
          `${groupType.toUpperCase().replace('_', ' ')}S (${group.length}):`
        );

        for (let i = 0; i < group.length; i++) {
          const b = group[i];
          const name = getBuildingName(b, i);
          let details = '';

          if (b.type === 'silo') {
            const silo = b as Silo;
            const mode = silo.mode === 'icbm' ? 'ATTACK' : 'DEFEND';
            details = `MODE: ${mode}  ICBM: ${silo.missileCount}  INT: ${silo.airDefenseAmmo}`;
          } else if (b.type === 'radar') {
            const radar = b as Radar;
            details = `RANGE: ${radar.range}km  ${radar.active ? 'ACTIVE' : 'INACTIVE'}`;
          } else if (b.type === 'airfield') {
            const af = b as Airfield;
            details = `F: ${af.fighterCount}  B: ${af.bomberCount}`;
          } else if (b.type === 'satellite_launch_facility') {
            const sat = b as SatelliteLaunchFacility;
            details = `SATELLITES: ${sat.satellites}`;
          }

          output.push(`  ${name}  ${details}`);
        }
      };

      if (type && typeGroups[type]) {
        listGroup(type, typeGroups[type]);
      } else if (type && type !== 'all') {
        return {
          output: [
            `Unknown type: ${type}`,
            'Valid types: silos, radars, airfields, satellite_launch_facility',
          ],
          isError: true,
        };
      } else {
        for (const [t, group] of Object.entries(typeGroups)) {
          listGroup(t, group);
        }
      }

      if (output.length === 0) {
        output.push('No installations found.');
      }

      return { output };
    },

    select: (args) => {
      if (!args[0]) {
        return {
          output: ['Usage: select <installation-name>', 'Example: select SILO-01'],
          isError: true,
        };
      }

      const result = getBuildingByName(args[0]);
      if (!result) {
        return {
          output: [`Installation "${args[0]}" not found.`, 'Use "list" to see available installations.'],
          isError: true,
        };
      }

      selectBuilding(result.building);
      return {
        output: [
          `Selected: ${result.displayName}`,
          'Installation highlighted on globe.',
        ],
      };
    },

    mode: (args) => {
      if (args.length < 2) {
        return {
          output: [
            'Usage: mode <silo-name> <attack|defend>',
            'Example: mode SILO-01 attack',
          ],
          isError: true,
        };
      }

      const result = getBuildingByName(args[0]);
      if (!result || result.building.type !== 'silo') {
        return {
          output: [`Silo "${args[0]}" not found.`],
          isError: true,
        };
      }

      const modeArg = args[1].toLowerCase();
      let mode: SiloMode;
      if (modeArg === 'attack' || modeArg === 'icbm') {
        mode = 'icbm';
      } else if (modeArg === 'defend' || modeArg === 'air_defense') {
        mode = 'air_defense';
      } else {
        return {
          output: ['Invalid mode. Use "attack" or "defend".'],
          isError: true,
        };
      }

      setSiloMode(result.building.id, mode);
      return {
        output: [
          `${result.displayName} mode set to ${mode === 'icbm' ? 'ATTACK' : 'DEFEND'}`,
        ],
      };
    },

    launch: (args) => {
      if (!gameState || gameState.defconLevel !== 1) {
        return {
          output: ['LAUNCH DENIED: Offensive actions only permitted at DEFCON 1'],
          isError: true,
        };
      }

      if (args.length < 2) {
        return {
          output: [
            'Usage: launch <silo-name> <lat,lng>',
            'Example: launch SILO-01 45.5,-122.6',
          ],
          isError: true,
        };
      }

      const result = getBuildingByName(args[0]);
      if (!result || result.building.type !== 'silo') {
        return {
          output: [`Silo "${args[0]}" not found.`],
          isError: true,
        };
      }

      const silo = result.building as Silo;
      if (silo.mode !== 'icbm') {
        return {
          output: [`${result.displayName} is in DEFEND mode. Switch to ATTACK mode first.`],
          isError: true,
        };
      }

      if (silo.missileCount <= 0) {
        return {
          output: [`${result.displayName} has no missiles remaining.`],
          isError: true,
        };
      }

      const coords = args[1].split(',').map((s) => parseFloat(s.trim()));
      if (coords.length !== 2 || coords.some(isNaN)) {
        return {
          output: ['Invalid coordinates. Use format: lat,lng (e.g., 45.5,-122.6)'],
          isError: true,
        };
      }

      // Convert geo to pixel (simplified - matches server's 1000x700 map)
      const [lat, lng] = coords;
      const x = ((lng + 180) / 360) * 1000;
      const y = ((90 - lat) / 180) * 700;

      launchMissile(silo.id, { x, y });

      return {
        output: [
          `████ LAUNCH AUTHORIZED ████`,
          ``,
          `Silo:   ${result.displayName}`,
          `Target: ${lat.toFixed(2)}°, ${lng.toFixed(2)}°`,
          ``,
          `Missile away. God help us all.`,
        ],
      };
    },

    population: () => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const cities = getCities(gameState);
      const myCities = cities.filter(
        (c) => gameState.territories[c.territoryId]?.ownerId === playerId
      );

      const totalPop = myCities.reduce((sum, c) => sum + c.population, 0);
      const maxPop = myCities.reduce((sum, c) => sum + c.maxPopulation, 0);
      const destroyed = myCities.filter((c) => c.destroyed).length;

      const output: string[] = [
        '┌───────────────────────────────────────┐',
        '│ POPULATION STATUS                     │',
        '├───────────────────────────────────────┤',
        `│ Total Population: ${totalPop.toLocaleString().padEnd(20)}│`,
        `│ Maximum:          ${maxPop.toLocaleString().padEnd(20)}│`,
        `│ Cities Intact:    ${(myCities.length - destroyed).toString().padEnd(20)}│`,
        `│ Cities Destroyed: ${destroyed.toString().padEnd(20)}│`,
        '└───────────────────────────────────────┘',
      ];

      return { output };
    },

    score: () => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const players = Object.values(gameState.players).sort(
        (a, b) => b.score - a.score
      );

      const output: string[] = [
        '┌───────────────────────────────────────────────────────┐',
        '│ SCOREBOARD                                            │',
        '├───────────────────────────────────────────────────────┤',
      ];

      for (const player of players) {
        const isYou = player.id === playerId;
        const marker = isYou ? '>' : ' ';
        const name = player.name.padEnd(20);
        const score = player.score.toString().padStart(8);
        output.push(
          `│${marker} ${name} ${score}  Kills: ${player.enemyKills.toString().padStart(4)} │`
        );
      }

      output.push('└───────────────────────────────────────────────────────┘');

      return { output };
    },

    // ============ HACKING COMMANDS ============

    scan: () => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const config = DEFCON_HACKING_CONFIG[gameState.defconLevel];
      if (!config.scanEnabled) {
        return {
          output: [
            'SCAN DISABLED',
            `Scanning only available at DEFCON 4 or lower.`,
            `Current: DEFCON ${gameState.defconLevel}`,
          ],
          isError: true,
        };
      }

      hackScan();
      setActiveTab('network');

      return {
        output: [
          '┌─────────────────────────────────────────┐',
          '│ INITIATING NETWORK SCAN...              │',
          '├─────────────────────────────────────────┤',
          '│ Scanning radar coverage zones...        │',
          '│ Querying satellite reconnaissance...    │',
          '│                                         │',
          '│ Results will appear in NETWORK tab.    │',
          '└─────────────────────────────────────────┘',
        ],
      };
    },

    hack: (args) => {
      if (!gameState) {
        return { output: ['ERROR: No game state available'], isError: true };
      }

      const config = DEFCON_HACKING_CONFIG[gameState.defconLevel];
      if (!config.hackingEnabled) {
        return {
          output: [
            'HACKING DISABLED',
            `Hacking only available at DEFCON 3 or lower.`,
            `Current: DEFCON ${gameState.defconLevel}`,
          ],
          isError: true,
        };
      }

      if (activeHack) {
        return {
          output: [
            'ERROR: Hack already in progress',
            'Use "disconnect" to abort current hack first.',
          ],
          isError: true,
        };
      }

      if (args.length < 2) {
        return {
          output: [
            'Usage: hack <target-id> <type>',
            '',
            'Available hack types:',
            '  blind_radar    - Blinds radar (shows nothing)',
            '  spoof_radar    - Spoofs radar (false contacts)',
            '  lock_silo      - Locks silo mode',
            '  delay_silo     - Adds silo cooldown',
            '  disable_satellite - Disables launch detection',
            '  intercept_comms   - Intercepts enemy emails',
            '',
            'Example: hack RD-01 blind_radar',
          ],
          isError: true,
        };
      }

      const targetCode = args[0].toUpperCase();
      const hackType = args[1].toLowerCase() as HackType;

      // Find target in detected buildings
      const targetIndex = parseInt(targetCode.split('-')[1]) - 1;
      const targetPrefix = targetCode.split('-')[0];

      const typeMap: Record<string, string> = {
        'SL': 'silo',
        'RD': 'radar',
        'AF': 'airfield',
        'ST': 'satellite_launch_facility',
      };

      const targetType = typeMap[targetPrefix];
      if (!targetType) {
        return {
          output: [`Unknown building type: ${targetPrefix}`],
          isError: true,
        };
      }

      const matchingTargets = detectedBuildings.filter((d) => d.type === targetType);
      const target = matchingTargets[targetIndex];

      if (!target) {
        return {
          output: [
            `Target "${targetCode}" not found in detected buildings.`,
            'Run "scan" first to detect enemy buildings.',
          ],
          isError: true,
        };
      }

      // Validate hack type
      const validTypes: HackType[] = ['blind_radar', 'spoof_radar', 'lock_silo', 'delay_silo', 'disable_satellite', 'intercept_comms', 'forge_alert'];
      if (!validTypes.includes(hackType)) {
        return {
          output: [
            `Unknown hack type: ${hackType}`,
            'Valid types: blind_radar, spoof_radar, lock_silo, delay_silo, disable_satellite, intercept_comms',
          ],
          isError: true,
        };
      }

      // Check if hack type is valid for target
      if (!target.vulnerabilities?.includes(hackType)) {
        return {
          output: [
            `${hackType} is not effective against ${targetType}.`,
            `Valid attacks for ${targetType}: ${target.vulnerabilities?.join(', ') || 'none'}`,
          ],
          isError: true,
        };
      }

      // Start hack
      hackStart(target.id, hackType);

      // Set local active hack state for UI
      setActiveHack({
        hackId: 'pending',
        targetId: target.id,
        targetName: targetCode,
        hackType,
        progress: 0,
        traceProgress: 0,
        status: 'connecting',
      });

      const risk = HACK_RISK_LEVELS[hackType];
      const riskLabel = risk <= 0.7 ? 'LOW' : risk <= 1.0 ? 'MEDIUM' : risk <= 1.5 ? 'HIGH' : 'CRITICAL';

      return {
        output: [
          '┌─────────────────────────────────────────┐',
          '│ INITIATING HACK...                      │',
          '├─────────────────────────────────────────┤',
          `│ Target:     ${targetCode.padEnd(27)}│`,
          `│ Attack:     ${hackType.padEnd(27)}│`,
          `│ Risk:       ${riskLabel.padEnd(27)}│`,
          '│                                         │',
          '│ Connection established.                 │',
          '│ Monitor NETWORK tab for progress.       │',
          '│ Type "disconnect" to abort.             │',
          '└─────────────────────────────────────────┘',
        ],
      };
    },

    disconnect: () => {
      if (!activeHack) {
        return {
          output: ['No active hack to disconnect.'],
          isError: true,
        };
      }

      hackDisconnect(activeHack.hackId);
      setActiveHack(null);

      return {
        output: [
          '┌─────────────────────────────────────────┐',
          '│ DISCONNECTING...                        │',
          '├─────────────────────────────────────────┤',
          '│ Connection terminated.                  │',
          '│ Trace avoided.                          │',
          '└─────────────────────────────────────────┘',
        ],
      };
    },

    trace: () => {
      hackTrace();

      const output: string[] = [
        '┌─────────────────────────────────────────┐',
        '│ INTRUSION DETECTION STATUS              │',
        '├─────────────────────────────────────────┤',
      ];

      if (intrusionAlerts.length === 0) {
        output.push('│ No active intrusions detected.          │');
      } else {
        for (const alert of intrusionAlerts) {
          output.push(`│ ⚠ Building under attack!               │`);
          output.push(`│   Trace: ${Math.floor(alert.traceProgress)}%                              │`);
          if (alert.attackerRevealed) {
            output.push(`│   Attacker: ${alert.attackerRevealed.slice(0, 20).padEnd(20)}│`);
          }
        }
      }

      output.push('├─────────────────────────────────────────┤');
      output.push('│ COMPROMISED SYSTEMS                     │');
      output.push('├─────────────────────────────────────────┤');

      if (compromisedBuildings.length === 0) {
        output.push('│ No compromised systems.                 │');
      } else {
        for (const comp of compromisedBuildings) {
          const remaining = comp.expiresAt > 0
            ? Math.max(0, Math.floor((comp.expiresAt - Date.now()) / 1000))
            : 'PERMANENT';
          output.push(`│ ${comp.targetId.slice(0, 15).padEnd(15)} ${String(comp.hackType).padEnd(12)} ${String(remaining).padStart(5)}s │`);
        }
      }

      output.push('└─────────────────────────────────────────┘');

      return { output };
    },

    purge: (args) => {
      if (!args[0]) {
        return {
          output: [
            'Usage: purge <building-id>',
            'Removes detected intrusions from your building.',
          ],
          isError: true,
        };
      }

      // Find building by code
      const targetCode = args[0].toUpperCase();
      const buildings = getMyBuildings();

      const typeGroups: Record<string, Building[]> = {
        silo: buildings.filter((b) => b.type === 'silo'),
        radar: buildings.filter((b) => b.type === 'radar'),
        airfield: buildings.filter((b) => b.type === 'airfield'),
        satellite_launch_facility: buildings.filter((b) => b.type === 'satellite_launch_facility'),
      };

      const prefix = targetCode.split('-')[0];
      const index = parseInt(targetCode.split('-')[1]) - 1;

      const typeMap: Record<string, string> = {
        'SL': 'silo',
        'RD': 'radar',
        'AF': 'airfield',
        'ST': 'satellite_launch_facility',
      };

      const targetType = typeMap[prefix];
      if (!targetType || !typeGroups[targetType] || !typeGroups[targetType][index]) {
        return {
          output: [`Building "${targetCode}" not found.`],
          isError: true,
        };
      }

      const building = typeGroups[targetType][index];

      // Check if building is compromised
      const compromise = compromisedBuildings.find((c) => c.targetId === building.id);
      if (!compromise) {
        return {
          output: [`${targetCode} is not compromised.`],
        };
      }

      hackPurge(building.id);

      return {
        output: [
          '┌─────────────────────────────────────────┐',
          '│ PURGING INTRUSION...                    │',
          '├─────────────────────────────────────────┤',
          `│ Target: ${targetCode.padEnd(31)}│`,
          '│ Running counter-intrusion protocols... │',
          '│ Resetting system access controls...     │',
          '│                                         │',
          '│ Intrusion removed.                      │',
          '└─────────────────────────────────────────┘',
        ],
      };
    },

    network: () => {
      setActiveTab('network');
      return {
        output: ['Switching to NETWORK tab...'],
      };
    },
  };

  const processCommand = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      const handler = commands[cmd];
      if (handler) {
        const result = handler(args);
        executeCommand(trimmed, result.output, result.isError);
      } else {
        executeCommand(
          trimmed,
          [
            `Unknown command: ${cmd}`,
            'Type "help" for available commands.',
          ],
          true
        );
      }
    },
    [commands, executeCommand]
  );

  return { processCommand };
}
