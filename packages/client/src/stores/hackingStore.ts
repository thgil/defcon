import { create } from 'zustand';
import {
  type HackingNode,
  type HackingConnection,
  type HackingRoute,
  type ActiveHack,
  type HackingNetworkState,
  createDefaultHackingNetwork,
  findRoute,
  createConnectionId,
} from '@defcon/shared';

interface HackingStore extends HackingNetworkState {
  // Actions
  initNetwork: () => void;
  setNetworkVisible: (visible: boolean) => void;
  toggleNetworkVisible: () => void;
  setPlayerSource: (nodeId: string | null) => void;

  // Hack actions
  startHack: (sourceId: string, targetId: string, color?: string) => string | null;
  updateHackProgress: (hackId: string, progress: number) => void;
  completeHack: (hackId: string) => void;
  failHack: (hackId: string) => void;
  startTrace: (hackId: string) => void;
  removeHack: (hackId: string) => void;

  // Demo/test actions
  startDemoHack: () => void;
  clearAllHacks: () => void;

  // Computed
  getNodesArray: () => HackingNode[];
  getConnectionsArray: () => HackingConnection[];
  getActiveHacksArray: () => ActiveHack[];
  getRouteForHack: (hackId: string) => HackingRoute | null;
}

// Hack trace colors for visual variety
const HACK_COLORS = [
  '#00ff88',  // Green
  '#ff00ff',  // Magenta
  '#00ffff',  // Cyan
  '#ffff00',  // Yellow
  '#ff8800',  // Orange
  '#ff4444',  // Red
];

let hackColorIndex = 0;

export const useHackingStore = create<HackingStore>((set, get) => ({
  // Initial state
  nodes: {},
  connections: {},
  activeHacks: {},
  playerSourceNodeId: null,
  networkVisible: false,

  // Initialize network with default nodes and connections
  initNetwork: () => {
    const network = createDefaultHackingNetwork();
    set({
      nodes: network.nodes,
      connections: network.connections,
      activeHacks: {},
      playerSourceNodeId: null,
      networkVisible: false,
    });
  },

  setNetworkVisible: (visible) => {
    set({ networkVisible: visible });
  },

  toggleNetworkVisible: () => {
    set((state) => ({ networkVisible: !state.networkVisible }));
  },

  setPlayerSource: (nodeId) => {
    set({ playerSourceNodeId: nodeId });
  },

  // Start a new hack from source to target
  startHack: (sourceId, targetId, color) => {
    const { nodes, connections } = get();

    // Find route
    const route = findRoute(nodes, connections, sourceId, targetId);
    if (!route) {
      console.warn(`No route found from ${sourceId} to ${targetId}`);
      return null;
    }

    // Generate hack ID
    const hackId = `hack-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Pick color
    const hackColor = color || HACK_COLORS[hackColorIndex % HACK_COLORS.length];
    hackColorIndex++;

    const hack: ActiveHack = {
      id: hackId,
      routeId: route.id,
      route,
      startTime: Date.now(),
      progress: 0,
      color: hackColor,
      status: 'routing',
    };

    set((state) => ({
      activeHacks: {
        ...state.activeHacks,
        [hackId]: hack,
      },
    }));

    return hackId;
  },

  updateHackProgress: (hackId, progress) => {
    set((state) => {
      const hack = state.activeHacks[hackId];
      if (!hack) return state;

      return {
        activeHacks: {
          ...state.activeHacks,
          [hackId]: {
            ...hack,
            progress: Math.max(0, Math.min(1, progress)),
            status: progress >= 1 ? 'complete' : 'active',
          },
        },
      };
    });
  },

  completeHack: (hackId) => {
    set((state) => {
      const hack = state.activeHacks[hackId];
      if (!hack) return state;

      return {
        activeHacks: {
          ...state.activeHacks,
          [hackId]: {
            ...hack,
            progress: 1,
            status: 'complete',
          },
        },
      };
    });
  },

  failHack: (hackId) => {
    set((state) => {
      const hack = state.activeHacks[hackId];
      if (!hack) return state;

      return {
        activeHacks: {
          ...state.activeHacks,
          [hackId]: {
            ...hack,
            status: 'failed',
          },
        },
      };
    });
  },

  startTrace: (hackId) => {
    set((state) => {
      const hack = state.activeHacks[hackId];
      if (!hack) return state;

      return {
        activeHacks: {
          ...state.activeHacks,
          [hackId]: {
            ...hack,
            status: 'traced',
            traceProgress: 0,
          },
        },
      };
    });
  },

  removeHack: (hackId) => {
    set((state) => {
      const { [hackId]: removed, ...rest } = state.activeHacks;
      return { activeHacks: rest };
    });
  },

  // Demo hack for testing - picks random source and target
  startDemoHack: () => {
    const { nodes, startHack } = get();
    const nodeIds = Object.keys(nodes);

    if (nodeIds.length < 2) {
      console.warn('Not enough nodes for demo hack');
      return;
    }

    // Pick random source and target (ensure they're different)
    const sourceIndex = Math.floor(Math.random() * nodeIds.length);
    let targetIndex = Math.floor(Math.random() * nodeIds.length);
    while (targetIndex === sourceIndex) {
      targetIndex = Math.floor(Math.random() * nodeIds.length);
    }

    const sourceId = nodeIds[sourceIndex];
    const targetId = nodeIds[targetIndex];

    console.log(`Starting demo hack from ${sourceId} to ${targetId}`);
    startHack(sourceId, targetId);
  },

  clearAllHacks: () => {
    set({ activeHacks: {} });
  },

  // Computed getters
  getNodesArray: () => Object.values(get().nodes),

  getConnectionsArray: () => Object.values(get().connections),

  getActiveHacksArray: () => Object.values(get().activeHacks),

  getRouteForHack: (hackId) => {
    const hack = get().activeHacks[hackId];
    return hack?.route || null;
  },
}));
