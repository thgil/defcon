import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useNetworkStore } from '../stores/networkStore';

export default function LobbyBrowser() {
  const [showCreate, setShowCreate] = useState(false);
  const [lobbyName, setLobbyName] = useState('');
  const playerName = useAppStore((s) => s.playerName);
  const setScreen = useAppStore((s) => s.setScreen);
  const lobbies = useNetworkStore((s) => s.lobbies);
  const createLobby = useNetworkStore((s) => s.createLobby);
  const joinLobby = useNetworkStore((s) => s.joinLobby);
  const error = useNetworkStore((s) => s.error);

  const handleCreate = () => {
    if (lobbyName.trim()) {
      createLobby(lobbyName.trim());
      setShowCreate(false);
      setLobbyName('');
    }
  };

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
        <h2 className="title">Game Lobbies</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => setShowCreate(true)}>Create Game</button>
          <button onClick={() => setScreen('menu')}>Back</button>
        </div>
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

      <div className="panel" style={{ flex: 1, overflow: 'auto' }}>
        {lobbies.length === 0 ? (
          <div style={{ color: '#666', textAlign: 'center', padding: 32 }}>
            No games available. Create one!
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: 8 }}>Name</th>
                <th style={{ textAlign: 'left', padding: 8 }}>Host</th>
                <th style={{ textAlign: 'center', padding: 8 }}>Players</th>
                <th style={{ padding: 8 }}></th>
              </tr>
            </thead>
            <tbody>
              {lobbies.map((lobby) => (
                <tr
                  key={lobby.id}
                  style={{ borderBottom: '1px solid var(--color-bg-grid)' }}
                >
                  <td style={{ padding: 8 }}>{lobby.name}</td>
                  <td style={{ padding: 8, color: '#666' }}>{lobby.hostName}</td>
                  <td style={{ textAlign: 'center', padding: 8 }}>
                    {lobby.playerCount}/{lobby.maxPlayers}
                  </td>
                  <td style={{ padding: 8, textAlign: 'right' }}>
                    <button
                      onClick={() => joinLobby(lobby.id)}
                      disabled={lobby.playerCount >= lobby.maxPlayers}
                    >
                      Join
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => setShowCreate(false)}
        >
          <div
            className="panel"
            style={{ width: 400 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="title">Create Game</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <input
                type="text"
                placeholder="Game name"
                value={lobbyName}
                onChange={(e) => setLobbyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowCreate(false)}>Cancel</button>
                <button onClick={handleCreate} disabled={!lobbyName.trim()}>
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, color: '#666', fontSize: 12 }}>
        Playing as: {playerName}
      </div>
    </div>
  );
}
