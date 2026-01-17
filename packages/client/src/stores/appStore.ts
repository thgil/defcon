import { create } from 'zustand';

type Screen = 'menu' | 'lobby_browser' | 'lobby_room' | 'game';

interface AppState {
  screen: Screen;
  playerName: string;
  setScreen: (screen: Screen) => void;
  setPlayerName: (name: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  screen: 'menu',
  playerName: '',
  setScreen: (screen) => set({ screen }),
  setPlayerName: (playerName) => set({ playerName }),
}));
