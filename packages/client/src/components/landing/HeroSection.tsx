import React from 'react';

interface HeroSectionProps {
  opacity: number;
  translateY: number;
}

export function HeroSection({ opacity, translateY }: HeroSectionProps) {
  // Don't render if effectively invisible (prevents ghost text)
  if (opacity < 0.05) return null;

  return (
    <div
      className="hero-section"
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        pointerEvents: opacity > 0.5 ? 'auto' : 'none',
      }}
    >
      <div className="hero-content">
        <h1 className="hero-title">
          <span className="hero-title-defcon">DEFCON</span>
        </h1>
        <p className="hero-subtitle">GLOBAL THERMONUCLEAR WAR</p>
        <p className="hero-tagline">
          Command your forces. Defend your cities. Annihilate the enemy.
        </p>
        <div className="hero-scroll-hint">
          <span className="scroll-arrow">&#x25BC;</span>
          <span className="scroll-text">Scroll to explore</span>
        </div>
      </div>
    </div>
  );
}

export default HeroSection;
