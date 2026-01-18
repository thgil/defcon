import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Satellite,
  SatelliteLaunchFacility,
  GameEvent,
  SatelliteLaunchEvent,
  SatelliteDestroyedEvent,
  getSatelliteGroundPosition,
  SatelliteOrbitalParams,
} from '@defcon/shared';

// Satellite configuration constants
export const SATELLITE_CONFIG = {
  ORBITAL_PERIOD: 90000,       // 90 seconds for full orbit
  ORBITAL_ALTITUDE: 120,       // 120 globe units above surface (above interceptor range)
  LAUNCH_COOLDOWN: 30000,      // 30 seconds between launches
  STARTING_SATELLITES: 2,      // Initial satellites per facility
  HEALTH: 100,                 // Satellite health points
  VISION_RANGE_DEGREES: 12,    // Vision coverage radius in degrees
  RADAR_COMM_RANGE: 30,        // Range to communicate with radar (degrees)
  SAT_SAT_COMM_RANGE: 40,      // Range for satellite-to-satellite relay (degrees)
};

// Map dimensions for converting positions
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 700;

export class SatelliteSimulator {
  constructor() {}

  /**
   * Launch a satellite from a facility with user-specified inclination
   */
  launchSatellite(
    facility: SatelliteLaunchFacility,
    inclination: number,
    ownerId: string,
    tick: number
  ): { satellite: Satellite; event: SatelliteLaunchEvent } | null {
    const now = Date.now();

    // Validate facility has satellites
    if (facility.satellites <= 0) {
      console.log('[SATELLITE] Launch failed: no satellites available');
      return null;
    }

    // Check cooldown
    if (now - facility.lastLaunchTime < facility.launchCooldown) {
      console.log('[SATELLITE] Launch failed: on cooldown');
      return null;
    }

    // Clamp inclination to valid range
    const clampedInclination = Math.max(0, Math.min(90, inclination));

    // Calculate starting longitude from facility position
    let startingLongitude: number;
    if (facility.geoPosition && typeof facility.geoPosition.lng === 'number' && !isNaN(facility.geoPosition.lng)) {
      startingLongitude = facility.geoPosition.lng;
    } else if (facility.position && typeof facility.position.x === 'number' && !isNaN(facility.position.x)) {
      startingLongitude = ((facility.position.x / MAP_WIDTH) * 360) - 180;
    } else {
      // Fallback to 0 longitude if position data is invalid
      console.warn('[SATELLITE] Invalid facility position, using default longitude 0');
      startingLongitude = 0;
    }

    // Normalize longitude to valid range [-180, 180]
    while (startingLongitude > 180) startingLongitude -= 360;
    while (startingLongitude < -180) startingLongitude += 360;

    const satelliteId = uuidv4();
    const satellite: Satellite = {
      id: satelliteId,
      ownerId,
      launchFacilityId: facility.id,
      launchTime: now,
      orbitalPeriod: SATELLITE_CONFIG.ORBITAL_PERIOD,
      orbitalAltitude: SATELLITE_CONFIG.ORBITAL_ALTITUDE,
      inclination: clampedInclination,
      startingLongitude,
      progress: 0,
      destroyed: false,
      health: SATELLITE_CONFIG.HEALTH,
    };

    const event: SatelliteLaunchEvent = {
      type: 'satellite_launch',
      tick,
      satelliteId,
      playerId: ownerId,
      facilityId: facility.id,
      inclination: clampedInclination,
    };

    console.log(`[SATELLITE] Launched satellite ${satelliteId} with inclination ${clampedInclination}deg`);

    return { satellite, event };
  }

  /**
   * Update all satellites each tick
   */
  update(state: GameState, deltaSeconds: number, sphereRadius: number): GameEvent[] {
    const events: GameEvent[] = [];
    const now = Date.now();

    for (const satellite of Object.values(state.satellites)) {
      if (satellite.destroyed) continue;

      // Update progress (wrapping from 1 back to 0)
      const elapsed = now - satellite.launchTime;
      satellite.progress = (elapsed / satellite.orbitalPeriod) % 1;

      // Update cached ground position
      const params: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };
      satellite.geoPosition = getSatelliteGroundPosition(params, now, sphereRadius);
    }

    return events;
  }

  /**
   * Destroy a satellite (called when hit by interceptor)
   */
  destroySatellite(
    satellite: Satellite,
    destroyedBy: string | undefined,
    tick: number
  ): SatelliteDestroyedEvent {
    satellite.destroyed = true;
    satellite.health = 0;

    const event: SatelliteDestroyedEvent = {
      type: 'satellite_destroyed',
      tick,
      satelliteId: satellite.id,
      destroyedBy,
    };

    console.log(`[SATELLITE] Satellite ${satellite.id} destroyed`);

    return event;
  }

  /**
   * Apply damage to a satellite and check if destroyed
   */
  damageSatellite(
    satellite: Satellite,
    damage: number,
    destroyedBy: string | undefined,
    tick: number
  ): SatelliteDestroyedEvent | null {
    if (satellite.destroyed) return null;

    satellite.health -= damage;

    if (satellite.health <= 0) {
      return this.destroySatellite(satellite, destroyedBy, tick);
    }

    return null;
  }

  /**
   * Create initial satellites state record
   */
  static createInitialSatellitesState(): Record<string, Satellite> {
    return {};
  }
}
