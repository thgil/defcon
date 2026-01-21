import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Aircraft,
  AircraftType,
  Airfield,
  GeoPosition,
  GameEvent,
  getBuildings,
  getAircraft,
  greatCircleDistance,
  geoInterpolate,
} from '@defcon/shared';

// Aircraft configuration
const AIRCRAFT_CONFIG = {
  FIGHTER_SPEED: 0.5,   // Degrees per second (angular velocity)
  BOMBER_SPEED: 0.3,    // Degrees per second
  RADAR_SPEED: 0.25,    // Degrees per second (slower AWACS)
  ALTITUDE: 5,          // Globe units above surface
  RETURN_THRESHOLD: 0.01,    // Degrees - when close enough to airfield, land
  SPLINE_SAMPLES: 100,  // Number of samples for path length calculation
};

export class AircraftSimulator {
  /**
   * Catmull-Rom spline interpolation for GeoPositions.
   * t is 0-1 between p1 and p2, with p0 and p3 as control points.
   */
  private catmullRomInterpolate(
    p0: GeoPosition,
    p1: GeoPosition,
    p2: GeoPosition,
    p3: GeoPosition,
    t: number
  ): GeoPosition {
    const t2 = t * t;
    const t3 = t2 * t;

    // Catmull-Rom basis functions
    const b0 = -0.5 * t3 + t2 - 0.5 * t;
    const b1 = 1.5 * t3 - 2.5 * t2 + 1;
    const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const b3 = 0.5 * t3 - 0.5 * t2;

    return {
      lat: b0 * p0.lat + b1 * p1.lat + b2 * p2.lat + b3 * p3.lat,
      lng: b0 * p0.lng + b1 * p1.lng + b2 * p2.lng + b3 * p3.lng,
    };
  }

  /**
   * Get position along the entire spline path.
   * progress is 0-1 along the full path.
   */
  private getSplinePosition(
    controlPoints: GeoPosition[],
    progress: number
  ): GeoPosition {
    if (controlPoints.length < 2) {
      return controlPoints[0] || { lat: 0, lng: 0 };
    }

    // Clamp progress
    progress = Math.max(0, Math.min(1, progress));

    // Number of segments (between consecutive points)
    const numSegments = controlPoints.length - 1;

    // Find which segment we're in
    const scaledProgress = progress * numSegments;
    const segmentIndex = Math.min(Math.floor(scaledProgress), numSegments - 1);
    const segmentT = scaledProgress - segmentIndex;

    // Get the 4 control points for Catmull-Rom (with clamping at ends)
    const p0 = controlPoints[Math.max(0, segmentIndex - 1)];
    const p1 = controlPoints[segmentIndex];
    const p2 = controlPoints[Math.min(controlPoints.length - 1, segmentIndex + 1)];
    const p3 = controlPoints[Math.min(controlPoints.length - 1, segmentIndex + 2)];

    return this.catmullRomInterpolate(p0, p1, p2, p3, segmentT);
  }

  /**
   * Calculate the total length of a spline path in degrees.
   */
  private calculateSplineLength(controlPoints: GeoPosition[]): number {
    if (controlPoints.length < 2) return 0;

    let totalLength = 0;
    let prevPos = this.getSplinePosition(controlPoints, 0);

    for (let i = 1; i <= AIRCRAFT_CONFIG.SPLINE_SAMPLES; i++) {
      const t = i / AIRCRAFT_CONFIG.SPLINE_SAMPLES;
      const pos = this.getSplinePosition(controlPoints, t);
      const dist = greatCircleDistance(prevPos, pos);
      totalLength += dist * (180 / Math.PI); // Convert to degrees
      prevPos = pos;
    }

    return totalLength;
  }

