import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GeoPosition, pointInPolygon } from '@defcon/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

interface GeoJSONMultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

interface GeoJSONFeature {
  type: 'Feature';
  geometry: GeoJSONPolygon | GeoJSONMultiPolygon;
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

// Store land polygons as arrays of GeoPosition
let landPolygons: GeoPosition[][] = [];
let initialized = false;

/**
 * Load land polygons from GeoJSON file.
 * Call this once at server startup.
 */
export function initializeLandDetection(): void {
  if (initialized) return;

  try {
    // Path relative to server package
    const geojsonPath = path.resolve(__dirname, '../../assets/world-land.geojson');
    const data = fs.readFileSync(geojsonPath, 'utf-8');
    const geojson: GeoJSONFeatureCollection = JSON.parse(data);

    for (const feature of geojson.features) {
      if (feature.geometry.type === 'Polygon') {
        // Single polygon - just use outer ring (first coordinate array)
        const coords = feature.geometry.coordinates[0];
        const polygon = coords.map(([lng, lat]) => ({ lat, lng }));
        landPolygons.push(polygon);
      } else if (feature.geometry.type === 'MultiPolygon') {
        // Multiple polygons - process each
        for (const poly of feature.geometry.coordinates) {
          const coords = poly[0]; // outer ring
          const polygon = coords.map(([lng, lat]) => ({ lat, lng }));
          landPolygons.push(polygon);
        }
      }
    }

    initialized = true;
    console.log(`Land detection initialized with ${landPolygons.length} polygons`);
  } catch (error) {
    console.error('Failed to load land detection data:', error);
    // Continue without land detection - will allow all placements
  }
}

/**
 * Check if a geographic position is on land.
 * Returns true if on land, false if in ocean.
 * If land detection not initialized, returns true (permissive fallback).
 */
export function isPointOnLand(point: GeoPosition): boolean {
  if (!initialized || landPolygons.length === 0) {
    return true; // Permissive fallback
  }

  // Check if point is inside any land polygon
  for (const polygon of landPolygons) {
    if (pointInPolygon(point, polygon)) {
      return true;
    }
  }

  return false;
}
