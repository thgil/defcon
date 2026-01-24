import { useState, useEffect, useCallback, useRef } from 'react';

export interface ScrollSection {
  id: string;
  name: string;
  index: number; // 0-based section index
  scrollMultiplier: number; // Higher = stickier, more scroll needed (1.0 = 100vh)
  // Hero-specific zoom parameters
  heroZoom?: {
    startDistance: number;
    endDistance: number;
    startVerticalOffset: number;
    endVerticalOffset: number;
    // Geographic transition (camera rotates toward target location)
    startLat?: number;
    startLng?: number;
    endLat?: number;
    endLng?: number;
  };
}

// Define sections with scroll multipliers
// Flow: hero → radar → missiles → satellites → network → strategy → cta
export const LANDING_SECTIONS: ScrollSection[] = [
  {
    id: 'hero',
    name: 'Hero',
    index: 0,
    scrollMultiplier: 1.5, // 150vh of scroll
    heroZoom: {
      startDistance: 550,  // Start very zoomed out
      endDistance: 300,    // End at radar section's starting distance
      startVerticalOffset: 180,
      endVerticalOffset: 0,
      // Camera coordinate system: lng=-90 = +Z axis (front of globe where text is)
      startLat: 25,
      startLng: -90,  // +Z axis (in front of globe where text faces)
      endLat: 45,     // Match radar targetLat
      endLng: -100,   // Match radar targetLng
    },
  },
  {
    id: 'radar',
    name: 'Radar',
    index: 1,
    scrollMultiplier: 1.0,
  },
  {
    id: 'missiles',
    name: 'Missiles',
    index: 2,
    scrollMultiplier: 1.0,
  },
  {
    id: 'satellites',
    name: 'Satellites',
    index: 3,
    scrollMultiplier: 1.0,
  },
  {
    id: 'network',
    name: 'Network',
    index: 4,
    scrollMultiplier: 1.5,
  },
  {
    id: 'strategy',
    name: 'Strategy',
    index: 5,
    scrollMultiplier: 1.5,
  },
  {
    id: 'cta',
    name: 'CTA',
    index: 6,
    scrollMultiplier: 1.0,
  },
];

// Calculate cumulative scroll heights for each section
function calculateSectionOffsets(): { offsets: number[]; totalHeight: number } {
  const offsets: number[] = [];
  let cumulative = 0;

  for (const section of LANDING_SECTIONS) {
    offsets.push(cumulative);
    cumulative += section.scrollMultiplier; // Height in viewport units
  }

  return { offsets, totalHeight: cumulative };
}

const { offsets: SECTION_OFFSETS, totalHeight: TOTAL_SCROLL_HEIGHT } = calculateSectionOffsets();

// Get the total scroll content height in vh units
export function getTotalScrollHeight(): number {
  return TOTAL_SCROLL_HEIGHT;
}

export interface ScrollState {
  progress: number;         // 0 to 1 overall scroll progress
  activeSection: ScrollSection | null;
  sectionProgress: number;  // 0 to 1 progress within active section
  heroOpacity: number;      // Calculated hero opacity
  heroTranslateY: number;   // Calculated hero Y translation
}

export interface UseScrollControllerOptions {
  containerRef: React.RefObject<HTMLElement>;
  onSectionEnter?: (section: ScrollSection) => void;
  onSectionExit?: (section: ScrollSection) => void;
}

// Easing function for smoother progress feel
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface ScrollControllerResult {
  scrollState: ScrollState;
  goToSection: (index: number) => void;
  goToNextSection: () => void;
  goToPrevSection: () => void;
  isAnimating: boolean;
}

