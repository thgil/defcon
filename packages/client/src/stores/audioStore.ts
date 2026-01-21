import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AudioState {
  musicVolume: number;      // 0-1
  sfxVolume: number;        // 0-1
  musicEnabled: boolean;
  sfxEnabled: boolean;
}

interface AudioStore extends AudioState {
  setMusicVolume: (volume: number) => void;
  setSfxVolume: (volume: number) => void;
  setMusicEnabled: (enabled: boolean) => void;
  setSfxEnabled: (enabled: boolean) => void;
  toggleMusic: () => void;
  toggleSfx: () => void;
}

export const useAudioStore = create<AudioStore>()(
  persist(
    (set) => ({
      // Default to 60% of original values (0.3 * 0.6 = 0.18 for music, 0.5 * 0.6 = 0.3 for sfx)
      musicVolume: 0.18,
      sfxVolume: 0.3,
      musicEnabled: true,
      sfxEnabled: true,

      setMusicVolume: (volume) => set({ musicVolume: Math.max(0, Math.min(1, volume)) }),
      setSfxVolume: (volume) => set({ sfxVolume: Math.max(0, Math.min(1, volume)) }),
      setMusicEnabled: (enabled) => set({ musicEnabled: enabled }),
      setSfxEnabled: (enabled) => set({ sfxEnabled: enabled }),
      toggleMusic: () => set((state) => ({ musicEnabled: !state.musicEnabled })),
      toggleSfx: () => set((state) => ({ sfxEnabled: !state.sfxEnabled })),
    }),
    {
      name: 'defcon-audio-settings',
    }
  )
);
