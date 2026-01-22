import { useTerminalStore, TERMINAL_THEMES, type TerminalTheme } from '../../../stores/terminalStore';
import { useAudioStore } from '../../../stores/audioStore';
import { soundEffects } from '../../../audio/SoundEffects';

export default function OptionsTab() {
  const theme = useTerminalStore((s) => s.theme);
  const setTheme = useTerminalStore((s) => s.setTheme);

  const musicVolume = useAudioStore((s) => s.musicVolume);
  const sfxVolume = useAudioStore((s) => s.sfxVolume);
  const musicEnabled = useAudioStore((s) => s.musicEnabled);
  const sfxEnabled = useAudioStore((s) => s.sfxEnabled);
  const setMusicVolume = useAudioStore((s) => s.setMusicVolume);
  const setSfxVolume = useAudioStore((s) => s.setSfxVolume);
  const toggleMusic = useAudioStore((s) => s.toggleMusic);
  const toggleSfx = useAudioStore((s) => s.toggleSfx);

  const themes = Object.entries(TERMINAL_THEMES) as [TerminalTheme, typeof TERMINAL_THEMES[TerminalTheme]][];

  return (
    <div className="options-tab">
      <div className="options-header">
        ┌───────────────────────────────────────┐
        <br />
        │ TERMINAL OPTIONS                      │
        <br />
        └───────────────────────────────────────┘
      </div>

      <div className="options-section">
        <div className="options-section-title">AUDIO</div>
        <div className="audio-options">
          <div className="audio-option">
            <label className="audio-label">
              <input
                type="checkbox"
                checked={musicEnabled}
                onChange={() => {
                  soundEffects.playClick();
                  toggleMusic();
                }}
              />
              <span>Music</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(musicVolume * 100)}
              onChange={(e) => setMusicVolume(parseInt(e.target.value) / 100)}
              disabled={!musicEnabled}
              className="volume-slider"
            />
            <span className="volume-value">{Math.round(musicVolume * 100)}%</span>
          </div>
          <div className="audio-option">
            <label className="audio-label">
              <input
                type="checkbox"
                checked={sfxEnabled}
                onChange={() => {
                  soundEffects.playClick();
                  toggleSfx();
                }}
              />
              <span>Sound FX</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(sfxVolume * 100)}
              onChange={(e) => setSfxVolume(parseInt(e.target.value) / 100)}
              disabled={!sfxEnabled}
              className="volume-slider"
            />
            <span className="volume-value">{Math.round(sfxVolume * 100)}%</span>
          </div>
        </div>
      </div>

      <div className="options-section">
        <div className="options-section-title">COLOR THEME</div>
        <div className="theme-list">
          {themes.map(([id, config]) => (
            <button
              key={id}
              className={`theme-option ${theme === id ? 'active' : ''}`}
              onClick={() => {
                soundEffects.playClick();
                setTheme(id);
              }}
              style={{ '--theme-color': config.primary } as React.CSSProperties}
            >
              <span className="theme-indicator" style={{ background: config.primary }} />
              <span className="theme-name">{config.name}</span>
              {theme === id && <span className="theme-check">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
