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
          status: 'active',
          isIntercontinental: false,
        };
      }
    }
  }

  return connections;
}

/**
 * Options for route finding
 */
export interface FindRouteOptions {
  skipCutCables?: boolean;          // Skip connections with status 'cut' (default: true)
  applyNodeLatencyMultiplier?: boolean; // Apply latency multiplier for compromised nodes (default: true)
}

/**
 * Find a route between two nodes using BFS
 * Returns the shortest path by number of hops
 *
 * When skipCutCables is true (default), routes will not use cut cables.
 * When applyNodeLatencyMultiplier is true (default), routes through compromised nodes
 * will have increased latency (2x).
 */
export function findRoute(
  nodes: Record<string, HackingNode>,
  connections: Record<string, HackingConnection>,
  sourceId: string,
  targetId: string,
  options: FindRouteOptions = {}
): HackingRoute | null {
  const { skipCutCables = true, applyNodeLatencyMultiplier = true } = options;

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
    // Skip cut cables if option is enabled
    if (skipCutCables && conn.status === 'cut') continue;

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

      // Calculate latency, applying multiplier for compromised nodes
      let connectionLatency = connection.latency;
      if (applyNodeLatencyMultiplier) {
        const neighborNode = nodes[neighborId];
        if (neighborNode?.compromisedBy) {
          connectionLatency *= 2; // 2x latency through compromised nodes
        }
      }

      const newPath = [...current.path, neighborId];
      const newLatency = current.latency + connectionLatency;

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
 * Add explicit intercontinental deep sea cable connections
 * These connect continents that are otherwise isolated by the distance limit
 */
export function addInterconnectCables(
  nodes: Record<string, HackingNode>,
  connections: Record<string, HackingConnection>
): void {
  // Define intercontinental cable routes (city pairs)
  const cables = [
    // Atlantic cables (Americas ↔ Europe)
    { from: 'north_america:new_york', to: 'europe:london', name: 'TAT-14' },
    { from: 'north_america:new_york', to: 'europe:paris', name: 'AC-1' },
    { from: 'europe:madrid', to: 'south_america:sao_paulo', name: 'EllaLink' },
    { from: 'europe:london', to: 'south_america:rio_de_janeiro', name: 'SAm-1' },
    // Pacific cables (Americas ↔ Asia)
    { from: 'north_america:los_angeles', to: 'asia:tokyo', name: 'PC-1' },
    { from: 'north_america:san_francisco', to: 'asia:tokyo', name: 'Unity' },
    { from: 'north_america:los_angeles', to: 'asia:shanghai', name: 'TPE' },
    { from: 'north_america:seattle', to: 'asia:hong_kong', name: 'NCP' },
    // Asia ↔ Australia
    { from: 'asia:hong_kong', to: 'australia:sydney', name: 'AAG' },
    { from: 'asia:tokyo', to: 'australia:sydney', name: 'SJC' },
    // Europe ↔ Middle East/Asia (via Med)
    { from: 'europe:rome', to: 'middle_east:mumbai', name: 'SEA-ME-WE' },
  ];

  for (const cable of cables) {
    const fromNode = nodes[cable.from];
    const toNode = nodes[cable.to];
    if (!fromNode || !toNode) continue;

    const connectionId = createConnectionId(fromNode.id, toNode.id);
    if (connections[connectionId]) continue; // Already exists

    // Intercontinental cables have higher latency but good bandwidth
    const distance = greatCircleDistance(fromNode.position, toNode.position);
    const distanceDegrees = distance * (180 / Math.PI);

    connections[connectionId] = {
      id: connectionId,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      latency: 800 + distanceDegrees * 15, // Higher base latency for undersea
      bandwidth: 0.7, // Good bandwidth (fiber)
      encrypted: true, // Undersea cables are encrypted
      status: 'active',
      isIntercontinental: true, // Can be cut by cable cutting hack
    };
  }
}

/**
 * Initialize a default hacking network state
 */
export function createDefaultHackingNetwork(): HackingNetworkState {
  const nodes = generateNetworkNodes();
  const connections = generateNetworkConnections(nodes);
  addInterconnectCables(nodes, connections);

  return {
    nodes,
    connections,
    activeHacks: {},
    playerSourceNodeId: null,
    networkVisible: false,
  };
}

// ============ NETWORK WARFARE UTILITIES ============

/**
 * Check if a node is currently under DDoS attack
 */
export function isNodeUnderDdos(node: HackingNode, now: number = Date.now()): boolean {
  if (!node.ddosActive) return false;
  if (node.ddosExpiresAt && now > node.ddosExpiresAt) return false;
  return true;
}

/**
 * Check if a node is currently compromised
 */
export function isNodeCompromised(node: HackingNode, now: number = Date.now()): boolean {
  if (!node.compromisedBy) return false;
  if (node.compromiseExpiresAt && now > node.compromiseExpiresAt) return false;
  return true;
}

/**
 * Check if a connection (cable) is currently cut
 */
export function isCableCut(connection: HackingConnection, now: number = Date.now()): boolean {
  if (connection.status !== 'cut') return false;
  if (connection.cutExpiresAt && now > connection.cutExpiresAt) return false;
  return true;
}

/**
 * Get all intercontinental cables (undersea cables that can be cut)
 */
export function getIntercontinentalCables(
  connections: Record<string, HackingConnection>
): HackingConnection[] {
  return Object.values(connections).filter(c => c.isIntercontinental);
}

/**
 * Apply DDoS to a node
 */
export function applyDdos(
  node: HackingNode,
  attackerId: string,
  durationMs: number
): void {
  node.ddosActive = true;
  node.ddosBy = attackerId;
  node.ddosExpiresAt = Date.now() + durationMs;
}

/**
 * Apply compromise to a node
 */
export function applyNodeCompromise(
  node: HackingNode,
  attackerId: string,
  durationMs: number
): void {
  node.compromisedBy = attackerId;
  node.compromiseExpiresAt = Date.now() + durationMs;
}

/**
 * Cut a cable
 */
export function cutCable(
  connection: HackingConnection,
  attackerId: string,
  durationMs: number
): void {
  connection.status = 'cut';
  connection.cutBy = attackerId;
  connection.cutExpiresAt = Date.now() + durationMs;
}

/**
 * Apply false flag to a node (makes hacks appear to come from another player)
 */
export function applyFalseFlag(
  node: HackingNode,
  impersonatePlayerId: string,
  durationMs: number
): void {
  node.falseFlagAs = impersonatePlayerId;
  node.falseFlagExpiresAt = Date.now() + durationMs;
}

/**
 * Clean up expired network warfare effects
 */
export function cleanupExpiredEffects(
  nodes: Record<string, HackingNode>,
  connections: Record<string, HackingConnection>,
  now: number = Date.now()
): void {
  // Clean up node effects
  for (const node of Object.values(nodes)) {
    if (node.ddosExpiresAt && now > node.ddosExpiresAt) {
      node.ddosActive = false;
      node.ddosBy = undefined;
      node.ddosExpiresAt = undefined;
    }
    if (node.compromiseExpiresAt && now > node.compromiseExpiresAt) {
      node.compromisedBy = undefined;
      node.compromiseExpiresAt = undefined;
    }
    if (node.falseFlagExpiresAt && now > node.falseFlagExpiresAt) {
      node.falseFlagAs = undefined;
      node.falseFlagExpiresAt = undefined;
    }
  }

  // Clean up cable effects
  for (const conn of Object.values(connections)) {
    if (conn.cutExpiresAt && now > conn.cutExpiresAt) {
      conn.status = 'active';
      conn.cutBy = undefined;
      conn.cutExpiresAt = undefined;
    }
  }
}
