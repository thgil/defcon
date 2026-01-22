import { useCallback, useRef, useEffect, useState } from 'react';
import { useTerminalStore, TERMINAL_THEMES } from '../../stores/terminalStore';
import { useEvilAI } from '../../hooks/useEvilAI';
import { useSystemEmails } from '../../hooks/useSystemEmails';
import { soundEffects } from '../../audio/SoundEffects';
import TerminalScreen from './TerminalScreen';
import HackingOverlay from './HackingOverlay';
import './Terminal.css';

export default function Terminal() {
  const isOpen = useTerminalStore((s) => s.isOpen);
  const isMinimized = useTerminalStore((s) => s.isMinimized);
  const position = useTerminalStore((s) => s.position);
  const setPosition = useTerminalStore((s) => s.setPosition);
  const isDragging = useTerminalStore((s) => s.isDragging);
  const setDragging = useTerminalStore((s) => s.setDragging);
  const minimize = useTerminalStore((s) => s.minimize);
  const restore = useTerminalStore((s) => s.restore);
  const theme = useTerminalStore((s) => s.theme);
  const glitchActive = useTerminalStore((s) => s.glitchActive);
  const glitchIntensity = useTerminalStore((s) => s.glitchIntensity);
  const getUnreadCount = useTerminalStore((s) => s.getUnreadCount);
  const hasPlayedStartup = useTerminalStore((s) => s.hasPlayedStartup);
  const setHasPlayedStartup = useTerminalStore((s) => s.setHasPlayedStartup);

  const { aiPresenceLevel } = useEvilAI();

  // Startup animation state
  const [isStartingUp, setIsStartingUp] = useState(false);

  // System emails (DEFCON changes, etc.)
  useSystemEmails();

  // Startup animation - plays once when terminal is first opened
  useEffect(() => {
    if (!isMinimized && !hasPlayedStartup) {
      setIsStartingUp(true);
      soundEffects.playComputerStartup();

      // Animation duration matches CSS (2.5 seconds)
      const timer = setTimeout(() => {
        setIsStartingUp(false);
        setHasPlayedStartup(true);
      }, 2500);

      return () => clearTimeout(timer);
    }
  }, [isMinimized, hasPlayedStartup, setHasPlayedStartup]);

  const dragOffset = useRef({ x: 0, y: 0 });
  const terminalRef = useRef<HTMLDivElement>(null);

  // Handle dragging
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.terminal-title-bar')) {
        setDragging(true);
        dragOffset.current = {
          x: e.clientX - position.x,
          y: e.clientY - position.y,
        };
      }
    },
    [position, setDragging]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: Math.max(0, e.clientX - dragOffset.current.x),
        y: Math.max(0, e.clientY - dragOffset.current.y),
      });
    };

    const handleMouseUp = () => {
      setDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, setDragging, setPosition]);

  const unreadCount = getUnreadCount();

  const themeConfig = TERMINAL_THEMES[theme];

  // Minimized state - just show title bar at bottom
  if (isMinimized) {
    return (
      <div
        className="terminal terminal-minimized"
        onClick={() => {
          soundEffects.playClick();
          restore();
        }}
        style={{
          '--terminal-primary': themeConfig.primary,
          '--terminal-bg': themeConfig.background,
        } as React.CSSProperties}
      >
        <div className="terminal-title-bar">
          <div className="terminal-title">
            <span className="terminal-icon">█</span>
            NORAD DEFENSE TERMINAL v3.14.159
            {unreadCount > 0 && (
              <span className="terminal-unread-badge">{unreadCount}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={terminalRef}
      className={`terminal ${glitchActive ? 'glitch' : ''} ${isStartingUp ? 'startup-animation' : ''}`}
      style={{
        left: position.x,
        top: position.y,
        '--glitch-intensity': glitchIntensity,
        '--ai-presence': aiPresenceLevel / 100,
        '--terminal-primary': themeConfig.primary,
        '--terminal-bg': themeConfig.background,
      } as React.CSSProperties}
      onMouseDown={handleMouseDown}
    >
      <div className="terminal-title-bar">
        <div className="terminal-title">
          <span className="terminal-icon">█</span>
          NORAD DEFENSE TERMINAL v3.14.159
          {unreadCount > 0 && (
            <span className="terminal-unread-badge">{unreadCount}</span>
          )}
        </div>
        <div className="terminal-controls">
          <button
            className="terminal-minimize"
            onClick={(e) => {
              e.stopPropagation();
              soundEffects.playBack();
              minimize();
            }}
          >
            ×
          </button>
        </div>
      </div>
      <TerminalScreen />

      {/* CRT overlay effects */}
      <div className="terminal-scanlines" />
      <div className="terminal-vignette" />

      {/* Glitch overlay */}
      {glitchActive && (
        <div
          className="terminal-glitch-overlay"
          style={{ opacity: glitchIntensity * 0.5 }}
        />
      )}

      {/* Hacking overlay */}
      <HackingOverlay />
    </div>
  );
}
