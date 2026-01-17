import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ConicPolygonGeometry from 'three-conic-polygon-geometry';
import {
  type GameState,
  type Building,
  type Missile,
  type City,
  type Territory,
  type GeoPosition,
  type Silo,
  type SiloMode,
  type Radar,
  type Satellite,
  type SatelliteLaunchFacility,
  geoToSphere,
  getMissilePosition3D,
  getMissileDirection3D,
  geoInterpolate,
  getTerritories,
  getCities,
  getBuildings,
  getMissiles,
  getSatellites,
  getSatellitePosition3D,
  getSatelliteGroundPosition,
  SatelliteOrbitalParams,
  TERRITORY_GEO_DATA,
} from '@defcon/shared';
import { HUDRenderer } from './HUDRenderer';

// DEFCON color palette
const COLORS = {
  background: 0x000508,
  ocean: 0x0c1620,  // Dark navy
  land: 0x080c10,   // Dark charcoal
  worldLine: 0x1a4a5a, // Cyan/teal coastlines
  friendly: 0x00ff88,
  friendlyGlow: 0x00ff88,
  enemy: 0xff4444,
  enemyGlow: 0xff4444,
  neutral: 0x444466,
  missile: 0xff0000,
  missileTrail: 0xff4400,
  interceptor: 0x00ffff,
  city: 0xffff00,
  cityDestroyed: 0x444400,
  satellite: 0x88aaff,
  satelliteOrbit: 0x4466aa,
  satelliteVision: 0x2244aa,
  communicationLink: 0x00ff88,
};

const GLOBE_RADIUS = 100;
const MISSILE_MIN_ALTITUDE = 5;  // Minimum altitude for very short flights
const MISSILE_MAX_ALTITUDE = 35; // Maximum altitude for intercontinental flights

// Satellite configuration (should match server SATELLITE_CONFIG)
const SATELLITE_ORBITAL_ALTITUDE = 50;  // Globe units above surface
const SATELLITE_VISION_RANGE_DEGREES = 12;
const SATELLITE_RADAR_COMM_RANGE = 90;  // Range to communicate with radar (degrees) - line of sight from orbit
const SATELLITE_SAT_COMM_RANGE = 90;    // Range for satellite-to-satellite relay (degrees)

// Calculate appropriate max altitude based on great-circle distance
function calculateMissileAltitude(startGeo: GeoPosition, endGeo: GeoPosition): number {
  // Calculate angular distance in radians using haversine formula
  const lat1 = startGeo.lat * (Math.PI / 180);
  const lat2 = endGeo.lat * (Math.PI / 180);
  const dLat = (endGeo.lat - startGeo.lat) * (Math.PI / 180);
  let dLng = (endGeo.lng - startGeo.lng) * (Math.PI / 180);

  // Normalize longitude difference to handle wrap-around
  while (dLng > Math.PI) dLng -= 2 * Math.PI;
  while (dLng < -Math.PI) dLng += 2 * Math.PI;

  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);
  const h = sinHalfDLat * sinHalfDLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

  // Clamp h to valid range for asin (numerical precision can cause issues)
  const clampedH = Math.max(0, Math.min(1, h));
  const angularDistance = 2 * Math.asin(Math.sqrt(clampedH));

  // Check for NaN and provide fallback
  if (isNaN(angularDistance) || angularDistance < 0.001) {
    return MISSILE_MIN_ALTITUDE;
  }

  // angularDistance ranges from 0 to π (half the globe)
  // Scale altitude: short flights get low altitude, long flights get high altitude
  const normalizedDistance = Math.min(1, angularDistance / Math.PI); // 0 to 1
  const altitudeFactor = Math.sqrt(normalizedDistance); // 0 to 1, rises quickly then flattens

  return MISSILE_MIN_ALTITUDE + altitudeFactor * (MISSILE_MAX_ALTITUDE - MISSILE_MIN_ALTITUDE);
}

export class GlobeRenderer {
  private container: HTMLElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private globe: THREE.Mesh;
  private worldLines: THREE.LineSegments | null = null;

  private gameState: GameState | null = null;
  private playerId: string | null = null;

  private animationFrame: number | null = null;
  private lastTime = 0;
  private radarAngle = 0;

  // Object groups for different layers
  private territoryGroup: THREE.Group;
  private cityGroup: THREE.Group;
  private buildingGroup: THREE.Group;
  private missileGroup: THREE.Group;
  private effectGroup: THREE.Group;
  private radarCoverageGroup: THREE.Group;
  private gridGroup: THREE.Group;
  private satelliteGroup: THREE.Group;

  // View toggles state
  private viewToggles = {
    radar: true,
    grid: true,
    labels: true,
    trails: true,
  };

  // Object maps for efficient updates
  private cityMarkers = new Map<string, THREE.Group>(); // Group contains marker + label
  private buildingMarkers = new Map<string, THREE.Group>();
  private missileObjects = new Map<string, {
    trail: THREE.Line;       // Traveled path (bright trail behind missile)
    head: THREE.Group;       // ICBM cone with glow
    maxAltitude: number;     // Calculated based on flight distance
    flightDuration: number;  // Flight duration in ms for phase timing
    plannedRoute?: THREE.Line; // Full planned path (only for player's missiles)
  }>();
  private satelliteObjects = new Map<string, {
    body: THREE.Group;        // Satellite body mesh
    orbitLine: THREE.Line;    // Orbit path visualization
    visionCircle: THREE.Line; // Vision coverage circle on surface
    commLinks: THREE.Line[];  // Communication relay lines
  }>();
  private territoryMeshes = new Map<string, THREE.Mesh>();
  private radarCoverageBeams = new Map<string, THREE.Group>();
  private radarSweepLines = new Map<string, { line: THREE.Line; center: THREE.Vector3; outward: THREE.Vector3 }>();
  private fogOfWarMesh: THREE.Mesh | null = null;
  private fogOfWarMaterial: THREE.ShaderMaterial | null = null;

  // Client-side interpolation for smooth missile movement
  private missileInterpolation = new Map<string, {
    lastProgress: number;
    lastUpdateTime: number;
    targetProgress: number;
    estimatedSpeed: number;  // Progress per second
  }>();

  // Track missile target positions for explosions when they're removed
  private missileTargets = new Map<string, GeoPosition>();

  // Radar coverage calculation
  // Maximum electronic range of radar (about 3000km / 27 degrees)
  private readonly RADAR_MAX_RANGE_DEGREES = 27;
  // Earth radius in km (for horizon calculations)
  private readonly EARTH_RADIUS_KM = 6371;
  // Radar antenna height in km (affects minimum horizon)
  // Using 2km to represent elevated radar installations on mountains/towers
  // This gives ~160km ground horizon, more tactically meaningful
  private readonly RADAR_HEIGHT_KM = 2.0;

  // Raycaster for click detection
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // Click callback
  private onClickCallback: ((geoPosition: GeoPosition) => void) | null = null;
  private onBuildingClickCallback: ((building: Building) => void) | null = null;
  private onModeChangeCallback: ((siloId: string, mode: SiloMode) => void) | null = null;
  private onPlacementModeCallback: ((type: string | null) => void) | null = null;
  private onLaunchSatelliteCallback: ((facilityId: string, inclination: number) => void) | null = null;

  // HUD renderer (canvas-based UI)
  private hudRenderer: HUDRenderer;
  private selectedBuilding: Building | null = null;
  private selectedSatelliteId: string | null = null;

  // Placement preview
  private placementMode: string | null = null;
  private hoverGeoPosition: GeoPosition | null = null;
  private placementPreviewGroup: THREE.Group;

  // Camera tracking - for following missiles or centering on objects
  private trackedMissileId: string | null = null;
  private cameraTargetGeo: GeoPosition | null = null;
  private cameraAnimating: boolean = false;

  constructor(container: HTMLElement) {
    this.container = container;

    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.background);

    // Camera
    const rect = container.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(
      45,
      rect.width / rect.height,
      0.1,
      1000
    );
    this.camera.position.z = 300;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(rect.width, rect.height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // OrbitControls for rotation/zoom
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 500;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;

    // Create groups for organization
    this.territoryGroup = new THREE.Group();
    this.cityGroup = new THREE.Group();
    this.buildingGroup = new THREE.Group();
    this.missileGroup = new THREE.Group();
    this.effectGroup = new THREE.Group();
    this.radarCoverageGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.satelliteGroup = new THREE.Group();

    this.placementPreviewGroup = new THREE.Group();

    this.scene.add(this.territoryGroup);
    this.scene.add(this.radarCoverageGroup);
    this.scene.add(this.gridGroup);
    this.scene.add(this.cityGroup);
    this.scene.add(this.buildingGroup);
    this.scene.add(this.missileGroup);
    this.scene.add(this.satelliteGroup);
    this.scene.add(this.effectGroup);
    this.scene.add(this.placementPreviewGroup);

    // Create starfield background
    this.createStarfield();

    // Create globe
    this.globe = this.createGlobe();
    this.scene.add(this.globe);

    // Create atmosphere
    this.createAtmosphere();

    // Create world outlines
    this.createWorldOutlines();

    // Create lat/long grid
    this.createGrid();

    // Create fog of war overlay
    this.createFogOfWar();

    // Create HUD renderer (canvas-based UI)
    this.hudRenderer = new HUDRenderer(container);
    this.hudRenderer.setCallbacks(
      (siloId, mode) => {
        if (this.onModeChangeCallback) {
          this.onModeChangeCallback(siloId, mode);
        }
      },
      (type) => {
        if (this.onPlacementModeCallback) {
          this.onPlacementModeCallback(type);
        }
      },
      (toggle, value) => {
        this.viewToggles[toggle] = value;
      },
      (facilityId, inclination) => {
        if (this.onLaunchSatelliteCallback) {
          this.onLaunchSatelliteCallback(facilityId, inclination);
        }
      }
    );
    // Sync initial view toggles to HUD
    this.hudRenderer.setViewToggles(this.viewToggles);

    // Event listeners
    window.addEventListener('resize', this.handleResize);
    this.renderer.domElement.addEventListener('click', this.handleClick);
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove);

    // Start render loop
    this.startRenderLoop();
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.renderer.domElement.removeEventListener('mousemove', this.handleMouseMove);

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    this.hudRenderer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setGameState(state: GameState, playerId: string | null): void {
    this.gameState = state;
    this.playerId = playerId;
    this.updateGameObjects();
    this.hudRenderer.updateState(state, playerId, this.selectedBuilding, this.placementMode);
  }

  setSelectedBuilding(building: Building | null): void {
    this.selectedBuilding = building;
    // Clear satellite selection when selecting building
    if (building) {
      this.selectedSatelliteId = null;
    }
    if (this.gameState) {
      this.hudRenderer.updateState(this.gameState, this.playerId, building, this.placementMode);
    }
  }

  setOnClick(callback: (geoPosition: GeoPosition) => void): void {
    this.onClickCallback = callback;
  }

  setOnBuildingClick(callback: (building: Building) => void): void {
    this.onBuildingClickCallback = callback;
  }

  setOnModeChange(callback: (siloId: string, mode: SiloMode) => void): void {
    this.onModeChangeCallback = callback;
  }

  setOnPlacementMode(callback: (type: string | null) => void): void {
    this.onPlacementModeCallback = callback;
  }

  setOnLaunchSatellite(callback: (facilityId: string, inclination: number) => void): void {
    this.onLaunchSatelliteCallback = callback;
  }

  setSelectedSatellite(satellite: Satellite | null): void {
    this.selectedSatelliteId = satellite ? satellite.id : null;
    // Clear building selection when selecting satellite
    if (satellite) {
      this.selectedBuilding = null;
    }
  }

  getSelectedSatellite(): Satellite | null {
    if (!this.selectedSatelliteId || !this.gameState) return null;
    return getSatellites(this.gameState).find(s => s.id === this.selectedSatelliteId) || null;
  }

  setPlacementMode(mode: string | null): void {
    this.placementMode = mode;
    if (!mode) {
      this.clearPlacementPreview();
    }
    if (this.gameState) {
      this.hudRenderer.updateState(this.gameState, this.playerId, this.selectedBuilding, mode);
    }
  }

