import type { GeoCoordinate } from './types';
import type { Vector2 } from '../types';

// Convert geographic coordinates to 3D sphere position
// Returns {x, y, z} where:
// - x is left/right (negative west, positive east)
// - y is up/down (positive north pole, negative south pole)
// - z is front/back
export function geoToSphere(coord: GeoCoordinate, radius: number): { x: number; y: number; z: number } {
  const phi = (90 - coord.lat) * (Math.PI / 180);   // Latitude to polar angle
  const theta = (coord.lng + 180) * (Math.PI / 180); // Longitude to azimuthal angle

  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta),
  };
}

// Convert 3D sphere position to geographic coordinates
export function sphereToGeo(point: { x: number; y: number; z: number }, radius: number): GeoCoordinate {
  // Normalize the point to unit sphere
  const len = Math.sqrt(point.x * point.x + point.y * point.y + point.z * point.z);
  const nx = point.x / len;
  const ny = point.y / len;
  const nz = point.z / len;

  const lat = 90 - Math.acos(ny) * (180 / Math.PI);
  let lng = Math.atan2(nz, -nx) * (180 / Math.PI) - 180;

  // Normalize longitude to -180 to 180
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;

  return { lat, lng };
}

// Calculate great-circle distance between two points (in radians)
export function greatCircleDistance(a: GeoCoordinate, b: GeoCoordinate): number {
  const lat1 = a.lat * (Math.PI / 180);
  const lat2 = b.lat * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * (Math.PI / 180);
  let dLng = (b.lng - a.lng) * (Math.PI / 180);

  // Normalize longitude difference to find shortest path (-π to π)
  while (dLng > Math.PI) dLng -= 2 * Math.PI;
  while (dLng < -Math.PI) dLng += 2 * Math.PI;

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);

  const h = sinHalfDLat * sinHalfDLat +
            Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

  // Clamp h to valid range for asin (numerical precision can cause h > 1)
  const clampedH = Math.max(0, Math.min(1, h));

  return 2 * Math.asin(Math.sqrt(clampedH));
}

// Interpolate along great circle path (spherical linear interpolation)
export function geoInterpolate(a: GeoCoordinate, b: GeoCoordinate, t: number): GeoCoordinate {
  const lat1 = a.lat * (Math.PI / 180);
  const lng1 = a.lng * (Math.PI / 180);
  const lat2 = b.lat * (Math.PI / 180);
  const lng2 = b.lng * (Math.PI / 180);

  const d = greatCircleDistance(a, b);
  if (d < 0.0001) return a; // Points are essentially the same

  const sinD = Math.sin(d);
  const A = Math.sin((1 - t) * d) / sinD;
  const B = Math.sin(t * d) / sinD;

  const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
  const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);

  const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * (180 / Math.PI);
  const lng = Math.atan2(y, x) * (180 / Math.PI);

  return { lat, lng };
}

// Easing function for ICBM trajectory
// Converts linear progress (0-1) to visual progress that accounts for
// realistic speed changes: slower climb, faster descent
export function icbmEaseProgress(linearProgress: number): number {
  const t = Math.max(0, Math.min(1, linearProgress));

  // Phase boundaries (as fractions of total progress)
  const LAUNCH_END = 0.20;    // First 20% is launch
  const REENTRY_START = 0.80; // Last 20% is reentry

  if (t < LAUNCH_END) {
    // Launch phase: slower movement (climbing against gravity)
    // Use ease-out - starts slower, speeds up as it gains momentum
    const launchT = t / LAUNCH_END;
    const easedLaunch = 1 - Math.pow(1 - launchT, 2); // ease-out quadratic
    return easedLaunch * LAUNCH_END;
  } else if (t > REENTRY_START) {
    // Reentry phase: faster movement (falling with gravity)
    // Use ease-in - accelerates as it falls
    const reentryT = (t - REENTRY_START) / (1 - REENTRY_START);
    const easedReentry = Math.pow(reentryT, 2); // ease-in quadratic
    return REENTRY_START + easedReentry * (1 - REENTRY_START);
  } else {
    // Cruise phase: constant speed in space
    return t;
  }
}

// Fixed phase durations in real-world seconds (consistent visual pacing)
const LAUNCH_DURATION_SECONDS = 15.0;  // All missiles take 15s to climb (realistic rocket launch)
const REENTRY_DURATION_SECONDS = 8.0;  // All missiles take 8s to descend
const MAX_PHASE_FRACTION = 0.45;       // Cap each phase at 45% to prevent overlap

// Easing helpers - using sine-based for gentle, natural curves
function easeOutSine(t: number): number {
  // Gentle acceleration at start, smooth approach to max altitude
  return Math.sin(t * Math.PI / 2);
}

function easeInSine(t: number): number {
  // Gentle start in space, smooth acceleration during descent
  return 1 - Math.cos(t * Math.PI / 2);
}

