import { create } from 'zustand';
import {
  type GameState,
  type Building,
  type Missile,
  type AnyMissile,
  type Satellite,
  type Aircraft,
  type GameEvent,
  type DefconLevel,
  type Vector2,
  type BuildingType,
  type GeoPosition,
  type LaunchDetectedEvent,
  getBuildings,
} from '@defcon/shared';

// Alert types for HUD display
export interface GameAlert {
  id: string;
  type: 'launch_detected' | 'incoming' | 'impact';
  message: string;
  position?: GeoPosition;
  regionName?: string;
  timestamp: number;
  expiresAt: number;
}

// Intercept info for manual intercept UI
export interface InterceptSiloInfo {
  siloId: string;
  siloName: string;
  hitProbability: number;
  estimatedInterceptProgress: number;
  ammoRemaining: number;
}

export interface ExistingInterceptorInfo {
  interceptorId: string;
  sourceSiloName: string;
  estimatedTimeToIntercept: number; // ms
}

export interface ManualInterceptState {
  targetMissileId: string | null;
  availableSilos: InterceptSiloInfo[];
  selectedSiloIds: Set<string>;
  existingInterceptors: ExistingInterceptorInfo[];
}

interface GameStore {
  // State
  gameState: GameState | null;
  playerId: string | null;
  selectedBuilding: Building | null;
  placementMode: BuildingType | null;
  gameEnded: boolean;
  winner: string | null;
  finalScores: Record<string, number> | null;
  alerts: GameAlert[];
  manualIntercept: ManualInterceptState;

  // Actions
  initGame: (state: GameState, playerId: string) => void;
  setFullState: (state: GameState) => void;
  applyDelta: (
    tick: number,
    timestamp: number,
    events: GameEvent[],
    buildingUpdates: Building[],
    missileUpdates: AnyMissile[],
    removedMissileIds: string[],
    satelliteUpdates?: Satellite[],
    removedSatelliteIds?: string[],
    aircraftUpdates?: Aircraft[],
    removedAircraftIds?: string[]
  ) => void;
  selectBuilding: (building: Building | null) => void;
  setPlacementMode: (type: BuildingType | null) => void;
  handleGameEnd: (winner: string | null, scores: Record<string, number>) => void;

  // Manual intercept actions
  setInterceptTarget: (targetMissileId: string | null) => void;
  setInterceptInfo: (targetMissileId: string, availableSilos: InterceptSiloInfo[], existingInterceptors: ExistingInterceptorInfo[]) => void;
  toggleInterceptSilo: (siloId: string) => void;
  clearInterceptSelection: () => void;

  // Computed
  getDefconColor: () => string;
  getMyBuildings: () => Building[];
  getMySilos: () => Building[];
  getAlerts: () => GameAlert[];
}

const DEFCON_COLORS: Record<DefconLevel, string> = {
  5: '#00ff00',
  4: '#88ff00',
  3: '#ffff00',
  2: '#ff8800',
  1: '#ff0000',
};

