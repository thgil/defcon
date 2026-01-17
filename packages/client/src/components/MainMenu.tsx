import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useNetworkStore } from '../stores/networkStore';

export default function MainMenu() {
  const [name, setName] = useState('');
  const setPlayerName = useAppStore((s) => s.setPlayerName);
  const setScreen = useAppStore((s) => s.setScreen);
  const connected = useNetworkStore((s) => s.connected);
  const quickStart = useNetworkStore((s) => s.quickStart);

  const handlePlay = () => {
    if (name.trim()) {
      setPlayerName(name.trim());
      setScreen('lobby_browser');
    }
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
      }}
    >
      <h1
        style={{
          fontSize: 64,
          color: '#ff0000',
          textShadow: '0 0 20px rgba(255, 0, 0, 0.5)',
          letterSpacing: 16,
          fontWeight: 'normal',
        }}
      >
        DEFCON
      </h1>

      <p style={{ color: '#666', fontSize: 14 }}>
        EVERYBODY DIES
      </p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          alignItems: 'center',
          marginTop: 32,
        }}
      >
        <input
          type="text"
          placeholder="Enter your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handlePlay()}
          style={{
            width: 250,
            textAlign: 'center',
            fontSize: 16,
          }}
        />

        <button
          onClick={handlePlay}
          disabled={!name.trim() || !connected}
          style={{
            width: 250,
            padding: 12,
            fontSize: 16,
          }}
        >
          {connected ? 'PLAY' : 'CONNECTING...'}
        </button>

        <button
          onClick={() => {
            setPlayerName(name.trim() || 'Player');
            quickStart();
          }}
          disabled={!connected}
          style={{
            width: 250,
            padding: 12,
            fontSize: 14,
            background: 'rgba(255, 0, 255, 0.2)',
            borderColor: '#ff00ff',
          }}
        >
          QUICK START (Solo Test)
        </button>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 20,
          color: '#333',
          fontSize: 12,
        }}
      >
        {connected ? '● Connected to server' : '○ Connecting...'}
      </div>
    </div>
  );
}
