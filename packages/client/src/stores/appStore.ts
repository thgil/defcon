import { create } from 'zustand';

type Screen = 'landing' | 'menu' | 'lobby_browser' | 'lobby_room' | 'game';

interface AppState {
  screen: Screen;
  playerName: string;
  setScreen: (screen: Screen) => void;
  setPlayerName: (name: string) => void;
}

// Check for ?play URL parameter to skip landing page
const urlParams = new URLSearchParams(window.location.search);
const skipLanding = urlParams.has('play');

export const useAppStore = create<AppState>((set) => ({
  screen: skipLanding ? 'menu' : 'landing',
  playerName: '',
  setScreen: (screen) => set({ screen }),
  setPlayerName: (playerName) => set({ playerName }),
}));
