import type { GeoCoordinate } from '../geography/types';
import type {
  HackingNode,
  HackingConnection,
  HackingRoute,
  HackingNetworkState,
} from './types';
import { createConnectionId } from './types';
import { greatCircleDistance } from '../geography/utils';
import { CITY_GEO_DATA } from '../geography/territories';

/**
 * Generate hacking nodes from city data
 * Selects major cities from each region to form the network
 */
export function generateNetworkNodes(): Record<string, HackingNode> {
  const nodes: Record<string, HackingNode> = {};

  // Select cities from each region to form the network backbone
  for (const [regionId, cities] of Object.entries(CITY_GEO_DATA)) {
    // Take the top 3-5 cities by population from each region
    const sortedCities = [...cities].sort((a, b) => b.population - a.population);
    const selectedCities = sortedCities.slice(0, Math.min(5, sortedCities.length));

    for (const city of selectedCities) {
      const nodeId = `${regionId}:${city.name.toLowerCase().replace(/\s+/g, '_')}`;
      nodes[nodeId] = {
        id: nodeId,
        name: city.name,
        position: city.position,
        type: 'relay',
        status: 'available',
      };
    }
  }

  return nodes;
}

/**
 * Generate connections between nodes based on proximity
 * Creates a network where nearby cities are connected
 */
export function generateNetworkConnections(
  nodes: Record<string, HackingNode>,
  maxDistanceDegrees: number = 50
): Record<string, HackingConnection> {
  const connections: Record<string, HackingConnection> = {};
  const nodeList = Object.values(nodes);

  for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
      const nodeA = nodeList[i];
      const nodeB = nodeList[j];

      const distance = greatCircleDistance(nodeA.position, nodeB.position);
      const distanceDegrees = distance * (180 / Math.PI);

      // Only connect nodes within range
      if (distanceDegrees <= maxDistanceDegrees) {
        const connectionId = createConnectionId(nodeA.id, nodeB.id);

        // Latency based on distance (longer distance = more latency)
        const baseLatency = 500; // Base latency in ms
        const distanceLatency = distanceDegrees * 20; // 20ms per degree
        const latency = baseLatency + distanceLatency;

        // Bandwidth inversely related to distance
        const bandwidth = Math.max(0.3, 1 - (distanceDegrees / maxDistanceDegrees) * 0.7);

        connections[connectionId] = {
          id: connectionId,
          fromNodeId: nodeA.id,
          toNodeId: nodeB.id,
          latency,
          bandwidth,
          encrypted: Math.random() > 0.7, // 30% chance of encrypted
        };
      }
    }
  }

  return connections;
}

/**
 * Find a route between two nodes using BFS
 * Returns the shortest path by number of hops
 */
export function findRoute(
  nodes: Record<string, HackingNode>,
  connections: Record<string, HackingConnection>,
  sourceId: string,
  targetId: string
): HackingRoute | null {
  if (!nodes[sourceId] || !nodes[targetId]) return null;
  if (sourceId === targetId) {
    return {
      id: `route:${sourceId}-${targetId}`,
      nodeIds: [sourceId],
      totalLatency: 0,
    };
  }

  // Build adjacency list
  const adjacency = new Map<string, { nodeId: string; connection: HackingConnection }[]>();
  for (const node of Object.values(nodes)) {
    adjacency.set(node.id, []);
  }

  for (const conn of Object.values(connections)) {
    adjacency.get(conn.fromNodeId)?.push({ nodeId: conn.toNodeId, connection: conn });
    adjacency.get(conn.toNodeId)?.push({ nodeId: conn.fromNodeId, connection: conn });
  }

  // BFS to find shortest path
  const queue: { nodeId: string; path: string[]; latency: number }[] = [
    { nodeId: sourceId, path: [sourceId], latency: 0 }
  ];
  const visited = new Set<string>([sourceId]);

  while (queue.length > 0) {
    const current = queue.shift()!;

    const neighbors = adjacency.get(current.nodeId) || [];
    for (const { nodeId: neighborId, connection } of neighbors) {
      if (visited.has(neighborId)) continue;

      const newPath = [...current.path, neighborId];
      const newLatency = current.latency + connection.latency;

      if (neighborId === targetId) {
        return {
          id: `route:${sourceId}-${targetId}`,
          nodeIds: newPath,
          totalLatency: newLatency,
        };
      }

      visited.add(neighborId);
      queue.push({ nodeId: neighborId, path: newPath, latency: newLatency });
    }
  }

  return null; // No route found
}

/**
 * Calculate which segment of the route the hack is currently on
 * Returns the segment index and progress within that segment
 */
export function getRouteSegmentProgress(
  route: HackingRoute,
  connections: Record<string, HackingConnection>,
  overallProgress: number
): { segmentIndex: number; segmentProgress: number; fromNodeId: string; toNodeId: string } | null {
  if (route.nodeIds.length < 2) return null;
  if (route.totalLatency === 0) return null;

  // Calculate cumulative latencies for each segment
  const segmentLatencies: number[] = [];
  for (let i = 0; i < route.nodeIds.length - 1; i++) {
    const connId = createConnectionId(route.nodeIds[i], route.nodeIds[i + 1]);
    const conn = connections[connId];
    segmentLatencies.push(conn?.latency || 500);
  }

  // Find which segment we're in
  const targetLatency = overallProgress * route.totalLatency;
  let accumulatedLatency = 0;

  for (let i = 0; i < segmentLatencies.length; i++) {
    const segmentLatency = segmentLatencies[i];

    if (accumulatedLatency + segmentLatency >= targetLatency) {
      // We're in this segment
      const segmentProgress = (targetLatency - accumulatedLatency) / segmentLatency;
      return {
        segmentIndex: i,
        segmentProgress: Math.max(0, Math.min(1, segmentProgress)),
        fromNodeId: route.nodeIds[i],
        toNodeId: route.nodeIds[i + 1],
      };
    }

    accumulatedLatency += segmentLatency;
  }

  // At the end
  return {
    segmentIndex: segmentLatencies.length - 1,
    segmentProgress: 1,
    fromNodeId: route.nodeIds[route.nodeIds.length - 2],
    toNodeId: route.nodeIds[route.nodeIds.length - 1],
  };
}

/**
 * Initialize a default hacking network state
 */
export function createDefaultHackingNetwork(): HackingNetworkState {
  const nodes = generateNetworkNodes();
  const connections = generateNetworkConnections(nodes);

  return {
    nodes,
    connections,
    activeHacks: {},
    playerSourceNodeId: null,
    networkVisible: false,
  };
}
