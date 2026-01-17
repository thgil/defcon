import type { TerritoryGeoData, CityGeoData, GeoCoordinate } from './types';

// Territory definitions with real world coordinates
export const TERRITORY_GEO_DATA: Record<string, TerritoryGeoData> = {
  north_america: {
    id: 'north_america',
    name: 'North America',
    centroid: { lat: 40, lng: -100 },
    bounds: { north: 70, south: 15, east: -50, west: -170 },
    boundaryCoords: [
      { lat: 70, lng: -170 },
      { lat: 70, lng: -50 },
      { lat: 60, lng: -50 },
      { lat: 45, lng: -55 },
      { lat: 25, lng: -80 },
      { lat: 15, lng: -90 },
      { lat: 15, lng: -110 },
      { lat: 30, lng: -120 },
      { lat: 50, lng: -130 },
      { lat: 60, lng: -140 },
      { lat: 70, lng: -170 },
    ],
  },
  south_america: {
    id: 'south_america',
    name: 'South America',
    centroid: { lat: -15, lng: -55 },
    bounds: { north: 10, south: -55, east: -35, west: -80 },
    boundaryCoords: [
      { lat: 10, lng: -80 },
      { lat: 10, lng: -60 },
      { lat: 0, lng: -50 },
      { lat: -10, lng: -35 },
      { lat: -35, lng: -55 },
      { lat: -55, lng: -70 },
      { lat: -55, lng: -75 },
      { lat: -20, lng: -70 },
      { lat: 0, lng: -80 },
      { lat: 10, lng: -80 },
    ],
  },
  europe: {
    id: 'europe',
    name: 'Europe',
    centroid: { lat: 50, lng: 10 },
    bounds: { north: 70, south: 35, east: 40, west: -10 },
    boundaryCoords: [
      { lat: 70, lng: -10 },
      { lat: 70, lng: 30 },
      { lat: 60, lng: 40 },
      { lat: 45, lng: 40 },
      { lat: 35, lng: 30 },
      { lat: 35, lng: -10 },
      { lat: 45, lng: -10 },
      { lat: 60, lng: -10 },
      { lat: 70, lng: -10 },
    ],
  },
  russia: {
    id: 'russia',
    name: 'Russia',
    centroid: { lat: 60, lng: 100 },
    bounds: { north: 75, south: 45, east: 180, west: 30 },
    boundaryCoords: [
      { lat: 70, lng: 30 },
      { lat: 75, lng: 100 },
      { lat: 70, lng: 180 },
      { lat: 55, lng: 180 },
      { lat: 45, lng: 140 },
      { lat: 50, lng: 90 },
      { lat: 45, lng: 60 },
      { lat: 50, lng: 40 },
      { lat: 60, lng: 30 },
      { lat: 70, lng: 30 },
    ],
  },
  africa: {
    id: 'africa',
    name: 'Africa',
    centroid: { lat: 5, lng: 20 },
    bounds: { north: 35, south: -35, east: 50, west: -20 },
    boundaryCoords: [
      { lat: 35, lng: -10 },
      { lat: 35, lng: 30 },
      { lat: 30, lng: 35 },
      { lat: 10, lng: 50 },
      { lat: -10, lng: 50 },
      { lat: -35, lng: 30 },
      { lat: -35, lng: 15 },
      { lat: -5, lng: 10 },
      { lat: 5, lng: -20 },
      { lat: 20, lng: -20 },
      { lat: 35, lng: -10 },
    ],
  },
  asia: {
    id: 'asia',
    name: 'Asia',
    centroid: { lat: 30, lng: 100 },
    bounds: { north: 50, south: -10, east: 145, west: 60 },
    boundaryCoords: [
      { lat: 50, lng: 60 },
      { lat: 45, lng: 90 },
      { lat: 50, lng: 140 },
      { lat: 40, lng: 145 },
      { lat: 25, lng: 145 },
      { lat: 5, lng: 120 },
      { lat: -10, lng: 105 },
      { lat: 5, lng: 95 },
      { lat: 25, lng: 60 },
      { lat: 35, lng: 60 },
      { lat: 50, lng: 60 },
    ],
  },
};

