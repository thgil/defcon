import { useState, useRef, useEffect, useCallback } from 'react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminalCommands } from '../../hooks/useTerminalCommands';

export default function TerminalPrompt() {
  const currentInput = useTerminalStore((s) => s.currentInput);
  const setCurrentInput = useTerminalStore((s) => s.setCurrentInput);
  const commandHistory = useTerminalStore((s) => s.commandHistory);

  const { processCommand } = useTerminalCommands();

  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Get command history (just the commands, not outputs)
  const getCommandList = useCallback(() => {
    return commandHistory.map((h) => h.command).reverse();
  }, [commandHistory]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentInput.trim()) {
        processCommand(currentInput);
        setHistoryIndex(-1);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const commands = getCommandList();
      if (commands.length > 0) {
        const newIndex = Math.min(historyIndex + 1, commands.length - 1);
        setHistoryIndex(newIndex);
        setCurrentInput(commands[newIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const commands = getCommandList();
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setCurrentInput(commands[newIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCurrentInput('');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Simple tab completion for commands
      const commands = ['help', 'status', 'defcon', 'email', 'clear', 'list', 'select', 'mode', 'launch', 'population', 'score'];
      const input = currentInput.toLowerCase();
      const match = commands.find((c) => c.startsWith(input));
      if (match && input.length > 0) {
        setCurrentInput(match);
      }
    }
  };

  return (
    <div className="terminal-prompt">
      <span className="prompt-symbol">&gt;</span>
      <input
        ref={inputRef}
        type="text"
        value={currentInput}
        onChange={(e) => {
          setCurrentInput(e.target.value);
          setHistoryIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        placeholder="Enter command..."
        spellCheck={false}
        autoComplete="off"
      />
      <span className="prompt-cursor">█</span>
    </div>
  );
}
