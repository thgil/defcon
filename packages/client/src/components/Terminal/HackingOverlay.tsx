import { useCallback } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useNetworkStore } from '../../stores/networkStore';
import { HackType, HACK_RISK_LEVELS } from '@defcon/shared';

// Get risk level label
function getRiskLabel(hackType: HackType): { label: string; class: string } {
  const risk = HACK_RISK_LEVELS[hackType];
  if (risk <= 0.7) return { label: 'LOW', class: 'risk-low' };
  if (risk <= 1.0) return { label: 'MEDIUM', class: 'risk-medium' };
  if (risk <= 1.5) return { label: 'HIGH', class: 'risk-high' };
  return { label: 'CRITICAL', class: 'risk-critical' };
}

// Get hack type display name
function getHackTypeName(hackType: HackType): string {
  switch (hackType) {
    case 'blind_radar': return 'Blind Radar';
    case 'spoof_radar': return 'Spoof Contacts';
    case 'lock_silo': return 'Lock Silo Mode';
    case 'delay_silo': return 'Delay Silo';
    case 'disable_satellite': return 'Disable Satellite';
    case 'intercept_comms': return 'Intercept Comms';
    case 'forge_alert': return 'Forge Alert';
    default: return hackType;
  }
}

export default function HackingOverlay() {
  const activeHack = useTerminalStore((s) => s.activeHack);
  const hackDisconnect = useNetworkStore((s) => s.hackDisconnect);

  const handleDisconnect = useCallback(() => {
    if (activeHack) {
      hackDisconnect(activeHack.hackId);
    }
  }, [activeHack, hackDisconnect]);

  if (!activeHack) {
    return null;
  }

  const risk = getRiskLabel(activeHack.hackType);
  const isTraceWarning = activeHack.traceProgress >= 75;
  const isTraceDanger = activeHack.traceProgress >= 90;

  return (
    <div className={`hacking-overlay ${isTraceDanger ? 'trace-danger' : isTraceWarning ? 'trace-warning' : ''}`}>
      <div className="hack-overlay-header">
        <span className="hack-status-icon">
          {activeHack.status === 'connecting' ? '◌' : '◉'}
        </span>
        ACTIVE INTRUSION - {activeHack.targetName}
      </div>

      <div className="hack-overlay-body">
        <div className="hack-info-row">
          <span className="info-label">Status:</span>
          <span className={`info-value status-${activeHack.status}`}>
            {activeHack.status.toUpperCase()}
          </span>
        </div>

        <div className="hack-info-row">
          <span className="info-label">Attack:</span>
          <span className="info-value">{getHackTypeName(activeHack.hackType)}</span>
        </div>

        <div className="hack-info-row">
          <span className="info-label">Risk:</span>
          <span className={`info-value ${risk.class}`}>{risk.label}</span>
        </div>

        <div className="hack-progress-section">
          <div className="progress-row">
            <span className="progress-label">Hack Progress</span>
            <div className="progress-bar-container">
              <div className="progress-bar-bg">
                <div
                  className="progress-bar-fill hack-fill"
                  style={{ width: `${activeHack.progress}%` }}
                />
              </div>
              <span className="progress-percent">{Math.floor(activeHack.progress)}%</span>
            </div>
          </div>

          <div className="progress-row">
            <span className="progress-label">Trace Progress</span>
            <div className="progress-bar-container">
              <div className="progress-bar-bg">
                <div
                  className={`progress-bar-fill trace-fill ${isTraceDanger ? 'danger' : isTraceWarning ? 'warning' : ''}`}
                  style={{ width: `${activeHack.traceProgress}%` }}
                />
              </div>
              <span className={`progress-percent ${isTraceDanger ? 'danger' : isTraceWarning ? 'warning' : ''}`}>
                {Math.floor(activeHack.traceProgress)}%
              </span>
            </div>
          </div>
        </div>

        {isTraceWarning && (
          <div className={`trace-alert ${isTraceDanger ? 'danger' : ''}`}>
            {isTraceDanger ? '⚠ TRACE IMMINENT - DISCONNECT NOW!' : '⚠ WARNING: Trace progress high'}
          </div>
        )}
      </div>

      <div className="hack-overlay-footer">
        <button className="disconnect-btn" onClick={handleDisconnect}>
          [ESC] DISCONNECT
        </button>
      </div>
    </div>
  );
}
