import type { GeoCoordinate } from '../geography/types';

/**
 * A node in the hacking network - typically a city or server location
 */
export interface HackingNode {
  id: string;
  name: string;
  position: GeoCoordinate;
  type: 'server' | 'relay' | 'target' | 'source';
  status: 'available' | 'compromised' | 'secured' | 'offline';
}

/**
 * A connection between two nodes in the hacking network
 */
export interface HackingConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  latency: number;  // Affects trace speed (ms for the trace to travel this segment)
  bandwidth: number; // 0-1, affects visual thickness
  encrypted: boolean;
}

/**
 * A complete route through the network
 */
export interface HackingRoute {
  id: string;
  nodeIds: string[];  // Ordered list of node IDs from source to target
  totalLatency: number;  // Sum of all connection latencies
}

/**
 * An active hack trace traveling along a route
 */
export interface NetworkHackTrace {
  id: string;
  routeId: string;
  route: HackingRoute;
  startTime: number;  // Timestamp when hack started
  progress: number;   // 0-1, current position along the total route
  color: string;      // Hex color for the trace
  status: 'routing' | 'active' | 'complete' | 'traced' | 'failed';
  traceProgress?: number;  // If being traced, how far the trace-back has progressed
}

/**
 * Complete hacking network state
 */
export interface HackingNetworkState {
  nodes: Record<string, HackingNode>;
  connections: Record<string, HackingConnection>;
  activeHacks: Record<string, NetworkHackTrace>;
  playerSourceNodeId: string | null;  // The player's entry point
  networkVisible: boolean;
}

/**
 * Create a connection ID from two node IDs (bidirectional)
 */
export function createConnectionId(nodeA: string, nodeB: string): string {
  return [nodeA, nodeB].sort().join('--');
}

/**
 * Get the connection between two nodes if it exists
 */
export function getConnection(
  connections: Record<string, HackingConnection>,
  nodeA: string,
  nodeB: string
): HackingConnection | undefined {
  const id = createConnectionId(nodeA, nodeB);
  return connections[id];
}
