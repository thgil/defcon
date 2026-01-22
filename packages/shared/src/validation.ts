import type { GameState, Territory, BuildingType, GameConfig, GeoPosition } from './types';
import { pointInPolygon, pixelToGeo } from './geography';

// Map dimensions for converting pixel to geo (must match server)
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

/**
 * Check if a geo position is within a territory's boundaries.
 * Uses polygon containment with geoBoundary if available,
 * otherwise falls back to bounding box check.
 */
export function isPointInTerritory(geo: GeoPosition, territory: Territory): boolean {
  // Use polygon containment if boundary exists
  if (territory.geoBoundary && territory.geoBoundary.length >= 3) {
    return pointInPolygon(geo, territory.geoBoundary);
  }

  // Fallback to bounds check
  if (territory.geoBounds) {
    const bounds = territory.geoBounds;
    return (
      geo.lat >= bounds.south &&
      geo.lat <= bounds.north &&
      geo.lng >= bounds.west &&
      geo.lng <= bounds.east
    );
  }

  return false;
}

/**
 * Get the building limit for a given building type from the game config.
 */
export function getBuildingLimit(buildingType: BuildingType, config: GameConfig): number {
  const limits = config.startingUnits;
  switch (buildingType) {
    case 'silo':
      return limits.silos;
    case 'radar':
      return limits.radars;
    case 'airfield':
      return limits.airfields;
    case 'satellite_launch_facility':
      return limits.satellite_launch_facilities;
    default:
      return 0;
  }
}

/**
 * Client-side validation for building placement.
 * Performs the same checks as the server (except land detection).
 *
 * Note: This does NOT check if the position is on land (ocean vs land).
 * That check is server-only. If a player clicks on water, the optimistic
 * building will briefly appear then disappear when server rejects it.
 *
 * @param state Current game state
 * @param playerId ID of the player placing the building
 * @param buildingType Type of building to place
 * @param geoPosition Geographic position to place the building
 * @param pendingBuildings Optional map of pending buildings to include in limit check
 * @returns true if placement is valid according to client-side rules
 */
export function canPlaceBuilding(
  state: GameState,
  playerId: string,
  buildingType: BuildingType,
  geoPosition: GeoPosition,
  pendingBuildings?: Record<string, { type: BuildingType; ownerId: string }>
): boolean {
  // Check DEFCON level - only allow placement during DEFCON 5
  if (state.defconLevel !== 5) {
    return false;
  }

  // Check player exists and has a territory
  const player = state.players[playerId];
  if (!player || !player.territoryId) {
    return false;
  }

  // Check territory exists
  const territory = state.territories[player.territoryId];
  if (!territory) {
    return false;
  }

  // Check position is within player's territory
  if (!isPointInTerritory(geoPosition, territory)) {
    return false;
  }

  // Count existing buildings of this type (including pending)
  const existingBuildings = Object.values(state.buildings).filter(
    (b) => b.ownerId === playerId && b.type === buildingType
  );

  // Also count pending buildings of this type
  let pendingCount = 0;
  if (pendingBuildings) {
    pendingCount = Object.values(pendingBuildings).filter(
      (b) => b.ownerId === playerId && b.type === buildingType
    ).length;
  }

  const totalCount = existingBuildings.length + pendingCount;
  const limit = getBuildingLimit(buildingType, state.config);

  if (totalCount >= limit) {
    return false;
  }

  return true;
}