export function useScrollController({
  containerRef,
  onSectionEnter,
  onSectionExit,
}: UseScrollControllerOptions): ScrollControllerResult {
  const [scrollState, setScrollState] = useState<ScrollState>({
    progress: 0,
    activeSection: LANDING_SECTIONS[0],
    sectionProgress: 0,
    heroOpacity: 1,
    heroTranslateY: 0,
  });

  // Animation state for scroll hijacking
  const [isAnimating, setIsAnimating] = useState(false);
  const isAnimatingRef = useRef(false); // Ref version to avoid stale closures
  const animationRef = useRef<number | null>(null);
  const touchStartY = useRef<number>(0);
  const currentSectionIndexRef = useRef(0); // Track current section for handlers
  const isLockedRef = useRef(false); // Lock during animation + cooldown
  const cooldownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lastSectionRef = useRef<string | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const resizeRafIdRef = useRef<number | null>(null);
  const lastScrollStateRef = useRef<ScrollState | null>(null);

  const calculateScrollState = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const scrollTop = container.scrollTop;
    const viewportHeight = container.clientHeight;

    // Convert scroll position to viewport units
    const scrollInViewportUnits = scrollTop / viewportHeight;

    // Find which section we're in based on cumulative offsets
    let currentSectionIndex = 0;
    for (let i = 0; i < LANDING_SECTIONS.length; i++) {
      const sectionStart = SECTION_OFFSETS[i];
      const sectionEnd = sectionStart + LANDING_SECTIONS[i].scrollMultiplier;

      if (scrollInViewportUnits >= sectionStart && scrollInViewportUnits < sectionEnd) {
        currentSectionIndex = i;
        break;
      } else if (scrollInViewportUnits >= sectionEnd) {
        currentSectionIndex = i + 1;
      }
    }

    // Clamp to valid range
    currentSectionIndex = Math.min(currentSectionIndex, LANDING_SECTIONS.length - 1);

    const activeSection = LANDING_SECTIONS[currentSectionIndex];
    const sectionStart = SECTION_OFFSETS[currentSectionIndex];

    // Progress within current section (0 to 1)
    const rawSectionProgress = (scrollInViewportUnits - sectionStart) / activeSection.scrollMultiplier;
    const sectionProgress = Math.max(0, Math.min(1, rawSectionProgress));

    // Overall progress (0 to 1)
    const progress = Math.min(1, scrollInViewportUnits / (TOTAL_SCROLL_HEIGHT - 1));

    // Calculate hero opacity - fade out during hero section
    let heroOpacity = 1;
    if (currentSectionIndex > 0) {
      heroOpacity = 0;
    } else {
      // Fade out in the second half of hero section
      heroOpacity = Math.max(0, 1 - sectionProgress * 1.5);
    }

    // Calculate hero translateY
    const heroTranslateY = sectionProgress * 150;

    // Fire section change callbacks
    if (activeSection && lastSectionRef.current !== activeSection.id) {
      // Exit previous section
      if (lastSectionRef.current) {
        const prevSection = LANDING_SECTIONS.find(s => s.id === lastSectionRef.current);
        if (prevSection && onSectionExit) {
          onSectionExit(prevSection);
        }
      }

      // Enter new section
      if (onSectionEnter) {
        onSectionEnter(activeSection);
      }

      lastSectionRef.current = activeSection.id;
    }

    const newState: ScrollState = {
      progress,
      activeSection,
      sectionProgress,
      heroOpacity,
      heroTranslateY,
    };

    // Update section index ref for navigation handlers
    currentSectionIndexRef.current = currentSectionIndex;

    // Only update React state if values actually changed (avoid unnecessary re-renders)
    const last = lastScrollStateRef.current;
    if (
      !last ||
      last.progress !== newState.progress ||
      last.sectionProgress !== newState.sectionProgress ||
      last.activeSection?.id !== newState.activeSection?.id
    ) {
      lastScrollStateRef.current = newState;
      setScrollState(newState);
    }
  }, [containerRef, onSectionEnter, onSectionExit]);

  // Calculate scroll position for a section
  const getScrollPositionForTarget = useCallback((sectionIndex: number): number => {
    const sectionOffset = SECTION_OFFSETS[sectionIndex];
    return sectionOffset * window.innerHeight;
  }, []);

  // Smooth animation to target position
  // Uses LINEAR interpolation - camera lerping handles the easing
  const animateToPosition = useCallback((targetScrollTop: number) => {
    const container = containerRef.current;
    if (!container) return;

    setIsAnimating(true);
    isAnimatingRef.current = true;
    isLockedRef.current = true; // Lock to prevent further changes

    // Clear any existing cooldown
    if (cooldownTimeoutRef.current) {
      clearTimeout(cooldownTimeoutRef.current);
    }

    const startScrollTop = container.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    const duration = 600; // ms - faster since camera lerp adds smoothness
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Linear interpolation - let camera lerping handle easing
      container.scrollTop = startScrollTop + distance * progress;

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        setIsAnimating(false);
        isAnimatingRef.current = false;
        animationRef.current = null;

        // Keep locked for additional cooldown to absorb momentum events
        cooldownTimeoutRef.current = setTimeout(() => {
          isLockedRef.current = false;
        }, 500); // Extra 500ms after animation
      }
    };

    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    animationRef.current = requestAnimationFrame(animate);
  }, [containerRef]);

  // Navigate to a specific section (at its start)
  const animateToSection = useCallback((targetIndex: number) => {
    const clampedIndex = Math.max(0, Math.min(LANDING_SECTIONS.length - 1, targetIndex));
    const targetScrollTop = getScrollPositionForTarget(clampedIndex);
    animateToPosition(targetScrollTop);
  }, [getScrollPositionForTarget, animateToPosition]);

  // Navigation helpers - simple section navigation
  const goToNext = useCallback(() => {
    const currentSectionIdx = currentSectionIndexRef.current;
    if (currentSectionIdx < LANDING_SECTIONS.length - 1) {
      animateToSection(currentSectionIdx + 1);
    }
  }, [animateToSection]);

  const goToPrev = useCallback(() => {
    const currentSectionIdx = currentSectionIndexRef.current;
    if (currentSectionIdx > 0) {
      animateToSection(currentSectionIdx - 1);
    }
  }, [animateToSection]);

  // Accumulated wheel delta for threshold-based navigation
  const wheelDeltaAccumRef = useRef(0);
  const wheelResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wheel handler - navigates between sections
  // Uses delta accumulation to filter out trackpad momentum
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    // If we're animating or in cooldown, ignore all wheel events
    if (isAnimatingRef.current) return;
    if (isLockedRef.current) return;

    // Accumulate wheel delta
    wheelDeltaAccumRef.current += e.deltaY;

    // Reset accumulator after a pause in scrolling
    if (wheelResetTimeoutRef.current) {
      clearTimeout(wheelResetTimeoutRef.current);
    }
    wheelResetTimeoutRef.current = setTimeout(() => {
      wheelDeltaAccumRef.current = 0;
    }, 150);

    // Require significant accumulated delta before triggering navigation
    // This filters out small momentum events
    const threshold = 50;
    if (Math.abs(wheelDeltaAccumRef.current) < threshold) {
      return;
    }

    const direction = wheelDeltaAccumRef.current > 0 ? 1 : -1;
    const currentSectionIdx = currentSectionIndexRef.current;

    // Reset accumulator after triggering
    wheelDeltaAccumRef.current = 0;

    if (direction > 0) {
      // Scrolling DOWN - go to next section
      if (currentSectionIdx < LANDING_SECTIONS.length - 1) {
        animateToSection(currentSectionIdx + 1);
      }
    } else {
      // Scrolling UP - go to previous section
      if (currentSectionIdx > 0) {
        animateToSection(currentSectionIdx - 1);
      }
    }
  }, [animateToSection]);

  // Touch handlers for mobile swipe
  const handleTouchStart = useCallback((e: TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (isAnimatingRef.current) return;
    if (isLockedRef.current) return;

    const deltaY = touchStartY.current - e.changedTouches[0].clientY;
    const threshold = 50; // minimum swipe distance in pixels

    if (Math.abs(deltaY) > threshold) {
      const direction = deltaY > 0 ? 1 : -1; // swipe up = next, swipe down = prev
      const currentSectionIdx = currentSectionIndexRef.current;

      if (direction > 0) {
        // Swiping UP (next)
        if (currentSectionIdx < LANDING_SECTIONS.length - 1) {
          animateToSection(currentSectionIdx + 1);
        }
      } else {
        // Swiping DOWN (prev)
        if (currentSectionIdx > 0) {
          animateToSection(currentSectionIdx - 1);
        }
      }
    }
  }, [animateToSection]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Initial calculation
    calculateScrollState();

    // Throttled scroll handler for state calculation (still needed for programmatic scrolls)
    const handleScroll = () => {
      if (rafIdRef.current !== null) return; // Already scheduled
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        calculateScrollState();
      });
    };

    // Scroll hijacking on window level to capture all wheel events
    // (container is transparent and might not receive events directly)
    window.addEventListener('wheel', handleWheel, { passive: false });

    // Touch handlers on window for mobile
    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });

    // Still listen to scroll on container for state updates during animations
    container.addEventListener('scroll', handleScroll, { passive: true });

    // Also handle resize (throttled)
    const handleResize = () => {
      if (resizeRafIdRef.current !== null) return;
      resizeRafIdRef.current = requestAnimationFrame(() => {
        resizeRafIdRef.current = null;
        calculateScrollState();
      });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (resizeRafIdRef.current !== null) {
        cancelAnimationFrame(resizeRafIdRef.current);
      }
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      if (cooldownTimeoutRef.current !== null) {
        clearTimeout(cooldownTimeoutRef.current);
      }
      if (wheelResetTimeoutRef.current !== null) {
        clearTimeout(wheelResetTimeoutRef.current);
      }
    };
  }, [containerRef, calculateScrollState, handleWheel, handleTouchStart, handleTouchEnd]);

  return {
    scrollState,
    goToSection: animateToSection,
    goToNextSection: goToNext,
    goToPrevSection: goToPrev,
    isAnimating,
  };
}

