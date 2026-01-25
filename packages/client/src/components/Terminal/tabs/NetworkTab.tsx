import { useEffect, useCallback, useState } from 'react';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useGameStore } from '../../../stores/gameStore';
import { useNetworkStore } from '../../../stores/networkStore';
import { useHackingStore } from '../../../stores/hackingStore';
import {
  getBuildings,
  type Building,
  type Silo,
  type Radar,
  type DetectedBuilding,
  type HackType,
  type HackingConnection,
  DEFCON_HACKING_CONFIG,
} from '@defcon/shared';

// Target types for the selector
type TargetType = 'building' | 'node' | 'cable' | 'satellite';

interface SelectedTarget {
  id: string;
  type: TargetType;
  name: string;
  vulnerabilities: HackType[];
}

// Generate short building names
function getBuildingCode(type: string, index: number): string {
  const prefix = type === 'silo' ? 'SL' :
                 type === 'radar' ? 'RD' :
                 type === 'airfield' ? 'AF' :
                 type === 'satellite_launch_facility' ? 'ST' : '??';
  return `${prefix}-${String(index + 1).padStart(2, '0')}`;
}

// Get a shorter display name for hack types
function getHackTypeName(hackType: HackType): string {
  switch (hackType) {
    case 'blind_radar': return 'BLIND';
    case 'spoof_radar': return 'SPOOF';
    case 'lock_silo': return 'LOCK';
    case 'delay_silo': return 'DELAY';
    case 'disable_satellite': return 'DISABLE';
    case 'intercept_comms': return 'INTERCEPT';
    case 'forge_alert': return 'FORGE';
    // New Phase 1 hacks
    case 'tap_radar': return 'TAP';
    case 'ddos': return 'DDOS';
    case 'compromise_node': return 'INFILTRATE';
    // New Phase 2 hacks
    case 'target_intel': return 'INTEL';
    case 'hijack_satellite': return 'HIJACK';
    case 'launch_warning': return 'MONITOR';
    // New Phase 3 hacks
    case 'cut_cable': return 'CUT';
    case 'false_flag': return 'FALSE FLAG';
    default: return hackType;
  }
}

// Get description for hack type
function getHackTypeDescription(hackType: HackType): string {
  switch (hackType) {
    case 'blind_radar': return 'Disable radar tracking';
    case 'spoof_radar': return 'Inject false contacts';
    case 'tap_radar': return 'See through enemy radar';
    case 'lock_silo': return 'Lock silo mode';
    case 'delay_silo': return 'Slow fire rate';
    case 'target_intel': return 'Reveal silo target';
    case 'launch_warning': return 'Get launch alerts';
    case 'hijack_satellite': return 'See through satellite';
    case 'ddos': return 'Block enemy hacking';
    case 'compromise_node': return 'Monitor/slow traffic';
    case 'cut_cable': return 'Sever undersea cable';
    case 'false_flag': return 'Impersonate attacker';
    default: return '';
  }
}

