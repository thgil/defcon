import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { useNetworkStore } from './stores/networkStore';
import MainMenu from './components/MainMenu';
import LobbyBrowser from './components/LobbyBrowser';
import LobbyRoom from './components/LobbyRoom';
import Game from './components/Game';

type Screen = 'menu' | 'lobby_browser' | 'lobby_room' | 'game';

function App() {
  const screen = useAppStore((s) => s.screen);
  const connect = useNetworkStore((s) => s.connect);

  useEffect(() => {
    // Connect to server on mount
    connect();
  }, [connect]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      {screen === 'menu' && <MainMenu />}
      {screen === 'lobby_browser' && <LobbyBrowser />}
      {screen === 'lobby_room' && <LobbyRoom />}
      {screen === 'game' && <Game />}
    </div>
  );
}

export default App;