// Camera parameters for each section
interface CameraParams {
  distance: number;
  // For hero section: vertical offset (camera above center, globe in upper half)
  verticalOffset?: number;
  // For other sections: lat/lng targeting
  targetLat?: number;
  targetLng?: number;
  // For sub-features with tracking
  trackType?: 'missile' | 'satellite' | 'radar';
}

// Section camera params - positions should flow smoothly between sections
// Flow: hero → radar → missiles → satellites → network → strategy → cta
const SECTION_CAMERA_PARAMS: Record<string, CameraParams> = {
  hero: { distance: 380, verticalOffset: 180 }, // Will be overridden by heroZoom
  radar: { distance: 300, targetLat: 45, targetLng: -100, trackType: 'radar' }, // North America
  missiles: { distance: 250, targetLat: 50, targetLng: -50, trackType: 'missile' }, // Mid-Atlantic
  satellites: { distance: 400, targetLat: 51, targetLng: 10, trackType: 'satellite' }, // Germany
  network: { distance: 300, targetLat: 51, targetLng: 10 }, // Germany (matches satellites end)
  strategy: { distance: 320, targetLat: 55, targetLng: 30 }, // Eastern Europe (closer to network)
  cta: { distance: 350, verticalOffset: 0, targetLat: 51, targetLng: 10 }, // Stay on Germany view
};

