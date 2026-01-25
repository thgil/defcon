import { create } from 'zustand';
import {
  type HackingNode,
  type HackingConnection,
  type HackingRoute,
  type NetworkHackTrace,
  type HackingNetworkState,
  type GeoPosition,
  type HackType,
  createDefaultHackingNetwork,
  findRoute,
  createConnectionId,
  greatCircleDistance,
} from '@defcon/shared';

interface HackingStore extends HackingNetworkState {
  // Actions
  initNetwork: () => void;
  setNetworkVisible: (visible: boolean) => void;
  toggleNetworkVisible: () => void;
  setPlayerSource: (nodeId: string | null) => void;

  // Hack actions
  startHack: (sourceId: string, targetId: string, color?: string, hackType?: HackType) => string | null;
  startHackFromGeo: (sourceGeo: GeoPosition, targetGeo: GeoPosition, hackId: string, color?: string, hackType?: HackType) => string | null;
  addActiveHack: (trace: NetworkHackTrace) => void;
  updateHackProgress: (hackId: string, progress: number, traceProgress?: number) => void;
  completeHack: (hackId: string) => void;
  failHack: (hackId: string) => void;
  startTrace: (hackId: string) => void;
  removeHack: (hackId: string) => void;

  // Demo/test actions
  startDemoHack: () => void;
  startDemoDdosHack: () => void;
  clearAllHacks: () => void;

  // Computed
  getNodesArray: () => HackingNode[];
  getConnectionsArray: () => HackingConnection[];
  getNetworkHackTracesArray: () => NetworkHackTrace[];
  getRouteForHack: (hackId: string) => HackingRoute | null;
  findNearestNode: (geoPos: GeoPosition) => HackingNode | null;
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
  startHack: (sourceId, targetId, color, hackType) => {
    const { nodes, connections } = get();

    // Find route
    const route = findRoute(nodes, connections, sourceId, targetId);
    if (!route) {
      console.warn(`No route found from ${sourceId} to ${targetId}`);
      return null;
    }

    // Generate hack ID
    const hackId = `hack-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Pick color (orange for DDoS)
    const hackColor = color || (hackType === 'ddos' ? '#ff8800' : HACK_COLORS[hackColorIndex % HACK_COLORS.length]);
    hackColorIndex++;

    const hack: NetworkHackTrace = {
      id: hackId,
      routeId: route.id,
      route,
      startTime: Date.now(),
      progress: 0,
      color: hackColor,
      status: 'routing',
      hackType,
    };

    set((state) => ({
      activeHacks: {
        ...state.activeHacks,
        [hackId]: hack,
      },
    }));

    return hackId;
  },

  // Start a hack from geographic positions (finds nearest network nodes)
  startHackFromGeo: (sourceGeo, targetGeo, hackId, color, hackType) => {
    const { nodes, connections, findNearestNode } = get();

    console.log('[HackingStore] startHackFromGeo called', { sourceGeo, targetGeo, hackId, hackType });
    console.log('[HackingStore] Network has', Object.keys(nodes).length, 'nodes and', Object.keys(connections).length, 'connections');

    const sourceNode = findNearestNode(sourceGeo);
    const targetNode = findNearestNode(targetGeo);

    console.log('[HackingStore] Found nodes:', sourceNode?.id, '->', targetNode?.id);

    if (!sourceNode || !targetNode) {
      console.warn('[HackingStore] Could not find network nodes near positions');
      return null;
    }

    // Find route
    const route = findRoute(nodes, connections, sourceNode.id, targetNode.id);
    if (!route) {
      console.warn(`[HackingStore] No route found from ${sourceNode.id} to ${targetNode.id}`);
      return null;
    }

    console.log('[HackingStore] Route found with', route.nodeIds.length, 'nodes:', route.nodeIds);

    // Pick color
    const hackColor = color || HACK_COLORS[hackColorIndex % HACK_COLORS.length];
    hackColorIndex++;

    const hack: NetworkHackTrace = {
      id: hackId,
      routeId: route.id,
      route,
      startTime: Date.now(),
      progress: 0,
      color: hackColor,
      status: 'routing',
      hackType,
    };

    set((state) => ({
      activeHacks: {
        ...state.activeHacks,
        [hackId]: hack,
      },
    }));

    return hackId;
  },

  // Add an existing hack trace directly
  addActiveHack: (trace) => {
    set((state) => ({
      activeHacks: {
        ...state.activeHacks,
        [trace.id]: trace,
      },
    }));
  },

  updateHackProgress: (hackId, progress, traceProgress?: number) => {
    set((state) => {
      const hack = state.activeHacks[hackId];
      if (!hack) return state;

      return {
        activeHacks: {
          ...state.activeHacks,
          [hackId]: {
            ...hack,
            progress: Math.max(0, Math.min(1, progress)),
            traceProgress: traceProgress !== undefined ? Math.max(0, Math.min(1, traceProgress)) : hack.traceProgress,
            status: progress >= 1 ? 'complete' : (traceProgress !== undefined && traceProgress >= 1) ? 'traced' : 'active',
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

  // Demo DDoS hack - picks random source and target, uses DDoS type (orange color)
  startDemoDdosHack: () => {
    const { nodes, startHack } = get();
    const nodeIds = Object.keys(nodes);

    if (nodeIds.length < 2) {
      console.warn('Not enough nodes for demo DDoS hack');
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

    console.log(`Starting demo DDoS hack from ${sourceId} to ${targetId}`);
    startHack(sourceId, targetId, undefined, 'ddos');
  },

  clearAllHacks: () => {
    set({ activeHacks: {} });
  },

  // Computed getters
  getNodesArray: () => Object.values(get().nodes),

  getConnectionsArray: () => Object.values(get().connections),

  getNetworkHackTracesArray: () => Object.values(get().activeHacks),

  getRouteForHack: (hackId) => {
    const hack = get().activeHacks[hackId];
    return hack?.route || null;
  },

  // Find nearest network node to a geographic position
  findNearestNode: (geoPos) => {
    const nodes = get().nodes;
    let nearest: HackingNode | null = null;
    let minDistance = Infinity;

    for (const node of Object.values(nodes)) {
      const dist = greatCircleDistance(node.position, geoPos);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = node;
      }
    }
    return nearest;
  },
}));
