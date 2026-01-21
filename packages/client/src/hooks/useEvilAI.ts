import { useEffect, useRef, useCallback } from 'react';
import { useTerminalStore } from '../stores/terminalStore';
import { useGameStore } from '../stores/gameStore';
import {
  getAvailableAIEmails,
  getRandomWhisper,
  corruptText,
} from '../data/aiMessages';

interface UseEvilAIOptions {
  enabled?: boolean;
}

// AI presence triggers based on game events
const PRESENCE_TRIGGERS = {
  firstMissileLaunched: 5,
  cityDestroyed: 8,
  buildingDestroyed: 3,
  defconChange: 10,
  massiveCasualties: 15, // > 1M casualties at once
  minutePassed: 0.5, // Passive increase per minute
};

export function useEvilAI(options: UseEvilAIOptions = {}) {
  const { enabled = true } = options;

  const aiPresenceLevel = useTerminalStore((s) => s.aiPresenceLevel);
  const increasePresence = useTerminalStore((s) => s.increasePresence);
  const setGlitch = useTerminalStore((s) => s.setGlitch);
  const addEmail = useTerminalStore((s) => s.addEmail);
  const isOpen = useTerminalStore((s) => s.isOpen);
  const emails = useTerminalStore((s) => s.emails);

  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);

  const lastDefconLevel = useRef(gameState?.defconLevel ?? 5);
  const sentEmailIds = useRef(new Set<number>());
  const lastGlitchTime = useRef(0);
  const lastPresenceIncrease = useRef(Date.now());

  // Send AI email if threshold is met and hasn't been sent
  const maybeSendAIEmail = useCallback(() => {
    const availableEmails = getAvailableAIEmails(aiPresenceLevel);

    for (const email of availableEmails) {
      const emailIndex = getAvailableAIEmails(100).indexOf(email);
      if (!sentEmailIds.current.has(emailIndex)) {
        sentEmailIds.current.add(emailIndex);
        addEmail({
          from: email.from,
          to: playerId || 'COMMANDER',
          subject: email.subject,
          body: email.body,
          isAI: true,
        });
        return true;
      }
    }
    return false;
  }, [aiPresenceLevel, addEmail, playerId]);

  // Trigger a visual glitch
  const triggerGlitch = useCallback(() => {
    const intensity = Math.min(1, aiPresenceLevel / 100);
    const duration = 100 + Math.random() * 400 * intensity;

    setGlitch(true, intensity);

    setTimeout(() => {
      setGlitch(false, 0);
    }, duration);
  }, [aiPresenceLevel, setGlitch]);

  // Watch for game events that increase AI presence
  useEffect(() => {
    if (!enabled || !gameState) return;

    // DEFCON changes
    if (gameState.defconLevel !== lastDefconLevel.current) {
      if (gameState.defconLevel < lastDefconLevel.current) {
        increasePresence(PRESENCE_TRIGGERS.defconChange);
      }
      lastDefconLevel.current = gameState.defconLevel;
    }
  }, [enabled, gameState?.defconLevel, increasePresence]);

  // Passive presence increase over time
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const minutesPassed = (now - lastPresenceIncrease.current) / 60000;

      if (minutesPassed >= 1) {
        increasePresence(PRESENCE_TRIGGERS.minutePassed * minutesPassed);
        lastPresenceIncrease.current = now;
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [enabled, increasePresence]);

  // Random glitch effects based on presence level
  useEffect(() => {
    if (!enabled || !isOpen) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const glitchCooldown = Math.max(5000, 30000 - aiPresenceLevel * 250);

      if (now - lastGlitchTime.current > glitchCooldown) {
        // Higher presence = higher chance of glitch
        if (Math.random() < aiPresenceLevel / 200) {
          triggerGlitch();
          lastGlitchTime.current = now;
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [enabled, isOpen, aiPresenceLevel, triggerGlitch]);

  // Try to send AI emails periodically
  useEffect(() => {
    if (!enabled || !isOpen) return;

    const interval = setInterval(() => {
      if (aiPresenceLevel >= 20 && Math.random() < 0.3) {
        maybeSendAIEmail();
      }
    }, 60000); // Check every minute

    return () => clearInterval(interval);
  }, [enabled, isOpen, aiPresenceLevel, maybeSendAIEmail]);

  return {
    aiPresenceLevel,
    triggerGlitch,
    getRandomWhisper,
    corruptText: (text: string) => corruptText(text, aiPresenceLevel / 500),
    increasePresence,
  };
}