  /**
   * Launch an aircraft from an airfield with waypoints.
   */
  launchAircraft(
    airfield: Airfield,
    aircraftType: AircraftType,
    waypoints: GeoPosition[],
    ownerId: string
  ): Aircraft | null {
    // Check if airfield has aircraft of this type
    if (aircraftType === 'fighter' && airfield.fighterCount <= 0) {
      console.log('[AIRCRAFT] No fighters available');
      return null;
    }
    if (aircraftType === 'bomber' && airfield.bomberCount <= 0) {
      console.log('[AIRCRAFT] No bombers available');
      return null;
    }
    if (aircraftType === 'radar' && (airfield.radarCount ?? 0) <= 0) {
      console.log('[AIRCRAFT] No radar planes available');
      return null;
    }

    if (!airfield.geoPosition) {
      console.log('[AIRCRAFT] Airfield has no geo position');
      return null;
    }

    if (waypoints.length === 0) {
      console.log('[AIRCRAFT] No waypoints provided');
      return null;
    }

    const speed = aircraftType === 'fighter'
      ? AIRCRAFT_CONFIG.FIGHTER_SPEED
      : aircraftType === 'radar'
        ? AIRCRAFT_CONFIG.RADAR_SPEED
        : AIRCRAFT_CONFIG.BOMBER_SPEED;

    // Build the full path: airfield -> waypoints -> airfield
    const fullPath = [
      airfield.geoPosition,
      ...waypoints,
      airfield.geoPosition,
    ];

    // Calculate total path length
    const totalPathLength = this.calculateSplineLength(fullPath);

    // Calculate initial heading toward first waypoint
    const heading = this.calculateHeading(airfield.geoPosition, waypoints[0]);

    const aircraft: Aircraft = {
      id: uuidv4(),
      type: aircraftType,
      ownerId,
      airfieldId: airfield.id,
      geoPosition: { ...airfield.geoPosition },
      altitude: AIRCRAFT_CONFIG.ALTITUDE,
      heading,
      speed,
      waypoints,
      currentWaypointIndex: 0,
      returning: false,
      status: 'flying',
      launchTime: Date.now(),
      splineProgress: 0,
      totalPathLength,
    };

    console.log(`[AIRCRAFT] Launched ${aircraftType} from airfield with ${waypoints.length} waypoints, path length: ${totalPathLength.toFixed(1)}°`);
    return aircraft;
  }

  /**
   * Update all aircraft positions and handle waypoint navigation.
   */
  update(state: GameState, deltaSeconds: number): GameEvent[] {
    const events: GameEvent[] = [];

    for (const aircraft of getAircraft(state)) {
      if (aircraft.status !== 'flying') continue;

      const airfield = state.buildings[aircraft.airfieldId] as Airfield | undefined;
      if (!airfield || !airfield.geoPosition) {
        aircraft.status = 'destroyed';
        continue;
      }

      // Build the full path for spline interpolation
      const fullPath = [
        airfield.geoPosition,
        ...aircraft.waypoints,
        airfield.geoPosition,
      ];

      // Initialize spline progress if not set (for backwards compatibility)
      if (aircraft.splineProgress === undefined) {
        aircraft.splineProgress = 0;
        aircraft.totalPathLength = this.calculateSplineLength(fullPath);
      }

      // Calculate movement in terms of progress
      const totalLength = aircraft.totalPathLength || this.calculateSplineLength(fullPath);
      if (totalLength <= 0) {
        this.landAircraft(state, aircraft);
        continue;
      }

      const moveDistance = aircraft.speed * deltaSeconds; // degrees
      const progressDelta = moveDistance / totalLength;

      // Advance progress
      aircraft.splineProgress = (aircraft.splineProgress || 0) + progressDelta;

      // Check if completed the path
      if (aircraft.splineProgress >= 1) {
        this.landAircraft(state, aircraft);
        continue;
      }

      // Get new position from spline
      const newPosition = this.getSplinePosition(fullPath, aircraft.splineProgress);

      // Calculate heading from current to next position (small step ahead)
      const lookAheadProgress = Math.min(1, aircraft.splineProgress + 0.01);
      const lookAheadPos = this.getSplinePosition(fullPath, lookAheadProgress);

      aircraft.heading = this.calculateHeading(newPosition, lookAheadPos);
      aircraft.geoPosition = newPosition;

      // Update waypoint index for UI (approximate based on progress)
      const numWaypoints = aircraft.waypoints.length;
      const waypointProgress = aircraft.splineProgress * (numWaypoints + 1); // +1 for return
      aircraft.currentWaypointIndex = Math.min(
        Math.floor(waypointProgress),
        numWaypoints
      );
      aircraft.returning = aircraft.currentWaypointIndex >= numWaypoints;
    }

    return events;
  }

  /**
   * Land an aircraft at its airfield.
   */
  private landAircraft(state: GameState, aircraft: Aircraft): void {
    const airfield = state.buildings[aircraft.airfieldId] as Airfield | undefined;
    if (!airfield || airfield.destroyed) {
      aircraft.status = 'destroyed';
      return;
    }

    // Return aircraft to airfield inventory
    if (aircraft.type === 'fighter') {
      airfield.fighterCount++;
    } else if (aircraft.type === 'radar') {
      airfield.radarCount = (airfield.radarCount ?? 0) + 1;
    } else {
      airfield.bomberCount++;
    }

    aircraft.status = 'grounded';
    console.log(`[AIRCRAFT] ${aircraft.type} landed at airfield`);
  }

  /**
   * Calculate heading in degrees from one position to another.
   * 0 = north, 90 = east, 180 = south, 270 = west
   */
  private calculateHeading(from: GeoPosition, to: GeoPosition): number {
    const lat1 = from.lat * (Math.PI / 180);
    const lat2 = to.lat * (Math.PI / 180);
    const dLng = (to.lng - from.lng) * (Math.PI / 180);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    let heading = Math.atan2(y, x) * (180 / Math.PI);
    heading = (heading + 360) % 360; // Normalize to 0-360

    return heading;
  }
}