  private clearPlacementPreview(): void {
    // Clear all preview objects
    while (this.placementPreviewGroup.children.length > 0) {
      const child = this.placementPreviewGroup.children[0];
      this.placementPreviewGroup.remove(child);
      if ((child as THREE.Mesh).geometry) {
        (child as THREE.Mesh).geometry.dispose();
      }
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material;
        if (Array.isArray(mat)) {
          mat.forEach(m => m.dispose());
        } else {
          mat.dispose();
        }
      }
    }
  }

  private updatePlacementPreview(): void {
    if (!this.placementMode || !this.hoverGeoPosition) {
      this.clearPlacementPreview();
      return;
    }

    // Clear existing preview
    this.clearPlacementPreview();

    const pos3d = geoToSphere(this.hoverGeoPosition, GLOBE_RADIUS + 2);

    // Create preview marker based on placement mode
    if (this.placementMode === 'silo') {
      const shape = new THREE.Shape();
      shape.moveTo(0, 4);
      shape.lineTo(-3, -4);
      shape.lineTo(3, -4);
      shape.lineTo(0, 4);

      const geometry = new THREE.ShapeGeometry(shape);
      const material = new THREE.MeshBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(pos3d.x, pos3d.y, pos3d.z);
      mesh.lookAt(0, 0, 0);
      mesh.rotateX(Math.PI);
      this.placementPreviewGroup.add(mesh);
    } else if (this.placementMode === 'radar') {
      // Radar icon
      const curve = new THREE.EllipseCurve(0, 0, 4, 4, 0, Math.PI, false, 0);
      const points = curve.getPoints(20);
      const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map((p) => new THREE.Vector3(p.x, p.y, 0))
      );
      const material = new THREE.LineBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.5,
      });
      const arc = new THREE.Line(geometry, material);
      arc.position.set(pos3d.x, pos3d.y, pos3d.z);
      arc.lookAt(0, 0, 0);
      arc.rotateX(Math.PI);
      this.placementPreviewGroup.add(arc);

      // Radar coverage preview - beam cone extending into space
      const previewBeam = this.createRadarBeam(this.hoverGeoPosition);
      // Make preview slightly more transparent
      previewBeam.traverse((child) => {
        if ((child as THREE.Mesh).material) {
          const mat = (child as THREE.Mesh).material as THREE.Material;
          if (mat.opacity) {
            mat.opacity *= 0.6;
          }
        }
      });
      this.placementPreviewGroup.add(previewBeam);
    } else if (this.placementMode === 'airfield') {
      const runwayGeom = new THREE.PlaneGeometry(8, 2);
      const runwayMat = new THREE.MeshBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const runway = new THREE.Mesh(runwayGeom, runwayMat);
      runway.position.set(pos3d.x, pos3d.y, pos3d.z);
      runway.lookAt(0, 0, 0);
      runway.rotateX(Math.PI);
      this.placementPreviewGroup.add(runway);
    }
  }

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.placementMode) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObject(this.globe);

    if (intersects.length > 0) {
      const point = intersects[0].point;
      this.hoverGeoPosition = this.spherePointToGeo(point);
      this.updatePlacementPreview();
    } else {
      this.hoverGeoPosition = null;
      this.clearPlacementPreview();
    }
  };

  private createGlobe(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64);
    const material = new THREE.MeshBasicMaterial({
      color: COLORS.ocean,
      depthWrite: true,
    });
    return new THREE.Mesh(geometry, material);
  }

  private createAtmosphere(): void {
    // Inner atmosphere layer - subtle glow close to surface
    const innerAtmoGeometry = new THREE.SphereGeometry(GLOBE_RADIUS + 1.5, 64, 64);
    const innerAtmoMaterial = new THREE.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.06,
      side: THREE.BackSide,
    });
    const innerAtmosphere = new THREE.Mesh(innerAtmoGeometry, innerAtmoMaterial);
    this.scene.add(innerAtmosphere);

    // Outer atmosphere layer - very subtle extended glow
    const outerAtmoGeometry = new THREE.SphereGeometry(GLOBE_RADIUS + 4, 64, 64);
    const outerAtmoMaterial = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.03,
      side: THREE.BackSide,
    });
    const outerAtmosphere = new THREE.Mesh(outerAtmoGeometry, outerAtmoMaterial);
    this.scene.add(outerAtmosphere);

    // Thin bright edge - like in the reference image
    const edgeGeometry = new THREE.TorusGeometry(GLOBE_RADIUS + 0.5, 0.3, 16, 100);
    // We'll create multiple rings at different angles to simulate a sphere edge glow
    for (let i = 0; i < 3; i++) {
      const edgeMaterial = new THREE.MeshBasicMaterial({
        color: 0xaaddff,
        transparent: true,
        opacity: 0.1 - i * 0.02,
      });
      const edge = new THREE.Mesh(edgeGeometry, edgeMaterial);
      edge.rotation.x = Math.PI / 2 + (i - 1) * 0.1;
      // Don't add these - they look weird when rotating
    }
  }

  private createFogOfWar(): void {
    // Shader that darkens areas outside radar and satellite coverage
    const vertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform vec3 radarPositions[8];
      uniform int radarCount;
      uniform float radarRange;
      uniform vec3 satellitePositions[8];
      uniform int satelliteCount;
      uniform float satelliteRange;
      varying vec3 vWorldPosition;

      void main() {
        float visibility = 0.0;
        vec3 normalizedPos = normalize(vWorldPosition);

        // Check radar coverage
        for (int i = 0; i < 8; i++) {
          if (i >= radarCount) break;
          vec3 radarDir = normalize(radarPositions[i]);
          float dist = acos(clamp(dot(normalizedPos, radarDir), -1.0, 1.0));
          float coverage = 1.0 - smoothstep(radarRange * 0.7, radarRange, dist);
          visibility = max(visibility, coverage);
        }

        // Check satellite coverage
        for (int i = 0; i < 8; i++) {
          if (i >= satelliteCount) break;
          vec3 satDir = normalize(satellitePositions[i]);
          float dist = acos(clamp(dot(normalizedPos, satDir), -1.0, 1.0));
          float coverage = 1.0 - smoothstep(satelliteRange * 0.7, satelliteRange, dist);
          visibility = max(visibility, coverage);
        }

        float darkness = 0.5 * (1.0 - visibility);
        gl_FragColor = vec4(0.0, 0.0, 0.0, darkness);
      }
    `;

    this.fogOfWarMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        radarPositions: { value: new Array(8).fill(new THREE.Vector3(0, 1, 0)) },
        radarCount: { value: 0 },
        radarRange: { value: 0.5 }, // ~30 degrees in radians
        satellitePositions: { value: new Array(8).fill(new THREE.Vector3(0, 1, 0)) },
        satelliteCount: { value: 0 },
        satelliteRange: { value: SATELLITE_VISION_RANGE_DEGREES * (Math.PI / 180) },
      },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
    });

    const fogGeometry = new THREE.SphereGeometry(GLOBE_RADIUS + 0.8, 64, 64);
    this.fogOfWarMesh = new THREE.Mesh(fogGeometry, this.fogOfWarMaterial);
    this.scene.add(this.fogOfWarMesh);
  }

  private updateFogOfWar(): void {
    if (!this.fogOfWarMaterial || !this.gameState) return;

    // Collect radar positions
    const radarPositions: THREE.Vector3[] = [];
    for (const building of getBuildings(this.gameState)) {
      if (building.type !== 'radar' || building.destroyed) continue;
      if (building.ownerId !== this.playerId) continue;

      const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
      const pos = geoToSphere(geoPos, GLOBE_RADIUS);
      radarPositions.push(new THREE.Vector3(pos.x, pos.y, pos.z));

      if (radarPositions.length >= 8) break;
    }

    // Pad radar positions
    while (radarPositions.length < 8) {
      radarPositions.push(new THREE.Vector3(0, 1, 0));
    }

    // Collect connected satellite positions
    const satellitePositions: THREE.Vector3[] = [];
    const connectedSatGeoPositions = this.getPlayerSatelliteVisionPositions();
    for (const geoPos of connectedSatGeoPositions) {
      const pos = geoToSphere(geoPos, GLOBE_RADIUS);
      satellitePositions.push(new THREE.Vector3(pos.x, pos.y, pos.z));

      if (satellitePositions.length >= 8) break;
    }

    // Pad satellite positions
    while (satellitePositions.length < 8) {
      satellitePositions.push(new THREE.Vector3(0, 1, 0));
    }

    this.fogOfWarMaterial.uniforms.radarPositions.value = radarPositions;
    this.fogOfWarMaterial.uniforms.radarCount.value = Math.min(radarPositions.length, 8);
    this.fogOfWarMaterial.uniforms.satellitePositions.value = satellitePositions;
    this.fogOfWarMaterial.uniforms.satelliteCount.value = connectedSatGeoPositions.length;
  }

  private createStarfield(): void {
    const starCount = 2000;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      // Random position on a large sphere
      const radius = 800 + Math.random() * 200;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);

      // Vary star sizes
      sizes[i] = 0.5 + Math.random() * 1.5;

      // Slightly vary star colors (white to light blue)
      const brightness = 0.3 + Math.random() * 0.4;
      colors[i * 3] = brightness * (0.8 + Math.random() * 0.2);     // R
      colors[i * 3 + 1] = brightness * (0.8 + Math.random() * 0.2); // G
      colors[i * 3 + 2] = brightness;                                // B (slightly more blue)
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
    });

    const stars = new THREE.Points(geometry, material);
    this.scene.add(stars);
  }

  private createGrid(): void {
    const material = new THREE.LineBasicMaterial({
      color: 0x1a1a2e,
      transparent: true,
      opacity: 0.3,
    });

    // Latitude lines
    for (let lat = -60; lat <= 60; lat += 30) {
      const points: THREE.Vector3[] = [];
      for (let lng = -180; lng <= 180; lng += 5) {
        const pos = geoToSphere({ lat, lng }, GLOBE_RADIUS + 0.1);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      this.gridGroup.add(line);
    }

    // Longitude lines
    for (let lng = -180; lng < 180; lng += 30) {
      const points: THREE.Vector3[] = [];
      for (let lat = -90; lat <= 90; lat += 5) {
        const pos = geoToSphere({ lat, lng }, GLOBE_RADIUS + 0.1);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      this.gridGroup.add(line);
    }
  }

  private createWorldOutlines(): void {
    // Load world coastline GeoJSON
    this.loadWorldMap();
  }

  private async loadWorldMap(): Promise<void> {
    try {
      // Load land polygons first (for filled continents) - 50m resolution
      const landResponse = await fetch('/assets/world-land-50m.geojson');
      const landGeojson = await landResponse.json();

      const landMaterial = new THREE.MeshBasicMaterial({
        color: COLORS.land,
        side: THREE.DoubleSide,
      });

      const LAND_RADIUS = GLOBE_RADIUS + 0.5; // Just above ocean

      // Process each land polygon using ConicPolygonGeometry
      for (const feature of landGeojson.features) {
        // Handle both Polygon and MultiPolygon geometries
        const polygons = feature.geometry.type === 'Polygon'
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates; // MultiPolygon is already array of polygons

        for (const coords of polygons) {
          const geometry = new ConicPolygonGeometry(
            coords,
            LAND_RADIUS,      // bottomHeight (sphere radius)
            LAND_RADIUS,      // topHeight (same = flat on surface)
            false,            // closedBottom
            true,             // closedTop - this creates the visible surface
            false,            // includeSides
            5                 // curvatureResolution in degrees
          );

          const mesh = new THREE.Mesh(geometry, landMaterial);
          // Rotate to match geoToSphere coordinate system (which adds 180° to longitude)
          mesh.rotation.y = Math.PI * 0.5;
          this.scene.add(mesh);
        }
      }

      // Load coastlines for outlines - this gives us clean continent boundaries (50m resolution)
      const coastResponse = await fetch('/assets/world-coastline-50m.geojson');
      const coastGeojson = await coastResponse.json();

      const lineMaterial = new THREE.LineBasicMaterial({
        color: COLORS.worldLine,
        transparent: true,
        opacity: 0.9,
      });

      // Process each feature (coastline segment)
      for (const feature of coastGeojson.features) {
        if (feature.geometry.type === 'LineString') {
          const points = this.coordsToPoints(feature.geometry.coordinates);
          if (points.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geometry, lineMaterial);
            this.scene.add(line);
          }
        } else if (feature.geometry.type === 'MultiLineString') {
          for (const coords of feature.geometry.coordinates) {
            const points = this.coordsToPoints(coords);
            if (points.length > 1) {
              const geometry = new THREE.BufferGeometry().setFromPoints(points);
              const line = new THREE.Line(geometry, lineMaterial);
              this.scene.add(line);
            }
          }
        }
      }

      // Load and draw country borders
      const bordersResponse = await fetch('/assets/world-borders-50m.geojson');
      const bordersGeojson = await bordersResponse.json();

      const borderMaterial = new THREE.LineBasicMaterial({
        color: 0x2a3a4a,
        transparent: true,
        opacity: 0.5,
      });

      for (const feature of bordersGeojson.features) {
        if (feature.geometry.type === 'LineString') {
          const points = this.coordsToPoints(feature.geometry.coordinates);
          if (points.length > 1) {
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geometry, borderMaterial);
            this.scene.add(line);
          }
        } else if (feature.geometry.type === 'MultiLineString') {
          for (const coords of feature.geometry.coordinates) {
            const points = this.coordsToPoints(coords);
            if (points.length > 1) {
              const geometry = new THREE.BufferGeometry().setFromPoints(points);
              const line = new THREE.Line(geometry, borderMaterial);
              this.scene.add(line);
            }
          }
        }
      }

      // Draw territory/airspace boundaries
      this.drawTerritoryBoundaries();

      console.log('World map loaded');
    } catch (error) {
      console.error('Failed to load world map:', error);
      // Fallback to simple territory outlines
      this.createSimpleTerritoryOutlines();
    }
  }

  private drawTerritoryBoundaries(): void {
    const boundaryMaterial = new THREE.LineDashedMaterial({
      color: 0x334455,
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity: 0.6,
    });

    for (const territory of Object.values(TERRITORY_GEO_DATA)) {
      const points: THREE.Vector3[] = [];

      for (const coord of territory.boundaryCoords) {
        const pos = geoToSphere(coord, GLOBE_RADIUS + 0.7);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }

      // Close the loop
      if (points.length > 0) {
        points.push(points[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, boundaryMaterial);
      line.computeLineDistances(); // Required for dashed lines
      this.scene.add(line);
    }
  }

  private coordsToPoints(coordinates: number[][]): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (const coord of coordinates) {
      const lng = coord[0];
      const lat = coord[1];
      const pos = geoToSphere({ lat, lng }, GLOBE_RADIUS + 0.6); // Slightly above land mesh
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }
    return points;
  }

  private createSimpleTerritoryOutlines(): void {
    // Fallback: simplified world outline using territory boundaries
    const material = new THREE.LineBasicMaterial({
      color: COLORS.worldLine,
      linewidth: 1,
    });

    for (const [id, territory] of Object.entries(TERRITORY_GEO_DATA)) {
      const points: THREE.Vector3[] = [];

      for (const coord of territory.boundaryCoords) {
        const pos = geoToSphere(coord, GLOBE_RADIUS + 0.5);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }

      // Close the loop
      if (points.length > 0) {
        points.push(points[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      this.territoryGroup.add(line);
    }
  }

  private fillTerritoryLand(): void {
    // Fill territory polygons with land color
    const landMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.land,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
    });

    const LAND_RADIUS = GLOBE_RADIUS + 1; // Above ocean surface

    for (const [id, territory] of Object.entries(TERRITORY_GEO_DATA)) {
      const coords = territory.boundaryCoords;
      if (coords.length < 3) continue;

      // Convert geo coordinates to 3D points on sphere
      const points3D: THREE.Vector3[] = [];
      for (const coord of coords) {
        const pos = geoToSphere(coord, LAND_RADIUS);
        points3D.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }

      // Calculate centroid
      const centroid = new THREE.Vector3();
      for (const p of points3D) {
        centroid.add(p);
      }
      centroid.divideScalar(points3D.length);
      centroid.normalize().multiplyScalar(LAND_RADIUS);

      // Create triangles from centroid to each edge (fan triangulation)
      const vertices: number[] = [];
      for (let i = 0; i < points3D.length; i++) {
        const p1 = points3D[i];
        const p2 = points3D[(i + 1) % points3D.length];

        // Calculate winding order
        const edge1 = new THREE.Vector3().subVectors(p1, centroid);
        const edge2 = new THREE.Vector3().subVectors(p2, centroid);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2);
        const outwardDir = centroid.clone().normalize();

        if (normal.dot(outwardDir) > 0) {
          vertices.push(centroid.x, centroid.y, centroid.z);
          vertices.push(p1.x, p1.y, p1.z);
          vertices.push(p2.x, p2.y, p2.z);
        } else {
          vertices.push(centroid.x, centroid.y, centroid.z);
          vertices.push(p2.x, p2.y, p2.z);
          vertices.push(p1.x, p1.y, p1.z);
        }
      }

      if (vertices.length >= 9) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, landMaterial);
        this.territoryGroup.add(mesh);
      }
    }
  }

  private updateGameObjects(): void {
    if (!this.gameState) return;

    this.updateTerritories();
    this.updateRadarCoverage();
    this.updateFogOfWar();
    this.updateCities();
    this.updateBuildings();
    this.updateMissiles();
    this.updateSatellites();
  }

  // Get all radar positions owned by the player
  private getPlayerRadarPositions(): GeoPosition[] {
    if (!this.gameState || !this.playerId) return [];

    const positions: GeoPosition[] = [];
    for (const building of getBuildings(this.gameState)) {
      if (building.ownerId === this.playerId && building.type === 'radar' && !building.destroyed) {
        const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
        positions.push(geoPos);
      }
    }
    return positions;
  }

  // Check if a geographic position is within radar coverage
  // Uses realistic horizon-limited detection: higher altitude = farther detection range
  private isWithinRadarCoverage(geoPos: GeoPosition, altitudeKm: number = 0): boolean {
    const radarPositions = this.getPlayerRadarPositions();

    // Always visible if player has no radars (early game) - TODO: revisit this
    if (radarPositions.length === 0) return true;

    // Calculate horizon-limited range based on target altitude
    // Formula: horizon distance = √(2*R*h_radar) + √(2*R*h_target)
    // Then convert to angular distance
    const horizonRangeKm = Math.sqrt(2 * this.EARTH_RADIUS_KM * this.RADAR_HEIGHT_KM) +
                           Math.sqrt(2 * this.EARTH_RADIUS_KM * Math.max(0, altitudeKm));

    // Convert km to angular degrees: angle = distance / circumference * 360
    // Or: angle = (distance / radius) * (180 / π)
    const horizonRangeDegrees = (horizonRangeKm / this.EARTH_RADIUS_KM) * (180 / Math.PI);

    // Effective range is minimum of horizon limit and electronic max range
    const effectiveRangeDegrees = Math.min(horizonRangeDegrees, this.RADAR_MAX_RANGE_DEGREES);

    for (const radarPos of radarPositions) {
      // Calculate angular distance using great circle formula
      const angularDistance = this.calculateAngularDistance(geoPos, radarPos);
      if (angularDistance <= effectiveRangeDegrees) {
        return true;
      }
    }
    return false;
  }

  // Calculate the current altitude of a missile based on its flight progress
  private calculateMissileAltitudeKm(
    startGeo: GeoPosition,
    endGeo: GeoPosition,
    progress: number,
    flightDuration: number
  ): number {
    // Get max altitude for this flight (reuse the same calculation as rendering)
    const maxAltitude = calculateMissileAltitude(startGeo, endGeo);

    // Calculate phase boundaries (same logic as getMissilePosition3D in utils.ts)
    const LAUNCH_DURATION_SECONDS = 15.0;
    const REENTRY_DURATION_SECONDS = 8.0;
    const MAX_PHASE_FRACTION = 0.45;

    const flightSeconds = flightDuration / 1000;
    const launchPhaseEnd = Math.min(MAX_PHASE_FRACTION, LAUNCH_DURATION_SECONDS / flightSeconds);
    const reentryPhaseDuration = Math.min(MAX_PHASE_FRACTION, REENTRY_DURATION_SECONDS / flightSeconds);
    const reentryPhaseStart = 1.0 - reentryPhaseDuration;

    const t = Math.max(0, Math.min(1, progress));
    let altitudeFraction: number;

    if (t < launchPhaseEnd) {
      // Launch phase - sine easing
      const launchProgress = t / launchPhaseEnd;
      altitudeFraction = Math.sin(launchProgress * Math.PI / 2);
    } else if (t > reentryPhaseStart) {
      // Reentry phase - sine easing
      const reentryProgress = (t - reentryPhaseStart) / reentryPhaseDuration;
      altitudeFraction = 1 - (1 - Math.cos(reentryProgress * Math.PI / 2));
    } else {
      // Cruise phase - at max altitude
      altitudeFraction = 1.0;
    }

    // maxAltitude is in globe units, convert to approximate km
    // GLOBE_RADIUS is 200, Earth radius is ~6371 km
    // So 1 globe unit ≈ 6371/200 ≈ 32 km
    const GLOBE_TO_KM = this.EARTH_RADIUS_KM / GLOBE_RADIUS;
    return maxAltitude * altitudeFraction * GLOBE_TO_KM;
  }

  // Calculate angular distance between two points in degrees
  private calculateAngularDistance(a: GeoPosition, b: GeoPosition): number {
    const lat1 = a.lat * (Math.PI / 180);
    const lat2 = b.lat * (Math.PI / 180);
    const dLat = (b.lat - a.lat) * (Math.PI / 180);
    const dLng = (b.lng - a.lng) * (Math.PI / 180);

    // Haversine formula
    const sinHalfDLat = Math.sin(dLat / 2);
    const sinHalfDLng = Math.sin(dLng / 2);

    const h = sinHalfDLat * sinHalfDLat +
              Math.cos(lat1) * Math.cos(lat2) * sinHalfDLng * sinHalfDLng;

    const angularDistanceRadians = 2 * Math.asin(Math.sqrt(h));
    return angularDistanceRadians * (180 / Math.PI);
  }

  private updateRadarCoverage(): void {
    if (!this.gameState) return;

    // Track which radars still exist
    const existingRadarIds = new Set(this.radarCoverageBeams.keys());

    // Create/update coverage beams for player's radars
    for (const building of getBuildings(this.gameState)) {
      if (building.type !== 'radar' || building.destroyed) continue;
      if (building.ownerId !== this.playerId) continue;

      existingRadarIds.delete(building.id);

      // Skip if beam already exists
      if (this.radarCoverageBeams.has(building.id)) continue;

      const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
      const beam = this.createRadarBeam(geoPos, building.id);
      this.radarCoverageGroup.add(beam);
      this.radarCoverageBeams.set(building.id, beam);
    }

    // Remove beams for radars that no longer exist
    for (const id of existingRadarIds) {
      const beam = this.radarCoverageBeams.get(id);
      if (beam) {
        this.radarCoverageGroup.remove(beam);
        this.disposeGroup(beam);
        this.radarCoverageBeams.delete(id);
      }
      this.radarSweepLines.delete(id);
    }
  }

  private createRadarBeam(center: GeoPosition, radarId?: string): THREE.Group {
    const group = new THREE.Group();

    // Get radar position on globe surface
    const radarPos = geoToSphere(center, GLOBE_RADIUS + 2);
    const radarVec = new THREE.Vector3(radarPos.x, radarPos.y, radarPos.z);
    const outwardDir = radarVec.clone().normalize();

    // Find a horizontal direction (tangent to globe surface)
    let tangentDir: THREE.Vector3;
    if (Math.abs(outwardDir.y) < 0.99) {
      tangentDir = new THREE.Vector3(0, 1, 0).cross(outwardDir).normalize();
    } else {
      tangentDir = new THREE.Vector3(1, 0, 0).cross(outwardDir).normalize();
    }

    // Calculate ground-level horizon distance (minimum radar range)
    // This is how far radar can see a target at ground level
    const groundHorizonKm = Math.sqrt(2 * this.EARTH_RADIUS_KM * this.RADAR_HEIGHT_KM);
    const groundHorizonDegrees = (groundHorizonKm / this.EARTH_RADIUS_KM) * (180 / Math.PI);

    // Inner circle: Ground-level detection range (solid, brighter - shows "guaranteed" coverage)
    // Minimum 3 degrees for visibility (actual horizon is ~1.4° at 2km height)
    const groundRangePoints = this.calculateCircleOnSphere(center, Math.max(3, groundHorizonDegrees), 32);
    const groundRangeGeometry = new THREE.BufferGeometry().setFromPoints(groundRangePoints);
    const groundRangeMaterial = new THREE.LineBasicMaterial({
      color: 0xff6666,
      transparent: true,
      opacity: 0.6,
    });
    const groundRangeCircle = new THREE.Line(groundRangeGeometry, groundRangeMaterial);
    group.add(groundRangeCircle);

    // Outer circle: Max range for high-altitude targets (dashed, fainter)
    const rangeCirclePoints = this.calculateCircleOnSphere(center, this.RADAR_MAX_RANGE_DEGREES, 64);
    const rangeGeometry = new THREE.BufferGeometry().setFromPoints(rangeCirclePoints);
    const rangeMaterial = new THREE.LineDashedMaterial({
      color: 0xff6666,
      transparent: true,
      opacity: 0.2,
      dashSize: 3,
      gapSize: 2,
    });
    const rangeCircle = new THREE.Line(rangeGeometry, rangeMaterial);
    rangeCircle.computeLineDistances(); // Required for dashed lines
    group.add(rangeCircle);

    // Add animated sweep line (single line from center outward on surface)
    // Sweep only covers ground-level detection range
    const sweepLength = Math.max(3, groundHorizonDegrees) * (Math.PI / 180) * GLOBE_RADIUS;
    const sweepEndPoint = radarVec.clone().add(tangentDir.clone().multiplyScalar(sweepLength));
    // Project sweep end point onto globe surface
    sweepEndPoint.normalize().multiplyScalar(GLOBE_RADIUS + 0.5);

    const sweepGeometry = new THREE.BufferGeometry().setFromPoints([
      radarVec.clone(),
      sweepEndPoint,
    ]);
    const sweepMaterial = new THREE.LineBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.8,
    });
    const sweepLine = new THREE.Line(sweepGeometry, sweepMaterial);
    sweepLine.name = 'sweepLine';
    group.add(sweepLine);

    // Add fading trail lines for sweep effect (4 trailing lines)
    for (let i = 1; i <= 4; i++) {
      const trailAngle = -i * 0.15; // Offset behind sweep line
      const trailEnd = radarVec.clone()
        .add(tangentDir.clone().multiplyScalar(Math.cos(trailAngle) * sweepLength))
        .add(outwardDir.clone().cross(tangentDir).normalize().multiplyScalar(Math.sin(trailAngle) * sweepLength));
      trailEnd.normalize().multiplyScalar(GLOBE_RADIUS + 0.5);

      const trailGeometry = new THREE.BufferGeometry().setFromPoints([
        radarVec.clone(),
        trailEnd,
      ]);
      const trailMaterial = new THREE.LineBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.6 - i * 0.12, // Fade out
      });
      const trailLine = new THREE.Line(trailGeometry, trailMaterial);
      trailLine.name = `sweepTrail${i}`;
      group.add(trailLine);
    }

    // Store sweep line reference for animation if this is a placed radar (not preview)
    if (radarId) {
      this.radarSweepLines.set(radarId, {
        line: sweepLine,
        center: radarVec.clone(),
        outward: outwardDir.clone(),
      });
    }

    return group;
  }

  // Calculate points on a circle on the sphere's surface using proper spherical geometry
  private calculateCircleOnSphere(center: GeoPosition, radiusDegrees: number, segments: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Convert center to 3D unit vector
    const centerPos = geoToSphere(center, 1);
    const centerVec = new THREE.Vector3(centerPos.x, centerPos.y, centerPos.z).normalize();

    // Find a perpendicular vector for rotation axis
    let perpVec: THREE.Vector3;
    if (Math.abs(centerVec.y) < 0.99) {
      // Use cross product with up vector
      perpVec = new THREE.Vector3(0, 1, 0).cross(centerVec).normalize();
    } else {
      // Near poles, use cross product with forward vector
      perpVec = new THREE.Vector3(0, 0, 1).cross(centerVec).normalize();
    }

    // Angular radius in radians (convert from degrees)
    const angularRadius = radiusDegrees * (Math.PI / 180);

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;

      // Rotate the perpendicular vector around the center vector
      const rotatedPerp = perpVec.clone().applyAxisAngle(centerVec, angle);

      // Create point at angular distance from center
      const point = centerVec.clone()
        .multiplyScalar(Math.cos(angularRadius))
        .add(rotatedPerp.multiplyScalar(Math.sin(angularRadius)));

      // Scale to globe radius
      point.multiplyScalar(GLOBE_RADIUS + 0.5);

      points.push(point);
    }

    return points;
  }

  private updateTerritories(): void {
    if (!this.gameState) return;

    // Clear existing territory highlights
    this.territoryMeshes.forEach((mesh) => {
      this.territoryGroup.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.territoryMeshes.clear();

    for (const territory of getTerritories(this.gameState)) {
      if (!territory.ownerId || !territory.geoBoundary) continue;

      const isMine = territory.ownerId === this.playerId;
      const color = isMine ? COLORS.friendly : COLORS.enemy;

      // Create a highlight for owned territories
      const points: THREE.Vector3[] = [];
      for (const coord of territory.geoBoundary) {
        const pos = geoToSphere(coord, GLOBE_RADIUS + 0.2);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }

      // Close the loop
      if (points.length > 0) {
        points.push(points[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: color,
        linewidth: 2,
      });
      const line = new THREE.Line(geometry, material) as unknown as THREE.Mesh;
      this.territoryGroup.add(line);
      this.territoryMeshes.set(territory.id, line);
    }
  }

  private updateCities(): void {
    if (!this.gameState) return;

    // Mark existing cities for removal
    const existingIds = new Set(this.cityMarkers.keys());

    for (const city of getCities(this.gameState)) {
      const territory = this.gameState.territories[city.territoryId];
      const isMine = territory?.ownerId === this.playerId;

      // Get position from geoPosition or fall back to calculated position
      const geoPos = city.geoPosition || this.pixelToGeoFallback(city.position);

      // Check fog of war - hide enemy cities outside radar coverage
      if (!isMine && !this.isWithinRadarCoverage(geoPos)) {
        // Remove marker if it exists but is now hidden
        const existingGroup = this.cityMarkers.get(city.id);
        if (existingGroup) {
          this.cityGroup.remove(existingGroup);
          this.disposeCityGroup(existingGroup);
          this.cityMarkers.delete(city.id);
        }
        continue;
      }

      existingIds.delete(city.id);

      const pos3d = geoToSphere(geoPos, GLOBE_RADIUS + 0.5);
      const color = city.destroyed ? COLORS.cityDestroyed : (isMine ? COLORS.friendly : COLORS.enemy);

      let group = this.cityMarkers.get(city.id);

      if (!group) {
        group = new THREE.Group();
        group.userData = { type: 'city', id: city.id };

        // Create smaller city marker (dot)
        const size = Math.max(0.4, Math.sqrt(city.population / 1000000) * 0.25);
        const geometry = new THREE.SphereGeometry(size, 8, 8);
        const material = new THREE.MeshBasicMaterial({ color });
        const marker = new THREE.Mesh(geometry, material);
        marker.name = 'marker';
        group.add(marker);

        // Create text label
        const label = this.createTextSprite(city.name, color);
        label.name = 'label';
        label.position.set(0, size + 1.5, 0); // Position above the marker
        group.add(label);

        this.cityGroup.add(group);
        this.cityMarkers.set(city.id, group);
      }

      // Update position
      group.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Orient the group to face outward from globe center
      group.lookAt(0, 0, 0);
      group.rotateX(Math.PI); // Flip so label is right-side up

      // Update colors
      const marker = group.getObjectByName('marker') as THREE.Mesh;
      if (marker) {
        (marker.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
    }

    // Remove cities that no longer exist
    for (const id of existingIds) {
      const group = this.cityMarkers.get(id);
      if (group) {
        this.cityGroup.remove(group);
        this.disposeCityGroup(group);
        this.cityMarkers.delete(id);
      }
    }
  }

  private createTextSprite(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;

    // Set canvas size
    canvas.width = 256;
    canvas.height = 64;

    // Draw text
    context.font = 'bold 24px "Courier New", monospace';
    context.fillStyle = '#' + color.toString(16).padStart(6, '0');
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
    });

    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(8, 2, 1); // Adjust scale as needed

    return sprite;
  }

  private disposeCityGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Sprite) {
        (child.material as THREE.SpriteMaterial).map?.dispose();
        child.material.dispose();
      }
    });
  }

  private updateBuildings(): void {
    if (!this.gameState) return;

    const existingIds = new Set(this.buildingMarkers.keys());

    for (const building of getBuildings(this.gameState)) {
      if (building.destroyed) continue;

      const isMine = building.ownerId === this.playerId;
      const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);

      // Check fog of war - hide enemy buildings outside radar coverage
      if (!isMine && !this.isWithinRadarCoverage(geoPos)) {
        // Remove marker if it exists but is now hidden
        const existingMarker = this.buildingMarkers.get(building.id);
        if (existingMarker) {
          this.buildingGroup.remove(existingMarker);
          this.disposeGroup(existingMarker);
          this.buildingMarkers.delete(building.id);
        }
        continue;
      }

      existingIds.delete(building.id);

      const pos3d = geoToSphere(geoPos, GLOBE_RADIUS + 2);

      let marker = this.buildingMarkers.get(building.id);

      if (!marker) {
        marker = this.createBuildingMarker(building, isMine);
        marker.userData = { type: 'building', id: building.id, building };
        this.buildingGroup.add(marker);
        this.buildingMarkers.set(building.id, marker);
      }

      marker.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Make marker face outward from globe center
      marker.lookAt(0, 0, 0);
      marker.rotateX(Math.PI);

      // Update building data for click handling
      marker.userData.building = building;
    }

    // Remove destroyed/removed buildings
    for (const id of existingIds) {
      const marker = this.buildingMarkers.get(id);
      if (marker) {
        this.buildingGroup.remove(marker);
        this.disposeGroup(marker);
        this.buildingMarkers.delete(id);
      }
    }
  }

  private createBuildingMarker(building: Building, isMine: boolean): THREE.Group {
    const group = new THREE.Group();
    const color = isMine ? COLORS.friendly : COLORS.enemy;

    switch (building.type) {
      case 'silo': {
        const silo = building as Silo;
        // Triangle outline for silo
        const points = [
          new THREE.Vector3(0, 1.5, 0),
          new THREE.Vector3(-1.2, -1, 0),
          new THREE.Vector3(1.2, -1, 0),
          new THREE.Vector3(0, 1.5, 0),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: color });
        const outline = new THREE.Line(geometry, material);
        group.add(outline);

        // Mode indicator (small dot in center)
        const indicatorGeom = new THREE.CircleGeometry(0.3, 8);
        const indicatorMat = new THREE.MeshBasicMaterial({
          color: silo.mode === 'icbm' ? COLORS.missile : COLORS.interceptor,
        });
        const indicator = new THREE.Mesh(indicatorGeom, indicatorMat);
        indicator.position.z = 0.1;
        group.add(indicator);
        break;
      }

      case 'radar': {
        // Smaller radar dish arc
        const curve = new THREE.EllipseCurve(0, 0, 2, 2, 0, Math.PI, false, 0);
        const points = curve.getPoints(16);
        const geometry = new THREE.BufferGeometry().setFromPoints(
          points.map((p) => new THREE.Vector3(p.x, p.y, 0))
        );
        const material = new THREE.LineBasicMaterial({ color: color });
        const arc = new THREE.Line(geometry, material);
        group.add(arc);

        // Radar stem
        const stemGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, -1.5, 0),
        ]);
        const stem = new THREE.Line(stemGeom, material);
        group.add(stem);
        break;
      }

      case 'airfield': {
        // Runway as lines (X pattern)
        const material = new THREE.LineBasicMaterial({ color: color });
        const runway1 = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-2, 0, 0),
          new THREE.Vector3(2, 0, 0),
        ]);
        const runway2 = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-1.5, -0.8, 0),
          new THREE.Vector3(1.5, 0.8, 0),
        ]);
        group.add(new THREE.Line(runway1, material));
        group.add(new THREE.Line(runway2, material));
        break;
      }

      case 'satellite_launch_facility': {
        // Small dish outline
        const curve = new THREE.EllipseCurve(0, 0, 1.5, 1.5, 0, Math.PI, false, 0);
        const points = curve.getPoints(12);
        const geometry = new THREE.BufferGeometry().setFromPoints(
          points.map((p) => new THREE.Vector3(p.x, p.y, 0))
        );
        const material = new THREE.LineBasicMaterial({ color: color });
        const dish = new THREE.Line(geometry, material);
        group.add(dish);

        // Support stand
        const stemGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, -1.2, 0),
        ]);
        group.add(new THREE.Line(stemGeom, material));
        break;
      }
    }

    // Add label below the building
    const labelText = this.getBuildingLabel(building.type);
    const label = this.createTextSprite(labelText, color);
    label.position.y = -3; // Position below the marker
    group.add(label);

    return group;
  }

  private getBuildingLabel(type: string): string {
    switch (type) {
      case 'silo': return 'SILO';
      case 'radar': return 'RADAR';
      case 'airfield': return 'AIRFIELD';
      case 'satellite_launch_facility': return 'SAT UPLINK';
      default: return type.toUpperCase();
    }
  }

  private updateMissiles(): void {
    if (!this.gameState) return;

    const existingIds = new Set(this.missileObjects.keys());
    const currentMissileIds = new Set<string>();
    const now = performance.now();

    for (const missile of getMissiles(this.gameState)) {
      currentMissileIds.add(missile.id);

      // Track target position for explosion when missile is removed
      const targetGeo = missile.geoTargetPosition || this.pixelToGeoFallback(missile.targetPosition);
      this.missileTargets.set(missile.id, targetGeo);

      const isMine = missile.ownerId === this.playerId;
      const currentGeo = missile.geoCurrentPosition || this.pixelToGeoFallback(missile.currentPosition);
      const startGeo = missile.geoLaunchPosition || this.pixelToGeoFallback(missile.launchPosition);

      if (missile.detonated || missile.intercepted) {
        // Show explosion effect at appropriate location
        // Detonated = at target, Intercepted = at current position (interception point)
        const explosionGeo = missile.intercepted ? currentGeo : targetGeo;
        this.showExplosionAt(explosionGeo);
        // Clean up
        this.missileInterpolation.delete(missile.id);
        this.missileTargets.delete(missile.id);
        continue;
      }

      // Check fog of war - hide enemy missiles outside radar coverage
      // Calculate missile altitude for horizon-limited radar detection
      const missileAltitudeKm = this.calculateMissileAltitudeKm(startGeo, targetGeo, missile.progress, missile.flightDuration);
      if (!isMine && !this.isWithinRadarCoverage(currentGeo, missileAltitudeKm)) {
        // Remove marker if it exists but is now hidden
        const existingObjects = this.missileObjects.get(missile.id);
        if (existingObjects) {
          this.missileGroup.remove(existingObjects.trail);
          this.missileGroup.remove(existingObjects.head);
          if (existingObjects.plannedRoute) {
            this.missileGroup.remove(existingObjects.plannedRoute);
          }
          this.disposeMissileObjects(existingObjects);
          this.missileObjects.delete(missile.id);
        }
        this.missileInterpolation.delete(missile.id);
        continue;
      }

      existingIds.delete(missile.id);

      // Color based on missile type: interceptors are cyan, ICBMs are red
      const isInterceptor = missile.type === 'interceptor';
      const color = isInterceptor ? COLORS.interceptor : COLORS.missile;

      // Client-side interpolation for smooth movement
      let interpolatedProgress = missile.progress;
      let interpState = this.missileInterpolation.get(missile.id);

      if (!interpState) {
        // New missile - initialize interpolation state
        interpState = {
          lastProgress: missile.progress,
          lastUpdateTime: now,
          targetProgress: missile.progress,
          estimatedSpeed: 1 / (missile.flightDuration / 1000), // Progress per second
        };
        this.missileInterpolation.set(missile.id, interpState);
      } else {
        // Check if server sent a new progress value
        if (Math.abs(missile.progress - interpState.targetProgress) > 0.0001) {
          // New server update received - update interpolation target
          const timeSinceLastUpdate = (now - interpState.lastUpdateTime) / 1000;
          if (timeSinceLastUpdate > 0.01) {
            // Estimate speed from the delta
            const progressDelta = missile.progress - interpState.targetProgress;
            interpState.estimatedSpeed = Math.max(progressDelta / timeSinceLastUpdate, 0.001);
          }
          interpState.lastProgress = interpState.targetProgress;
          interpState.targetProgress = missile.progress;
          interpState.lastUpdateTime = now;
        }

        // Smoothly interpolate towards target progress
        const timeSinceUpdate = (now - interpState.lastUpdateTime) / 1000;
        const predictedProgress = interpState.targetProgress + interpState.estimatedSpeed * timeSinceUpdate;

        // Blend between last known and predicted, capped at target + small buffer
        interpolatedProgress = Math.min(predictedProgress, interpState.targetProgress + 0.02);
        interpolatedProgress = Math.max(interpolatedProgress, interpState.targetProgress);
        interpolatedProgress = Math.min(interpolatedProgress, 1.0);
      }

      // startGeo and targetGeo already defined above

      let objects = this.missileObjects.get(missile.id);

      // Calculate max altitude based on distance (only once per missile)
      let maxAltitude: number;
      if (!objects) {
        maxAltitude = calculateMissileAltitude(startGeo, targetGeo);

        // Create traveled trail - shows where missile has been
        const trailPoints = this.calculateTraveledTrailSmooth(startGeo, targetGeo, interpolatedProgress, maxAltitude, missile.flightDuration);
        const trailGeom = new THREE.BufferGeometry().setFromPoints(trailPoints);
        const trailMat = new THREE.LineBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.7,
        });
        const trail = new THREE.Line(trailGeom, trailMat);

        // Create ICBM-shaped head (cone with glowing tip)
        const head = this.createICBMHead(isInterceptor);

        this.missileGroup.add(trail);
        this.missileGroup.add(head);

        // Create planned route line for player's missiles (light gray full path)
        let plannedRoute: THREE.Line | undefined;
        if (isMine) {
          const routePoints = this.calculateFullRoutePath(startGeo, targetGeo, maxAltitude, missile.flightDuration);
          const routeGeom = new THREE.BufferGeometry().setFromPoints(routePoints);
          const routeMat = new THREE.LineBasicMaterial({
            color: 0x888888,  // Light gray
            transparent: true,
            opacity: 0.4,
            linewidth: 1,
          });
          plannedRoute = new THREE.Line(routeGeom, routeMat);
          this.missileGroup.add(plannedRoute);
        }

        objects = { trail, head, maxAltitude, flightDuration: missile.flightDuration, plannedRoute };
        this.missileObjects.set(missile.id, objects);
      } else {
        maxAltitude = objects.maxAltitude;
      }

      // Get 3D position using linear progress (altitude easing is handled inside getMissilePosition3D)
      const pos3d = getMissilePosition3D(startGeo, targetGeo, interpolatedProgress, maxAltitude, GLOBE_RADIUS, objects.flightDuration);

      // Update ICBM position and orientation
      objects.head.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Orient ICBM along flight path
      const direction = getMissileDirection3D(startGeo, targetGeo, interpolatedProgress, maxAltitude, GLOBE_RADIUS, objects.flightDuration);
      const dirVec = new THREE.Vector3(direction.x, direction.y, direction.z);
      const targetPos = new THREE.Vector3(pos3d.x + dirVec.x, pos3d.y + dirVec.y, pos3d.z + dirVec.z);
      objects.head.lookAt(targetPos);

      // Update traveled trail with linear progress
      const trailPoints = this.calculateTraveledTrailSmooth(startGeo, targetGeo, interpolatedProgress, maxAltitude, objects.flightDuration);
      const positions = new Float32Array(trailPoints.length * 3);
      for (let i = 0; i < trailPoints.length; i++) {
        positions[i * 3] = trailPoints[i].x;
        positions[i * 3 + 1] = trailPoints[i].y;
        positions[i * 3 + 2] = trailPoints[i].z;
      }
      objects.trail.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      objects.trail.geometry.attributes.position.needsUpdate = true;
    }

    // Remove completed missiles and show explosions
    for (const id of existingIds) {
      // Show explosion at target position if we have it stored
      const targetPos = this.missileTargets.get(id);
      if (targetPos) {
        this.showExplosionAt(targetPos);
        this.missileTargets.delete(id);
      }

      const objects = this.missileObjects.get(id);
      if (objects) {
        this.missileGroup.remove(objects.trail);
        this.missileGroup.remove(objects.head);
        if (objects.plannedRoute) {
          this.missileGroup.remove(objects.plannedRoute);
        }
        this.disposeMissileObjects(objects);
        this.missileObjects.delete(id);
      }
      this.missileInterpolation.delete(id);
    }
  }

  private createICBMHead(isInterceptor: boolean): THREE.Group {
    const group = new THREE.Group();

    // Main ICBM body (elongated cone)
    // Interceptors are cyan/blue, ICBMs are red/orange
    const bodyGeom = new THREE.ConeGeometry(1.2, 5, 8);
    const bodyMat = new THREE.MeshBasicMaterial({
      color: isInterceptor ? 0x00aaff : 0xff3300,
    });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.rotation.x = Math.PI / 2; // Point forward
    group.add(body);

    // Glowing warhead tip
    const tipGeom = new THREE.SphereGeometry(0.8, 8, 8);
    const tipMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    const tip = new THREE.Mesh(tipGeom, tipMat);
    tip.position.z = 2.5; // At front of cone
    group.add(tip);

    // Engine glow at back
    const glowGeom = new THREE.SphereGeometry(1.5, 8, 8);
    const glowMat = new THREE.MeshBasicMaterial({
      color: isInterceptor ? 0x0088ff : 0xff4400,
      transparent: true,
      opacity: 0.6,
    });
    const glow = new THREE.Mesh(glowGeom, glowMat);
    glow.position.z = -2.5; // At back of cone
    group.add(glow);

    return group;
  }

  private disposeMissileObjects(objects: { trail: THREE.Line; head: THREE.Group; maxAltitude: number; flightDuration: number; plannedRoute?: THREE.Line }): void {
    objects.trail.geometry.dispose();
    (objects.trail.material as THREE.Material).dispose();
    this.disposeGroup(objects.head);
    if (objects.plannedRoute) {
      objects.plannedRoute.geometry.dispose();
      (objects.plannedRoute.material as THREE.Material).dispose();
    }
  }

  private calculateTraveledTrailSmooth(startGeo: GeoPosition, endGeo: GeoPosition, progress: number, maxAltitude: number, flightDuration: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Draw trail from launch to current position
    // Use enough steps to capture the altitude curve smoothly
    const steps = Math.max(10, Math.floor(60 * progress));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * progress;
      const pos = getMissilePosition3D(startGeo, endGeo, t, maxAltitude, GLOBE_RADIUS, flightDuration);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    return points;
  }

  // Calculate the full planned route path (0% to 100% progress)
  private calculateFullRoutePath(startGeo: GeoPosition, endGeo: GeoPosition, maxAltitude: number, flightDuration: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Draw full path from launch to target
    // Use enough steps to capture the altitude curve smoothly
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pos = getMissilePosition3D(startGeo, endGeo, t, maxAltitude, GLOBE_RADIUS, flightDuration);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    return points;
  }

  private showExplosionAt(geoPos: GeoPosition): void {
    const pos3d = geoToSphere(geoPos, GLOBE_RADIUS + 3); // Place slightly above surface
    const explosionGroup = new THREE.Group();
    explosionGroup.position.set(pos3d.x, pos3d.y, pos3d.z);
    this.effectGroup.add(explosionGroup);

    // Initial bright flash (smaller, white, fades quickly)
    const flashGeom = new THREE.SphereGeometry(2.5, 16, 16);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthTest: true, // Render on top of globe
    });
    const flash = new THREE.Mesh(flashGeom, flashMat);
    explosionGroup.add(flash);

    // Core fireball (orange/red, grows then fades)
    const fireballGeom = new THREE.SphereGeometry(0.8, 16, 16);
    const fireballMat = new THREE.MeshBasicMaterial({
      color: 0xff4400,
      transparent: true,
      opacity: 0.9,
      depthTest: true, // Render on top of globe
    });
    const fireball = new THREE.Mesh(fireballGeom, fireballMat);
    explosionGroup.add(fireball);

    // Outer glow ring
    const ringGeom = new THREE.RingGeometry(1, 2, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthTest: true, // Render on top of globe
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    // Orient ring to be parallel to globe surface (face outward)
    // The ring's default normal is (0,0,1), we want it to point away from globe center
    const outwardDir = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outwardDir);
    explosionGroup.add(ring);

    // Animation - 2.5x longer duration
    let frame = 0;
    const maxFrames = 150; // ~2.5 seconds at 60fps (was 60)
    const flashDuration = 15; // Flash still fades in ~0.25 seconds (fast)

    const animate = () => {
      frame++;
      const progress = frame / maxFrames;

      // Flash fades quickly (same speed as before, independent of total duration)
      const flashProgress = Math.min(1, frame / flashDuration);
      flashMat.opacity = Math.max(0, 1 - flashProgress);
      flash.scale.setScalar(1 + flashProgress * 2);

      // Fireball grows slowly then fades
      const fireballScale = 1 + progress * 4;
      fireball.scale.setScalar(fireballScale);
      fireballMat.opacity = Math.max(0, 0.9 - progress * 1.0);

      // Ring expands slowly and fades
      ring.scale.setScalar(1 + progress * 5);
      ringMat.opacity = Math.max(0, 0.7 - progress * 0.8);

      if (frame < maxFrames) {
        requestAnimationFrame(animate);
      } else {
        // Cleanup
        this.effectGroup.remove(explosionGroup);
        flashGeom.dispose();
        flashMat.dispose();
        fireballGeom.dispose();
        fireballMat.dispose();
        ringGeom.dispose();
        ringMat.dispose();
      }
    };
    animate();
  }

  private updateSatellites(): void {
    if (!this.gameState) return;

    const satellites = getSatellites(this.gameState);
    const currentIds = new Set(satellites.map(s => s.id));
    const existingIds = new Set(this.satelliteObjects.keys());

    // Remove satellites that no longer exist
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const objects = this.satelliteObjects.get(id);
        if (objects) {
          this.satelliteGroup.remove(objects.body);
          this.satelliteGroup.remove(objects.orbitLine);
          this.satelliteGroup.remove(objects.visionCircle);
          for (const link of objects.commLinks) {
            this.satelliteGroup.remove(link);
          }
          this.disposeSatelliteObjects(objects);
          this.satelliteObjects.delete(id);
        }
      }
    }

    const now = Date.now();

    // Update or create satellites
    for (const satellite of satellites) {
      if (satellite.destroyed) continue;

      const isMine = satellite.ownerId === this.playerId;
      const color = isMine ? COLORS.friendly : COLORS.enemy;

      // Create orbital params
      const orbitalParams: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };

      // Get current 3D position
      const pos3d = getSatellitePosition3D(orbitalParams, now, GLOBE_RADIUS);

      let objects = this.satelliteObjects.get(satellite.id);

      if (!objects) {
        // Create satellite body
        const body = this.createSatelliteBody(isMine);
        // Store satellite reference for click detection
        body.userData = { satellite };

        // Create orbit line
        const orbitLine = this.createOrbitLine(orbitalParams, color);

        // Create vision circle (only for player's satellites)
        const visionCircle = isMine
          ? this.createSatelliteVisionCircle(orbitalParams, now)
          : this.createEmptyLine();

        this.satelliteGroup.add(body);
        this.satelliteGroup.add(orbitLine);
        if (isMine) {
          this.satelliteGroup.add(visionCircle);
        }

        objects = {
          body,
          orbitLine,
          visionCircle,
          commLinks: [],
        };
        this.satelliteObjects.set(satellite.id, objects);
      } else {
        // Update satellite reference in existing body
        objects.body.userData = { satellite };
      }

      // Update satellite position
      objects.body.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Orient satellite to face away from globe center
      const outwardDir = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();
      objects.body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outwardDir);

      // Update vision circle position for player's satellites
      if (isMine) {
        this.updateSatelliteVisionCircle(objects.visionCircle, orbitalParams, now);
      }
    }

    // Update communication links for player's satellites
    this.updateCommunicationLinks();
  }

  private createSatelliteBody(isFriendly: boolean): THREE.Group {
    const group = new THREE.Group();
    const color = isFriendly ? COLORS.satellite : COLORS.enemy;

    // Invisible hitbox for easier clicking (larger sphere around satellite)
    const hitboxGeom = new THREE.SphereGeometry(8, 8, 8);
    const hitboxMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const hitbox = new THREE.Mesh(hitboxGeom, hitboxMat);
    group.add(hitbox);

    // Main satellite body (small box)
    const bodyGeom = new THREE.BoxGeometry(1.5, 1, 1.5);
    const bodyMat = new THREE.MeshBasicMaterial({ color });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    group.add(body);

    // Solar panels (two flat rectangles)
    const panelGeom = new THREE.PlaneGeometry(4, 1);
    const panelMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      side: THREE.DoubleSide,
    });

    const panel1 = new THREE.Mesh(panelGeom, panelMat);
    panel1.position.x = 3;
    panel1.rotation.y = Math.PI / 2;
    group.add(panel1);

    const panel2 = new THREE.Mesh(panelGeom, panelMat);
    panel2.position.x = -3;
    panel2.rotation.y = Math.PI / 2;
    group.add(panel2);

    // Antenna dish
    const dishGeom = new THREE.CircleGeometry(0.6, 16);
    const dishMat = new THREE.MeshBasicMaterial({
      color: 0xaaaaaa,
      side: THREE.DoubleSide,
    });
    const dish = new THREE.Mesh(dishGeom, dishMat);
    dish.position.z = 1;
    dish.rotation.x = -Math.PI / 4;
    group.add(dish);

    return group;
  }

  private createOrbitLine(params: SatelliteOrbitalParams, color: number): THREE.Line {
    const points: THREE.Vector3[] = [];
    const segments = 128;

    for (let i = 0; i <= segments; i++) {
      // Simulate the full orbit path
      const fakeTime = params.launchTime + (i / segments) * params.orbitalPeriod;
      const pos = getSatellitePosition3D(params, fakeTime, GLOBE_RADIUS);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.satelliteOrbit,
      transparent: true,
      opacity: 0.3,
    });

    return new THREE.Line(geometry, material);
  }

  private createSatelliteVisionCircle(params: SatelliteOrbitalParams, currentTime: number): THREE.Line {
    const groundPos = getSatelliteGroundPosition(params, currentTime, GLOBE_RADIUS);
    return this.createVisionCircleAtPosition(groundPos);
  }

  private createVisionCircleAtPosition(centerGeo: GeoPosition): THREE.Line {
    const points: THREE.Vector3[] = [];
    const segments = 64;
    const rangeRad = SATELLITE_VISION_RANGE_DEGREES * (Math.PI / 180);

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * 2 * Math.PI;

      // Calculate point on circle at given range from center
      const lat = centerGeo.lat * (Math.PI / 180);
      const lng = centerGeo.lng * (Math.PI / 180);

      const pointLat = Math.asin(
        Math.sin(lat) * Math.cos(rangeRad) +
        Math.cos(lat) * Math.sin(rangeRad) * Math.cos(angle)
      );
      const pointLng = lng + Math.atan2(
        Math.sin(angle) * Math.sin(rangeRad) * Math.cos(lat),
        Math.cos(rangeRad) - Math.sin(lat) * Math.sin(pointLat)
      );

      const geoPoint: GeoPosition = {
        lat: pointLat * (180 / Math.PI),
        lng: pointLng * (180 / Math.PI),
      };

      const pos3d = geoToSphere(geoPoint, GLOBE_RADIUS + 0.5);
      points.push(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.satelliteVision,
      transparent: true,
      opacity: 0.5,
    });

    return new THREE.Line(geometry, material);
  }

  private createEmptyLine(): THREE.Line {
    const geometry = new THREE.BufferGeometry().setFromPoints([]);
    const material = new THREE.LineBasicMaterial({ color: 0x000000 });
    return new THREE.Line(geometry, material);
  }

  private updateSatelliteVisionCircle(circle: THREE.Line, params: SatelliteOrbitalParams, currentTime: number): void {
    const groundPos = getSatelliteGroundPosition(params, currentTime, GLOBE_RADIUS);

    const points: THREE.Vector3[] = [];
    const segments = 64;
    const rangeRad = SATELLITE_VISION_RANGE_DEGREES * (Math.PI / 180);

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * 2 * Math.PI;

      const lat = groundPos.lat * (Math.PI / 180);
      const lng = groundPos.lng * (Math.PI / 180);

      const pointLat = Math.asin(
        Math.sin(lat) * Math.cos(rangeRad) +
        Math.cos(lat) * Math.sin(rangeRad) * Math.cos(angle)
      );
      const pointLng = lng + Math.atan2(
        Math.sin(angle) * Math.sin(rangeRad) * Math.cos(lat),
        Math.cos(rangeRad) - Math.sin(lat) * Math.sin(pointLat)
      );

      const geoPoint: GeoPosition = {
        lat: pointLat * (180 / Math.PI),
        lng: pointLng * (180 / Math.PI),
      };

      const pos3d = geoToSphere(geoPoint, GLOBE_RADIUS + 0.5);
      points.push(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z));
    }

    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      positions[i * 3] = points[i].x;
      positions[i * 3 + 1] = points[i].y;
      positions[i * 3 + 2] = points[i].z;
    }
    circle.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    circle.geometry.attributes.position.needsUpdate = true;
  }

  private updateCommunicationLinks(): void {
    if (!this.gameState || !this.playerId) return;

    // Remove all existing communication links
    for (const objects of this.satelliteObjects.values()) {
      for (const link of objects.commLinks) {
        this.satelliteGroup.remove(link);
        link.geometry.dispose();
        (link.material as THREE.Material).dispose();
      }
      objects.commLinks = [];
    }

    // Check if a radar is selected
    const selectedRadar = this.selectedBuilding?.type === 'radar' ? this.selectedBuilding as Radar : null;

    // Only show communication links when a satellite or radar is selected
    if (!this.selectedSatelliteId && !selectedRadar) return;

    const now = Date.now();
    const satellites = getSatellites(this.gameState).filter(
      s => s.ownerId === this.playerId && !s.destroyed
    );

    // Get player's radar positions
    const radarPositions = this.getPlayerRadarPositions();

    // If a radar is selected, show links to all satellites that can connect to it
    if (selectedRadar) {
      const radarGeoPos = selectedRadar.geoPosition || this.pixelToGeoFallback(selectedRadar.position);
      const radarPos3d = geoToSphere(radarGeoPos, GLOBE_RADIUS + 2);
      const radarVec = new THREE.Vector3(radarPos3d.x, radarPos3d.y, radarPos3d.z);

      for (const satellite of satellites) {
        const orbitalParams: SatelliteOrbitalParams = {
          launchTime: satellite.launchTime,
          orbitalPeriod: satellite.orbitalPeriod,
          orbitalAltitude: satellite.orbitalAltitude,
          inclination: satellite.inclination,
          startingLongitude: satellite.startingLongitude,
        };

        const satPos3d = getSatellitePosition3D(orbitalParams, now, GLOBE_RADIUS);
        const satGroundPos = getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS);
        const satVec = new THREE.Vector3(satPos3d.x, satPos3d.y, satPos3d.z);

        const distance = this.calculateAngularDistance(satGroundPos, radarGeoPos);
        if (distance <= SATELLITE_RADAR_COMM_RANGE && this.hasLineOfSight(satVec, radarVec)) {
          const objects = this.satelliteObjects.get(satellite.id);
          if (objects) {
            const link = this.createCommunicationLink(satVec, radarVec);
            this.satelliteGroup.add(link);
            objects.commLinks.push(link);
          }
        }
      }
      return;
    }

    // Find the selected satellite from current game state
    const selectedSatellite = satellites.find(s => s.id === this.selectedSatelliteId);
    if (!selectedSatellite) {
      // Selected satellite no longer exists (destroyed), clear selection
      this.selectedSatelliteId = null;
      return;
    }

    // Show links for the selected satellite and connected satellites
    const selectedId = selectedSatellite.id;
    const connectedSatelliteIds = new Set<string>([selectedId]);

    // First pass: find all satellites connected to the selected one
    for (const satellite of satellites) {
      if (satellite.id === selectedId) continue;

      const selectedParams: SatelliteOrbitalParams = {
        launchTime: selectedSatellite.launchTime,
        orbitalPeriod: selectedSatellite.orbitalPeriod,
        orbitalAltitude: selectedSatellite.orbitalAltitude,
        inclination: selectedSatellite.inclination,
        startingLongitude: selectedSatellite.startingLongitude,
      };
      const selectedGroundPos = getSatelliteGroundPosition(selectedParams, now, GLOBE_RADIUS);

      const otherParams: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };
      const otherGroundPos = getSatelliteGroundPosition(otherParams, now, GLOBE_RADIUS);

      const distance = this.calculateAngularDistance(selectedGroundPos, otherGroundPos);
      if (distance <= SATELLITE_SAT_COMM_RANGE) {
        connectedSatelliteIds.add(satellite.id);
      }
    }

    // For each connected satellite (including selected), show communication links
    for (const satellite of satellites) {
      if (!connectedSatelliteIds.has(satellite.id)) continue;

      const orbitalParams: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };

      const satPos3d = getSatellitePosition3D(orbitalParams, now, GLOBE_RADIUS);
      const satGroundPos = getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS);

      const objects = this.satelliteObjects.get(satellite.id);
      if (!objects) continue;

      // Check for direct radar link
      for (const radarPos of radarPositions) {
        const distance = this.calculateAngularDistance(satGroundPos, radarPos);
        if (distance <= SATELLITE_RADAR_COMM_RANGE) {
          // Create link line from satellite to radar
          const radarPos3d = geoToSphere(radarPos, GLOBE_RADIUS + 2);
          const satVec = new THREE.Vector3(satPos3d.x, satPos3d.y, satPos3d.z);
          const radarVec = new THREE.Vector3(radarPos3d.x, radarPos3d.y, radarPos3d.z);

          // Only create link if line-of-sight is clear (doesn't pass through globe)
          if (this.hasLineOfSight(satVec, radarVec)) {
            const link = this.createCommunicationLink(satVec, radarVec);
            this.satelliteGroup.add(link);
            objects.commLinks.push(link);
          }
        }
      }

      // Check for satellite-to-satellite links (only between connected satellites)
      for (const otherSat of satellites) {
        if (otherSat.id === satellite.id) continue;
        if (!connectedSatelliteIds.has(otherSat.id)) continue;

        const otherParams: SatelliteOrbitalParams = {
          launchTime: otherSat.launchTime,
          orbitalPeriod: otherSat.orbitalPeriod,
          orbitalAltitude: otherSat.orbitalAltitude,
          inclination: otherSat.inclination,
          startingLongitude: otherSat.startingLongitude,
        };

        const otherGroundPos = getSatelliteGroundPosition(otherParams, now, GLOBE_RADIUS);
        const distance = this.calculateAngularDistance(satGroundPos, otherGroundPos);

        if (distance <= SATELLITE_SAT_COMM_RANGE) {
          const otherPos3d = getSatellitePosition3D(otherParams, now, GLOBE_RADIUS);
          const satVec = new THREE.Vector3(satPos3d.x, satPos3d.y, satPos3d.z);
          const otherVec = new THREE.Vector3(otherPos3d.x, otherPos3d.y, otherPos3d.z);

          // Only create link if line-of-sight is clear (doesn't pass through globe)
          if (this.hasLineOfSight(satVec, otherVec)) {
            const link = this.createCommunicationLink(satVec, otherVec);
            this.satelliteGroup.add(link);
            objects.commLinks.push(link);
          }
        }
      }
    }
  }

  private createCommunicationLink(from: THREE.Vector3, to: THREE.Vector3): THREE.Line {
    const points = [from, to];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.communicationLink,
      transparent: true,
      opacity: 0.4,
    });
    return new THREE.Line(geometry, material);
  }

  // Check if two points have line-of-sight (line doesn't pass through globe)
  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    // Find the closest point on the line segment to the origin (globe center)
    // If that distance is less than GLOBE_RADIUS, the line passes through the globe
    const dir = to.clone().sub(from);
    const len = dir.length();
    dir.normalize();

    // Project origin onto the line: t = -dot(from, dir) / dot(dir, dir)
    // Since dir is normalized, dot(dir, dir) = 1
    const t = -from.dot(dir);

    // Clamp t to the segment [0, len]
    const tClamped = Math.max(0, Math.min(len, t));

    // Find the closest point on the segment to the origin
    const closestPoint = from.clone().add(dir.clone().multiplyScalar(tClamped));
    const distanceToOrigin = closestPoint.length();

    // Line must not pass through the globe surface
    // Small margin above surface to cut off just before horizon
    return distanceToOrigin >= GLOBE_RADIUS + 1;
  }

  private disposeSatelliteObjects(objects: {
    body: THREE.Group;
    orbitLine: THREE.Line;
    visionCircle: THREE.Line;
    commLinks: THREE.Line[];
  }): void {
    this.disposeGroup(objects.body);
    objects.orbitLine.geometry.dispose();
    (objects.orbitLine.material as THREE.Material).dispose();
    objects.visionCircle.geometry.dispose();
    (objects.visionCircle.material as THREE.Material).dispose();
    for (const link of objects.commLinks) {
      link.geometry.dispose();
      (link.material as THREE.Material).dispose();
    }
  }

  // Check if a position is within satellite coverage (for fog of war)
  private getPlayerSatelliteVisionPositions(): GeoPosition[] {
    if (!this.gameState || !this.playerId) return [];

    const positions: GeoPosition[] = [];
    const now = Date.now();

    for (const satellite of getSatellites(this.gameState)) {
      if (satellite.ownerId !== this.playerId || satellite.destroyed) continue;

      const orbitalParams: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };

      // Only include satellites that have communication back to ground
      if (this.satelliteHasGroundLink(satellite)) {
        positions.push(getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS));
      }
    }

    return positions;
  }

  private satelliteHasGroundLink(satellite: Satellite): boolean {
    if (!this.gameState || !this.playerId) return false;

    const now = Date.now();
    const radarPositions = this.getPlayerRadarPositions();

    const orbitalParams: SatelliteOrbitalParams = {
      launchTime: satellite.launchTime,
      orbitalPeriod: satellite.orbitalPeriod,
      orbitalAltitude: satellite.orbitalAltitude,
      inclination: satellite.inclination,
      startingLongitude: satellite.startingLongitude,
    };

    const satGroundPos = getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS);

    // Check direct radar link
    for (const radarPos of radarPositions) {
      const distance = this.calculateAngularDistance(satGroundPos, radarPos);
      if (distance <= SATELLITE_RADAR_COMM_RANGE) {
        return true;
      }
    }

    // Check relay through other satellites (simple one-hop relay)
    for (const otherSat of getSatellites(this.gameState)) {
      if (otherSat.id === satellite.id || otherSat.ownerId !== this.playerId || otherSat.destroyed) continue;

      const otherParams: SatelliteOrbitalParams = {
        launchTime: otherSat.launchTime,
        orbitalPeriod: otherSat.orbitalPeriod,
        orbitalAltitude: otherSat.orbitalAltitude,
        inclination: otherSat.inclination,
        startingLongitude: otherSat.startingLongitude,
      };

      const otherGroundPos = getSatelliteGroundPosition(otherParams, now, GLOBE_RADIUS);
      const satToSatDistance = this.calculateAngularDistance(satGroundPos, otherGroundPos);

      if (satToSatDistance <= SATELLITE_SAT_COMM_RANGE) {
        // Check if other satellite has direct radar link
        for (const radarPos of radarPositions) {
          const otherToRadarDistance = this.calculateAngularDistance(otherGroundPos, radarPos);
          if (otherToRadarDistance <= SATELLITE_RADAR_COMM_RANGE) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // Updated method to include satellite coverage in fog of war
  private isWithinCoverage(geoPos: GeoPosition, altitudeKm: number = 0): boolean {
    // First check radar coverage
    if (this.isWithinRadarCoverage(geoPos, altitudeKm)) {
      return true;
    }

    // Then check satellite coverage
    const satellitePositions = this.getPlayerSatelliteVisionPositions();
    for (const satPos of satellitePositions) {
      const distance = this.calculateAngularDistance(geoPos, satPos);
      if (distance <= SATELLITE_VISION_RANGE_DEGREES) {
        return true;
      }
    }

    return false;
  }

  private pixelToGeoFallback(pixel: { x: number; y: number }): GeoPosition {
    // Fallback conversion for entities without geoPosition
    const MAP_WIDTH = 1000;
    const MAP_HEIGHT = 700;
    const lng = ((pixel.x / MAP_WIDTH) * 360) - 180;
    const lat = 90 - ((pixel.y / MAP_HEIGHT) * 180);
    return { lat, lng };
  }

  private disposeGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if ((child as THREE.Mesh).geometry) {
        (child as THREE.Mesh).geometry.dispose();
      }
      if ((child as THREE.Mesh).material) {
        const material = (child as THREE.Mesh).material;
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material.dispose();
        }
      }
    });
  }

  private handleResize = (): void => {
    const rect = this.container.getBoundingClientRect();
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height);
  };

  private handleClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Check if click is over HUD first
    if (this.hudRenderer.handleClick(canvasX, canvasY)) {
      return; // Click handled by HUD
    }

    this.mouse.x = (canvasX / rect.width) * 2 - 1;
    this.mouse.y = -(canvasY / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Check for missile clicks first (they're in flight, most interesting)
    const missileIntersects = this.raycaster.intersectObjects(
      this.missileGroup.children,
      true
    );

    if (missileIntersects.length > 0) {
      let obj = missileIntersects[0].object;
      // Walk up to find the parent with missile ID
      while (obj && obj.parent && obj.parent !== this.missileGroup) {
        obj = obj.parent as THREE.Object3D;
      }
      // Find which missile this belongs to
      for (const [missileId, missileObjs] of this.missileObjects) {
        if (missileObjs.head === obj || missileObjs.trail === obj) {
          // Found the missile - track it and center camera
          this.trackedMissileId = missileId;
          // Get missile position and center on it
          if (this.gameState) {
            const missiles = getMissiles(this.gameState);
            const missile = missiles.find(m => m.id === missileId);
            if (missile) {
              const geoPos = missile.geoCurrentPosition ||
                this.pixelToGeoFallback(missile.currentPosition);
              this.centerCameraOnGeo(geoPos);
            }
          }
          return;
        }
      }
    }

    // Check for satellite clicks
    const satelliteIntersects = this.raycaster.intersectObjects(
      this.satelliteGroup.children,
      true
    );

    if (satelliteIntersects.length > 0) {
      let obj = satelliteIntersects[0].object;
      // Walk up to find the group with satellite data
      while (obj && !obj.userData?.satellite && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.satellite) {
        const satellite = obj.userData.satellite as Satellite;
        // Only allow selecting player's own satellites
        if (satellite.ownerId === this.playerId) {
          // Stop any missile tracking
          this.trackedMissileId = null;
          // Clear building selection
          this.selectedBuilding = null;
          // Set satellite selection by ID (persists across state updates)
          this.selectedSatelliteId = satellite.id;
          // Center camera on satellite's ground position
          const now = Date.now();
          const orbitalParams: SatelliteOrbitalParams = {
            launchTime: satellite.launchTime,
            orbitalPeriod: satellite.orbitalPeriod,
            orbitalAltitude: satellite.orbitalAltitude,
            inclination: satellite.inclination,
            startingLongitude: satellite.startingLongitude,
          };
          const groundPos = getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS);
          this.centerCameraOnGeo(groundPos);
          // Update HUD
          if (this.gameState) {
            this.hudRenderer.updateState(this.gameState, this.playerId, null, this.placementMode);
          }
          return;
        }
      }
    }

    // Check for building clicks (silos, radars, airfields)
    const buildingIntersects = this.raycaster.intersectObjects(
      this.buildingGroup.children,
      true
    );

    if (buildingIntersects.length > 0) {
      let obj = buildingIntersects[0].object;
      // Walk up to find the group with building data
      while (obj && !obj.userData?.building && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.building) {
        const building = obj.userData.building as Building;
        // Stop any missile tracking
        this.trackedMissileId = null;
        // Clear satellite selection
        this.selectedSatelliteId = null;
        // Center camera on the building
        const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
        this.centerCameraOnGeo(geoPos);
        // Also trigger the building click callback if set
        if (this.onBuildingClickCallback) {
          this.onBuildingClickCallback(building);
        }
        return;
      }
    }

    // Check for city clicks
    const cityIntersects = this.raycaster.intersectObjects(
      this.cityGroup.children,
      true
    );

    if (cityIntersects.length > 0) {
      let obj = cityIntersects[0].object;
      // Walk up to find group with city data
      while (obj && !obj.userData?.city && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.city) {
        const city = obj.userData.city;
        // Stop any missile tracking
        this.trackedMissileId = null;
        // Center camera on the city
        const geoPos = city.geoPosition || this.pixelToGeoFallback(city.position);
        this.centerCameraOnGeo(geoPos);
        return;
      }
    }

    // Check for radar coverage clicks (center on radar)
    const radarIntersects = this.raycaster.intersectObjects(
      this.radarCoverageGroup.children,
      true
    );

    if (radarIntersects.length > 0) {
      // Find the radar this belongs to
      for (const [radarId, beam] of this.radarCoverageBeams) {
        if (beam.children.some(child => radarIntersects[0].object === child ||
            radarIntersects[0].object.parent === child)) {
          // Find the radar building
          if (this.gameState) {
            const radar = getBuildings(this.gameState).find(b => b.id === radarId);
            if (radar) {
              this.trackedMissileId = null;
              const geoPos = radar.geoPosition || this.pixelToGeoFallback(radar.position);
              this.centerCameraOnGeo(geoPos);
              return;
            }
          }
        }
      }
    }

    // Stop tracking and clear selections when clicking elsewhere
    this.trackedMissileId = null;
    this.selectedSatelliteId = null;

    // Check for globe clicks
    const globeIntersects = this.raycaster.intersectObject(this.globe);
    if (globeIntersects.length > 0 && this.onClickCallback) {
      const point = globeIntersects[0].point;
      const geoPos = this.spherePointToGeo(point);
      this.onClickCallback(geoPos);
    }
  };

  private spherePointToGeo(point: THREE.Vector3): GeoPosition {
    const normalized = point.clone().normalize();
    const lat = 90 - Math.acos(normalized.y) * (180 / Math.PI);
    let lng = Math.atan2(normalized.z, -normalized.x) * (180 / Math.PI) - 180;
    if (lng < -180) lng += 360;
    if (lng > 180) lng -= 360;
    return { lat, lng };
  }

  // Center camera on a geographic position with smooth animation
  private centerCameraOnGeo(geoPos: GeoPosition, distance?: number): void {
    this.cameraTargetGeo = geoPos;
    this.cameraAnimating = true;

    // Calculate target camera position (looking at the point from outside)
    const targetDist = distance || this.camera.position.length();
    const targetPos = geoToSphere(geoPos, targetDist);

    // Animate camera movement smoothly
    const startPos = this.camera.position.clone();
    const endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
    const startTime = performance.now();
    const duration = 800; // ms

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      // Ease out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - t, 3);

      // Interpolate position (spherical interpolation would be better but this works)
      this.camera.position.lerpVectors(startPos, endPos, eased);
      this.camera.lookAt(0, 0, 0);
      this.controls.update();

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        this.cameraAnimating = false;
      }
    };

    animate();
  }

  // Track a missile - camera will follow it
  public trackMissile(missileId: string | null): void {
    this.trackedMissileId = missileId;
  }

  // Stop tracking and clear selection
  public stopTracking(): void {
    this.trackedMissileId = null;
  }

  private startRenderLoop(): void {
    const render = (time: number) => {
      const deltaTime = (time - this.lastTime) / 1000;
      this.lastTime = time;

      // Update controls
      this.controls.update();

      // Follow tracked missile if one is selected
      if (this.trackedMissileId && this.gameState && !this.cameraAnimating) {
        const missiles = getMissiles(this.gameState);
        const trackedMissile = missiles.find(m => m.id === this.trackedMissileId);
        if (trackedMissile && !trackedMissile.detonated && !trackedMissile.intercepted) {
          const missileGeo = trackedMissile.geoCurrentPosition ||
            this.pixelToGeoFallback(trackedMissile.currentPosition);
          // Smoothly follow the missile
          const targetPos = geoToSphere(missileGeo, this.camera.position.length());
          this.camera.position.lerp(new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z), 0.05);
          this.camera.lookAt(0, 0, 0);
        } else {
          // Missile no longer exists, stop tracking
          this.trackedMissileId = null;
        }
      }

      // Update camera to follow selected satellite (both position and target)
      // (buildings don't change rotation center - that would make targeting difficult)
      if (this.selectedSatelliteId && this.gameState && !this.cameraAnimating) {
        const selectedSatellite = getSatellites(this.gameState).find(s => s.id === this.selectedSatelliteId);
        if (selectedSatellite && !selectedSatellite.destroyed) {
          const now = Date.now();
          const orbitalParams: SatelliteOrbitalParams = {
            launchTime: selectedSatellite.launchTime,
            orbitalPeriod: selectedSatellite.orbitalPeriod,
            orbitalAltitude: selectedSatellite.orbitalAltitude,
            inclination: selectedSatellite.inclination,
            startingLongitude: selectedSatellite.startingLongitude,
          };
          const satPos3d = getSatellitePosition3D(orbitalParams, now, GLOBE_RADIUS);
          const satVec = new THREE.Vector3(satPos3d.x, satPos3d.y, satPos3d.z);

          // Move camera to follow satellite - maintain current distance from satellite
          const cameraDistance = this.camera.position.length();
          const targetCameraPos = satVec.clone().normalize().multiplyScalar(cameraDistance);
          this.camera.position.lerp(targetCameraPos, 0.05);

          // Set orbit controls target to satellite position
          this.controls.target.lerp(satVec, 0.1);
        } else {
          // Satellite was destroyed, clear selection and return to origin
          this.selectedSatelliteId = null;
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }
      } else if (!this.selectedSatelliteId && !this.controls.target.equals(new THREE.Vector3(0, 0, 0))) {
        // No satellite selected - smoothly return to origin (globe center)
        this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
      }

      // Update radar sweep animation
      this.radarAngle += deltaTime * Math.PI * 0.5;
      this.animateRadarSweeps();

      // Update game objects
      this.updateGameObjects();

      // Apply view toggle visibility
      this.applyViewToggles();

      // Render 3D scene
      this.renderer.render(this.scene, this.camera);

      // Render HUD (canvas overlay)
      this.hudRenderer.render();

      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);
  }

  private animateRadarSweeps(): void {
    // Sweep line covers ground-level horizon distance
    const groundHorizonKm = Math.sqrt(2 * this.EARTH_RADIUS_KM * this.RADAR_HEIGHT_KM);
    const groundHorizonDegrees = Math.max(3, (groundHorizonKm / this.EARTH_RADIUS_KM) * (180 / Math.PI));
    const sweepLength = groundHorizonDegrees * (Math.PI / 180) * GLOBE_RADIUS;

    for (const [radarId, sweepData] of this.radarSweepLines) {
      const beam = this.radarCoverageBeams.get(radarId);
      if (!beam) continue;

      const { center, outward } = sweepData;

      // Find a tangent direction for this radar
      let tangentDir: THREE.Vector3;
      if (Math.abs(outward.y) < 0.99) {
        tangentDir = new THREE.Vector3(0, 1, 0).cross(outward).normalize();
      } else {
        tangentDir = new THREE.Vector3(1, 0, 0).cross(outward).normalize();
      }

      const perpDir = outward.clone().cross(tangentDir).normalize();

      // Animate main sweep line and trails
      const sweepLine = beam.getObjectByName('sweepLine') as THREE.Line;
      if (sweepLine) {
        const sweepEnd = center.clone()
          .add(tangentDir.clone().multiplyScalar(Math.cos(this.radarAngle) * sweepLength))
          .add(perpDir.clone().multiplyScalar(Math.sin(this.radarAngle) * sweepLength));
        sweepEnd.normalize().multiplyScalar(GLOBE_RADIUS + 0.5);

        const positions = sweepLine.geometry.attributes.position;
        positions.setXYZ(0, center.x, center.y, center.z);
        positions.setXYZ(1, sweepEnd.x, sweepEnd.y, sweepEnd.z);
        positions.needsUpdate = true;
      }

      // Animate trailing lines
      for (let i = 1; i <= 4; i++) {
        const trailLine = beam.getObjectByName(`sweepTrail${i}`) as THREE.Line;
        if (trailLine) {
          const trailAngle = this.radarAngle - i * 0.15;
          const trailEnd = center.clone()
            .add(tangentDir.clone().multiplyScalar(Math.cos(trailAngle) * sweepLength))
            .add(perpDir.clone().multiplyScalar(Math.sin(trailAngle) * sweepLength));
          trailEnd.normalize().multiplyScalar(GLOBE_RADIUS + 0.5);

          const positions = trailLine.geometry.attributes.position;
          positions.setXYZ(0, center.x, center.y, center.z);
          positions.setXYZ(1, trailEnd.x, trailEnd.y, trailEnd.z);
          positions.needsUpdate = true;
        }
      }
    }
  }

  private applyViewToggles(): void {
    // Apply radar visibility
    this.radarCoverageGroup.visible = this.viewToggles.radar;

    // Apply grid visibility
    this.gridGroup.visible = this.viewToggles.grid;

    // Apply label visibility - hide/show label sprites in city and building groups
    for (const [, group] of this.cityMarkers) {
      const label = group.getObjectByName('label');
      if (label) {
        label.visible = this.viewToggles.labels;
      }
    }

    // Apply trails visibility - hide trail lines but keep missile heads
    for (const [, objects] of this.missileObjects) {
      objects.trail.visible = this.viewToggles.trails;
      // Head is always visible
    }
  }

  // Public setter for view toggles
  setViewToggle(toggle: 'radar' | 'grid' | 'labels' | 'trails', value: boolean): void {
    this.viewToggles[toggle] = value;
  }

  getViewToggles(): { radar: boolean; grid: boolean; labels: boolean; trails: boolean } {
    return { ...this.viewToggles };
  }

  // Public method to focus camera on a specific location
  focusOnGeo(geo: GeoPosition): void {
    const pos = geoToSphere(geo, GLOBE_RADIUS * 2);
    this.camera.position.set(pos.x, pos.y, pos.z);
    this.camera.lookAt(0, 0, 0);
  }
}
