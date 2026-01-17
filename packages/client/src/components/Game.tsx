import { useRef, useEffect, useCallback, useState } from 'react';
import { useGameStore } from '../stores/gameStore';
import { useNetworkStore } from '../stores/networkStore';
import { GlobeRenderer } from '../renderer/GlobeRenderer';
import DebugPanel from './DebugPanel';
import { type Vector2, type Silo, type SiloMode, type GeoPosition, type Building, geoToPixel } from '@defcon/shared';

// Map dimensions for converting geo to pixel (must match server)
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

export default function Game() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GlobeRenderer | null>(null);
  const [showDebug, setShowDebug] = useState(true);
  const gameState = useGameStore((s) => s.gameState);
  const playerId = useGameStore((s) => s.playerId);
  const placementMode = useGameStore((s) => s.placementMode);
  const setPlacementMode = useGameStore((s) => s.setPlacementMode);
  const selectBuilding = useGameStore((s) => s.selectBuilding);
  const placeBuilding = useNetworkStore((s) => s.placeBuilding);
  const launchMissile = useNetworkStore((s) => s.launchMissile);
  const launchSatellite = useNetworkStore((s) => s.launchSatellite);
  const setSiloMode = useNetworkStore((s) => s.setSiloMode);
  const gameEnded = useGameStore((s) => s.gameEnded);

  // Debug panel keyboard toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        setShowDebug((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    (building: Building) => {
      const playerId = useGameStore.getState().playerId;
      if (building.ownerId === playerId) {
        selectBuilding(building);
        // Update renderer's selected building
        if (rendererRef.current) {
          rendererRef.current.setSelectedBuilding(building);
        }
      }
    },
    [selectBuilding]
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

  // Initialize renderer and subscribe to store updates
  useEffect(() => {
    if (!containerRef.current) return;

    const renderer = new GlobeRenderer(containerRef.current);
    rendererRef.current = renderer;

    // Set up click handlers
    renderer.setOnClick(handleGlobeClick);
    renderer.setOnBuildingClick(handleBuildingClick);
    renderer.setOnModeChange(handleModeChange);
    renderer.setOnPlacementMode(handlePlacementModeChange);
    renderer.setOnLaunchSatellite(handleLaunchSatellite);

    // Subscribe directly to store for immediate updates (bypasses React render cycle)
    const unsubscribe = useGameStore.subscribe((state) => {
      if (state.gameState) {
        renderer.setGameState(state.gameState, state.playerId);
      }
      renderer.setPlacementMode(state.placementMode);
      renderer.setSelectedBuilding(state.selectedBuilding);
    });

    // Initial state
    const initialState = useGameStore.getState();
    if (initialState.gameState) {
      renderer.setGameState(initialState.gameState, initialState.playerId);
    }

    return () => {
      unsubscribe();
      renderer.destroy();
    };
  }, [handleGlobeClick, handleBuildingClick, handleModeChange, handlePlacementModeChange, handleLaunchSatellite]);

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
      {showDebug && <DebugPanel />}
      {gameEnded && <GameEndOverlay />}
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