export const useGameStore = create<GameStore>((set, get) => ({
  gameState: null,
  playerId: null,
  selectedBuilding: null,
  placementMode: null,
  gameEnded: false,
  winner: null,
  finalScores: null,
  alerts: [],
  manualIntercept: {
    targetMissileId: null,
    availableSilos: [],
    selectedSiloIds: new Set(),
    existingInterceptors: [],
  },

  initGame: (state, playerId) => {
    set({
      gameState: state,
      playerId,
      selectedBuilding: null,
      placementMode: null,
      gameEnded: false,
      winner: null,
      finalScores: null,
      alerts: [],
      manualIntercept: {
        targetMissileId: null,
        availableSilos: [],
        selectedSiloIds: new Set(),
        existingInterceptors: [],
      },
    });
  },

  setFullState: (state) => {
    set({ gameState: state });
  },

  applyDelta: (tick, timestamp, events, buildingUpdates, missileUpdates, removedMissileIds, satelliteUpdates, removedSatelliteIds, aircraftUpdates, removedAircraftIds) => {
    const { gameState, selectedBuilding, playerId } = get();
    if (!gameState) return;

    const newState = { ...gameState, tick, timestamp };
    let updatedSelectedBuilding = selectedBuilding;
    const newAlerts: GameAlert[] = [];

    // Validate arrays before iterating (protect against null/undefined)
    const safeEvents = events || [];
    const safeBuildingUpdates = buildingUpdates || [];
    const safeMissileUpdates = missileUpdates || [];
    const safeRemovedMissileIds = removedMissileIds || [];
    const safeSatelliteUpdates = satelliteUpdates || [];
    const safeRemovedSatelliteIds = removedSatelliteIds || [];
    const safeAircraftUpdates = aircraftUpdates || [];
    const safeRemovedAircraftIds = removedAircraftIds || [];

    // Apply building updates
    for (const building of safeBuildingUpdates) {
      newState.buildings = {
        ...newState.buildings,
        [building.id]: building,
      };
      // Update selectedBuilding if it matches
      if (selectedBuilding && selectedBuilding.id === building.id) {
        console.log('[DEBUG] Updating selectedBuilding:', building.id, 'mode:', (building as any).mode);
        updatedSelectedBuilding = building;
      }
    }

    if (safeBuildingUpdates.length > 0) {
      console.log('[DEBUG] applyDelta buildingUpdates:', safeBuildingUpdates.length, 'selectedBuilding updated:', updatedSelectedBuilding !== selectedBuilding);
    }

    // Apply missile updates
    for (const missile of safeMissileUpdates) {
      newState.missiles = {
        ...newState.missiles,
        [missile.id]: missile,
      };
    }

    // Remove missiles
    for (const id of safeRemovedMissileIds) {
      const { [id]: removed, ...rest } = newState.missiles;
      newState.missiles = rest;
    }

    // Apply satellite updates
    if (safeSatelliteUpdates.length > 0) {
      for (const satellite of safeSatelliteUpdates) {
        newState.satellites = {
          ...newState.satellites,
          [satellite.id]: satellite,
        };
      }
    }

    // Remove satellites
    if (safeRemovedSatelliteIds.length > 0) {
      for (const id of safeRemovedSatelliteIds) {
        const { [id]: removed, ...rest } = newState.satellites;
        newState.satellites = rest;
      }
    }

    // Apply aircraft updates
    if (safeAircraftUpdates.length > 0) {
      for (const aircraft of safeAircraftUpdates) {
        newState.aircraft = {
          ...newState.aircraft,
          [aircraft.id]: aircraft,
        };
      }
    }

    // Remove aircraft
    if (safeRemovedAircraftIds.length > 0) {
      for (const id of safeRemovedAircraftIds) {
        const { [id]: removed, ...rest } = newState.aircraft;
        newState.aircraft = rest;
      }
    }

    // Process events
    let shouldClearPlacement = false;
    for (const event of safeEvents) {
      switch (event.type) {
        case 'defcon_change':
          newState.defconLevel = event.newLevel;
          // Clear placement mode when leaving DEFCON 5
          if (event.newLevel !== 5) {
            shouldClearPlacement = true;
          }
          break;

        case 'building_placed':
          newState.buildings = {
            ...newState.buildings,
            [event.building.id]: event.building,
          };
          break;

        case 'missile_launch':
          // Missile already in updates
          break;

        case 'city_hit':
          if (newState.cities[event.cityId]) {
            newState.cities = {
              ...newState.cities,
              [event.cityId]: {
                ...newState.cities[event.cityId],
                population: event.remainingPopulation,
                destroyed: event.remainingPopulation <= 0,
              },
            };
          }
          break;

        case 'building_destroyed':
          if (newState.buildings[event.buildingId]) {
            newState.buildings = {
              ...newState.buildings,
              [event.buildingId]: {
                ...newState.buildings[event.buildingId],
                destroyed: true,
              },
            };
          }
          break;

        case 'launch_detected':
          // Only show alerts for the detecting player
          if (event.detectedByPlayerId === playerId) {
            const now = Date.now();
            const regionText = event.regionName || 'Unknown Region';
            newAlerts.push({
              id: `launch-${now}-${Math.random()}`,
              type: 'launch_detected',
              message: `LAUNCH DETECTED: ${regionText}`,
              position: event.approximatePosition,
              regionName: event.regionName,
              timestamp: now,
              expiresAt: now + 8000, // Show for 8 seconds
            });
          }
          break;
      }
    }

    // Clean up expired alerts and add new ones
    const now = Date.now();
    const currentAlerts = get().alerts.filter(a => a.expiresAt > now);
    const finalAlerts = [...currentAlerts, ...newAlerts];

    // Update game state and optionally clear placement mode
    if (shouldClearPlacement) {
      set({ gameState: newState, placementMode: null, selectedBuilding: null, alerts: finalAlerts });
    } else {
      set({ gameState: newState, selectedBuilding: updatedSelectedBuilding, alerts: finalAlerts });
    }
  },

  selectBuilding: (building) => {
    set({ selectedBuilding: building });
  },

  setPlacementMode: (type) => {
    set({ placementMode: type, selectedBuilding: null });
  },

  handleGameEnd: (winner, scores) => {
    set({
      gameEnded: true,
      winner,
      finalScores: scores,
    });
  },

  // Manual intercept actions
  setInterceptTarget: (targetMissileId) => {
    set({
      manualIntercept: {
        targetMissileId,
        availableSilos: [],
        selectedSiloIds: new Set(),
        existingInterceptors: [],
      },
    });
  },

  setInterceptInfo: (targetMissileId, availableSilos, existingInterceptors) => {
    const current = get().manualIntercept;
    // Only update if this is for the current target
    if (current.targetMissileId === targetMissileId) {
      set({
        manualIntercept: {
          ...current,
          availableSilos,
          existingInterceptors,
        },
      });
    }
  },

  toggleInterceptSilo: (siloId) => {
    const current = get().manualIntercept;
    const newSelectedSiloIds = new Set(current.selectedSiloIds);
    if (newSelectedSiloIds.has(siloId)) {
      newSelectedSiloIds.delete(siloId);
    } else {
      newSelectedSiloIds.add(siloId);
    }
    set({
      manualIntercept: {
        ...current,
        selectedSiloIds: newSelectedSiloIds,
      },
    });
  },

  clearInterceptSelection: () => {
    set({
      manualIntercept: {
        targetMissileId: null,
        availableSilos: [],
        selectedSiloIds: new Set(),
        existingInterceptors: [],
      },
    });
  },

  getDefconColor: () => {
    const { gameState } = get();
    if (!gameState) return DEFCON_COLORS[5];
    return DEFCON_COLORS[gameState.defconLevel];
  },

  getMyBuildings: () => {
    const { gameState, playerId } = get();
    if (!gameState || !playerId) return [];
    return getBuildings(gameState).filter(
      (b) => b.ownerId === playerId && !b.destroyed
    );
  },

  getMySilos: () => {
    const { gameState, playerId } = get();
    if (!gameState || !playerId) return [];
    return getBuildings(gameState).filter(
      (b) => b.ownerId === playerId && b.type === 'silo' && !b.destroyed
    );
  },

  getAlerts: () => {
    const { alerts } = get();
    const now = Date.now();
    return alerts.filter(a => a.expiresAt > now);
  },
}));
