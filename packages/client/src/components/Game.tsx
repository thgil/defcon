import { useRef, useEffect, useCallback } from 'react';
import { useGameStore } from '../stores/gameStore';
import { useNetworkStore } from '../stores/networkStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useHackingStore } from '../stores/hackingStore';
import { useBackgroundMusic } from '../hooks/useBackgroundMusic';
import { GlobeRenderer } from '../renderer/GlobeRenderer';
import { type Vector2, type Silo, type SiloMode, type GeoPosition, type Building, type AircraftType, geoToPixel } from '@defcon/shared';
import type { ManualInterceptState } from '../stores/gameStore';
import Terminal from './Terminal/Terminal';

// Map dimensions for converting geo to pixel (must match server)
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

export default function Game() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const placementMode = useGameStore((s) => s.placementMode);
  const setPlacementMode = useGameStore((s) => s.setPlacementMode);
  const selectBuilding = useGameStore((s) => s.selectBuilding);
  const placeBuilding = useNetworkStore((s) => s.placeBuilding);
  const launchMissile = useNetworkStore((s) => s.launchMissile);
  const launchSatellite = useNetworkStore((s) => s.launchSatellite);
  const setSiloMode = useNetworkStore((s) => s.setSiloMode);
  const sendDebugCommand = useNetworkStore((s) => s.sendDebugCommand);
  const enableAI = useNetworkStore((s) => s.enableAI);
  const disableAI = useNetworkStore((s) => s.disableAI);
  const launchAircraft = useNetworkStore((s) => s.launchAircraft);
  const gameEnded = useGameStore((s) => s.gameEnded);

  // Manual intercept
  const requestInterceptInfo = useNetworkStore((s) => s.requestInterceptInfo);
  const manualIntercept = useNetworkStore((s) => s.manualIntercept);
  const setInterceptTarget = useGameStore((s) => s.setInterceptTarget);
  const toggleInterceptSilo = useGameStore((s) => s.toggleInterceptSilo);
  const clearInterceptSelection = useGameStore((s) => s.clearInterceptSelection);
  const manualInterceptState = useGameStore((s) => s.manualIntercept);

  // Terminal toggle
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const isTerminalOpen = useTerminalStore((s) => s.isOpen);

  // Hacking network store
  const initHackingNetwork = useHackingStore((s) => s.initNetwork);
  const hackingNetworkState = useHackingStore((s) => ({
    nodes: s.nodes,
    connections: s.connections,
    activeHacks: s.activeHacks,
    playerSourceNodeId: s.playerSourceNodeId,
    networkVisible: s.networkVisible,
  }));
  const toggleHackingNetworkVisible = useHackingStore((s) => s.toggleNetworkVisible);
  const startDemoHack = useHackingStore((s) => s.startDemoHack);
  const updateHackProgress = useHackingStore((s) => s.updateHackProgress);
  const getNetworkHackTracesArray = useHackingStore((s) => s.getNetworkHackTracesArray);

  // Background music
  useBackgroundMusic();

  // Initialize hacking network on mount
  useEffect(() => {
    initHackingNetwork();
  }, [initHackingNetwork]);

  // Animate active hacks
  useEffect(() => {
    let lastTime = performance.now();
    let animationFrame: number;

    const animate = () => {
      const now = performance.now();
      const deltaTime = (now - lastTime) / 1000;
      lastTime = now;

      // Update progress for all active hacks
      const activeHacks = getNetworkHackTracesArray();
      for (const hack of activeHacks) {
        if (hack.status === 'routing' || hack.status === 'active') {
          // Calculate progress based on elapsed time and total latency
          const elapsed = now - hack.startTime;
          const newProgress = Math.min(1, elapsed / hack.route.totalLatency);
          updateHackProgress(hack.id, newProgress);
        }
      }

      animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
    };
  }, [getNetworkHackTracesArray, updateHackProgress]);

  // Debug panel and keyboard toggles
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'd' || e.key === 'D') {
        if (rendererRef.current) {
          rendererRef.current.toggleDebugPanel();
        }
      }
      // Toggle terminal with backtick key
      if (e.key === '`') {
        e.preventDefault();
        toggleTerminal();
      }
      // 'N' key toggles network visibility
      if (e.key === 'n' || e.key === 'N') {
        toggleHackingNetworkVisible();
      }
      // 'H' key starts a demo hack
      if (e.key === 'h' || e.key === 'H') {
        startDemoHack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleTerminal, toggleHackingNetworkVisible, startDemoHack]);

  // Convert geo position to pixel position for server
  const geoToPixelPosition = useCallback((geo: GeoPosition): Vector2 => {
    return geoToPixel(geo, MAP_WIDTH, MAP_HEIGHT);
  }, []);

  // Handle globe click
  const handleGlobeClick = useCallback(
    (geoPosition: GeoPosition) => {
      const gameState = useGameStore.getState().gameState;
      const placementMode = useGameStore.getState().placementMode;
      if (!gameState) return;

      // Convert geo to pixel for server
      const position = geoToPixelPosition(geoPosition);

      if (placementMode && gameState.defconLevel === 5) {
        // Place building
        placeBuilding(placementMode, position);
      } else if (gameState.defconLevel === 1) {
        // Launch missile
        const selectedSilo = useGameStore.getState().selectedBuilding;
        if (selectedSilo && selectedSilo.type === 'silo') {
          const silo = selectedSilo as Silo;
          if (silo.mode === 'icbm' && silo.missileCount > 0) {
            launchMissile(silo.id, position);
          }
        }
      }
    },
    [geoToPixelPosition, placeBuilding, launchMissile]
  );

  // Handle building click
  const handleBuildingClick = useCallback(
    (building: Building | null) => {
      const state = useGameStore.getState();

      // Handle deselection (null building)
      if (!building) {
        selectBuilding(null);
        if (rendererRef.current) {
          rendererRef.current.setSelectedBuilding(null);
        }
        return;
      }

      if (building.ownerId === state.playerId) {
        // Select own buildings
        selectBuilding(building);
        // Update renderer's selected building
        if (rendererRef.current) {
          rendererRef.current.setSelectedBuilding(building);
        }
      } else if (state.gameState?.defconLevel === 1) {
        // Enemy building - try to target it with selected silo
        const selectedBuilding = state.selectedBuilding;
        if (selectedBuilding?.type === 'silo') {
          const silo = selectedBuilding as Silo;
          if (silo.mode === 'icbm' && silo.missileCount > 0) {
            // Launch missile at enemy building position
            const position = geoToPixel(building.geoPosition || { lat: 0, lng: 0 }, MAP_WIDTH, MAP_HEIGHT);
            launchMissile(silo.id, position);
          }
        }
      }
    },
    [selectBuilding, launchMissile]
  );

  // Handle mode change from HUD
  const handleModeChange = useCallback(
    (siloId: string, mode: SiloMode) => {
      setSiloMode(siloId, mode);
    },
    [setSiloMode]
  );

  // Handle placement mode change from HUD
  const handlePlacementModeChange = useCallback(
    (type: string | null) => {
      setPlacementMode(type as any);
      if (rendererRef.current) {
        rendererRef.current.setPlacementMode(type);
      }
    },
    [setPlacementMode]
  );

  // Handle satellite launch from HUD
  const handleLaunchSatellite = useCallback(
    (facilityId: string, inclination: number) => {
      launchSatellite(facilityId, inclination);
    },
    [launchSatellite]
  );

  // Handle aircraft launch from HUD
  const handleLaunchAircraft = useCallback(
    (airfieldId: string, aircraftType: AircraftType, waypoints: GeoPosition[]) => {
      launchAircraft(airfieldId, aircraftType, waypoints);
    },
    [launchAircraft]
  );

  // Handle enemy ICBM click - open manual intercept panel
  const handleEnemyICBMClick = useCallback(
    (missileId: string) => {
      setInterceptTarget(missileId);
      requestInterceptInfo(missileId);
    },
    [setInterceptTarget, requestInterceptInfo]
  );

  // Handle silo toggle in intercept panel
  const handleToggleInterceptSilo = useCallback(
    (siloId: string) => {
      toggleInterceptSilo(siloId);
    },
    [toggleInterceptSilo]
  );

  // Handle launch button in intercept panel
  const handleLaunchIntercept = useCallback(() => {
    const state = useGameStore.getState().manualIntercept;
    if (state.targetMissileId && state.selectedSiloIds.size > 0) {
      manualIntercept(state.targetMissileId, Array.from(state.selectedSiloIds));
      clearInterceptSelection();
    }
  }, [manualIntercept, clearInterceptSelection]);

  // Handle cancel button in intercept panel
  const handleCancelIntercept = useCallback(() => {
    clearInterceptSelection();
  }, [clearInterceptSelection]);

  // Initialize renderer and subscribe to store updates
  useEffect(() => {
    if (!containerRef.current) return;

    const newRenderer = new GlobeRenderer(containerRef.current);
    rendererRef.current = newRenderer;

    // Set up click handlers
    const renderer = newRenderer;
    renderer.setOnClick(handleGlobeClick);
    renderer.setOnBuildingClick(handleBuildingClick);
    renderer.setOnModeChange(handleModeChange);
    renderer.setOnPlacementMode(handlePlacementModeChange);
    renderer.setOnLaunchSatellite(handleLaunchSatellite);
    renderer.setOnLaunchAircraft(handleLaunchAircraft);
    renderer.setOnEnemyICBMClick(handleEnemyICBMClick);

    // Set up manual intercept HUD callbacks
    renderer.setManualInterceptCallbacks(
      handleToggleInterceptSilo,
      handleLaunchIntercept,
      handleCancelIntercept
    );

    // Set up debug panel callbacks
    renderer.setDebugCallbacks(
      (command, value, targetRegion) => {
        sendDebugCommand(command as any, value, targetRegion);
      },
      enableAI,
      disableAI
    );

    // Subscribe directly to store for immediate updates (bypasses React render cycle)
    const unsubscribeGame = useGameStore.subscribe((state) => {
      if (state.gameState) {
        renderer.setGameState(state.gameState, state.playerId);
      }
      renderer.setPlacementMode(state.placementMode);
      renderer.setSelectedBuilding(state.selectedBuilding);
      renderer.setAlerts(state.getAlerts());
      renderer.setManualInterceptState(state.manualIntercept);
    });

    // Subscribe to hacking store
    const unsubscribeHacking = useHackingStore.subscribe((state) => {
      renderer.setHackingNetworkState({
        nodes: state.nodes,
        connections: state.connections,
        activeHacks: state.activeHacks,
        playerSourceNodeId: state.playerSourceNodeId,
        networkVisible: state.networkVisible,
      });
    });

    // Initial state
    const initialState = useGameStore.getState();
    if (initialState.gameState) {
      renderer.setGameState(initialState.gameState, initialState.playerId);
    }

    // Initial hacking network state
    const initialHackingState = useHackingStore.getState();
    renderer.setHackingNetworkState({
      nodes: initialHackingState.nodes,
      connections: initialHackingState.connections,
      activeHacks: initialHackingState.activeHacks,
      playerSourceNodeId: initialHackingState.playerSourceNodeId,
      networkVisible: initialHackingState.networkVisible,
    });

    return () => {
      unsubscribeGame();
      unsubscribeHacking();
      renderer.destroy();
    };
  }, [handleGlobeClick, handleBuildingClick, handleModeChange, handlePlacementModeChange, handleLaunchSatellite, handleLaunchAircraft, sendDebugCommand, enableAI, disableAI, handleEnemyICBMClick, handleToggleInterceptSilo, handleLaunchIntercept, handleCancelIntercept]);

  // Handle right click to cancel
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setPlacementMode(null);
      selectBuilding(null);
      if (rendererRef.current) {
        rendererRef.current.setPlacementMode(null);
        rendererRef.current.setSelectedBuilding(null);
      }
    },
    [setPlacementMode, selectBuilding]
  );

  if (!gameState) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        Loading game...
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          cursor: placementMode ? 'crosshair' : 'default',
        }}
        onContextMenu={handleContextMenu}
      />
      {gameEnded && <GameEndOverlay />}
      <Terminal />
    </div>
  );
}

