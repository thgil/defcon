import { useEffect, useCallback } from 'react';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useGameStore } from '../../../stores/gameStore';
import { useNetworkStore } from '../../../stores/networkStore';
import {
  getBuildings,
  type Building,
  type Silo,
  type Radar,
  type DetectedBuilding,
  type HackType,
  DEFCON_HACKING_CONFIG,
} from '@defcon/shared';

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
    default: return hackType;
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

    return (
      <div
        key={detected.id}
        className={`network-node enemy-node ${isTarget ? 'node-hacking' : ''}`}
      >
        [{isTarget ? '◎' : '○'}] {code}
        {isTarget && activeHack && (
          <span className="node-progress"> ({Math.floor(activeHack.progress)}%)</span>
        )}
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

      {activeHack && (
        <div className="active-hack-display">
          <div className="hack-header">ACTIVE INTRUSION</div>
          <div className="hack-info">
            <div>Target: {activeHack.targetName}</div>
            <div>Type: {activeHack.hackType}</div>
            <div>Status: {activeHack.status.toUpperCase()}</div>
          </div>
          <div className="hack-bars">
            <div className="progress-bar">
              <span className="bar-label">Progress:</span>
              <div className="bar-track">
                <div
                  className="bar-fill progress-fill"
                  style={{ width: `${activeHack.progress}%` }}
                />
              </div>
              <span className="bar-value">{Math.floor(activeHack.progress)}%</span>
            </div>
            <div className="progress-bar">
              <span className="bar-label">Trace:</span>
              <div className="bar-track">
                <div
                  className="bar-fill trace-fill"
                  style={{ width: `${activeHack.traceProgress}%` }}
                />
              </div>
              <span className="bar-value">{Math.floor(activeHack.traceProgress)}%</span>
            </div>
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