export default function NetworkTab() {
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const detectedBuildings = useTerminalStore((s) => s.detectedBuildings);
  const activeHack = useTerminalStore((s) => s.activeHack);
  const compromisedBuildings = useTerminalStore((s) => s.compromisedBuildings);
  const intrusionAlerts = useTerminalStore((s) => s.intrusionAlerts);
  const hackScan = useNetworkStore((s) => s.hackScan);
  const hackStart = useNetworkStore((s) => s.hackStart);

  // Network infrastructure from hacking store
  const networkConnections = useHackingStore((s) => s.connections);
  const networkNodes = useHackingStore((s) => s.nodes);

  // Selected target for initiating hacks (now supports multiple target types)
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);

  // Tab for infrastructure vs buildings
  const [infraTab, setInfraTab] = useState<'targets' | 'infrastructure'>('targets');

  // Get intercontinental cables that can be cut
  const intercontinentalCables = Object.values(networkConnections).filter(
    (c) => c.isIntercontinental && c.status === 'active'
  );

  // Get enemy players for DDoS targeting
  const enemyPlayers = gameState && playerId
    ? Object.values(gameState.players).filter(p => p.id !== playerId)
    : [];

  // Get player's buildings
  const myBuildings = gameState && playerId
    ? getBuildings(gameState).filter((b) => b.ownerId === playerId && !b.destroyed)
    : [];

  // Group buildings by type
  const mySilos = myBuildings.filter((b) => b.type === 'silo');
  const myRadars = myBuildings.filter((b) => b.type === 'radar');
  const mySatFacilities = myBuildings.filter((b) => b.type === 'satellite_launch_facility');
  const myAirfields = myBuildings.filter((b) => b.type === 'airfield');

  // Get hacking config for current DEFCON level
  const defconLevel = gameState?.defconLevel || 5;
  const hackConfig = DEFCON_HACKING_CONFIG[defconLevel];

  // Auto-scan on mount and when DEFCON changes
  useEffect(() => {
    if (hackConfig.scanEnabled) {
      hackScan();
    }
  }, [defconLevel, hackConfig.scanEnabled, hackScan]);

  // Manual scan
  const handleScan = useCallback(() => {
    if (hackConfig.scanEnabled) {
      hackScan();
    }
  }, [hackConfig.scanEnabled, hackScan]);

  // Handle building target click
  const handleBuildingClick = useCallback((detected: DetectedBuilding) => {
    if (!hackConfig.hackingEnabled) return;
    if (activeHack) return; // Already hacking

    if (selectedTarget?.id === detected.id) {
      setSelectedTarget(null);
    } else {
      setSelectedTarget({
        id: detected.id,
        type: 'building',
        name: getBuildingCode(detected.type, detectedBuildings.findIndex(b => b.id === detected.id)),
        vulnerabilities: detected.vulnerabilities || ['blind_radar', 'intercept_comms'],
      });
    }
  }, [hackConfig.hackingEnabled, activeHack, selectedTarget, detectedBuildings]);

  // Handle cable target click
  const handleCableClick = useCallback((cable: HackingConnection) => {
    if (!hackConfig.hackingEnabled) return;
    if (activeHack) return;

    const cableId = `cable:${cable.id}`;
    if (selectedTarget?.id === cableId) {
      setSelectedTarget(null);
    } else {
      // Get node names for display
      const fromNode = networkNodes[cable.fromNodeId];
      const toNode = networkNodes[cable.toNodeId];
      const cableName = `${fromNode?.name || cable.fromNodeId} - ${toNode?.name || cable.toNodeId}`;

      setSelectedTarget({
        id: cableId,
        type: 'cable',
        name: cableName,
        vulnerabilities: ['cut_cable'],
      });
    }
  }, [hackConfig.hackingEnabled, activeHack, selectedTarget, networkNodes]);

  // Handle player target click (for DDoS)
  const handlePlayerClick = useCallback((playerId: string, playerName: string) => {
    if (!hackConfig.hackingEnabled) return;
    if (activeHack) return;

    const fullId = `player:${playerId}`;
    if (selectedTarget?.id === fullId) {
      setSelectedTarget(null);
    } else {
      setSelectedTarget({
        id: fullId,
        type: 'node',
        name: `${playerName}'s Network`,
        vulnerabilities: ['ddos'],
      });
    }
  }, [hackConfig.hackingEnabled, activeHack, selectedTarget]);

  // Handle hack type selection
  const handleStartHack = useCallback((hackType: HackType) => {
    console.log('[NetworkTab] handleStartHack called', { hackType, selectedTarget });
    if (!selectedTarget) return;
    console.log('[NetworkTab] Calling hackStart with:', selectedTarget.id, hackType);
    hackStart(selectedTarget.id, hackType);
    setSelectedTarget(null);
  }, [selectedTarget, hackStart]);

  // Clear selected target when a hack starts
  useEffect(() => {
    if (activeHack) {
      setSelectedTarget(null);
    }
  }, [activeHack]);

  // Check if a building is compromised
  const isCompromised = (buildingId: string): HackType | null => {
    const compromise = compromisedBuildings.find((c) => c.targetId === buildingId);
    return compromise?.hackType || null;
  };

  // Check if a building is being targeted
  const isBeingHacked = (buildingId: string): boolean => {
    return intrusionAlerts.some((a) => a.targetId === buildingId);
  };

  // Render building node
  const renderBuildingNode = (building: Building, index: number, isOwn: boolean) => {
    const code = getBuildingCode(building.type, index);
    const compromiseType = isCompromised(building.id);
    const beingHacked = isBeingHacked(building.id);

    let statusIcon = '●';
    let statusClass = 'node-ok';

    if (compromiseType) {
      statusIcon = '!';
      statusClass = 'node-compromised';
    } else if (beingHacked) {
      statusIcon = '?';
      statusClass = 'node-intrusion';
    }

    return (
      <div key={building.id} className={`network-node ${statusClass}`}>
        [{statusIcon}] {code}
        {compromiseType && <span className="node-effect"> ({getHackTypeName(compromiseType)})</span>}
      </div>
    );
  };

  // Render detected enemy node
  const renderEnemyNode = (detected: DetectedBuilding, index: number) => {
    const code = getBuildingCode(detected.type, index);
    const isTarget = activeHack?.targetId === detected.id;
    const isSelected = selectedTarget?.id === detected.id;
    const canHack = hackConfig.hackingEnabled && !activeHack;

    return (
      <div
        key={detected.id}
        className={`network-node enemy-node ${isTarget ? 'node-hacking' : ''} ${isSelected ? 'node-selected' : ''} ${canHack ? 'node-clickable' : ''}`}
        onClick={() => handleBuildingClick(detected)}
      >
        [{isTarget ? '◎' : isSelected ? '◉' : '○'}] {code}
        {isTarget && activeHack && (
          <span className="node-progress"> ({Math.floor(activeHack.progress)}%)</span>
        )}
      </div>
    );
  };

  // Render cable for cutting
  const renderCable = (cable: HackingConnection) => {
    const cableId = `cable:${cable.id}`;
    const isSelected = selectedTarget?.id === cableId;
    const canHack = hackConfig.hackingEnabled && !activeHack && defconLevel <= 2;
    const fromNode = networkNodes[cable.fromNodeId];
    const toNode = networkNodes[cable.toNodeId];

    return (
      <div
        key={cable.id}
        className={`network-node cable-node ${isSelected ? 'node-selected' : ''} ${canHack ? 'node-clickable' : ''}`}
        onClick={() => canHack && handleCableClick(cable)}
      >
        [≈] {fromNode?.name || '???'} ↔ {toNode?.name || '???'}
        {cable.status === 'cut' && <span className="node-effect"> (SEVERED)</span>}
      </div>
    );
  };

  // Render enemy player for DDoS
  const renderEnemyPlayer = (player: { id: string; name: string }) => {
    const fullId = `player:${player.id}`;
    const isSelected = selectedTarget?.id === fullId;
    const canHack = hackConfig.hackingEnabled && !activeHack && defconLevel <= 2;

    return (
      <div
        key={player.id}
        className={`network-node enemy-player ${isSelected ? 'node-selected' : ''} ${canHack ? 'node-clickable' : ''}`}
        onClick={() => canHack && handlePlayerClick(player.id, player.name)}
      >
        [◆] {player.name.toUpperCase()}
      </div>
    );
  };

  return (
    <div className="network-tab">
      <div className="network-header">
        ┌─────────────────────────────────────────────────────────┐
        │ NETWORK TOPOLOGY - CYBER WARFARE INTERFACE              │
        └─────────────────────────────────────────────────────────┘
      </div>

      <div className="network-status">
        <span>DEFCON {defconLevel}</span>
        <span className="status-sep">│</span>
        <span>Scan: {hackConfig.scanEnabled ? 'ENABLED' : 'DISABLED'}</span>
        <span className="status-sep">│</span>
        <span>Hack: {hackConfig.hackingEnabled ? 'ENABLED' : 'DISABLED'}</span>
        {hackConfig.scanEnabled && (
          <button className="scan-button" onClick={handleScan}>
            [SCAN]
          </button>
        )}
      </div>

      {/* Tab selector for targets vs infrastructure */}
      <div className="network-subtabs">
        <button
          className={`subtab ${infraTab === 'targets' ? 'active' : ''}`}
          onClick={() => setInfraTab('targets')}
        >
          TARGETS
        </button>
        <button
          className={`subtab ${infraTab === 'infrastructure' ? 'active' : ''}`}
          onClick={() => setInfraTab('infrastructure')}
        >
          INFRASTRUCTURE
        </button>
      </div>

      {infraTab === 'targets' ? (
        <div className="network-topology">
          <div className="network-section own-systems">
            <div className="section-header">YOUR SYSTEMS</div>
            <div className="node-list">
              {mySilos.map((b, i) => renderBuildingNode(b, i, true))}
              {myRadars.map((b, i) => renderBuildingNode(b, i, true))}
              {mySatFacilities.map((b, i) => renderBuildingNode(b, i, true))}
              {myAirfields.map((b, i) => renderBuildingNode(b, i, true))}
              {myBuildings.length === 0 && (
                <div className="no-buildings">No buildings deployed</div>
              )}
            </div>
          </div>

          <div className="network-firewall">
            <div className="firewall-line">═══════════</div>
            <div className="firewall-label">FIREWALL</div>
            <div className="firewall-line">═══════════</div>
          </div>

          <div className="network-section enemy-systems">
            <div className="section-header">DETECTED TARGETS</div>
            <div className="node-list">
              {detectedBuildings.map((d, i) => renderEnemyNode(d, i))}
              {detectedBuildings.length === 0 && (
                <div className="no-buildings">
                  {hackConfig.scanEnabled ? 'No targets detected (run scan)' : 'Scanning disabled'}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="network-topology infrastructure">
          <div className="network-section">
            <div className="section-header">ENEMY NETWORKS {defconLevel > 2 && '(DEFCON 2+)'}</div>
            <div className="node-list">
              {enemyPlayers.map((p) => renderEnemyPlayer(p))}
              {enemyPlayers.length === 0 && (
                <div className="no-buildings">No enemy players</div>
              )}
            </div>
            <div className="section-hint">Target for DDoS or node compromise</div>
          </div>

          <div className="network-section">
            <div className="section-header">UNDERSEA CABLES {defconLevel > 2 && '(DEFCON 2+)'}</div>
            <div className="node-list">
              {intercontinentalCables.slice(0, 8).map((c) => renderCable(c))}
              {intercontinentalCables.length === 0 && (
                <div className="no-buildings">No cables available</div>
              )}
              {intercontinentalCables.length > 8 && (
                <div className="more-items">+{intercontinentalCables.length - 8} more cables</div>
              )}
            </div>
            <div className="section-hint">Sever to disrupt enemy routing</div>
          </div>
        </div>
      )}

      {/* Active hack display moved to HackingOverlay component */}

      {selectedTarget && (
        <div className="hack-type-selector">
          <div className="selector-header">
            SELECT EXPLOIT FOR {selectedTarget.name}
            {selectedTarget.type === 'cable' && <span className="target-type"> (CABLE)</span>}
            {selectedTarget.type === 'node' && <span className="target-type"> (NETWORK)</span>}
          </div>
          <div className="hack-options">
            {selectedTarget.vulnerabilities.map((hackType) => (
              <button
                key={hackType}
                className="hack-option"
                onClick={() => handleStartHack(hackType)}
                title={getHackTypeDescription(hackType)}
              >
                [{getHackTypeName(hackType)}]
                <span className="hack-desc">{getHackTypeDescription(hackType)}</span>
              </button>
            ))}
            <button className="hack-option cancel" onClick={() => setSelectedTarget(null)}>
              [CANCEL]
            </button>
          </div>
        </div>
      )}

      {intrusionAlerts.length > 0 && (
        <div className="intrusion-alerts">
          <div className="alert-header">⚠ INTRUSION ALERTS</div>
          {intrusionAlerts.map((alert) => (
            <div key={alert.id} className="alert-item">
              Building under attack! Trace: {Math.floor(alert.traceProgress)}%
              {alert.attackerRevealed && (
                <span className="attacker-revealed"> (Attacker: {alert.attackerRevealed})</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="network-help">
        Commands: scan, hack &lt;id&gt; &lt;type&gt;, disconnect, trace, purge &lt;id&gt;
      </div>
    </div>
  );
}