// Get 3D position along missile arc (great circle + altitude)
// Uses fixed real-time durations for climb/descent for consistent visual pacing
export function getMissilePosition3D(
  startGeo: GeoCoordinate,
  endGeo: GeoCoordinate,
  progress: number,
  maxAltitude: number,
  sphereRadius: number,
  flightDuration?: number // in milliseconds - used to calculate fixed-time phases
): { x: number; y: number; z: number } {
  // Clamp progress
  const t = Math.max(0, Math.min(1, progress));

  // Get ground position along great circle
  const groundGeo = geoInterpolate(startGeo, endGeo, t);
  const groundPos = geoToSphere(groundGeo, sphereRadius);

  // Safety check for NaN (can happen with bad geo coordinates)
  if (isNaN(groundPos.x) || isNaN(groundPos.y) || isNaN(groundPos.z)) {
    // Fallback to start position
    const startPos = geoToSphere(startGeo, sphereRadius);
    return startPos;
  }

  // Calculate phase boundaries based on fixed real-time durations
  // This ensures all missiles take ~4s to climb and ~3s to descend
  const flightSeconds = (flightDuration || 15000) / 1000;

  // Calculate phase boundaries as fractions of total flight
  // Cap each phase at MAX_PHASE_FRACTION to ensure they don't overlap
  const launchPhaseEnd = Math.min(MAX_PHASE_FRACTION, LAUNCH_DURATION_SECONDS / flightSeconds);
  const reentryPhaseDuration = Math.min(MAX_PHASE_FRACTION, REENTRY_DURATION_SECONDS / flightSeconds);
  const reentryPhaseStart = 1.0 - reentryPhaseDuration;

  // Calculate altitude using dynamic phase boundaries
  let altitude: number;

  if (t < launchPhaseEnd) {
    // Launch phase: Gentle climb to space
    // Smooth acceleration, gradual approach to cruise altitude
    const launchProgress = t / launchPhaseEnd;
    altitude = maxAltitude * easeOutSine(launchProgress);
  } else if (t > reentryPhaseStart) {
    // Reentry phase: Gentle descent from space
    // Smooth start, gradual acceleration during descent
    const reentryProgress = (t - reentryPhaseStart) / reentryPhaseDuration;
    altitude = maxAltitude * (1 - easeInSine(reentryProgress));
  } else {
    // Cruise phase: Constant altitude in space
    altitude = maxAltitude;
  }

  // Move position outward from sphere center by altitude
  const len = Math.sqrt(groundPos.x * groundPos.x + groundPos.y * groundPos.y + groundPos.z * groundPos.z);

  // Safety check for zero length
  if (len < 0.001) {
    return geoToSphere(startGeo, sphereRadius + altitude);
  }

  const scale = (sphereRadius + altitude) / len;

  return {
    x: groundPos.x * scale,
    y: groundPos.y * scale,
    z: groundPos.z * scale,
  };
}

// Get the direction vector of the missile at current position (for orienting the model)
export function getMissileDirection3D(
  startGeo: GeoCoordinate,
  endGeo: GeoCoordinate,
  progress: number,
  maxAltitude: number,
  sphereRadius: number,
  flightDuration?: number
): { x: number; y: number; z: number } {
  // Get position slightly ahead to calculate direction
  const delta = 0.01;
  const nextProgress = Math.min(1, progress + delta);

  const currentPos = getMissilePosition3D(startGeo, endGeo, progress, maxAltitude, sphereRadius, flightDuration);
  const nextPos = getMissilePosition3D(startGeo, endGeo, nextProgress, maxAltitude, sphereRadius, flightDuration);

  // Direction vector
  const dx = nextPos.x - currentPos.x;
  const dy = nextPos.y - currentPos.y;
  const dz = nextPos.z - currentPos.z;

  // Normalize
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.0001) return { x: 0, y: 1, z: 0 };

  return { x: dx / len, y: dy / len, z: dz / len };
}

// Convert 2D pixel position to approximate geo coordinates (for legacy support)
// Uses a simple equirectangular projection
export function pixelToGeo(pixel: Vector2, mapWidth: number, mapHeight: number): GeoCoordinate {
  // Map is assumed to show -180 to 180 longitude and 90 to -90 latitude
  const lng = ((pixel.x / mapWidth) * 360) - 180;
  const lat = 90 - ((pixel.y / mapHeight) * 180);
  return { lat, lng };
}

// Convert geo coordinates to 2D pixel position (for legacy support)
export function geoToPixel(geo: GeoCoordinate, mapWidth: number, mapHeight: number): Vector2 {
  const x = ((geo.lng + 180) / 360) * mapWidth;
  const y = ((90 - geo.lat) / 180) * mapHeight;
  return { x, y };
}

