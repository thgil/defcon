import { create } from 'zustand';
import {
  type GameState,
  type Building,
  type Missile,
  type Satellite,
  type GameEvent,
  type DefconLevel,
  type Vector2,
  type BuildingType,
  getBuildings,
} from '@defcon/shared';

interface GameStore {
  // State
  gameState: GameState | null;
  playerId: string | null;
  selectedBuilding: Building | null;
  placementMode: BuildingType | null;
  gameEnded: boolean;
  winner: string | null;
  finalScores: Record<string, number> | null;

  // Actions
  initGame: (state: GameState, playerId: string) => void;
  setFullState: (state: GameState) => void;
  applyDelta: (
    events: GameEvent[],
    buildingUpdates: Building[],
    missileUpdates: Missile[],
    removedMissileIds: string[],
    satelliteUpdates?: Satellite[],
    removedSatelliteIds?: string[]
  ) => void;
  selectBuilding: (building: Building | null) => void;
  setPlacementMode: (type: BuildingType | null) => void;
  handleGameEnd: (winner: string | null, scores: Record<string, number>) => void;

  // Computed
  getDefconColor: () => string;
  getMyBuildings: () => Building[];
  getMySilos: () => Building[];
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

  initGame: (state, playerId) => {
    set({
      gameState: state,
      playerId,
      selectedBuilding: null,
      placementMode: null,
      gameEnded: false,
      winner: null,
      finalScores: null,
    });
  },

  setFullState: (state) => {
    set({ gameState: state });
  },

  applyDelta: (events, buildingUpdates, missileUpdates, removedMissileIds, satelliteUpdates, removedSatelliteIds) => {
    const { gameState, selectedBuilding } = get();
    if (!gameState) return;

    const newState = { ...gameState };
    let updatedSelectedBuilding = selectedBuilding;

    // Apply building updates
    for (const building of buildingUpdates) {
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

    if (buildingUpdates.length > 0) {
      console.log('[DEBUG] applyDelta buildingUpdates:', buildingUpdates.length, 'selectedBuilding updated:', updatedSelectedBuilding !== selectedBuilding);
    }

    // Apply missile updates
    for (const missile of missileUpdates) {
      newState.missiles = {
        ...newState.missiles,
        [missile.id]: missile,
      };
    }

    // Remove missiles
    for (const id of removedMissileIds) {
      const { [id]: removed, ...rest } = newState.missiles;
      newState.missiles = rest;
    }

    // Apply satellite updates
    if (satelliteUpdates) {
      for (const satellite of satelliteUpdates) {
        newState.satellites = {
          ...newState.satellites,
          [satellite.id]: satellite,
        };
      }
    }

    // Remove satellites
    if (removedSatelliteIds) {
      for (const id of removedSatelliteIds) {
        const { [id]: removed, ...rest } = newState.satellites;
        newState.satellites = rest;
      }
    }

    // Process events
    let shouldClearPlacement = false;
    for (const event of events) {
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
      }
    }

    // Update game state and optionally clear placement mode
    if (shouldClearPlacement) {
      set({ gameState: newState, placementMode: null, selectedBuilding: null });
    } else {
      set({ gameState: newState, selectedBuilding: updatedSelectedBuilding });
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
}));