// City definitions with real world coordinates
export const CITY_GEO_DATA: Record<string, CityGeoData[]> = {
  north_america: [
    { name: 'New York', position: { lat: 40.7128, lng: -74.006 }, population: 20000000 },
    { name: 'Los Angeles', position: { lat: 34.0522, lng: -118.2437 }, population: 15000000 },
    { name: 'Chicago', position: { lat: 41.8781, lng: -87.6298 }, population: 10000000 },
    { name: 'Houston', position: { lat: 29.7604, lng: -95.3698 }, population: 7000000 },
    { name: 'Washington DC', position: { lat: 38.9072, lng: -77.0369 }, population: 6000000 },
    { name: 'Toronto', position: { lat: 43.6532, lng: -79.3832 }, population: 6000000 },
    { name: 'Phoenix', position: { lat: 33.4484, lng: -112.074 }, population: 5000000 },
    { name: 'Philadelphia', position: { lat: 39.9526, lng: -75.1652 }, population: 6000000 },
    { name: 'San Francisco', position: { lat: 37.7749, lng: -122.4194 }, population: 4700000 },
    { name: 'Seattle', position: { lat: 47.6062, lng: -122.3321 }, population: 4000000 },
  ],
  south_america: [
    { name: 'Sao Paulo', position: { lat: -23.5505, lng: -46.6333 }, population: 22000000 },
    { name: 'Buenos Aires', position: { lat: -34.6037, lng: -58.3816 }, population: 15000000 },
    { name: 'Rio de Janeiro', position: { lat: -22.9068, lng: -43.1729 }, population: 12000000 },
    { name: 'Lima', position: { lat: -12.0464, lng: -77.0428 }, population: 10000000 },
    { name: 'Bogota', position: { lat: 4.711, lng: -74.0721 }, population: 11000000 },
    { name: 'Santiago', position: { lat: -33.4489, lng: -70.6693 }, population: 7000000 },
    { name: 'Caracas', position: { lat: 10.4806, lng: -66.9036 }, population: 3000000 },
    { name: 'Brasilia', position: { lat: -15.8267, lng: -47.9218 }, population: 4700000 },
    { name: 'Medellin', position: { lat: 6.2442, lng: -75.5812 }, population: 4000000 },
  ],
  europe: [
    { name: 'London', position: { lat: 51.5074, lng: -0.1278 }, population: 14000000 },
    { name: 'Paris', position: { lat: 48.8566, lng: 2.3522 }, population: 12000000 },
    { name: 'Berlin', position: { lat: 52.52, lng: 13.405 }, population: 6000000 },
    { name: 'Madrid', position: { lat: 40.4168, lng: -3.7038 }, population: 6500000 },
    { name: 'Rome', position: { lat: 41.9028, lng: 12.4964 }, population: 4500000 },
    { name: 'Barcelona', position: { lat: 41.3851, lng: 2.1734 }, population: 5500000 },
    { name: 'Vienna', position: { lat: 48.2082, lng: 16.3738 }, population: 2000000 },
    { name: 'Warsaw', position: { lat: 52.2297, lng: 21.0122 }, population: 3500000 },
    { name: 'Amsterdam', position: { lat: 52.3676, lng: 4.9041 }, population: 2500000 },
    { name: 'Munich', position: { lat: 48.1351, lng: 11.582 }, population: 3000000 },
  ],
  russia: [
    { name: 'Moscow', position: { lat: 55.7558, lng: 37.6173 }, population: 17000000 },
    { name: 'St Petersburg', position: { lat: 59.9311, lng: 30.3609 }, population: 7000000 },
    { name: 'Novosibirsk', position: { lat: 55.0084, lng: 82.9357 }, population: 1600000 },
    { name: 'Vladivostok', position: { lat: 43.1332, lng: 131.9113 }, population: 600000 },
    { name: 'Yekaterinburg', position: { lat: 56.8389, lng: 60.6057 }, population: 1500000 },
    { name: 'Kazan', position: { lat: 55.8304, lng: 49.0661 }, population: 1300000 },
    { name: 'Nizhny Novgorod', position: { lat: 56.2965, lng: 43.9361 }, population: 1250000 },
    { name: 'Chelyabinsk', position: { lat: 55.1644, lng: 61.4368 }, population: 1200000 },
    { name: 'Omsk', position: { lat: 54.9885, lng: 73.3242 }, population: 1150000 },
  ],
  africa: [
    { name: 'Cairo', position: { lat: 30.0444, lng: 31.2357 }, population: 20000000 },
    { name: 'Lagos', position: { lat: 6.5244, lng: 3.3792 }, population: 15000000 },
    { name: 'Johannesburg', position: { lat: -26.2041, lng: 28.0473 }, population: 10000000 },
    { name: 'Nairobi', position: { lat: -1.2921, lng: 36.8219 }, population: 5000000 },
    { name: 'Kinshasa', position: { lat: -4.4419, lng: 15.2663 }, population: 14000000 },
    { name: 'Casablanca', position: { lat: 33.5731, lng: -7.5898 }, population: 4000000 },
    { name: 'Addis Ababa', position: { lat: 9.0054, lng: 38.7636 }, population: 5000000 },
    { name: 'Dar es Salaam', position: { lat: -6.7924, lng: 39.2083 }, population: 6000000 },
    { name: 'Cape Town', position: { lat: -33.9249, lng: 18.4241 }, population: 4600000 },
  ],
  asia: [
    { name: 'Beijing', position: { lat: 39.9042, lng: 116.4074 }, population: 22000000 },
    { name: 'Tokyo', position: { lat: 35.6762, lng: 139.6503 }, population: 38000000 },
    { name: 'Mumbai', position: { lat: 19.076, lng: 72.8777 }, population: 21000000 },
    { name: 'Shanghai', position: { lat: 31.2304, lng: 121.4737 }, population: 27000000 },
    { name: 'Delhi', position: { lat: 28.7041, lng: 77.1025 }, population: 30000000 },
    { name: 'Seoul', position: { lat: 37.5665, lng: 126.978 }, population: 25000000 },
    { name: 'Bangkok', position: { lat: 13.7563, lng: 100.5018 }, population: 10000000 },
    { name: 'Hong Kong', position: { lat: 22.3193, lng: 114.1694 }, population: 7500000 },
    { name: 'Singapore', position: { lat: 1.3521, lng: 103.8198 }, population: 5900000 },
    { name: 'Jakarta', position: { lat: -6.2088, lng: 106.8456 }, population: 11000000 },
  ],
};

// Get all territories as array
export function getAllTerritories(): TerritoryGeoData[] {
  return Object.values(TERRITORY_GEO_DATA);
}

// Get territory by ID
export function getTerritoryById(id: string): TerritoryGeoData | undefined {
  return TERRITORY_GEO_DATA[id];
}

// Get cities for a territory
export function getCitiesForTerritory(territoryId: string): CityGeoData[] {
  return CITY_GEO_DATA[territoryId] || [];
}

// Check if a geographic point is within a territory bounds
export function isPointInTerritoryBounds(point: GeoCoordinate, territoryId: string): boolean {
  const territory = TERRITORY_GEO_DATA[territoryId];
  if (!territory) return false;

  const { bounds } = territory;
  return (
    point.lat >= bounds.south &&
    point.lat <= bounds.north &&
    point.lng >= bounds.west &&
    point.lng <= bounds.east
  );
}
