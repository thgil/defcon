import { useEffect, useRef } from 'react';
import { useGameStore } from '../stores/gameStore';
import { useTerminalStore } from '../stores/terminalStore';
import { getDefconEmail, SYSTEM_EMAILS } from '../data/emails';
import type { DefconLevel } from '@defcon/shared';

/**
 * Hook that watches game events and generates system emails
 */
export function useSystemEmails() {
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const addEmail = useTerminalStore((s) => s.addEmail);
  const increasePresence = useTerminalStore((s) => s.increasePresence);

  const lastDefconLevel = useRef<DefconLevel | null>(null);
  const welcomeSent = useRef(false);
  const gameStartTime = useRef<number | null>(null);

  // Send welcome email when game starts
  useEffect(() => {
    if (gameState && playerId && !welcomeSent.current) {
      welcomeSent.current = true;
      gameStartTime.current = Date.now();

      // Small delay so terminal has time to initialize
      setTimeout(() => {
        addEmail({
          from: SYSTEM_EMAILS.welcome.from,
          to: 'COMMANDER',
          subject: SYSTEM_EMAILS.welcome.subject,
          body: SYSTEM_EMAILS.welcome.body,
          isSystem: true,
        });
      }, 1000);
    }
  }, [gameState, playerId, addEmail]);

  // Watch for DEFCON changes
  useEffect(() => {
    if (!gameState) return;

    const currentLevel = gameState.defconLevel;

    // Initialize on first run
    if (lastDefconLevel.current === null) {
      lastDefconLevel.current = currentLevel;
      return;
    }

    // DEFCON decreased (escalation)
    if (currentLevel < lastDefconLevel.current) {
      // Only send emails for DEFCON 4, 3, 2, 1
      if (currentLevel <= 4 && currentLevel >= 1) {
        const email = getDefconEmail(currentLevel as 1 | 2 | 3 | 4);
        addEmail({
          from: email.from,
          to: 'COMMANDER',
          subject: email.subject,
          body: email.body,
          isSystem: true,
        });

        // Increase AI presence on DEFCON changes
        increasePresence(10);
      }
    }

    lastDefconLevel.current = currentLevel;
  }, [gameState?.defconLevel, addEmail, increasePresence]);
}
