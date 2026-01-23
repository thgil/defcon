import { useGameStore } from '../stores/gameStore';
import { useNetworkStore } from '../stores/networkStore';
import { type Silo, type Radar, type BuildingType, type GameSpeed, getBuildings, getPlayers } from '@defcon/shared';

const DEFCON_COLORS: Record<number, string> = {
  5: '#00ff00',
  4: '#88ff00',
  3: '#ffff00',
  2: '#ff8800',
  1: '#ff0000',
};

export default function GameHUD() {
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const placementMode = useGameStore((s) => s.placementMode);
  const setPlacementMode = useGameStore((s) => s.setPlacementMode);
  const selectedBuilding = useGameStore((s) => s.selectedBuilding);
  const setSiloMode = useNetworkStore((s) => s.setSiloMode);
  const setGameSpeed = useNetworkStore((s) => s.setGameSpeed);

  if (!gameState || !playerId) return null;

  const currentSpeed = gameState.gameSpeed || 1;

  const player = gameState.players[playerId];
  const defconColor = DEFCON_COLORS[gameState.defconLevel];
  const timeLeft = Math.ceil(gameState.defconTimer / 1000);
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;

  // Count buildings
  const myBuildings = getBuildings(gameState).filter(
    (b) => b.ownerId === playerId && !b.destroyed
  );
  const siloCount = myBuildings.filter((b) => b.type === 'silo').length;
  const radarCount = myBuildings.filter((b) => b.type === 'radar').length;
  const airfieldCount = myBuildings.filter((b) => b.type === 'airfield').length;

  const canPlace = gameState.defconLevel === 5;

  return (
    <>
      {/* Top bar - DEFCON level */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 60,
          background: 'rgba(0, 0, 0, 0.8)',
          borderBottom: `2px solid ${defconColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div
            style={{
              fontSize: 32,
              fontWeight: 'bold',
              color: defconColor,
              textShadow: `0 0 10px ${defconColor}`,
            }}
          >
            DEFCON {gameState.defconLevel}
          </div>
          <div style={{ color: '#888' }}>
            {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([1, 2, 5] as GameSpeed[]).map((speed) => (
              <button
                key={speed}
                onClick={() => setGameSpeed(speed)}
                style={{
                  padding: '4px 8px',
                  fontSize: 12,
                  background: currentSpeed === speed ? 'rgba(0, 255, 136, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                  border: currentSpeed === speed ? '1px solid #00ff88' : '1px solid #444',
                  color: currentSpeed === speed ? '#00ff88' : '#888',
                  cursor: 'pointer',
                }}
              >
                {speed}x
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 32 }}>
          {getPlayers(gameState).map((p) => (
            <div
              key={p.id}
              style={{
                textAlign: 'center',
                opacity: p.id === playerId ? 1 : 0.6,
              }}
            >
              <div style={{ fontSize: 12, color: '#888' }}>{p.name}</div>
              <div
                style={{
                  fontSize: 16,
                  color: p.id === playerId ? '#00ff88' : '#ff4444',
                }}
              >
                {(p.populationRemaining / 1000000).toFixed(1)}M
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Left sidebar - Building placement (DEFCON 5 only) */}
      {canPlace && (
        <div
          style={{
            position: 'absolute',
            top: 80,
            left: 16,
            background: 'rgba(0, 0, 0, 0.8)',
            border: '1px solid var(--color-border)',
            padding: 16,
          }}
        >
          <h3 style={{ marginBottom: 12, fontSize: 14, color: '#888' }}>
            DEPLOY UNITS
          </h3>

          <BuildingButton
            type="silo"
            label="Silo"
            count={siloCount}
            max={gameState.config.startingUnits.silos}
            active={placementMode === 'silo'}
            onClick={() => setPlacementMode(placementMode === 'silo' ? null : 'silo')}
          />
          <BuildingButton
            type="radar"
            label="Radar"
            count={radarCount}
            max={gameState.config.startingUnits.radars}
            active={placementMode === 'radar'}
            onClick={() => setPlacementMode(placementMode === 'radar' ? null : 'radar')}
          />
          <BuildingButton
            type="airfield"
            label="Airfield"
            count={airfieldCount}
            max={gameState.config.startingUnits.airfields}
            active={placementMode === 'airfield'}
            onClick={() => setPlacementMode(placementMode === 'airfield' ? null : 'airfield')}
          />

          <p style={{ fontSize: 10, color: '#666', marginTop: 12 }}>
            Right-click to cancel
          </p>
        </div>
      )}

      {/* Selected building info */}
      {selectedBuilding && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            background: 'rgba(0, 0, 0, 0.8)',
            border: '1px solid var(--color-border)',
            padding: 16,
            minWidth: 200,
          }}
        >
          <h3 style={{ marginBottom: 8, textTransform: 'uppercase' }}>
            {selectedBuilding.type}
          </h3>

          {selectedBuilding.type === 'silo' && (
            <SiloPanel
              silo={selectedBuilding as Silo}
              onModeChange={(mode) => setSiloMode(selectedBuilding.id, mode)}
            />
          )}

          {selectedBuilding.type === 'radar' && (
            <div style={{ fontSize: 12, color: '#888' }}>
              Range: {(selectedBuilding as Radar).range}
            </div>
          )}
        </div>
      )}

      {/* Bottom status bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 40,
          background: 'rgba(0, 0, 0, 0.8)',
          borderTop: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          fontSize: 12,
          color: '#666',
        }}
      >
        <div>
          Population: {(player.populationRemaining / 1000000).toFixed(1)}M
        </div>
        <div>Score: {player.score}</div>
        <div>
          Kills: {(player.enemyKills / 1000000).toFixed(1)}M
        </div>
      </div>
    </>
  );
}

function BuildingButton({
  type,
  label,
  count,
  max,
  active,
  onClick,
}: {
  type: BuildingType;
  label: string;
  count: number;
  max: number;
  active: boolean;
  onClick: () => void;
}) {
  const remaining = max - count;

  return (
    <button
      onClick={onClick}
      disabled={remaining <= 0}
      style={{
        display: 'block',
        width: '100%',
        marginBottom: 8,
        padding: '8px 12px',
        textAlign: 'left',
        background: active ? 'rgba(0, 255, 136, 0.2)' : undefined,
        borderColor: active ? '#00ff88' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{label}</span>
        <span style={{ color: '#888' }}>
          {remaining}/{max}
        </span>
      </div>
    </button>
  );
}

function SiloPanel({
  silo,
  onModeChange,
}: {
  silo: Silo;
  onModeChange: (mode: 'air_defense' | 'icbm') => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        Mode: {silo.mode === 'air_defense' ? 'Air Defense' : 'ICBM'}
      </div>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
        {silo.mode === 'air_defense'
          ? `Interceptors: ${silo.airDefenseAmmo}`
          : `Missiles: ${silo.missileCount}`}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onModeChange('air_defense')}
          disabled={silo.mode === 'air_defense'}
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 10,
            background: silo.mode === 'air_defense' ? 'rgba(0, 255, 255, 0.2)' : undefined,
          }}
        >
          DEFEND
        </button>
        <button
          onClick={() => onModeChange('icbm')}
          disabled={silo.mode === 'icbm'}
          style={{
            flex: 1,
            padding: '4px 8px',
            fontSize: 10,
            background: silo.mode === 'icbm' ? 'rgba(255, 0, 0, 0.2)' : undefined,
          }}
        >
          ATTACK
        </button>
      </div>
    </div>
  );
}
