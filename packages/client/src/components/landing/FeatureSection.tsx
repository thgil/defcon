import React from 'react';

export interface FeatureSectionProps {
  id: string;
  title: string;
  description: string;
  details: string[];
  position: 'left' | 'right';
  isActive: boolean;
  progress: number;
}

export function FeatureSection({
  id,
  title,
  description,
  details,
  position,
  isActive,
}: FeatureSectionProps) {
  // Don't render if not active
  if (!isActive) return null;

  return (
    <div
      className={`feature-section feature-section--${position}`}
      id={id}
    >
      <div className="feature-content">
        {/* Corner accents */}
        <div className="feature-corner feature-corner--tl" />
        <div className="feature-corner feature-corner--tr" />
        <div className="feature-corner feature-corner--bl" />
        <div className="feature-corner feature-corner--br" />

        {/* Scanline overlay */}
        <div className="feature-scanlines" />

        <h2 className="feature-title">{title}</h2>
        <p className="feature-description">{description}</p>

        <ul className="feature-details">
          {details.map((detail, index) => (
            <li
              key={index}
              className="feature-detail"
            >
              {detail}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Feature data - one for each section
export const FEATURES = [
  {
    id: 'feature-radar',
    sectionId: 'radar',
    title: 'RADAR COVERAGE',
    description: 'Overlapping radar networks reveal incoming threats in real-time.',
    details: [
      'Detect enemy launches within seconds of ignition',
      'Triangulate missile trajectories across multiple installations',
      'Blind spots create strategic vulnerabilities',
      'Extended range with satellite-linked networks',
    ],
    position: 'right' as const,
  },
  {
    id: 'feature-missiles',
    sectionId: 'missiles',
    title: 'ACTIVE TRACKING',
    description: 'Follow individual ICBMs from launch through atmospheric re-entry.',
    details: [
      'Track multiple warheads simultaneously',
      'Predict impact zones with precision targeting',
      'Deploy interceptors to neutralize threats',
      'Calculate optimal strike trajectories',
    ],
    position: 'left' as const,
  },
  {
    id: 'feature-satellites',
    sectionId: 'satellites',
    title: 'SATELLITE RECON',
    description: 'Deploy orbital assets for global early warning coverage.',
    details: [
      'Detect launches from geosynchronous orbit',
      'Infrared tracking ignores ground interference',
      'Coordinate with ground-based radar',
      'Vulnerable to anti-satellite weapons',
    ],
    position: 'right' as const,
  },
  {
    id: 'feature-network',
    sectionId: 'network',
    title: 'CYBER WARFARE',
    description: 'Hack enemy systems through a global network of data centers and communication nodes.',
    details: [
      'Blind enemy radar with precision DDoS attacks',
      'Spoof missile tracking data to create confusion',
      'Tap into enemy communications for intel',
      'Compromise network nodes to slow enemy operations',
    ],
    position: 'left' as const,
  },
  {
    id: 'feature-strategy',
    sectionId: 'strategy',
    title: 'TERRITORIAL CONTROL',
    description: 'Claim territories, position your forces, and outmaneuver your opponents.',
    details: [
      'Choose from 9 global territories with unique geography',
      'Deploy satellites for early warning detection',
      'Establish overlapping radar coverage',
      'Coordinate multi-theater operations',
    ],
    position: 'right' as const,
  },
];

export default FeatureSection;
