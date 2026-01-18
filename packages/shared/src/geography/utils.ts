import type { GeoCoordinate } from './types';
import type { Vector2 } from '../types';

// ============================================================================
// Vector3 Types and Math Utilities
// ============================================================================

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

// Basic vector operations
export function vec3Add(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: Vector3, s: number): Vector3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3Magnitude(v: Vector3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vector3): Vector3 {
  const mag = vec3Magnitude(v);
  if (mag < 0.00001) return { x: 0, y: 0, z: 0 };
  return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

export function vec3Lerp(a: Vector3, b: Vector3, t: number): Vector3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function vec3Distance(a: Vector3, b: Vector3): number {
  return vec3Magnitude(vec3Subtract(b, a));
}

export function vec3AngleBetween(a: Vector3, b: Vector3): number {
  const dot = vec3Dot(vec3Normalize(a), vec3Normalize(b));
  // Clamp to prevent NaN from acos
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/**
 * Rotate vector 'from' toward vector 'to' by at most 'maxAngle' radians
 */
export function vec3RotateToward(from: Vector3, to: Vector3, maxAngle: number): Vector3 {
  const fromNorm = vec3Normalize(from);
  const toNorm = vec3Normalize(to);
  const angle = vec3AngleBetween(fromNorm, toNorm);

  if (angle < 0.0001) return fromNorm;

  const t = Math.min(1, maxAngle / angle);
  // Spherical lerp (simplified - works well for small angles)
  const result = vec3Lerp(fromNorm, toNorm, t);
  return vec3Normalize(result);
}

/**
 * Convert geo coordinates to Cartesian 3D position
 * @param geo Geographic coordinates
 * @param altitude Altitude above the sphere surface
 * @param sphereRadius Radius of the sphere
 */
export function geoToCartesian(geo: GeoCoordinate, altitude: number, sphereRadius: number): Vector3 {
  const phi = (90 - geo.lat) * (Math.PI / 180);
  const theta = (geo.lng + 180) * (Math.PI / 180);
  const r = sphereRadius + altitude;

  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta),
  };
}

/**
 * Convert Cartesian 3D position to geo coordinates
 * @param pos 3D position
 * @param sphereRadius Radius of the sphere (used to calculate altitude)
 * @returns Geographic coordinates with altitude
 */
export function cartesianToGeo(pos: Vector3, sphereRadius: number): GeoCoordinate & { altitude: number } {
  const r = vec3Magnitude(pos);

  // Handle zero-length vector (at origin)
  if (r < 0.00001) {
    return { lat: 0, lng: 0, altitude: -sphereRadius };
  }

  const altitude = r - sphereRadius;

  // Normalize to unit sphere
  const nx = pos.x / r;
  const ny = pos.y / r;
  const nz = pos.z / r;

  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, ny))) * (180 / Math.PI);
  let lng = Math.atan2(nz, -nx) * (180 / Math.PI) - 180;

  // Normalize longitude to -180 to 180
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;

  return { lat, lng, altitude };
}

/**
 * Get the "up" vector (radially outward from globe center) at a given position
 */
export function getUpVector(pos: Vector3): Vector3 {
  return vec3Normalize(pos);
}

// ============================================================================
// Geographic Utilities
// ============================================================================

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

  // Handle zero-length vector (at origin)
  if (len < 0.00001) {
    return { lat: 0, lng: 0 };
  }

  const nx = point.x / len;
  const ny = point.y / len;
  const nz = point.z / len;

  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, ny))) * (180 / Math.PI);
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