// Calculate bearing from point A to point B (in degrees, 0 = north, 90 = east)
export function calculateBearing(a: GeoCoordinate, b: GeoCoordinate): number {
  const lat1 = a.lat * (Math.PI / 180);
  const lat2 = b.lat * (Math.PI / 180);
  const dLng = (b.lng - a.lng) * (Math.PI / 180);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  const bearing = Math.atan2(y, x) * (180 / Math.PI);
  return (bearing + 360) % 360;
}

// Satellite orbital mechanics

export interface SatelliteOrbitalParams {
  launchTime: number;
  orbitalPeriod: number;
  orbitalAltitude: number;
  inclination: number;        // degrees (0-90)
  startingLongitude: number;  // degrees
}

/**
 * Calculate 3D position of a satellite at orbital altitude
 *
 * The satellite orbits on an inclined great circle. The inclination
 * determines how far north/south the satellite travels (0° = equatorial,
 * 90° = polar orbit).
 *
 * @param params Orbital parameters
 * @param currentTime Current timestamp in ms
 * @param sphereRadius Radius of the globe
 * @returns 3D position {x, y, z}
 */
export function getSatellitePosition3D(
  params: SatelliteOrbitalParams,
  currentTime: number,
  sphereRadius: number
): { x: number; y: number; z: number } {
  const elapsed = currentTime - params.launchTime;
  const progress = (elapsed / params.orbitalPeriod) % 1;

  // Calculate position on inclined orbit
  const angle = progress * 2 * Math.PI;
  const inclination = params.inclination * (Math.PI / 180);

  // Position on inclined orbit (before longitude rotation)
  // The orbit is tilted from the equatorial plane by inclination
  const x = Math.cos(angle);
  const y = Math.sin(angle) * Math.sin(inclination);
  const z = Math.sin(angle) * Math.cos(inclination);

  // Rotate by starting longitude around Y axis
  const startRad = params.startingLongitude * (Math.PI / 180);
  const rotatedX = x * Math.cos(startRad) - z * Math.sin(startRad);
  const rotatedZ = x * Math.sin(startRad) + z * Math.cos(startRad);

  // Scale to orbital altitude
  const altitude = sphereRadius + params.orbitalAltitude;

  return {
    x: rotatedX * altitude,
    y: y * altitude,
    z: rotatedZ * altitude
  };
}

/**
 * Get the geographic position directly below a satellite (nadir point)
 *
 * @param params Orbital parameters
 * @param currentTime Current timestamp in ms
 * @param sphereRadius Radius of the globe
 * @returns Geographic coordinates of the point directly below the satellite
 */
export function getSatelliteGroundPosition(
  params: SatelliteOrbitalParams,
  currentTime: number,
  sphereRadius: number
): GeoCoordinate {
  const pos3D = getSatellitePosition3D(params, currentTime, sphereRadius);
  return sphereToGeo(pos3D, sphereRadius);
}

/**
 * Calculate orbital progress (0-1) for a satellite at given time
 */
export function getSatelliteProgress(
  launchTime: number,
  orbitalPeriod: number,
  currentTime: number
): number {
  const elapsed = currentTime - launchTime;
  return (elapsed / orbitalPeriod) % 1;
}

/**
 * Check if a satellite has line-of-sight to a ground position
 * Used for determining if satellite can communicate with a radar
 *
 * @param satelliteParams Orbital parameters of the satellite
 * @param groundPos Position of the ground station
 * @param currentTime Current timestamp
 * @param sphereRadius Globe radius
 * @param maxRangeDegrees Maximum communication range in degrees
 * @returns true if within communication range
 */
export function satelliteCanCommunicate(
  satelliteParams: SatelliteOrbitalParams,
  groundPos: GeoCoordinate,
  currentTime: number,
  sphereRadius: number,
  maxRangeDegrees: number
): boolean {
  const satGroundPos = getSatelliteGroundPosition(satelliteParams, currentTime, sphereRadius);
  const angularDistance = greatCircleDistance(satGroundPos, groundPos);
  const distanceDegrees = angularDistance * (180 / Math.PI);
  return distanceDegrees <= maxRangeDegrees;
}

/**
 * Check if two satellites can communicate with each other
 *
 * @param sat1Params First satellite orbital parameters
 * @param sat2Params Second satellite orbital parameters
 * @param currentTime Current timestamp
 * @param sphereRadius Globe radius
 * @param maxRangeDegrees Maximum inter-satellite communication range in degrees
 * @returns true if within communication range
 */
export function satellitesCanCommunicate(
  sat1Params: SatelliteOrbitalParams,
  sat2Params: SatelliteOrbitalParams,
  currentTime: number,
  sphereRadius: number,
  maxRangeDegrees: number
): boolean {
  const sat1Pos = getSatelliteGroundPosition(sat1Params, currentTime, sphereRadius);
  const sat2Pos = getSatelliteGroundPosition(sat2Params, currentTime, sphereRadius);
  const angularDistance = greatCircleDistance(sat1Pos, sat2Pos);
  const distanceDegrees = angularDistance * (180 / Math.PI);
  return distanceDegrees <= maxRangeDegrees;
}
