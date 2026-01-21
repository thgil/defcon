import { useRef, useEffect } from 'react';
import { useTerminalStore } from '../../../stores/terminalStore';
import TerminalPrompt from '../TerminalPrompt';

export default function CommandsTab() {
  const commandHistory = useTerminalStore((s) => s.commandHistory);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new commands are added
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [commandHistory]);

  return (
    <div className="commands-tab">
      <div className="commands-output" ref={outputRef}>
        <div className="commands-welcome">{
`╔═══════════════════════════════════════════════════════════╗
║  NORAD DEFENSE TERMINAL v3.14.159                         ║
║  Type 'help' for available commands                       ║
╚═══════════════════════════════════════════════════════════╝`
        }</div>
        {commandHistory.map((entry) => (
          <div key={entry.id} className="command-entry">
            <div className="command-line">
              <span className="command-prompt">&gt;</span>
              <span className="command-text">{entry.command}</span>
            </div>
            <div className={`command-output ${entry.isError ? 'error' : ''}`}>
              {entry.output.map((line, i) => (
                <div key={i} className="output-line">
                  {line}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TerminalPrompt />
    </div>
  );
}
