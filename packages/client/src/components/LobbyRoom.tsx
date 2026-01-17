import { useNetworkStore } from '../stores/networkStore';

const TERRITORY_NAMES: Record<string, string> = {
  north_america: 'North America',
  south_america: 'South America',
  europe: 'Europe',
  russia: 'Russia',
  africa: 'Africa',
  asia: 'Asia',
};

export default function LobbyRoom() {
  const lobbyState = useNetworkStore((s) => s.lobbyState);
  const leaveLobby = useNetworkStore((s) => s.leaveLobby);
  const setReady = useNetworkStore((s) => s.setReady);
  const selectTerritory = useNetworkStore((s) => s.selectTerritory);
  const startGame = useNetworkStore((s) => s.startGame);
  const error = useNetworkStore((s) => s.error);

  if (!lobbyState) {
    return <div>Loading...</div>;
  }

  const { lobby, playerId, players, availableTerritories, isHost } = lobbyState;
  const myPlayer = players.find((p) => p.id === playerId);
  const allReady = players.every((p) => p.ready && p.territoryId);
  const canStart = isHost && allReady && players.length >= 2;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: 32,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <h2 className="title">{lobby?.name}</h2>
        <button onClick={leaveLobby}>Leave</button>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid #ff0000',
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 24, flex: 1 }}>
        {/* Players list */}
        <div className="panel" style={{ width: 300 }}>
          <h3 style={{ marginBottom: 16, color: '#888' }}>Players</h3>
          {players.map((player) => (
            <div
              key={player.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 0',
                borderBottom: '1px solid var(--color-bg-grid)',
              }}
            >
              <span>{player.name}</span>
              <span
                style={{
                  color: player.ready ? '#00ff00' : '#ff0000',
                  fontSize: 12,
                }}
              >
                {player.ready ? 'READY' : 'NOT READY'}
              </span>
            </div>
          ))}
        </div>

        {/* Territory selection */}
        <div className="panel" style={{ flex: 1 }}>
          <h3 style={{ marginBottom: 16, color: '#888' }}>Select Territory</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 12,
            }}
          >
            {Object.entries(TERRITORY_NAMES).map(([id, name]) => {
              const owner = players.find((p) => p.territoryId === id);
              const isAvailable = availableTerritories.includes(id);
              const isMine = owner?.id === playerId;

              return (
                <button
                  key={id}
                  onClick={() => isAvailable && selectTerritory(id)}
                  disabled={!isAvailable && !isMine}
                  style={{
                    padding: 16,
                    background: isMine
                      ? 'rgba(0, 255, 0, 0.2)'
                      : owner
                      ? 'rgba(255, 255, 255, 0.1)'
                      : undefined,
                    borderColor: isMine ? '#00ff00' : undefined,
                  }}
                >
                  <div>{name}</div>
                  {owner && (
                    <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
                      {owner.name}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 24,
        }}
      >
        <button
          onClick={() => {
            if (myPlayer) setReady(!myPlayer.ready);
          }}
          style={{
            background: myPlayer?.ready
              ? 'rgba(0, 255, 0, 0.2)'
              : undefined,
          }}
        >
          {myPlayer?.ready ? 'READY' : 'NOT READY'}
        </button>

        {isHost && (
          <button
            onClick={startGame}
            disabled={!canStart}
            style={{
              background: canStart ? 'rgba(255, 0, 0, 0.3)' : undefined,
              borderColor: canStart ? '#ff0000' : undefined,
            }}
          >
            START GAME
          </button>
        )}
      </div>

      <div style={{ marginTop: 16, color: '#666', fontSize: 12 }}>
        {players.length} / {lobby?.maxPlayers} players
        {isHost && ' (You are the host)'}
      </div>
    </div>
  );
}