// Easing helper
function smootherstep(t: number): number {
  // Ken Perlin's smoother version - zero 1st and 2nd derivatives at endpoints
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Compute a smooth ballistic altitude profile using a single continuous function.
 * No phase boundaries - uses a modified raised cosine that:
 * - Starts at 0 with zero velocity (on the ground)
 * - Rises with a natural rocket trajectory
 * - Has a flattened top (cruise phase)
 * - Descends smoothly to target
 * - Ends at 0
 *
 * The sqrt(sin) function naturally creates the flattened cruise phase
 * while remaining perfectly smooth (C∞ continuous).
 */
function ballisticAltitude(t: number): number {
  // Clamp input
  const progress = Math.max(0, Math.min(1, t));

  // Use sin(π*t) as the base - goes from 0 to 1 to 0 smoothly
  // sin already has zero derivative at the endpoints
  const sinCurve = Math.sin(progress * Math.PI);

  // Apply sqrt to flatten the top (cruise phase)
  // sqrt(sin(x)) spends more time near the peak value
  // This creates the "cruise at altitude" effect naturally
  const flattenedCurve = Math.sqrt(sinCurve);

  return flattenedCurve;
}

/**
 * Ground progress - use linear (constant speed) for smooth motion.
 * The visual effect of "slow launch" comes from the steep altitude climb,
 * not from actually slowing the ground speed. This avoids velocity
 * discontinuities at phase boundaries.
 */
function ballisticGroundProgress(t: number): number {
  // Simple linear progress - no phase-based speed changes
  // The altitude curve creates the visual impression of speed variation
  return Math.max(0, Math.min(1, t));
}

// Simple seeded random for deterministic variation
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Get 3D position along missile arc (great circle + altitude)
// Uses smooth ballistic curves for natural rocket-like motion
export function getMissilePosition3D(
  startGeo: GeoCoordinate,
  endGeo: GeoCoordinate,
  progress: number,
  maxAltitude: number,
  sphereRadius: number,
  flightDuration?: number, // in milliseconds (used for reference, but curves are normalized)
  seed?: number // optional seed for adding variation to missile path
): { x: number; y: number; z: number } {
  // Clamp progress
  const t = Math.max(0, Math.min(1, progress));

  // Calculate ground progress using ballistic speed profile
  // (slow at launch, constant in cruise, accelerating in descent)
  const groundProgress = ballisticGroundProgress(t);

  // Add slight randomness to path if seed provided
  let pathOffset = 0;
  if (seed !== undefined) {
    // Create a slight lateral wobble that varies along the path
    // Maximum offset at mid-flight, zero at start and end
    const wobbleFactor = Math.sin(groundProgress * Math.PI); // 0 at ends, 1 in middle
    const randomOffset = (seededRandom(seed) - 0.5) * 2; // -1 to 1
    pathOffset = wobbleFactor * randomOffset * 0.008; // Small offset in radians
  }

  // Get ground position along great circle with possible offset
  let groundGeo = geoInterpolate(startGeo, endGeo, groundProgress);

  // Apply lateral offset perpendicular to path
  if (pathOffset !== 0) {
    // Calculate bearing and offset perpendicular to it
    const bearing = calculateBearing(startGeo, endGeo);
    const perpBearing = (bearing + 90) % 360;
    // Offset the position slightly perpendicular to the path
    groundGeo = {
      lat: groundGeo.lat + pathOffset * Math.cos(perpBearing * Math.PI / 180) * 10,
      lng: groundGeo.lng + pathOffset * Math.sin(perpBearing * Math.PI / 180) * 10,
    };
  }

  const groundPos = geoToSphere(groundGeo, sphereRadius);

  // Safety check for NaN (can happen with bad geo coordinates)
  if (isNaN(groundPos.x) || isNaN(groundPos.y) || isNaN(groundPos.z)) {
    // Fallback to start position
    const startPos = geoToSphere(startGeo, sphereRadius);
    return startPos;
  }

  // Calculate altitude using smooth ballistic profile
  // Add slight altitude variation from seed
  let altitudeVariation = 1.0;
  if (seed !== undefined) {
    altitudeVariation = 0.95 + seededRandom(seed + 2) * 0.1; // 0.95 to 1.05
  }

  // Get smooth altitude from ballistic curve (returns 0-1+ range)
  const altitudeFactor = ballisticAltitude(t);
  const altitude = maxAltitude * altitudeVariation * altitudeFactor;

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
  flightDuration?: number,
  seed?: number
): { x: number; y: number; z: number } {
  // Get position slightly ahead to calculate direction
  const delta = 0.01;
  const nextProgress = Math.min(1, progress + delta);

  const currentPos = getMissilePosition3D(startGeo, endGeo, progress, maxAltitude, sphereRadius, flightDuration, seed);
  const nextPos = getMissilePosition3D(startGeo, endGeo, nextProgress, maxAltitude, sphereRadius, flightDuration, seed);

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

/**
 * Check if a point is inside a polygon using ray casting algorithm.
 * Works with geo coordinates (lat/lng).
 *
 * The algorithm counts how many times a horizontal ray from the point
 * crosses polygon edges. An odd count means the point is inside.
 */
export function pointInPolygon(point: GeoCoordinate, polygon: GeoCoordinate[]): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  const x = point.lng;
  const y = point.lat;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng, yi = polygon[i].lat;
    const xj = polygon[j].lng, yj = polygon[j].lat;

    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}
