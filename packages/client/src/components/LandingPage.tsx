import React, { useRef, useCallback } from 'react';
import { useScrollController, LANDING_SECTIONS, getTotalScrollHeight, type ScrollSection } from '../hooks/useScrollController';
import { DemoGlobeContainer } from './landing/DemoGlobeContainer';
import { FeatureSection, FEATURES } from './landing/FeatureSection';
import { useTerminalStore } from '../stores/terminalStore';
import { useAudioStore } from '../stores/audioStore';
import { useBackgroundMusic } from '../hooks/useBackgroundMusic';
import '../styles/landing.css';

// HeroSection removed - now rendered as 3D text in the globe scene

export function LandingPage() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Background music for demo
  useBackgroundMusic();

  // Audio mute state
  const musicEnabled = useAudioStore((s) => s.musicEnabled);
  const sfxEnabled = useAudioStore((s) => s.sfxEnabled);
  const toggleMusic = useAudioStore((s) => s.toggleMusic);
  const toggleSfx = useAudioStore((s) => s.toggleSfx);
  const isMuted = !musicEnabled && !sfxEnabled;

  const handleMuteToggle = useCallback(() => {
    // Toggle both together
    if (isMuted) {
      // Unmute both
      if (!musicEnabled) toggleMusic();
      if (!sfxEnabled) toggleSfx();
    } else {
      // Mute both
      if (musicEnabled) toggleMusic();
      if (sfxEnabled) toggleSfx();
    }
  }, [isMuted, musicEnabled, sfxEnabled, toggleMusic, toggleSfx]);

  // Glitch state from terminal store
  const glitchActive = useTerminalStore((s) => s.glitchActive);
  const glitchIntensity = useTerminalStore((s) => s.glitchIntensity);

  // Handle section transitions
  const handleSectionEnter = useCallback((_section: ScrollSection) => {
    // Section enter logic
  }, []);

  const handleSectionExit = useCallback((_section: ScrollSection) => {
    // Section exit logic
  }, []);

  // Use scroll controller with scroll hijacking
  const { scrollState, goToSection, goToNextSection, goToPrevSection, isAnimating } = useScrollController({
    containerRef: scrollContainerRef,
    onSectionEnter: handleSectionEnter,
    onSectionExit: handleSectionExit,
  });

  // Discord invite link
  const DISCORD_INVITE_URL = 'https://discord.gg/YK8bezkADc';

  // Check if CTA should be visible - show when in CTA section
  const showCTA = scrollState.activeSection?.id === 'cta';

  // Calculate total scroll height in vh
  const totalScrollHeight = getTotalScrollHeight();

  return (
    <div className="landing-page">
      {/* Fixed globe background with 3D hero text */}
      <DemoGlobeContainer scrollState={scrollState} />

      {/* Mute button */}
      <button
        className="mute-button"
        onClick={handleMuteToggle}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
        )}
      </button>

      {/* Hero text is now rendered in 3D inside the globe scene */}

      {/* Feature sections */}
      {FEATURES.map((feature) => (
        <FeatureSection
          key={feature.id}
          id={feature.id}
          title={feature.title}
          description={feature.description}
          details={feature.details}
          position={feature.position}
          isActive={feature.sectionId === scrollState.activeSection?.id}
          progress={
            feature.sectionId === scrollState.activeSection?.id
              ? scrollState.sectionProgress
              : 0
          }
        />
      ))}

      {/* CTA section - only render when in CTA section */}
      {showCTA && (
        <div className={`cta-section ${glitchActive ? 'glitch' : ''}`}>
          <div className="cta-content">
            <p className="cta-text">Join the community</p>
            <a
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="cta-button cta-button--discord"
            >
              <svg className="discord-icon" viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Join Discord
            </a>
          </div>
          {/* Glitch overlay */}
          {glitchActive && (
            <div
              className="cta-glitch-overlay"
              style={{ opacity: glitchIntensity * 0.5 }}
            />
          )}
        </div>
      )}

      {/* Scrollable container - creates scroll height and captures scroll events */}
      <div className="landing-scroll-container" ref={scrollContainerRef}>
        <div
          className="landing-scroll-content"
          style={{ height: `${totalScrollHeight * 100}vh` }}
        >
          {/* Section markers with proper heights based on scroll multipliers */}
          {LANDING_SECTIONS.map((section) => (
            <div
              key={section.id}
              className="section-marker"
              data-section={section.id}
              style={{ height: `${section.scrollMultiplier * 100}vh` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default LandingPage;
