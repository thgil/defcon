import React, { useRef, useEffect, useCallback, useState } from 'react';
import { GlobeRenderer } from '../../renderer/GlobeRenderer';
import { DemoSimulator } from '../../demo/DemoSimulator';
import { useHackingStore } from '../../stores/hackingStore';
import type { ScrollState } from '../../hooks/useScrollController';
import { getCameraParamsForScroll } from '../../hooks/useScrollController';
import type { GameState } from '@defcon/shared';

interface DemoGlobeContainerProps {
  scrollState: ScrollState;
}

// AI player ID to use as perspective during combat section (USA)
const COMBAT_PERSPECTIVE_PLAYER_ID = 'demo-player-1';

export function DemoGlobeContainer({ scrollState }: DemoGlobeContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const simulatorRef = useRef<DemoSimulator | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Track the last section to detect changes
  const lastSectionRef = useRef<string | null>(null);

  // Track current player perspective (null = spectator, player ID = fog of war view)
  const currentPerspectiveRef = useRef<string | null>(null);

  // Track last camera params to avoid redundant updates
  const lastCameraRef = useRef<{
    distance: number;
    verticalOffset: number;
    targetLat?: number;
    targetLng?: number;
    trackType?: string;
  } | null>(null);

  // Get hacking store for network visualization
  const initHackingNetwork = useHackingStore((s) => s.initNetwork);
  const setNetworkVisible = useHackingStore((s) => s.setNetworkVisible);
  const startDemoHack = useHackingStore((s) => s.startDemoHack);
  const startDemoDdosHack = useHackingStore((s) => s.startDemoDdosHack);
  const updateHackProgress = useHackingStore((s) => s.updateHackProgress);
  const removeHack = useHackingStore((s) => s.removeHack);

  // Demo hack progress animation
  const hackAnimationRef = useRef<number | null>(null);
  // Track if we've already started the one-time DDoS hack
  const ddosHackStartedRef = useRef(false);

  // Handle state updates from simulator
  const handleStateUpdate = useCallback((state: GameState) => {
    if (rendererRef.current) {
      // Use current perspective (null for spectator, or player ID for fog of war)
      rendererRef.current.setGameState(state, currentPerspectiveRef.current);
    }
  }, []);

  // Initialize renderer and simulator
  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize hacking network
    initHackingNetwork();

    // Create renderer
    const renderer = new GlobeRenderer(containerRef.current);
    rendererRef.current = renderer;

    // Disable interactive controls and enable demo camera mode for landing page
    renderer.setInteractive(false);
    renderer.setDemoCameraMode(true);

    // Create 3D hero text
    renderer.createHeroText();

    // Create and start simulator
    const simulator = new DemoSimulator(handleStateUpdate);
    simulatorRef.current = simulator;

    // Set initial state
    renderer.setGameState(simulator.getState(), null);

    // Start simulation
    simulator.start();

    // Subscribe to hacking store for network visualization
    const unsubscribeHacking = useHackingStore.subscribe((state) => {
      renderer.setHackingNetworkState({
        nodes: state.nodes,
        connections: state.connections,
        activeHacks: state.activeHacks,
        playerSourceNodeId: state.playerSourceNodeId,
        networkVisible: state.networkVisible,
      });
    });

    // Initial hacking state
    const initialHackingState = useHackingStore.getState();
    renderer.setHackingNetworkState({
      nodes: initialHackingState.nodes,
      connections: initialHackingState.connections,
      activeHacks: initialHackingState.activeHacks,
      playerSourceNodeId: initialHackingState.playerSourceNodeId,
      networkVisible: initialHackingState.networkVisible,
    });

    setIsInitialized(true);

    return () => {
      unsubscribeHacking();
      simulator.stop();
      renderer.destroy();
      rendererRef.current = null;
      simulatorRef.current = null;
      // Clean up hack animation
      if (hackAnimationRef.current) {
        cancelAnimationFrame(hackAnimationRef.current);
        hackAnimationRef.current = null;
      }
    };
  }, [handleStateUpdate, initHackingNetwork]);

  // Handle scroll-based camera updates using the new demo camera system
  // Using refs to avoid creating new objects on every render
  useEffect(() => {
    if (!rendererRef.current || !isInitialized) return;

    const renderer = rendererRef.current;
    const cameraParams = getCameraParamsForScroll(scrollState);

    // Build current camera state for comparison
    const currentCamera = {
      distance: cameraParams.distance,
      verticalOffset: cameraParams.currentVerticalOffset,
      targetLat: cameraParams.targetLat,
      targetLng: cameraParams.targetLng,
      trackType: cameraParams.trackType,
    };

    // Check if camera params actually changed (with tolerance for floating point)
    const last = lastCameraRef.current;
    const hasChanged = !last ||
      Math.abs(last.distance - currentCamera.distance) > 0.5 ||
      Math.abs(last.verticalOffset - currentCamera.verticalOffset) > 0.5 ||
      last.trackType !== currentCamera.trackType ||
      (currentCamera.targetLat !== undefined && last.targetLat !== undefined &&
        Math.abs(last.targetLat - currentCamera.targetLat) > 0.1) ||
      (currentCamera.targetLng !== undefined && last.targetLng !== undefined &&
        Math.abs(last.targetLng - currentCamera.targetLng) > 0.1);

    if (hasChanged) {
      // Use the new demo camera target system for smooth lerped transitions
      if (cameraParams.isHeroZoom) {
        renderer.setDemoAutoRotate(true, 0.003); // Very slow rotation during hero
        renderer.setDemoCameraTarget({
          distance: cameraParams.distance,
          verticalOffset: cameraParams.currentVerticalOffset,
          targetLat: cameraParams.targetLat,
          targetLng: cameraParams.targetLng,
          lerpFactor: 0.012, // Slower for buttery smooth hero transitions
        });
      } else if (cameraParams.trackType === 'missile') {
        renderer.setDemoAutoRotate(false);
        // Trigger missile salvo to ensure missiles are flying
        simulatorRef.current?.triggerMissileSalvo();
        renderer.setDemoCameraTarget({
          distance: cameraParams.distance,
          verticalOffset: 0,
          targetLat: cameraParams.targetLat || 50,
          targetLng: cameraParams.targetLng || -50,
          trackType: 'missile',
          lerpFactor: 0.06,
        });
      } else if (cameraParams.trackType === 'satellite') {
        renderer.setDemoAutoRotate(false);
        renderer.setDemoCameraTarget({
          distance: cameraParams.distance,
          verticalOffset: 0,
          targetLat: cameraParams.targetLat,
          targetLng: cameraParams.targetLng,
          trackType: 'satellite',
          lerpFactor: 0.04,
        });
      } else if (cameraParams.trackType === 'radar') {
        renderer.setDemoAutoRotate(true, 0.01);
        renderer.setDemoCameraTarget({
          distance: cameraParams.distance,
          verticalOffset: 0,
          targetLat: cameraParams.targetLat,
          targetLng: cameraParams.targetLng,
          trackType: 'radar',
          lerpFactor: 0.04,
        });
      } else {
        renderer.setDemoAutoRotate(true, 0.01);
        renderer.setDemoCameraTarget({
          distance: cameraParams.distance,
          verticalOffset: cameraParams.currentVerticalOffset,
          targetLat: cameraParams.targetLat,
          targetLng: cameraParams.targetLng,
          trackType: null,
          lerpFactor: 0.04,
        });
      }

      lastCameraRef.current = currentCamera;
    }

    // Update hero text (these are cheap operations)
    if (scrollState.activeSection?.id === 'hero') {
      renderer.setHeroTextVisible(true);
      renderer.setHeroTextOpacity(scrollState.heroOpacity);
    } else {
      renderer.setHeroTextVisible(false);
    }

    // Handle radar visibility
    renderer.setForceRadarVisible(cameraParams.trackType === 'radar');
  }, [scrollState, isInitialized]);

  // Ensure missiles are firing when in missile tracking mode
  // The render loop handles finding and following missiles, we just need to ensure they exist
  useEffect(() => {
    if (!isInitialized || !rendererRef.current) return;

    const cameraParams = getCameraParamsForScroll(scrollState);
    if (cameraParams.trackType !== 'missile') return;

    // Poll to ensure missiles are available for tracking
    const pollInterval = setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      // Check if we have any missiles to track
      const missileId = renderer.getActiveMissileIdForDemo();
      if (!missileId) {
        // No missiles available, trigger another salvo
        simulatorRef.current?.triggerMissileSalvo();
      }
    }, 500);

    return () => clearInterval(pollInterval);
  }, [scrollState.activeSection?.id, isInitialized]);

  // Handle section changes (network visibility, demo hack, player perspective)
  useEffect(() => {
    if (!isInitialized || !simulatorRef.current) return;

    const section = scrollState.activeSection;
    if (!section) return;

    // Combat sections (radar, missiles, satellites) - set player perspective for fog of war
    const isCombatSection = section.id === 'radar' || section.id === 'missiles' || section.id === 'satellites';
    if (isCombatSection) {
      if (currentPerspectiveRef.current !== COMBAT_PERSPECTIVE_PLAYER_ID) {
        currentPerspectiveRef.current = COMBAT_PERSPECTIVE_PLAYER_ID;
        // Update renderer with new perspective
        rendererRef.current?.setGameState(simulatorRef.current.getState(), COMBAT_PERSPECTIVE_PLAYER_ID);
      }
    } else {
      if (currentPerspectiveRef.current !== null) {
        currentPerspectiveRef.current = null;
        // Update renderer back to spectator mode
        rendererRef.current?.setGameState(simulatorRef.current.getState(), null);
      }
    }

    // Network section - show network and trigger demo hacks
    if (section.id === 'network') {
      setNetworkVisible(true);
      // Also force network visible directly on renderer (store propagation may not work in demo mode)
      rendererRef.current?.forceNetworkVisible(true);

      // Start 2-3 regular demo hacks
      startDemoHack();
      setTimeout(() => startDemoHack(), 300);
      setTimeout(() => startDemoHack(), 600);

      // Start exactly one DDoS hack (only once ever across all visits to this section)
      if (!ddosHackStartedRef.current) {
        ddosHackStartedRef.current = true;
        setTimeout(() => startDemoDdosHack(), 150);
      }

      // Track if component is still mounted to prevent state updates after unmount
      let isMounted = true;

      // Start hack progress animation loop - keep 2-3 regular hacks running
      const animateHacks = () => {
        // Prevent state updates after unmount
        if (!isMounted) return;

        const state = useHackingStore.getState();
        const activeHacks = Object.values(state.activeHacks);
        const regularHacks = activeHacks.filter((h) => h.hackType !== 'ddos');

        // Progress all active hacks
        for (const hack of activeHacks) {
          if (hack.progress < 1) {
            // Progress hack by ~1% per frame (complete in ~5-6 seconds at 60fps)
            const newProgress = Math.min(1, hack.progress + 0.01);
            updateHackProgress(hack.id, newProgress);
          } else {
            // Remove completed hack
            removeHack(hack.id);
            // Only restart regular hacks, never restart DDoS
            if (hack.hackType !== 'ddos' && regularHacks.length <= 3) {
              setTimeout(() => startDemoHack(), 500);
            }
          }
        }

        // Ensure we always have at least 2 regular hacks running (DDoS is separate)
        if (regularHacks.length < 2) {
          startDemoHack();
        }

        hackAnimationRef.current = requestAnimationFrame(animateHacks);
      };

      // Start animation
      hackAnimationRef.current = requestAnimationFrame(animateHacks);

      // Cleanup: mark unmounted before cancelling RAF
      return () => {
        isMounted = false;
        if (hackAnimationRef.current) {
          cancelAnimationFrame(hackAnimationRef.current);
          hackAnimationRef.current = null;
        }
      };
    } else {
      setNetworkVisible(false);
      rendererRef.current?.forceNetworkVisible(false);

      // Stop hack animation
      if (hackAnimationRef.current) {
        cancelAnimationFrame(hackAnimationRef.current);
        hackAnimationRef.current = null;
      }
    }
  }, [scrollState.activeSection?.id, isInitialized, setNetworkVisible, startDemoHack, startDemoDdosHack, updateHackProgress, removeHack]);

  // Handle section transitions (trigger missile salvo when entering missiles section)
  useEffect(() => {
    if (!isInitialized) return;

    const section = scrollState.activeSection;
    if (!section) return;

    const currentSectionId = section.id;
    if (currentSectionId !== lastSectionRef.current) {
      lastSectionRef.current = currentSectionId;

      // Trigger missile salvo when entering missiles section
      if (currentSectionId === 'missiles') {
        simulatorRef.current?.triggerMissileSalvo();
      }
    }
  }, [scrollState.activeSection?.id, isInitialized]);

  return (
    <div
      ref={containerRef}
      className="demo-globe-container"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1,
      }}
    />
  );
}

export default DemoGlobeContainer;
