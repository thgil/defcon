import { useTerminalStore, TERMINAL_THEMES, type TerminalTheme } from '../../../stores/terminalStore';

export default function OptionsTab() {
  const theme = useTerminalStore((s) => s.theme);
  const setTheme = useTerminalStore((s) => s.setTheme);

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
        <div className="options-section-title">COLOR THEME</div>
        <div className="theme-list">
          {themes.map(([id, config]) => (
            <button
              key={id}
              className={`theme-option ${theme === id ? 'active' : ''}`}
              onClick={() => setTheme(id)}
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