/**
 * Get camera parameters based on scroll state
 * Returns interpolated values during transitions
 */
export function getCameraParamsForScroll(state: ScrollState): CameraParams & {
  currentVerticalOffset: number;
  isHeroZoom: boolean;
  easedProgress: number;
} {
  const { activeSection, sectionProgress } = state;

  if (!activeSection) {
    const heroParams = SECTION_CAMERA_PARAMS.hero;
    return {
      ...heroParams,
      currentVerticalOffset: heroParams.verticalOffset || 0,
      isHeroZoom: false,
      easedProgress: 0,
    };
  }

  // Apply easing to section progress for smoother feel
  const easedProgress = easeInOutCubic(sectionProgress);

  // Hero section with zoom
  if (activeSection.id === 'hero' && activeSection.heroZoom) {
    const {
      startDistance, endDistance,
      startVerticalOffset, endVerticalOffset,
      startLat, startLng, endLat, endLng
    } = activeSection.heroZoom;

    // Interpolate distance and offset based on eased progress
    const distance = startDistance + (endDistance - startDistance) * easedProgress;
    const verticalOffset = startVerticalOffset + (endVerticalOffset - startVerticalOffset) * easedProgress;

    // Interpolate geographic position if provided
    let targetLat: number | undefined;
    let targetLng: number | undefined;
    if (startLat !== undefined && endLat !== undefined) {
      targetLat = startLat + (endLat - startLat) * easedProgress;
    }
    if (startLng !== undefined && endLng !== undefined) {
      targetLng = startLng + (endLng - startLng) * easedProgress;
    }

    return {
      distance,
      verticalOffset,
      currentVerticalOffset: verticalOffset,
      targetLat,
      targetLng,
      isHeroZoom: true,
      easedProgress,
    };
  }

  // Get section params
  const params = SECTION_CAMERA_PARAMS[activeSection.id] || SECTION_CAMERA_PARAMS.hero;

  // Calculate interpolated vertical offset
  const currentVerticalOffset = params.verticalOffset || 0;

  return {
    ...params,
    currentVerticalOffset,
    isHeroZoom: false,
    easedProgress,
  };
}
