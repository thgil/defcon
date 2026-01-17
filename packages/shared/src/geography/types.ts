// Geographic coordinate (latitude/longitude)
export interface GeoCoordinate {
  lat: number;  // -90 to 90 (degrees)
  lng: number;  // -180 to 180 (degrees)
}

// Geographic bounds for territories
export interface GeoBounds {
  north: number;  // Max latitude
  south: number;  // Min latitude
  east: number;   // Max longitude
  west: number;   // Min longitude
}

// Territory geographic data
export interface TerritoryGeoData {
  id: string;
  name: string;
  centroid: GeoCoordinate;
  bounds: GeoBounds;
  // Simplified boundary polygon (for rendering)
  boundaryCoords: GeoCoordinate[];
}

// City geographic data
export interface CityGeoData {
  name: string;
  position: GeoCoordinate;
  population: number;
}