function GameEndOverlay() {
  const winner = useGameStore((s) => s.winner);
  const finalScores = useGameStore((s) => s.finalScores);
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);

  const winnerPlayer = winner && gameState?.players[winner];
  const isWinner = winner === playerId;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.9)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
      }}
    >
      <h1
        style={{
          fontSize: 48,
          color: isWinner ? '#00ff00' : '#ff0000',
          textShadow: `0 0 20px ${isWinner ? 'rgba(0, 255, 0, 0.5)' : 'rgba(255, 0, 0, 0.5)'}`,
        }}
      >
        {winner ? (isWinner ? 'VICTORY' : 'DEFEAT') : 'DRAW'}
      </h1>

      {winnerPlayer && (
        <p style={{ color: '#888' }}>Winner: {winnerPlayer.name}</p>
      )}

      {finalScores && gameState && (
        <div className="panel" style={{ minWidth: 300 }}>
          <h3 style={{ marginBottom: 16 }}>Final Scores</h3>
          {Object.entries(finalScores)
            .sort(([, a], [, b]) => b - a)
            .map(([id, score]) => (
              <div
                key={id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--color-bg-grid)',
                  color: id === playerId ? '#00ff00' : undefined,
                }}
              >
                <span>{gameState.players[id]?.name || 'Unknown'}</span>
                <span>{score}</span>
              </div>
            ))}
        </div>
      )}

      <button onClick={() => window.location.reload()}>
        Return to Menu
      </button>
    </div>
  );
}
