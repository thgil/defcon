import { useNetworkStore } from '../stores/networkStore';
import { useGameStore } from '../stores/gameStore';

export default function DebugPanel() {
  const sendDebugCommand = useNetworkStore((s) => s.sendDebugCommand);
  const gameState = useGameStore((s) => s.gameState);

  if (!gameState) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 80,
        right: 16,
        background: 'rgba(0, 0, 0, 0.9)',
        border: '1px solid #ff00ff',
        padding: 12,
        fontSize: 11,
        minWidth: 150,
      }}
    >
      <h4 style={{ marginBottom: 8, color: '#ff00ff', fontSize: 12 }}>
        DEBUG
      </h4>

      <div style={{ marginBottom: 8, color: '#888' }}>
        DEFCON: {gameState.defconLevel}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={() => sendDebugCommand('advance_defcon')}
          style={{
            padding: '4px 8px',
            fontSize: 10,
            background: 'rgba(255, 0, 255, 0.2)',
            borderColor: '#ff00ff',
          }}
        >
          Advance DEFCON
        </button>

        <div style={{ display: 'flex', gap: 4 }}>
          {[5, 4, 3, 2, 1].map((level) => (
            <button
              key={level}
              onClick={() => sendDebugCommand('set_defcon', level)}
              disabled={gameState.defconLevel === level}
              style={{
                flex: 1,
                padding: '4px',
                fontSize: 10,
                background:
                  gameState.defconLevel === level
                    ? 'rgba(255, 0, 255, 0.4)'
                    : undefined,
              }}
            >
              {level}
            </button>
          ))}
        </div>

        <button
          onClick={() => sendDebugCommand('skip_timer')}
          style={{
            padding: '4px 8px',
            fontSize: 10,
          }}
        >
          Skip Timer (1s)
        </button>

        <button
          onClick={() => sendDebugCommand('add_missiles')}
          style={{
            padding: '4px 8px',
            fontSize: 10,
          }}
        >
          Refill Ammo
        </button>
      </div>

      <div style={{ marginTop: 8, fontSize: 9, color: '#666' }}>
        Press D to toggle
      </div>
    </div>
  );
}
