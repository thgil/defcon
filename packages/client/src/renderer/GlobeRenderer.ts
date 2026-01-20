import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ConicPolygonGeometry from 'three-conic-polygon-geometry';
import {
  type GameState,
  type Building,
  type Missile,
  type PhysicsMissile,
  type RailInterceptor,
  type GuidedInterceptor,
  type City,
  type Territory,
  type GeoPosition,
  type Silo,
  type SiloMode,
  type Radar,
  type Satellite,
  type SatelliteLaunchFacility,
  geoToSphere,
  sphereToGeo,
  getMissilePosition3D,
  getMissileDirection3D,
  getInterceptorPosition3D,
  getInterceptorDirection3D,
  geoInterpolate,
  greatCircleDistance,
  getTerritories,
  getCities,
  getBuildings,
  getMissiles,
  getSatellites,
  getSatellitePosition3D,
  getSatelliteGroundPosition,
  SatelliteOrbitalParams,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  isPhysicsMissile,
  isRailInterceptor,
  isGuidedInterceptor,
  isInterceptor as isInterceptorType,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
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
const MISSILE_MIN_ALTITUDE = 8;  // Minimum altitude for very short flights
const MISSILE_MAX_ALTITUDE = 50; // Maximum altitude for intercontinental flights (higher for more dramatic arcs)

// Satellite configuration (should match server SATELLITE_CONFIG)
const SATELLITE_ORBITAL_ALTITUDE = 120;  // Globe units above surface (above interceptor range)
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
  private coastlineGroup: THREE.Group;
  private borderGroup: THREE.Group;
  private airspaceGroup: THREE.Group;

  // View toggles state
  private viewToggles = {
    radar: true,
    grid: true,
    labels: true,
    trails: true,
    coastlines: true,
    borders: true,
    airspaces: true,
  };

  // Object maps for efficient updates
  private cityMarkers = new Map<string, THREE.Group>(); // Group contains marker + label
  private buildingMarkers = new Map<string, THREE.Group>();
  private missileObjects = new Map<string, {
    trail: THREE.Line;       // Traveled path (bright trail behind missile)
    head: THREE.Group;       // ICBM cone with glow
    maxAltitude: number;     // Calculated based on flight distance
    flightDuration: number;  // Flight duration in ms for phase timing
    seed: number;            // Unique seed for path variation
    plannedRoute?: THREE.Line; // Full planned path (only for player's missiles)
    isInterceptor?: boolean; // Whether this is an interceptor missile
    targetMissileId?: string; // For interceptors: the ID of the ICBM being tracked
    interceptorTrailHistory?: THREE.Vector3[]; // For interceptors: actual path taken
    lastTrailProgress?: number; // Last progress when we added a trail point
    targetQuaternion?: THREE.Quaternion; // Target orientation for smooth interpolation
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
  private selectedCityInfo: { name: string; population: number; territoryId: string } | null = null;

  // Client-side interpolation for smooth missile movement
  private missileInterpolation = new Map<string, {
    lastProgress: number;
    lastUpdateTime: number;
    targetProgress: number;
    estimatedSpeed: number;  // Progress per second
  }>();

  // Client-side interpolation for physics missiles (position-based)
  private physicsMissileInterpolation = new Map<string, {
    lastPosition: { x: number; y: number; z: number };
    targetPosition: { x: number; y: number; z: number };
    estimatedVelocity: { x: number; y: number; z: number };
    lastUpdateTime: number;
  }>();

  // Track missile positions for explosions when they're removed
  private missileTargets = new Map<string, GeoPosition>();
  private missileLastPositions = new Map<string, GeoPosition>();
  private missileWasIntercepted = new Map<string, boolean>();

  // Track missiles that have had ground impact explosions shown (prevent duplicate explosions)
  private groundImpactMissiles = new Set<string>();

  // Track missiles that have had detonation/interception explosions shown
  private shownExplosions = new Set<string>();

  // Stage markers for SpaceX-style flight event visualization
  private stageMarkers = new Map<string, THREE.Group[]>();
  private interceptorPhases = new Map<string, string>();  // Track previous phase for transition detection
  private missileRadarStatus = new Map<string, boolean>(); // Track radar coverage for LOS markers
  private icbmMarkerProgress = new Map<string, Set<string>>(); // Track which ICBM markers have been added

  // Fading missiles after detonation/interception
  private fadingMissiles = new Map<string, {
    objects: {
      trail: THREE.Line;
      head: THREE.Group;
      explosionSphere?: THREE.Mesh;  // Small explosion sphere at destruction point
    };
    impactPosition: THREE.Vector3;   // Where the missile exploded
    trailPoints: THREE.Vector3[];    // Original trail points
    fadeStartTime: number;           // When fade started
    fadeDuration: number;            // How long to fade (ms)
  }>();

  // Uncertain radar contacts - tracks detection confidence and glitch state
  private uncertainContacts = new Map<string, {
    confidence: number;              // 0-1, how certain we are this is a real contact
    classification: 'unknown' | 'anomaly' | 'probable' | 'confirmed';
    jitteredPosition: GeoPosition;   // Noisy position for display
    lastFlickerTime: number;         // For flickering effect
    flickerState: boolean;           // Current visibility in flicker
    firstDetectedTime: number;       // When we first saw this contact
    positionNoise: { lat: number; lng: number };  // Persistent noise offset
  }>();

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

  // Drag detection - prevent firing missiles when rotating the globe
  private mouseDownPosition: { x: number; y: number } | null = null;
  private readonly DRAG_THRESHOLD = 5; // pixels - if mouse moves more than this, it's a drag

  // Click callback
  private onClickCallback: ((geoPosition: GeoPosition) => void) | null = null;
  private onBuildingClickCallback: ((building: Building) => void) | null = null;
  private onEnemyICBMClickCallback: ((missileId: string) => void) | null = null;
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
  private cameraAnimationStabilizeFrames: number = 0;

  // Communication chain visualization (shown when interceptor is selected)
  private commChainGroup: THREE.Group;
  private commChainLines: THREE.Line[] = [];
  private commChainPackets: THREE.Mesh[] = [];
  private packetAnimationTime: number = 0;

  // Intercept prediction visualization (shown when interceptor is tracked)
  private interceptPredictionGroup: THREE.Group;
  private interceptMarker: THREE.Group | null = null;
  private interceptChanceLabel: THREE.Sprite | null = null;
  private flameoutMarker: THREE.Group | null = null;
  private missileStatsLabel: THREE.Sprite | null = null;

  // Fog of war toggle (for debug mode)
  private fogOfWarDisabled: boolean = false;

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
      2000
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
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 500;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    // Prevent gimbal lock - restrict vertical rotation
    this.controls.minPolarAngle = Math.PI * 0.1;  // 18° from top
    this.controls.maxPolarAngle = Math.PI * 0.9;  // 162° from top

    // Create groups for organization
    this.territoryGroup = new THREE.Group();
    this.cityGroup = new THREE.Group();
    this.buildingGroup = new THREE.Group();
    this.missileGroup = new THREE.Group();
    this.effectGroup = new THREE.Group();
    this.radarCoverageGroup = new THREE.Group();
    this.gridGroup = new THREE.Group();
    this.satelliteGroup = new THREE.Group();
    this.coastlineGroup = new THREE.Group();
    this.borderGroup = new THREE.Group();
    this.airspaceGroup = new THREE.Group();

    this.placementPreviewGroup = new THREE.Group();
    this.commChainGroup = new THREE.Group();
    this.interceptPredictionGroup = new THREE.Group();

    this.scene.add(this.territoryGroup);
    this.scene.add(this.coastlineGroup);
    this.scene.add(this.borderGroup);
    this.scene.add(this.airspaceGroup);
    this.scene.add(this.radarCoverageGroup);
    this.scene.add(this.gridGroup);
    this.scene.add(this.cityGroup);
    this.scene.add(this.buildingGroup);
    this.scene.add(this.missileGroup);
    this.scene.add(this.satelliteGroup);
    this.scene.add(this.effectGroup);
    this.scene.add(this.placementPreviewGroup);
    this.scene.add(this.commChainGroup);
    this.scene.add(this.interceptPredictionGroup);

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
    this.renderer.domElement.addEventListener('mousedown', this.handleMouseDown);
    this.renderer.domElement.addEventListener('click', this.handleClick);
    this.renderer.domElement.addEventListener('mousemove', this.handleMouseMove);

    // Start render loop
    this.startRenderLoop();
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('mousedown', this.handleMouseDown);
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

  setAlerts(alerts: import('../stores/gameStore').GameAlert[]): void {
    this.hudRenderer.setAlerts(alerts);
  }

  setManualInterceptState(state: import('../stores/gameStore').ManualInterceptState): void {
    this.hudRenderer.setManualInterceptState(state);
  }

  setManualInterceptCallbacks(
    onToggleSilo: (siloId: string) => void,
    onLaunch: () => void,
    onCancel: () => void
  ): void {
    this.hudRenderer.setManualInterceptCallbacks(onToggleSilo, onLaunch, onCancel);
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

  setOnEnemyICBMClick(callback: (missileId: string) => void): void {
    this.onEnemyICBMClickCallback = callback;
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

  // Layer visibility toggles
  toggleCoastlines(visible?: boolean): boolean {
    const newState = visible !== undefined ? visible : !this.viewToggles.coastlines;
    this.viewToggles.coastlines = newState;
    this.coastlineGroup.visible = newState;
    return newState;
  }

  toggleBorders(visible?: boolean): boolean {
    const newState = visible !== undefined ? visible : !this.viewToggles.borders;
    this.viewToggles.borders = newState;
    this.borderGroup.visible = newState;
    return newState;
  }

  toggleAirspaces(visible?: boolean): boolean {
    const newState = visible !== undefined ? visible : !this.viewToggles.airspaces;
    this.viewToggles.airspaces = newState;
    this.airspaceGroup.visible = newState;
    return newState;
  }

  getLayerVisibility(): { coastlines: boolean; borders: boolean; airspaces: boolean } {
    return {
      coastlines: this.viewToggles.coastlines,
      borders: this.viewToggles.borders,
      airspaces: this.viewToggles.airspaces,
    };
  }

  // Debug panel methods
  setDebugCallbacks(
    onDebugCommand: (command: string, value?: number, targetRegion?: string) => void,
    onEnableAI: (region: string) => void,
    onDisableAI: () => void
  ): void {
    this.hudRenderer.setDebugCallbacks(
      onDebugCommand,
      onEnableAI,
      onDisableAI,
      (layer) => {
        switch (layer) {
          case 'coastlines':
            return this.toggleCoastlines();
          case 'borders':
            return this.toggleBorders();
          case 'airspaces':
            return this.toggleAirspaces();
        }
      },
      (enabled) => {
        this.setFogOfWarEnabled(enabled);
      }
    );
    // Initialize layer visibility in HUD
    this.hudRenderer.setLayerVisibility(this.getLayerVisibility());
  }

  setFogOfWarEnabled(enabled: boolean): void {
    // Track fog of war state (disabled = show everything)
    this.fogOfWarDisabled = !enabled;

    // Hide/show the visual fog overlay
    if (this.fogOfWarMesh) {
      this.fogOfWarMesh.visible = enabled;
    }
  }

  toggleDebugPanel(): void {
    this.hudRenderer.toggleDebugPanel();
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
      // Small triangle outline (matching building marker size)
      const points = [
        new THREE.Vector3(0, 1.5, 0),
        new THREE.Vector3(-1.2, -1, 0),
        new THREE.Vector3(1.2, -1, 0),
        new THREE.Vector3(0, 1.5, 0),
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: 0x00ff88,
        transparent: true,
        opacity: 0.6,
      });
      const outline = new THREE.Line(geometry, material);
      outline.position.set(pos3d.x, pos3d.y, pos3d.z);
      outline.lookAt(0, 0, 0);
      outline.rotateX(Math.PI);
      this.placementPreviewGroup.add(outline);
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
    // Shared shader code for atmosphere layers
    const vertexShader = `
      varying vec3 vPositionW;
      void main() {
        vPositionW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const fragmentShader = `
      uniform vec3 glowColor;
      uniform float intensity;
      varying vec3 vPositionW;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vPositionW);
        vec3 sphereNormal = normalize(vPositionW);
        float rim = 1.0 - abs(dot(viewDir, sphereNormal));
        float glow = smoothstep(0.0, 0.5, rim) * smoothstep(1.0, 0.6, rim);
        gl_FragColor = vec4(glowColor, glow * intensity);
      }
    `;

    // Inner atmosphere layer - main glow
    const innerGeometry = new THREE.SphereGeometry(GLOBE_RADIUS + 16, 64, 64);
    const innerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x2a5577) },
        intensity: { value: 0.25 },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.scene.add(new THREE.Mesh(innerGeometry, innerMaterial));

    // Outer atmosphere layer - soft fade into space
    const outerGeometry = new THREE.SphereGeometry(GLOBE_RADIUS + 30, 64, 64);
    const outerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x223355) },
        intensity: { value: 0.08 },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.scene.add(new THREE.Mesh(outerGeometry, outerMaterial));
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
      // Load land polygons first (for filled continents) - 110m resolution for faster loading
      const landResponse = await fetch('/assets/world-land.geojson');
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

      // Load coastlines for outlines - this gives us clean continent boundaries (110m resolution for faster loading)
      const coastResponse = await fetch('/assets/world-coastline.geojson');
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
            this.coastlineGroup.add(line);
          }
        } else if (feature.geometry.type === 'MultiLineString') {
          for (const coords of feature.geometry.coordinates) {
            const points = this.coordsToPoints(coords);
            if (points.length > 1) {
              const geometry = new THREE.BufferGeometry().setFromPoints(points);
              const line = new THREE.Line(geometry, lineMaterial);
              this.coastlineGroup.add(line);
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
            this.borderGroup.add(line);
          }
        } else if (feature.geometry.type === 'MultiLineString') {
          for (const coords of feature.geometry.coordinates) {
            const points = this.coordsToPoints(coords);
            if (points.length > 1) {
              const geometry = new THREE.BufferGeometry().setFromPoints(points);
              const line = new THREE.Line(geometry, borderMaterial);
              this.borderGroup.add(line);
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
      color: 0x4a6080,
      dashSize: 4,
      gapSize: 2,
      transparent: true,
      opacity: 0.8,
    });

    for (const territory of Object.values(TERRITORY_GEO_DATA)) {
      const points: THREE.Vector3[] = [];

      for (const coord of territory.boundaryCoords) {
        const pos = geoToSphere(coord, GLOBE_RADIUS + 4);
        points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
      }

      // Close the loop
      if (points.length > 0) {
        points.push(points[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, boundaryMaterial);
      line.computeLineDistances(); // Required for dashed lines
      this.airspaceGroup.add(line);
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
    const info = this.getRadarDetectionInfo(geoPos, altitudeKm);
    return info.detected;
  }

  // Get detailed radar detection info including confidence level
  // Confidence decreases near the edge of radar range (uncertainty zone)
  private getRadarDetectionInfo(geoPos: GeoPosition, altitudeKm: number = 0): {
    detected: boolean;
    confidence: number;  // 0-1: 0 = edge of range, 1 = very close to radar
    closestRadarDistance: number;  // Angular distance to nearest radar
    effectiveRange: number;  // Effective radar range in degrees
  } {
    const radarPositions = this.getPlayerRadarPositions();

    // Always visible if player has no radars (early game) - TODO: revisit this
    if (radarPositions.length === 0) {
      return { detected: true, confidence: 1, closestRadarDistance: 0, effectiveRange: this.RADAR_MAX_RANGE_DEGREES };
    }

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

    let closestDistance = Infinity;
    let detected = false;

    for (const radarPos of radarPositions) {
      // Calculate angular distance using great circle formula
      const angularDistance = this.calculateAngularDistance(geoPos, radarPos);
      closestDistance = Math.min(closestDistance, angularDistance);
      if (angularDistance <= effectiveRangeDegrees) {
        detected = true;
      }
    }

    // Calculate confidence based on distance ratio
    // 0-60% of range: confidence = 1 (clear detection)
    // 60-85% of range: confidence decreases (getting fuzzy)
    // 85-100% of range: confidence low (very uncertain, flickery)
    // 100-115% of range: detection possible but very unreliable (edge anomalies)
    let confidence = 0;
    if (detected) {
      const rangeRatio = closestDistance / effectiveRangeDegrees;
      if (rangeRatio <= 0.6) {
        confidence = 1.0;
      } else if (rangeRatio <= 0.85) {
        // Linear decrease from 1.0 to 0.7
        confidence = 1.0 - (rangeRatio - 0.6) / 0.25 * 0.3;
      } else {
        // Steep decrease from 0.7 to 0.2
        confidence = 0.7 - (rangeRatio - 0.85) / 0.15 * 0.5;
      }
    } else {
      // Not officially detected, but check for edge anomalies
      // Contacts at 100-115% of range may flicker in and out
      const rangeRatio = closestDistance / effectiveRangeDegrees;
      if (rangeRatio <= 1.15) {
        confidence = Math.max(0, 0.2 - (rangeRatio - 1.0) * 1.33);
        detected = confidence > 0.05; // Can still "detect" if close enough to edge
      }
    }

    return {
      detected,
      confidence: Math.max(0, Math.min(1, confidence)),
      closestRadarDistance: closestDistance,
      effectiveRange: effectiveRangeDegrees,
    };
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

    // Build a map of game state cities by name+territory for matching
    const gameStateCities = new Map<string, City>();
    for (const city of getCities(this.gameState)) {
      gameStateCities.set(`${city.territoryId}:${city.name}`, city);
    }

    // Render all cities from CITY_GEO_DATA
    for (const [territoryId, cities] of Object.entries(CITY_GEO_DATA)) {
      for (const cityData of cities) {
        const cityKey = `${territoryId}:${cityData.name}`;
        const gameCity = gameStateCities.get(cityKey);

        // Determine ownership and color
        const territory = this.gameState.territories[territoryId];
        const hasOwner = territory?.ownerId != null;
        const isMine = territory?.ownerId === this.playerId;
        const isEnemy = hasOwner && !isMine;

        const geoPos = cityData.position;
        const population = gameCity?.population ?? cityData.population;
        const destroyed = gameCity?.destroyed ?? false;

        // NOTE: Enemy cities are always visible for targeting purposes.
        // Fog-of-war applies to missiles, interceptors, and other dynamic objects,
        // but strategic targets (cities) remain visible on the map.

        existingIds.delete(cityKey);

        const pos3d = geoToSphere(geoPos, GLOBE_RADIUS + 0.5);
        let color: number;
        if (destroyed) {
          color = COLORS.cityDestroyed;
        } else if (isMine) {
          color = COLORS.friendly;
        } else if (isEnemy) {
          color = COLORS.enemy;
        } else {
          color = COLORS.neutral; // Gray for unowned cities
        }

        let group = this.cityMarkers.get(cityKey);

        if (!group) {
          group = new THREE.Group();
          group.userData = {
            type: 'city',
            id: cityKey,
            name: cityData.name,
            population: population,
            territoryId: territoryId,
          };

          // Create smaller city marker (dot)
          const size = Math.max(0.4, Math.sqrt(population / 1000000) * 0.25);
          const geometry = new THREE.SphereGeometry(size, 8, 8);
          const material = new THREE.MeshBasicMaterial({ color });
          const marker = new THREE.Mesh(geometry, material);
          marker.name = 'marker';
          group.add(marker);

          // Create text label
          const label = this.createTextSprite(cityData.name, color);
          label.name = 'label';
          label.position.set(0, size + 1.5, 0); // Position above the marker
          group.add(label);

          this.cityGroup.add(group);
          this.cityMarkers.set(cityKey, group);
        }

        // Update population in userData
        group.userData.population = population;

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

      // Check fog of war - hide enemy buildings outside radar coverage (unless fog of war is disabled)
      if (!isMine && !this.fogOfWarDisabled && !this.isWithinRadarCoverage(geoPos)) {
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

      // Track positions for explosion when missile is removed
      // Physics missiles may have undefined legacy position fields - use geo fields or defaults
      const targetGeo = missile.geoTargetPosition
        || (missile.targetPosition ? this.pixelToGeoFallback(missile.targetPosition) : { lat: 0, lng: 0 });
      this.missileTargets.set(missile.id, targetGeo);

      const isMine = missile.ownerId === this.playerId;
      const currentGeo = missile.geoCurrentPosition
        || (missile.currentPosition ? this.pixelToGeoFallback(missile.currentPosition) : { lat: 0, lng: 0 });
      const startGeo = missile.geoLaunchPosition
        || (missile.launchPosition ? this.pixelToGeoFallback(missile.launchPosition) : { lat: 0, lng: 0 });

      // Always track last known position and intercepted status
      this.missileLastPositions.set(missile.id, currentGeo);
      if (missile.intercepted) {
        this.missileWasIntercepted.set(missile.id, true);
      }

      if (missile.detonated || missile.intercepted) {
        // Detonated = at target, Intercepted = at current position (interception point)
        const explosionGeo = missile.intercepted ? currentGeo : targetGeo;

        // Show explosion effect (only once per missile)
        if (!this.shownExplosions.has(missile.id)) {
          this.showExplosionAt(explosionGeo);
          this.shownExplosions.add(missile.id);
        }

        // Move missile to fading state instead of immediate removal
        const objects = this.missileObjects.get(missile.id);
        if (objects) {
          // Get impact position in 3D
          const impactPos3d = geoToSphere(explosionGeo, GLOBE_RADIUS + 2);
          const impactVec = new THREE.Vector3(impactPos3d.x, impactPos3d.y, impactPos3d.z);

          // Extract current trail points
          const trailGeom = objects.trail.geometry;
          const posAttr = trailGeom.getAttribute('position');
          const trailPoints: THREE.Vector3[] = [];
          if (posAttr) {
            for (let i = 0; i < posAttr.count; i++) {
              trailPoints.push(new THREE.Vector3(
                posAttr.getX(i),
                posAttr.getY(i),
                posAttr.getZ(i)
              ));
            }
          }

          // Add to fading missiles (no separate explosion sphere - showExplosionAt handles the effect)
          this.fadingMissiles.set(missile.id, {
            objects: {
              trail: objects.trail,
              head: objects.head,
            },
            impactPosition: impactVec,
            trailPoints: trailPoints,
            fadeStartTime: Date.now(),
            fadeDuration: 2000, // 2 seconds fade
          });

          // Remove planned route if exists
          if (objects.plannedRoute) {
            this.missileGroup.remove(objects.plannedRoute);
            objects.plannedRoute.geometry.dispose();
            (objects.plannedRoute.material as THREE.Material).dispose();
          }

          // Remove from active missiles (but keep objects in scene for fading)
          this.missileObjects.delete(missile.id);
        }

        // Clean up tracking
        this.missileInterpolation.delete(missile.id);
        this.physicsMissileInterpolation.delete(missile.id);
        this.missileTargets.delete(missile.id);
        this.missileLastPositions.delete(missile.id);
        this.missileWasIntercepted.delete(missile.id);
        continue;
      }

      // Check fog of war - hide enemy missiles outside radar coverage (unless fog of war is disabled)
      // Calculate missile altitude for horizon-limited radar detection
      // Use defaults for physics missiles where progress/flightDuration might be undefined
      const missileProgress = missile.progress ?? 0;
      const missileFlightDuration = missile.flightDuration ?? 30000;
      const missileAltitudeKm = this.calculateMissileAltitudeKm(startGeo, targetGeo, missileProgress, missileFlightDuration);

      // Get detailed detection info for uncertainty effects
      const detectionInfo = this.getRadarDetectionInfo(currentGeo, missileAltitudeKm);

      // Track uncertain contacts and apply glitch effects for enemy missiles
      let uncertainContact = this.uncertainContacts.get(missile.id);
      let displayConfidence = 1.0;
      let shouldFlicker = false;
      let classification: 'unknown' | 'anomaly' | 'probable' | 'confirmed' = 'confirmed';

      if (!isMine && !this.fogOfWarDisabled) {
        if (!detectionInfo.detected) {
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
          this.physicsMissileInterpolation.delete(missile.id);
          this.uncertainContacts.delete(missile.id);
          continue;
        }

        // Apply detection uncertainty for enemy missiles
        displayConfidence = detectionInfo.confidence;

        // Initialize or update uncertain contact tracking
        if (!uncertainContact) {
          // Generate persistent noise for this contact
          const noiseScale = 3.0; // degrees of position uncertainty at low confidence
          uncertainContact = {
            confidence: displayConfidence,
            classification: 'unknown',
            jitteredPosition: currentGeo,
            lastFlickerTime: now,
            flickerState: true,
            firstDetectedTime: now,
            positionNoise: {
              lat: (Math.random() - 0.5) * 2 * noiseScale,
              lng: (Math.random() - 0.5) * 2 * noiseScale,
            },
          };
          this.uncertainContacts.set(missile.id, uncertainContact);
        }

        // Update confidence with some smoothing
        uncertainContact.confidence = uncertainContact.confidence * 0.9 + displayConfidence * 0.1;
        displayConfidence = uncertainContact.confidence;

        // Determine classification based on confidence and time tracked
        const timeTracked = now - uncertainContact.firstDetectedTime;
        if (displayConfidence >= 0.9 || timeTracked > 8000) {
          classification = 'confirmed';
        } else if (displayConfidence >= 0.7 || timeTracked > 4000) {
          classification = 'probable';
        } else if (displayConfidence >= 0.4 || timeTracked > 1500) {
          classification = 'anomaly';
        } else {
          classification = 'unknown';
        }
        uncertainContact.classification = classification;

        // Flickering effect at low confidence
        // The lower the confidence, the more frequent and longer the flicker
        if (displayConfidence < 0.85) {
          const flickerInterval = 100 + (1 - displayConfidence) * 400; // 100-500ms between flickers
          const flickerDuration = 50 + (1 - displayConfidence) * 150;  // 50-200ms flicker off time

          if (now - uncertainContact.lastFlickerTime > flickerInterval) {
            uncertainContact.flickerState = false;
            uncertainContact.lastFlickerTime = now;
          }
          if (!uncertainContact.flickerState && now - uncertainContact.lastFlickerTime > flickerDuration) {
            uncertainContact.flickerState = true;
          }
          shouldFlicker = !uncertainContact.flickerState;
        } else {
          uncertainContact.flickerState = true;
        }
      }

      // Skip rendering this frame if flickering off
      if (shouldFlicker && displayConfidence < 0.5) {
        // At very low confidence, actually hide the missile during flicker
        const existingObjects = this.missileObjects.get(missile.id);
        if (existingObjects) {
          existingObjects.head.visible = false;
          existingObjects.trail.visible = false;
        }
        continue;
      }

      existingIds.delete(missile.id);

      // Color based on ownership: player = blue, enemy = red, interceptors = cyan
      // Apply uncertainty tint for unclear contacts
      const isInterceptor = isInterceptorType(missile);
      let color: number;
      if (isInterceptor) {
        color = COLORS.interceptor; // Cyan
      } else if (isMine) {
        color = 0x2266ff; // Blue for player
      } else {
        // Enemy missile color varies by classification
        if (classification === 'confirmed') {
          color = COLORS.missile; // Red for confirmed enemy
        } else if (classification === 'probable') {
          color = 0xff6600; // Orange for probable
        } else if (classification === 'anomaly') {
          color = 0xffaa00; // Yellow-orange for anomaly
        } else {
          color = 0xffff00; // Yellow for unknown
        }
      }

      // Client-side interpolation for smooth movement
      // Use defaults for physics missiles that may have undefined progress/flightDuration
      let interpolatedProgress = missileProgress;
      let interpState = this.missileInterpolation.get(missile.id);

      // Skip interpolation for physics missiles - they use server position directly
      if (!isPhysicsMissile(missile)) {
        if (!interpState) {
          // New missile - initialize interpolation state
          // Guard against division by zero if flight duration is 0
          const flightDurationSec = Math.max(1, missileFlightDuration / 1000);
          interpState = {
            lastProgress: missileProgress,
            lastUpdateTime: now,
            targetProgress: missileProgress,
            estimatedSpeed: 1 / flightDurationSec, // Progress per second
          };
          this.missileInterpolation.set(missile.id, interpState);
        } else {
          // Check if server sent a new progress value
          if (Math.abs(missileProgress - interpState.targetProgress) > 0.0001) {
            // New server update received - update interpolation target
            const timeSinceLastUpdate = (now - interpState.lastUpdateTime) / 1000;
            if (timeSinceLastUpdate > 0.01) {
              // Estimate speed from the delta
              const progressDelta = missileProgress - interpState.targetProgress;
              interpState.estimatedSpeed = Math.max(progressDelta / timeSinceLastUpdate, 0.001);
            }
            interpState.lastProgress = interpState.targetProgress;
            interpState.targetProgress = missileProgress;
            interpState.lastUpdateTime = now;
          }

          // Smoothly interpolate towards target progress
          const timeSinceUpdate = (now - interpState.lastUpdateTime) / 1000;
          const predictedProgress = interpState.targetProgress + interpState.estimatedSpeed * timeSinceUpdate;

          // Blend between last known and predicted, capped at target + small buffer
          interpolatedProgress = Math.min(predictedProgress, interpState.targetProgress + 0.02);
          interpolatedProgress = Math.max(interpolatedProgress, interpState.targetProgress);

          // Cap at 1.0 for normal missiles, but allow up to 1.5 for missed interceptors
          // Allow extended progress for missed interceptors
          const isMissed = isRailInterceptor(missile)
            ? (missile as RailInterceptor).status === 'missed'
            : (missile as any).missedTarget;
          const maxProgress = (isInterceptor && isMissed) ? 1.5 : 1.0;
          interpolatedProgress = Math.min(interpolatedProgress, maxProgress);
        }
      }

      // startGeo and targetGeo already defined above

      let objects = this.missileObjects.get(missile.id);

      // Calculate max altitude based on distance (only once per missile)
      // Interceptors fly at lower altitude than ICBMs
      let maxAltitude: number;
      let seed: number;
      if (!objects) {
        // ICBMs: Use server-provided apexHeight
        if (!isInterceptor && 'apexHeight' in missile && typeof missile.apexHeight === 'number') {
          maxAltitude = Math.min(missile.apexHeight, 60);
        } else if (isInterceptor) {
          // Interceptors: 40% of calculated altitude
          const baseAltitude = calculateMissileAltitude(startGeo, targetGeo);
          maxAltitude = baseAltitude * 0.4;
        } else {
          // Fallback for legacy missiles without apexHeight
          maxAltitude = calculateMissileAltitude(startGeo, targetGeo);
        }
        // Generate deterministic seed from missile ID
        seed = this.hashStringToNumber(missile.id);

        // Create traveled trail - shows where missile has been
        // Interceptor trails are thinner and use historical tracking
        let trailPoints: THREE.Vector3[];
        if (isInterceptor) {
          // Start with just the launch position - will be filled in each frame
          const launchPos = geoToSphere(startGeo, GLOBE_RADIUS);
          trailPoints = [new THREE.Vector3(launchPos.x, launchPos.y, launchPos.z)];
        } else {
          trailPoints = this.calculateTraveledTrailSmooth(startGeo, targetGeo, interpolatedProgress, maxAltitude, missileFlightDuration, seed);
        }
        const trailGeom = new THREE.BufferGeometry().setFromPoints(trailPoints);
        const trailMat = new THREE.LineBasicMaterial({
          color: color,
          transparent: true,
          opacity: isInterceptor ? 0.25 : 0.35,
        });
        const trail = new THREE.Line(trailGeom, trailMat);

        // Create missile head (smaller for interceptors, colored by ownership)
        const head = this.createICBMHead(isInterceptor, isMine);

        this.missileGroup.add(trail);
        this.missileGroup.add(head);

        // Create planned route line for player's missiles (light gray full path)
        // For interceptors, skip planned route since target changes dynamically
        let plannedRoute: THREE.Line | undefined;
        if (isMine && !isInterceptor) {
          const routePoints = this.calculateFullRoutePath(startGeo, targetGeo, maxAltitude, missileFlightDuration, seed);
          const routeGeom = new THREE.BufferGeometry().setFromPoints(routePoints);
          const routeMat = new THREE.LineBasicMaterial({
            color: 0x888888,  // Light gray
            transparent: true,
            opacity: 0.2,
            linewidth: 1,
          });
          plannedRoute = new THREE.Line(routeGeom, routeMat);
          this.missileGroup.add(plannedRoute);
        }

        // For interceptors, initialize trail history with launch position
        const interceptorTrailHistory = isInterceptor ? [new THREE.Vector3(
          geoToSphere(startGeo, GLOBE_RADIUS).x,
          geoToSphere(startGeo, GLOBE_RADIUS).y,
          geoToSphere(startGeo, GLOBE_RADIUS).z
        )] : undefined;

        // Get targetId from the appropriate field based on missile type
        const targetMissileId = isRailInterceptor(missile)
          ? (missile as RailInterceptor).targetId
          : (missile as any).targetId;
        objects = { trail, head, maxAltitude, flightDuration: missileFlightDuration, seed, plannedRoute, isInterceptor, targetMissileId, interceptorTrailHistory, lastTrailProgress: 0 };
        this.missileObjects.set(missile.id, objects);
      } else {
        maxAltitude = objects.maxAltitude;
        seed = objects.seed;

        // Update trail color for existing missiles (for classification changes)
        if (!isMine && !isInterceptor) {
          const trailMat = objects.trail.material as THREE.LineBasicMaterial;
          trailMat.color.setHex(color);
        }
      }

      // Get 3D position
      // Physics missiles (new interceptors) use position from server directly
      // Legacy missiles use curve-based calculation
      let pos3d: { x: number; y: number; z: number };

      // Calculate flameout progress for legacy interceptors (when fuel runs out)
      // For physics missiles and rail interceptors, we don't use this (they handle fuel differently)
      const flameoutProgress = isInterceptor && !isPhysicsMissile(missile) && !isRailInterceptor(missile)
        ? this.calculateFlameoutProgress(missile as Missile)
        : 1.0;

      if (isGuidedInterceptor(missile)) {
        // Guided interceptor: use position from server (continuously updated)
        const guidedMissile = missile as GuidedInterceptor;
        const altitude = guidedMissile.altitude || guidedMissile.currentAltitude || 0;
        const geoPos = guidedMissile.geoPosition || guidedMissile.geoCurrentPosition;
        if (geoPos) {
          const groundPos = geoToSphere(geoPos, GLOBE_RADIUS + altitude);
          pos3d = { x: groundPos.x, y: groundPos.y, z: groundPos.z };
        } else {
          // Fallback to launch position
          pos3d = geoToSphere(startGeo, GLOBE_RADIUS);
        }
      } else if (isRailInterceptor(missile)) {
        // Rail-based interceptor: use pre-calculated rail path
        const railMissile = missile as RailInterceptor;
        if (railMissile.status === 'missed' && railMissile.missBehavior) {
          // Missed interceptor: interpolate from miss point to crash point
          const elapsed = now - railMissile.missBehavior.missStartTime;
          const coastProgress = Math.min(1, elapsed / railMissile.missBehavior.duration);
          const missGeo = geoInterpolate(
            railMissile.rail.startGeo,
            railMissile.rail.endGeo,
            railMissile.missBehavior.missStartProgress
          );
          const currentGeo = geoInterpolate(
            missGeo,
            railMissile.missBehavior.endGeo,
            coastProgress
          );
          // Altitude decreases during coast
          const startAltitude = railMissile.currentAltitude || railMissile.rail.endAltitude;
          const altitude = startAltitude * (1 - coastProgress) * (1 - coastProgress);
          const groundPos = geoToSphere(currentGeo, GLOBE_RADIUS + altitude);
          pos3d = { x: groundPos.x, y: groundPos.y, z: groundPos.z };
        } else {
          // Active interceptor: follow rail path
          pos3d = getInterceptorPosition3D(
            railMissile.rail.startGeo,
            railMissile.rail.endGeo,
            interpolatedProgress,
            railMissile.rail.apexHeight,
            railMissile.rail.endAltitude,
            GLOBE_RADIUS
          );
        }
      } else if (isPhysicsMissile(missile)) {
        // Physics-based interceptor: use interpolated position for smooth movement
        pos3d = this.getInterpolatedPhysicsPosition(missile, now);
      } else if (isInterceptor && (missile as any).targetId) {
        // Legacy interceptor: use trajectory calculation
        const legacyMissile = missile as Missile;
        const boostEnd = legacyMissile.boostEndProgress ?? 0.25;
        pos3d = this.getInterceptorPositionTowardTarget(
          startGeo,
          interpolatedProgress,
          legacyMissile.targetId!,
          boostEnd,
          legacyMissile.flightPhase,
          legacyMissile.missedTarget,
          legacyMissile.missDirection,
          flameoutProgress
        );
      } else {
        // ICBM: use standard ballistic trajectory
        pos3d = getMissilePosition3D(startGeo, targetGeo, interpolatedProgress, maxAltitude, GLOBE_RADIUS, objects.flightDuration, seed);
      }

      // Check for ground impact on missed interceptors
      const isMissedInterceptor = isInterceptor && (
        isRailInterceptor(missile)
          ? (missile as RailInterceptor).status === 'missed'
          : isGuidedInterceptor(missile)
            ? (missile as GuidedInterceptor).status === 'missed' || (missile as GuidedInterceptor).status === 'crashed'
            : (missile as any).missedTarget
      );
      if (isMissedInterceptor && missileProgress > 1) {
        const altitude = Math.sqrt(pos3d.x * pos3d.x + pos3d.y * pos3d.y + pos3d.z * pos3d.z) - GLOBE_RADIUS;
        if (altitude <= 0.5 && !this.groundImpactMissiles.has(missile.id)) {
          // Ground impact! Create small explosion (only once per missile)
          this.createGroundImpactExplosion(pos3d);
          this.groundImpactMissiles.add(missile.id);
        }
      }

      // Update ICBM position and orientation (no jitter - show actual position)
      objects.head.position.set(pos3d.x, pos3d.y, pos3d.z);

      // For uncertain contacts, apply subtle opacity-based uncertainty (no wobble)
      if (uncertainContact && displayConfidence < 0.9 && !isMine) {
        // Simple opacity based on confidence - no scale or position wobble
        const finalOpacity = 0.5 + displayConfidence * 0.5; // 0.5-1.0 based on confidence

        objects.head.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const mat = child.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
            if (mat.transparent !== undefined) {
              mat.transparent = true;
              mat.opacity = finalOpacity;
            }
          }
        });

        const trailMat = objects.trail.material as THREE.LineBasicMaterial;
        trailMat.opacity = finalOpacity * 0.35;

        objects.head.visible = true;
        objects.trail.visible = true;
      } else if (!isMine && objects.head) {
        // Full opacity for confirmed contacts
        objects.head.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const mat = child.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
            if (mat.transparent !== undefined) {
              mat.opacity = 1.0;
            }
          }
        });
        const trailMat = objects.trail.material as THREE.LineBasicMaterial;
        trailMat.opacity = 0.35;
        objects.head.visible = true;
        objects.trail.visible = true;
      }

      // Apply fade effect for coasting physics missiles approaching timeout
      if (isPhysicsMissile(missile) && missile.engineFlameout && missile.flameoutTime) {
        const coastTimeout = 15 / GLOBAL_MISSILE_SPEED_MULTIPLIER; // Matches server's scaled coastTimeout
        const coastTime = (now - missile.flameoutTime) / 1000;
        // Start fading 5 seconds before despawn
        const fadeStartTime = coastTimeout - 5;
        if (coastTime > fadeStartTime) {
          const fadeProgress = (coastTime - fadeStartTime) / 5; // 0 to 1 over 5 seconds
          const fadeOpacity = Math.max(0.1, 1 - fadeProgress * 0.9); // Fade from 1.0 to 0.1

          objects.head.traverse((child) => {
            if (child instanceof THREE.Mesh && child.material) {
              const mat = child.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
              if (mat.transparent !== undefined) {
                mat.transparent = true;
                mat.opacity = fadeOpacity;
              }
            }
          });

          const trailMat = objects.trail.material as THREE.LineBasicMaterial;
          trailMat.opacity = fadeOpacity * 0.35;
        }
      }

      // Orient missile along flight path (direction of movement)
      let lookTarget: THREE.Vector3 | null = null;

      if (isGuidedInterceptor(missile)) {
        // Guided interceptor: orient along heading and climb angle
        const guidedMissile = missile as GuidedInterceptor;
        const headingRad = guidedMissile.heading * (Math.PI / 180);
        const climbRad = guidedMissile.climbAngle * (Math.PI / 180);

        // Calculate forward direction based on heading and climb
        const cosClimb = Math.cos(climbRad);
        const sinClimb = Math.sin(climbRad);
        const cosHead = Math.cos(headingRad);
        const sinHead = Math.sin(headingRad);

        // Get up vector at current position (radially outward)
        const up = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();

        // North direction (tangent pointing toward north pole)
        const north = new THREE.Vector3(0, 1, 0);
        const east = new THREE.Vector3().crossVectors(north, up).normalize();
        const northTangent = new THREE.Vector3().crossVectors(up, east).normalize();

        // Forward direction based on heading
        const forward = new THREE.Vector3()
          .addScaledVector(northTangent, cosHead * cosClimb)
          .addScaledVector(east, sinHead * cosClimb)
          .addScaledVector(up, sinClimb)
          .normalize();

        lookTarget = new THREE.Vector3(
          pos3d.x + forward.x * 10,
          pos3d.y + forward.y * 10,
          pos3d.z + forward.z * 10
        );
      } else if (isRailInterceptor(missile)) {
        // Rail interceptor: calculate direction from rail path
        const railMissile = missile as RailInterceptor;
        if (railMissile.status === 'missed' && railMissile.missBehavior) {
          // Missed: point toward crash location
          const crashPos = geoToSphere(railMissile.missBehavior.endGeo, GLOBE_RADIUS);
          lookTarget = new THREE.Vector3(crashPos.x, crashPos.y, crashPos.z);
        } else {
          // Active: use rail direction
          const direction = getInterceptorDirection3D(
            railMissile.rail.startGeo,
            railMissile.rail.endGeo,
            interpolatedProgress,
            railMissile.rail.apexHeight,
            railMissile.rail.endAltitude,
            GLOBE_RADIUS
          );
          lookTarget = new THREE.Vector3(
            pos3d.x + direction.x,
            pos3d.y + direction.y,
            pos3d.z + direction.z
          );
        }
      } else if (isPhysicsMissile(missile)) {
        // Physics missile: orient along velocity vector (or heading if velocity is zero)
        const vel = missile.velocity;
        const velMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        if (velMag > 0.01) {
          // Point along velocity direction
          lookTarget = new THREE.Vector3(
            pos3d.x + vel.x,
            pos3d.y + vel.y,
            pos3d.z + vel.z
          );
        } else {
          // No velocity yet - use heading
          const hdg = missile.heading;
          lookTarget = new THREE.Vector3(
            pos3d.x + hdg.x,
            pos3d.y + hdg.y,
            pos3d.z + hdg.z
          );
        }
      } else if (isInterceptor && (missile as any).targetId && this.gameState) {
        // Legacy interceptor: calculate orientation from trajectory
        const legacyMissile = missile as Missile;
        const pastFlameout = interpolatedProgress > flameoutProgress;

        if (pastFlameout || legacyMissile.missedTarget) {
          // After flameout or miss: point along direction of travel (coasting)
          const aheadProgress = Math.min(interpolatedProgress + 0.02, 1.5);
          const boostEnd = legacyMissile.boostEndProgress ?? 0.25;
          const aheadPos = this.getInterceptorPositionTowardTarget(
            startGeo, aheadProgress, legacyMissile.targetId!, boostEnd,
            legacyMissile.flightPhase, legacyMissile.missedTarget, legacyMissile.missDirection, flameoutProgress
          );
          lookTarget = new THREE.Vector3(aheadPos.x, aheadPos.y, aheadPos.z);
        } else {
          // Still tracking: point toward predicted intercept point
          const targetIcbm = this.gameState.missiles[legacyMissile.targetId!];
          if (targetIcbm && targetIcbm.geoLaunchPosition && targetIcbm.geoTargetPosition && !isPhysicsMissile(targetIcbm)) {
            const interceptorRemaining = 1 - interpolatedProgress;
            const leadFactor = 0.5;
            const predictedIcbmProgress = Math.min(1, (targetIcbm.progress || 0) + interceptorRemaining * leadFactor);

            const icbmStartGeo = targetIcbm.geoLaunchPosition;
            const icbmEndGeo = targetIcbm.geoTargetPosition;
            const icbmAltitude = (targetIcbm as any).apexHeight ?? calculateMissileAltitude(icbmStartGeo, icbmEndGeo);
            const icbmObjects = this.missileObjects.get(legacyMissile.targetId!);
            const icbmSeed = icbmObjects?.seed || 0;
            const icbmFlightDuration = icbmObjects?.flightDuration || 30000;

            const predictedPos = getMissilePosition3D(
              icbmStartGeo, icbmEndGeo, predictedIcbmProgress,
              icbmAltitude, GLOBE_RADIUS, icbmFlightDuration, icbmSeed
            );

            lookTarget = new THREE.Vector3(predictedPos.x, predictedPos.y, predictedPos.z);
          }
        }
      } else {
        // ICBM: use the standard direction calculation
        const direction = getMissileDirection3D(startGeo, targetGeo, interpolatedProgress, maxAltitude, GLOBE_RADIUS, objects.flightDuration, seed);
        const dirVec = new THREE.Vector3(direction.x, direction.y, direction.z);
        lookTarget = new THREE.Vector3(pos3d.x + dirVec.x, pos3d.y + dirVec.y, pos3d.z + dirVec.z);
      }

      // Apply orientation with smooth interpolation
      if (lookTarget) {
        // Calculate target quaternion by using lookAt on a temp object
        const tempObj = new THREE.Object3D();
        tempObj.position.copy(objects.head.position);
        tempObj.lookAt(lookTarget);
        const targetQuat = tempObj.quaternion.clone();

        // Initialize target quaternion if not set
        if (!objects.targetQuaternion) {
          objects.targetQuaternion = targetQuat.clone();
          objects.head.quaternion.copy(targetQuat);
        } else {
          // Update target quaternion
          objects.targetQuaternion.copy(targetQuat);
          // Smoothly interpolate current orientation toward target (slerp)
          // Use higher factor (0.3) for faster response while still being smooth
          objects.head.quaternion.slerp(objects.targetQuaternion, 0.3);
        }
      }

      // Update exhaust visibility based on flight phase (engine cuts out in space)
      this.updateMissileExhaust(objects.head, interpolatedProgress, isInterceptor, missile);

      // For interceptors, record actual path taken (add points periodically)
      if (isInterceptor && objects.interceptorTrailHistory) {
        const progressStep = 0.02; // Add a point every 2% progress
        if (interpolatedProgress - (objects.lastTrailProgress || 0) >= progressStep) {
          objects.interceptorTrailHistory.push(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z));
          objects.lastTrailProgress = interpolatedProgress;
        }
      }

      // Track phase transitions for SpaceX-style stage markers (physics missiles)
      if (isPhysicsMissile(missile)) {
        const currentPhase = missile.phase;
        const prevPhase = this.interceptorPhases.get(missile.id);

        // Add launch marker on first update
        if (!prevPhase && currentPhase === 'boost') {
          const launchPos = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z);
          this.addStageMarker(missile.id, launchPos, 'LNC', 0x00ffff);
        }

        // Track phase transitions
        if (prevPhase && prevPhase !== currentPhase) {
          const phaseInfo = this.getPhaseMarkerInfo(currentPhase);
          if (phaseInfo) {
            const markerPos = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z);
            this.addStageMarker(missile.id, markerPos, phaseInfo.label, phaseInfo.color);
          }
        }

        // Add MECO marker when engine flames out
        if (missile.engineFlameout && prevPhase && !this.stageMarkers.get(missile.id)?.some(m => m.userData?.label === 'MECO')) {
          const flameoutPos = missile.flameoutPosition;
          if (flameoutPos) {
            const mecoPos = new THREE.Vector3(flameoutPos.x, flameoutPos.y, flameoutPos.z);
            const marker = this.createStageMarker(mecoPos, 'MECO', 0xff8800);
            marker.userData = { label: 'MECO' };
            if (!this.stageMarkers.has(missile.id)) {
              this.stageMarkers.set(missile.id, []);
            }
            this.stageMarkers.get(missile.id)!.push(marker);
            this.missileGroup.add(marker);
          }
        }

        this.interceptorPhases.set(missile.id, currentPhase);
      }

      // Add ICBM milestone markers (launch, BECO, apogee, re-entry)
      if (!isInterceptor) {
        const markerSet = this.icbmMarkerProgress.get(missile.id) || new Set<string>();

        // Launch marker - add on first frame we see this missile
        if (!markerSet.has('LNC')) {
          const launchPos = geoToSphere(startGeo, GLOBE_RADIUS + 1);
          const launchVec = new THREE.Vector3(launchPos.x, launchPos.y, launchPos.z);
          this.addStageMarker(missile.id, launchVec, 'LNC', 0xcc2200);
          markerSet.add('LNC');
        }

        // BECO (Booster Engine Cutoff) marker at 20% progress when boost phase ends
        // This matches updateMissileExhaust which turns engine off at progress > 0.20
        if (!markerSet.has('BECO') && interpolatedProgress >= 0.20) {
          const becoPos = getMissilePosition3D(startGeo, targetGeo, 0.20, maxAltitude, GLOBE_RADIUS, objects.flightDuration, seed);
          const becoVec = new THREE.Vector3(becoPos.x, becoPos.y, becoPos.z);
          this.addStageMarker(missile.id, becoVec, 'BECO', 0xff8800);
          markerSet.add('BECO');
        }

        // Apogee marker when we pass 50% progress (peak altitude)
        if (!markerSet.has('APO') && interpolatedProgress >= 0.50) {
          const apogeePos = getMissilePosition3D(startGeo, targetGeo, 0.50, maxAltitude, GLOBE_RADIUS, objects.flightDuration, seed);
          const apogeeVec = new THREE.Vector3(apogeePos.x, apogeePos.y, apogeePos.z);
          this.addStageMarker(missile.id, apogeeVec, 'APO', 0xffaa00);
          markerSet.add('APO');
        }

        // Re-entry marker when we pass 85% progress (engine reignites for terminal phase)
        // This matches updateMissileExhaust which turns engine back on at progress > 0.85
        if (!markerSet.has('RNT') && interpolatedProgress >= 0.85) {
          const reentryPos = getMissilePosition3D(startGeo, targetGeo, 0.85, maxAltitude, GLOBE_RADIUS, objects.flightDuration, seed);
          const reentryVec = new THREE.Vector3(reentryPos.x, reentryPos.y, reentryPos.z);
          this.addStageMarker(missile.id, reentryVec, 'RNT', 0xff4444);
          markerSet.add('RNT');
        }

        this.icbmMarkerProgress.set(missile.id, markerSet);
      }

      // Track radar coverage loss (LOS marker)
      const missileGeo = missile.geoCurrentPosition || missile.currentPosition
        ? sphereToGeo(pos3d, GLOBE_RADIUS)
        : startGeo;
      const wasInRadar = this.missileRadarStatus.get(missile.id);
      const isInRadar = this.isMissileInRadarCoverage(missileGeo);

      // Only track for enemy missiles (we always see our own)
      if (missile.ownerId !== this.playerId) {
        if (wasInRadar === true && !isInRadar) {
          // Lost radar tracking - add LOS marker
          const losPos = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z);
          this.addStageMarker(missile.id, losPos, 'LOS', 0xff0000);
        }
        this.missileRadarStatus.set(missile.id, isInRadar);
      }

      // Update traveled trail with linear progress
      let trailPoints: THREE.Vector3[];
      if (isInterceptor && objects.interceptorTrailHistory) {
        // Use the stored trail history for interceptors
        trailPoints = [...objects.interceptorTrailHistory];
        // Add current position as the last point
        trailPoints.push(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z));
      } else {
        trailPoints = this.calculateTraveledTrailSmooth(startGeo, targetGeo, interpolatedProgress, maxAltitude, objects.flightDuration, seed);
      }
      const trailGeom = objects.trail.geometry;
      const existingAttr = trailGeom.getAttribute('position') as THREE.BufferAttribute | undefined;

      // Reuse existing buffer if it's large enough, otherwise create a new one
      if (existingAttr && existingAttr.array.length >= trailPoints.length * 3) {
        const positions = existingAttr.array as Float32Array;
        for (let i = 0; i < trailPoints.length; i++) {
          positions[i * 3] = trailPoints[i].x;
          positions[i * 3 + 1] = trailPoints[i].y;
          positions[i * 3 + 2] = trailPoints[i].z;
        }
        existingAttr.needsUpdate = true;
        trailGeom.setDrawRange(0, trailPoints.length);
      } else {
        // Need a larger buffer - create new one
        const positions = new Float32Array(trailPoints.length * 3);
        for (let i = 0; i < trailPoints.length; i++) {
          positions[i * 3] = trailPoints[i].x;
          positions[i * 3 + 1] = trailPoints[i].y;
          positions[i * 3 + 2] = trailPoints[i].z;
        }
        trailGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      }
    }

    // Remove missiles that are no longer in game state
    // Instead of instant removal, move them to fading state
    for (const id of existingIds) {
      const objects = this.missileObjects.get(id);
      if (objects) {
        // Get last known position for impact point
        const lastPos = this.missileLastPositions.get(id);
        const targetPos = this.missileTargets.get(id);
        const impactGeo = lastPos || targetPos;

        if (impactGeo) {
          // Extract current trail points
          const trailGeom = objects.trail.geometry;
          const posAttr = trailGeom.getAttribute('position');
          const trailPoints: THREE.Vector3[] = [];
          if (posAttr) {
            for (let i = 0; i < posAttr.count; i++) {
              trailPoints.push(new THREE.Vector3(
                posAttr.getX(i),
                posAttr.getY(i),
                posAttr.getZ(i)
              ));
            }
          }

          // Get impact position in 3D
          const impactPos3d = geoToSphere(impactGeo, GLOBE_RADIUS + 2);
          const impactVec = new THREE.Vector3(impactPos3d.x, impactPos3d.y, impactPos3d.z);

          // Add to fading missiles
          this.fadingMissiles.set(id, {
            objects: {
              trail: objects.trail,
              head: objects.head,
            },
            impactPosition: impactVec,
            trailPoints: trailPoints,
            fadeStartTime: Date.now(),
            fadeDuration: 2000,
          });

          // Remove planned route if exists
          if (objects.plannedRoute) {
            this.missileGroup.remove(objects.plannedRoute);
            objects.plannedRoute.geometry.dispose();
            (objects.plannedRoute.material as THREE.Material).dispose();
          }

          // Remove from active missiles (but keep in scene for fading)
          this.missileObjects.delete(id);
        } else {
          // No position info, just remove immediately
          this.missileGroup.remove(objects.trail);
          this.missileGroup.remove(objects.head);
          if (objects.plannedRoute) {
            this.missileGroup.remove(objects.plannedRoute);
          }
          this.disposeMissileObjects(objects);
          this.missileObjects.delete(id);
        }
      }

      // Clean up tracking maps
      this.missileTargets.delete(id);
      this.missileLastPositions.delete(id);
      this.missileWasIntercepted.delete(id);
      this.missileInterpolation.delete(id);
      this.physicsMissileInterpolation.delete(id);
      this.uncertainContacts.delete(id);
      this.shownExplosions.delete(id);
      this.groundImpactMissiles.delete(id);

      // Note: Stage markers cleaned up when fading missile is fully disposed
      // If not going through fading state, clean up immediately
      if (!this.fadingMissiles.has(id)) {
        this.disposeStageMarkers(id);
      }
    }
  }

  private createICBMHead(isInterceptor: boolean, isMine: boolean): THREE.Group {
    const group = new THREE.Group();

    // Visual scale
    const scale = isInterceptor ? 0.156 : 0.3125;

    // Invisible hitbox for easier clicking (keeps original clickable area)
    const hitboxSize = isInterceptor ? 4 : 6;
    const hitboxGeom = new THREE.SphereGeometry(hitboxSize, 8, 8);
    const hitboxMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,  // Prevents rendering while keeping raycasting
    });
    const hitbox = new THREE.Mesh(hitboxGeom, hitboxMat);
    hitbox.renderOrder = -1;  // Render first (behind everything)
    group.add(hitbox);

    // Colors based on ownership: player = blue, enemy = red
    // Interceptors are always cyan (defensive)
    let primaryColor: number;
    let secondaryColor: number;
    let exhaustColor: number;
    let glowColor: number;

    if (isInterceptor) {
      // Interceptors are cyan
      primaryColor = 0x00ddff;
      secondaryColor = 0x006688;
      exhaustColor = 0x00ffff;
      glowColor = 0x0088aa;
    } else if (isMine) {
      // Player ICBMs are blue
      primaryColor = 0x2266ff;
      secondaryColor = 0x113388;
      exhaustColor = 0x4488ff;
      glowColor = 0x2244aa;
    } else {
      // Enemy ICBMs are red
      primaryColor = 0xcc2200;
      secondaryColor = 0x881100;
      exhaustColor = 0xff6600;
      glowColor = 0xff4400;
    }

    // Nose cone (pointed tip)
    const noseGeom = new THREE.ConeGeometry(0.8 * scale, 3 * scale, 8);
    const noseMat = new THREE.MeshBasicMaterial({ color: primaryColor });
    const nose = new THREE.Mesh(noseGeom, noseMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 4 * scale;
    group.add(nose);

    // Main body (cylinder)
    const bodyGeom = new THREE.CylinderGeometry(0.8 * scale, 1.0 * scale, 5 * scale, 8);
    const bodyMat = new THREE.MeshBasicMaterial({ color: secondaryColor });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.rotation.x = Math.PI / 2;
    body.position.z = 0;
    group.add(body);

    // Tail section (tapered)
    const tailGeom = new THREE.CylinderGeometry(1.0 * scale, 0.6 * scale, 2 * scale, 8);
    const tailMat = new THREE.MeshBasicMaterial({ color: secondaryColor });
    const tail = new THREE.Mesh(tailGeom, tailMat);
    tail.rotation.x = Math.PI / 2;
    tail.position.z = -3.5 * scale;
    group.add(tail);

    // Fins (4 stabilizers)
    const finGeom = new THREE.BoxGeometry(0.15 * scale, 2.5 * scale, 1.5 * scale);
    const finMat = new THREE.MeshBasicMaterial({ color: primaryColor });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeom, finMat);
      const angle = (i * Math.PI) / 2;
      fin.position.set(
        Math.cos(angle) * 1.2 * scale,
        Math.sin(angle) * 1.2 * scale,
        -3 * scale
      );
      fin.rotation.z = angle;
      group.add(fin);
    }

    // Engine exhaust (bright glow) - named for later update
    const exhaustGeom = new THREE.ConeGeometry(0.5 * scale, 2.5 * scale, 8);
    const exhaustMat = new THREE.MeshBasicMaterial({
      color: exhaustColor,
      transparent: true,
      opacity: 0.9,
    });
    const exhaust = new THREE.Mesh(exhaustGeom, exhaustMat);
    exhaust.name = 'exhaust';
    exhaust.rotation.x = -Math.PI / 2;
    exhaust.position.z = -5.5 * scale;
    group.add(exhaust);

    // Outer exhaust glow - named for later update
    const glowGeom = new THREE.ConeGeometry(1.0 * scale, 4 * scale, 8);
    const glowMat = new THREE.MeshBasicMaterial({
      color: glowColor,
      transparent: true,
      opacity: 0.4,
    });
    const glow = new THREE.Mesh(glowGeom, glowMat);
    glow.name = 'exhaustGlow';
    glow.rotation.x = -Math.PI / 2;
    glow.position.z = -6 * scale;
    group.add(glow);

    return group;
  }

  /**
   * Update missile exhaust visibility based on flight phase.
   * Engine cuts out during cruise phase (in space) and reignites for reentry.
   */
  private updateMissileExhaust(
    head: THREE.Group,
    progress: number,
    isInterceptorMissile: boolean,
    missile?: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor
  ): void {
    const exhaust = head.getObjectByName('exhaust') as THREE.Mesh | undefined;
    const exhaustGlow = head.getObjectByName('exhaustGlow') as THREE.Mesh | undefined;

    if (!exhaust || !exhaustGlow) return;

    // Physics missiles: exhaust visible when engine has fuel
    if (missile && isPhysicsMissile(missile)) {
      const engineOn = missile.fuel > 0 && !missile.engineFlameout;
      exhaust.visible = engineOn;
      exhaustGlow.visible = engineOn;
      return;
    }

    // Rail interceptors: exhaust visible while has fuel
    if (missile && isRailInterceptor(missile)) {
      const railMissile = missile as RailInterceptor;
      const engineOn = railMissile.fuel > 0 && railMissile.status === 'active';
      exhaust.visible = engineOn;
      exhaustGlow.visible = engineOn;
      return;
    }

    // Guided interceptors: exhaust visible while has fuel and active
    if (missile && isGuidedInterceptor(missile)) {
      const guidedMissile = missile as GuidedInterceptor;
      const engineOn = guidedMissile.fuel > 0 && guidedMissile.status === 'active';
      exhaust.visible = engineOn;
      exhaustGlow.visible = engineOn;
      return;
    }

    // Legacy interceptors keep engine on the whole time (short flight)
    if (isInterceptorMissile) {
      exhaust.visible = true;
      exhaustGlow.visible = true;
      return;
    }

    // ICBMs: Engine on during launch (0-20%) and reentry (85-100%)
    // Engine off during cruise phase in space (20-85%)
    const engineOn = progress < 0.20 || progress > 0.85;

    exhaust.visible = engineOn;
    exhaustGlow.visible = engineOn;
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

  private calculateTraveledTrailSmooth(startGeo: GeoPosition, endGeo: GeoPosition, progress: number, maxAltitude: number, flightDuration: number, seed?: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Draw trail from launch to current position
    // Use enough steps to capture the altitude curve smoothly
    const steps = Math.max(10, Math.floor(60 * progress));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * progress;
      const pos = getMissilePosition3D(startGeo, endGeo, t, maxAltitude, GLOBE_RADIUS, flightDuration, seed);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    return points;
  }

  // Calculate the full planned route path (0% to 100% progress)
  private calculateFullRoutePath(startGeo: GeoPosition, endGeo: GeoPosition, maxAltitude: number, flightDuration: number, seed?: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Draw full path from launch to target
    // Use enough steps to capture the altitude curve smoothly
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const pos = getMissilePosition3D(startGeo, endGeo, t, maxAltitude, GLOBE_RADIUS, flightDuration, seed);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    return points;
  }

  // Get interceptor position along straight line toward target ICBM's 3D position
  /**
   * Get interceptor position with phase-aware trajectory:
   * - Boost Phase (0-boostEndProgress): Smooth acceleration UP with slight forward lean
   * - Track Phase (boostEndProgress-1): Constant speed (linear) toward target
   * - Miss Phase (1+): Continue past target, descending toward ground
   */
  private getInterceptorPositionTowardTarget(
    startGeo: GeoPosition,
    progress: number,
    targetMissileId?: string,
    boostEndProgress: number = 0.25,
    flightPhase?: 'boost' | 'track',
    missedTarget?: boolean,
    missDirection?: GeoPosition,
    flameoutProgress?: number
  ): { x: number; y: number; z: number } {
    // For missed interceptors, progress can exceed 1.0
    const t = Math.max(0, progress);

    // Get launch position on globe surface
    const startPos = geoToSphere(startGeo, GLOBE_RADIUS);
    const startVec = new THREE.Vector3(startPos.x, startPos.y, startPos.z);

    // Higher boost altitude for more dramatic launch (~20 units)
    const maxBoostAltitude = 20;

    // Determine current phase based on progress (fallback if flightPhase not provided)
    const inBoostPhase = flightPhase === 'boost' || (flightPhase === undefined && t <= boostEndProgress);

    // Get target ICBM's 3D position
    // IMPORTANT: After flameout, we freeze the target position - no more tracking!
    let targetPos3D: { x: number; y: number; z: number } | null = null;
    const actualFlameoutProgress = flameoutProgress ?? 1.0;
    const pastFlameout = t > actualFlameoutProgress;

    if (pastFlameout && !missedTarget) {
      // After flameout but before miss: calculate where ICBM WAS at flameout time
      // The interceptor coasts toward that frozen position
      targetPos3D = this.getTargetIcbmPositionAtProgress(targetMissileId, actualFlameoutProgress, boostEndProgress);
    } else if (missedTarget && t > 1 && missDirection) {
      // After a miss: use stored miss direction
      const missPos = geoToSphere(missDirection, GLOBE_RADIUS);
      // Estimate the altitude the target was at when missed (roughly mid-arc)
      const missAltitude = 15; // Approximate altitude at intercept
      const missVec = new THREE.Vector3(missPos.x, missPos.y, missPos.z).normalize();
      targetPos3D = {
        x: missVec.x * (GLOBE_RADIUS + missAltitude),
        y: missVec.y * (GLOBE_RADIUS + missAltitude),
        z: missVec.z * (GLOBE_RADIUS + missAltitude)
      };
    } else {
      // Normal tracking: get ICBM's current live position
      targetPos3D = this.getTargetIcbm3DPosition(targetMissileId);
    }

    if (inBoostPhase) {
      // BOOST PHASE: Smooth acceleration upward (ease-in quadratic)
      const boostProgress = t / boostEndProgress;
      // Ease-in for acceleration (starts slow, picks up speed)
      const easedBoost = boostProgress * boostProgress;
      const currentBoostAltitude = maxBoostAltitude * easedBoost;

      // Also move slightly toward target during boost (10% of ground distance)
      let forwardProgress = 0;
      if (targetPos3D) {
        forwardProgress = boostProgress * 0.1; // Slight forward lean
        const targetVec = new THREE.Vector3(targetPos3D.x, targetPos3D.y, targetPos3D.z);
        const targetGroundVec = targetVec.clone().normalize().multiplyScalar(GLOBE_RADIUS);

        // Interpolate ground position slightly toward target
        const groundPos = new THREE.Vector3().lerpVectors(startVec, targetGroundVec, forwardProgress);
        groundPos.normalize().multiplyScalar(GLOBE_RADIUS + currentBoostAltitude);

        return { x: groundPos.x, y: groundPos.y, z: groundPos.z };
      }

      // No target - just go straight up
      const direction = startVec.clone().normalize();
      const boostedPos = startVec.clone().add(direction.multiplyScalar(currentBoostAltitude));
      return { x: boostedPos.x, y: boostedPos.y, z: boostedPos.z };
    }

    // TRACK PHASE (or MISS PHASE): Linear interpolation for constant speed
    if (!targetPos3D) {
      // No target - hover at boost altitude
      const direction = startVec.clone().normalize();
      const boostedPos = startVec.clone().add(direction.multiplyScalar(maxBoostAltitude));
      return { x: boostedPos.x, y: boostedPos.y, z: boostedPos.z };
    }

    // Calculate progress through track phase (0 to 1, can exceed 1 for missed)
    const trackProgress = (t - boostEndProgress) / (1 - boostEndProgress);

    // LINEAR interpolation for constant speed (no easing - maintains speed throughout)
    const linearProgress = trackProgress;

    // Calculate positions at boost end (where track phase starts from)
    const targetVec = new THREE.Vector3(targetPos3D.x, targetPos3D.y, targetPos3D.z);
    const targetGroundVec = targetVec.clone().normalize().multiplyScalar(GLOBE_RADIUS);

    // Boost end position (10% toward target, at max boost altitude)
    const boostEndGroundPos = new THREE.Vector3().lerpVectors(startVec, targetGroundVec, 0.1);
    boostEndGroundPos.normalize().multiplyScalar(GLOBE_RADIUS);

    // Target altitude
    const targetAltitude = targetVec.length() - GLOBE_RADIUS;

    if (missedTarget && linearProgress > 1) {
      // MISS PHASE: Continue past target, descending toward ground
      const missProgress = linearProgress - 1; // 0 at target, increasing after

      // Direction of travel at intercept (from boost end toward target)
      const travelDir = new THREE.Vector3().subVectors(targetGroundVec, boostEndGroundPos).normalize();

      // Continue in travel direction past target
      const continueDistance = missProgress * 0.3; // Continue at reduced rate
      const missGroundPos = targetGroundVec.clone().add(travelDir.multiplyScalar(continueDistance * GLOBE_RADIUS));
      missGroundPos.normalize().multiplyScalar(GLOBE_RADIUS);

      // Descend toward ground (fuel running out)
      const descentRate = missProgress * 0.8; // Rapid descent
      const missAltitude = Math.max(0, targetAltitude * (1 - descentRate));

      const finalPos = missGroundPos.clone().normalize().multiplyScalar(GLOBE_RADIUS + missAltitude);
      return { x: finalPos.x, y: finalPos.y, z: finalPos.z };
    }

    // Normal tracking: linear interpolation from boost end to target
    const groundPos = new THREE.Vector3().lerpVectors(boostEndGroundPos, targetGroundVec, linearProgress);
    groundPos.normalize().multiplyScalar(GLOBE_RADIUS);

    // Altitude: linear from boost altitude to target altitude (constant climb rate)
    const currentAltitude = maxBoostAltitude + (targetAltitude - maxBoostAltitude) * linearProgress;

    // Apply altitude to ground position
    const finalPos = groundPos.clone().normalize().multiplyScalar(GLOBE_RADIUS + currentAltitude);

    return { x: finalPos.x, y: finalPos.y, z: finalPos.z };
  }

  // Get the target ICBM's current 3D position (including altitude from its ballistic arc)
  private getTargetIcbm3DPosition(targetMissileId?: string): { x: number; y: number; z: number } | null {
    if (!targetMissileId || !this.gameState) return null;

    const targetIcbm = this.gameState.missiles[targetMissileId];
    if (!targetIcbm || !targetIcbm.geoLaunchPosition || !targetIcbm.geoTargetPosition) {
      return null;
    }

    // Skip rail interceptors - this method is for ICBMs
    if (isRailInterceptor(targetIcbm)) return null;

    // Calculate the ICBM's altitude for its arc (use server's apexHeight if available)
    const icbmAltitude = (targetIcbm as any).apexHeight ?? calculateMissileAltitude(targetIcbm.geoLaunchPosition, targetIcbm.geoTargetPosition);

    // Get the ICBM's current 3D position using its progress
    const seed = this.hashStringToNumber(targetIcbm.id);
    const progress = targetIcbm.progress ?? 0;
    const flightDuration = targetIcbm.flightDuration ?? 30000;
    return getMissilePosition3D(
      targetIcbm.geoLaunchPosition,
      targetIcbm.geoTargetPosition,
      progress,
      icbmAltitude,
      GLOBE_RADIUS,
      flightDuration,
      seed
    );
  }

  /**
   * Get the target ICBM's 3D position at a specific interceptor progress.
   * Used to calculate where the ICBM was when the interceptor ran out of fuel (flameout).
   * This allows the interceptor to coast toward that frozen position instead of continuing to track.
   */
  private getTargetIcbmPositionAtProgress(
    targetMissileId?: string,
    interceptorProgress?: number,
    boostEndProgress: number = 0.25
  ): { x: number; y: number; z: number } | null {
    if (!targetMissileId || !this.gameState || interceptorProgress === undefined) return null;

    const targetIcbm = this.gameState.missiles[targetMissileId];
    if (!targetIcbm || !targetIcbm.geoLaunchPosition || !targetIcbm.geoTargetPosition) {
      return null;
    }

    // Skip rail interceptors - this method is for ICBMs
    if (isRailInterceptor(targetIcbm)) return null;

    // Calculate what the ICBM's progress was when the interceptor reached its flameout point
    // We need to figure out how much time elapsed from interceptor launch to flameout
    // and where the ICBM was at that moment
    const targetFlightDuration = targetIcbm.flightDuration ?? 30000;
    const interceptorSpeed = 1 / targetFlightDuration; // Approximate - not exact but close
    const icbmSpeed = 1 / targetFlightDuration;

    // Time from interceptor launch to flameout (as fraction of interceptor's flight)
    // ICBM progress at that time = icbm.launchProgress + (interceptor elapsed time * icbm speed)
    // This is approximate since we don't have exact timing, but it's close enough for visual effect

    // Estimate: when interceptor was at flameout progress, how much had ICBM advanced?
    // Use the current ICBM progress as a reference point
    const interceptorId = Object.keys(this.gameState.missiles).find(
      id => this.gameState!.missiles[id].targetId === targetMissileId
    );
    const currentInterceptorProgress = interceptorId
      ? (this.gameState.missiles[interceptorId]?.progress ?? interceptorProgress)
      : interceptorProgress;

    // Scale ICBM progress proportionally
    const targetProgress = targetIcbm.progress ?? 0;
    const icbmProgressAtFlameout = Math.min(
      1,
      targetProgress * (interceptorProgress / Math.max(0.01, currentInterceptorProgress))
    );

    // Get ICBM's geo position at that progress
    const icbmGeoAtFlameout = geoInterpolate(
      targetIcbm.geoLaunchPosition,
      targetIcbm.geoTargetPosition,
      icbmProgressAtFlameout
    );

    // Calculate the ICBM's altitude for its arc at that progress (use server's apexHeight if available)
    const icbmAltitude = (targetIcbm as any).apexHeight ?? calculateMissileAltitude(targetIcbm.geoLaunchPosition, targetIcbm.geoTargetPosition);

    // Get the ICBM's 3D position using its progress at flameout
    const seed = this.hashStringToNumber(targetIcbm.id);
    return getMissilePosition3D(
      targetIcbm.geoLaunchPosition,
      targetIcbm.geoTargetPosition,
      icbmProgressAtFlameout,
      icbmAltitude,
      GLOBE_RADIUS,
      targetIcbm.flightDuration,
      seed
    );
  }

  /**
   * Get interpolated position for physics missiles for smooth client-side rendering.
   * Interpolates between server updates to eliminate network jitter.
   */
  private getInterpolatedPhysicsPosition(
    missile: PhysicsMissile,
    now: number
  ): { x: number; y: number; z: number } {
    let interpState = this.physicsMissileInterpolation.get(missile.id);

    if (!interpState) {
      // New missile - initialize interpolation state
      interpState = {
        lastPosition: { ...missile.position },
        targetPosition: { ...missile.position },
        estimatedVelocity: { ...missile.velocity },
        lastUpdateTime: now,
      };
      this.physicsMissileInterpolation.set(missile.id, interpState);
      return { ...missile.position };
    }

    // Check if server sent a new position (position changed significantly)
    const dx = missile.position.x - interpState.targetPosition.x;
    const dy = missile.position.y - interpState.targetPosition.y;
    const dz = missile.position.z - interpState.targetPosition.z;
    const posDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (posDelta > 0.01) {
      // Server update received - update interpolation targets
      const timeSinceLastUpdate = Math.max(0.001, (now - interpState.lastUpdateTime) / 1000);

      // Estimate velocity from position delta
      interpState.estimatedVelocity = {
        x: dx / timeSinceLastUpdate,
        y: dy / timeSinceLastUpdate,
        z: dz / timeSinceLastUpdate,
      };

      interpState.lastPosition = { ...interpState.targetPosition };
      interpState.targetPosition = { ...missile.position };
      interpState.lastUpdateTime = now;
    }

    // Interpolate position based on estimated velocity
    const timeSinceUpdate = (now - interpState.lastUpdateTime) / 1000;

    // Predict current position based on last known position + velocity * time
    // But blend toward server position to prevent drift
    const predictedX = interpState.targetPosition.x + interpState.estimatedVelocity.x * timeSinceUpdate;
    const predictedY = interpState.targetPosition.y + interpState.estimatedVelocity.y * timeSinceUpdate;
    const predictedZ = interpState.targetPosition.z + interpState.estimatedVelocity.z * timeSinceUpdate;

    // Clamp prediction to not overshoot too much (within 0.5 seconds of predicted travel)
    const maxExtrapolation = 0.5; // seconds
    const clampedTime = Math.min(timeSinceUpdate, maxExtrapolation);

    return {
      x: interpState.targetPosition.x + interpState.estimatedVelocity.x * clampedTime,
      y: interpState.targetPosition.y + interpState.estimatedVelocity.y * clampedTime,
      z: interpState.targetPosition.z + interpState.estimatedVelocity.z * clampedTime,
    };
  }

  // Hash string to a deterministic number for seeding randomness
  private hashStringToNumber(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Update communication chain visualization.
   * Shows data flow: ICBM → Radar → Silo → Interceptor
   * Only displayed when an interceptor is tracked (selected).
   */
  private updateCommunicationChain(deltaTime: number): void {
    // Clear existing visualization
    this.clearCommunicationChain();

    if (!this.trackedMissileId || !this.gameState) return;

    // Get the tracked missile
    const trackedMissile = getMissiles(this.gameState).find(m => m.id === this.trackedMissileId);
    if (!trackedMissile || trackedMissile.type !== 'interceptor') return;
    if (trackedMissile.detonated || trackedMissile.intercepted) return;

    // Get the target ICBM
    const targetIcbm = trackedMissile.targetId ? this.gameState.missiles[trackedMissile.targetId] : null;
    if (!targetIcbm || !targetIcbm.geoCurrentPosition) return;

    // Get the detecting radar
    const radarId = trackedMissile.detectedByRadarId;
    const radar = radarId ? this.gameState.buildings[radarId] as Radar : null;

    // Get the launching silo
    const siloId = trackedMissile.launchingSiloId || trackedMissile.sourceId;
    const silo = siloId ? this.gameState.buildings[siloId] as Silo : null;

    // Get positions - using geo positions for 3D visualization
    const icbmPos = targetIcbm.geoCurrentPosition;
    const radarPos = radar?.geoPosition;
    const siloPos = silo?.geoPosition;
    const interceptorPos = trackedMissile.geoCurrentPosition;

    // Create the chain if we have all positions
    if (!interceptorPos) return;

    // Helper to create 3D position above globe surface (for visibility)
    const getPos3D = (geo: GeoPosition, altitude: number = 5) => {
      const pos = geoToSphere(geo, GLOBE_RADIUS + altitude);
      return new THREE.Vector3(pos.x, pos.y, pos.z);
    };

    // Colors for different segments
    const colors = {
      detection: 0xff8800,    // Orange: ICBM → Radar
      targetData: 0x00ff88,   // Green: Radar → Silo
      guidance: 0x00ffff,     // Cyan: Silo → Interceptor
    };

    // Update animation time
    this.packetAnimationTime += deltaTime;

    // Create chain segments
    const segments: { start: THREE.Vector3; end: THREE.Vector3; color: number; label: string }[] = [];

    // Get interceptor 3D position (at its current flight altitude)
    let interceptorVec: THREE.Vector3;
    if (isPhysicsMissile(trackedMissile)) {
      // Physics missile: use position directly
      interceptorVec = new THREE.Vector3(
        trackedMissile.position.x,
        trackedMissile.position.y,
        trackedMissile.position.z
      );
    } else {
      // Legacy missile: calculate position from trajectory
      const boostEnd = trackedMissile.boostEndProgress ?? 0.15;
      const flameoutProgress = this.calculateFlameoutProgress(trackedMissile);
      const missileProgress = trackedMissile.progress ?? 0;
      const interceptor3D = this.getInterceptorPositionTowardTarget(
        trackedMissile.geoLaunchPosition!,
        missileProgress,
        trackedMissile.targetId,
        boostEnd,
        trackedMissile.flightPhase,
        trackedMissile.missedTarget,
        trackedMissile.missDirection,
        flameoutProgress
      );
      interceptorVec = new THREE.Vector3(interceptor3D.x, interceptor3D.y, interceptor3D.z);
    }

    // Get ICBM 3D position (at its current flight altitude)
    const icbm3D = this.getTargetIcbm3DPosition(targetIcbm.id);
    if (icbm3D) {
      const icbmVec = new THREE.Vector3(icbm3D.x, icbm3D.y, icbm3D.z);

      if (radarPos) {
        const radarVec = getPos3D(radarPos, 3);
        // ICBM → Radar (detection)
        segments.push({ start: icbmVec, end: radarVec, color: colors.detection, label: 'detection' });

        if (siloPos) {
          const siloVec = getPos3D(siloPos, 3);
          // Radar → Silo (target data)
          segments.push({ start: radarVec, end: siloVec, color: colors.targetData, label: 'target data' });
          // Silo → Interceptor (guidance)
          segments.push({ start: siloVec, end: interceptorVec, color: colors.guidance, label: 'guidance' });
        } else {
          // No silo info, just show Radar → Interceptor
          segments.push({ start: radarVec, end: interceptorVec, color: colors.guidance, label: 'guidance' });
        }
      } else if (siloPos) {
        // No radar info, show Silo → Interceptor
        const siloVec = getPos3D(siloPos, 3);
        segments.push({ start: siloVec, end: interceptorVec, color: colors.guidance, label: 'guidance' });
      }
    }

    // Create line segments and packets
    for (const segment of segments) {
      // Create curved line that arcs above the globe surface
      const curvePoints = this.createArcedLine(segment.start, segment.end, 16);
      const lineGeom = new THREE.BufferGeometry().setFromPoints(curvePoints);
      const lineMat = new THREE.LineDashedMaterial({
        color: segment.color,
        dashSize: 3,
        gapSize: 2,
        transparent: true,
        opacity: 0.6,
      });
      const line = new THREE.Line(lineGeom, lineMat);
      line.computeLineDistances();
      this.commChainGroup.add(line);
      this.commChainLines.push(line);

      // Create animated packets (3 per segment, staggered)
      for (let i = 0; i < 3; i++) {
        const packetGeom = new THREE.SphereGeometry(0.4, 6, 6);
        const packetMat = new THREE.MeshBasicMaterial({
          color: segment.color,
          transparent: true,
          opacity: 0.9,
        });
        const packet = new THREE.Mesh(packetGeom, packetMat);

        // Calculate packet position along curved segment
        const speed = 0.5; // Traversals per second
        const offset = i / 3; // Stagger packets
        const rawProgress = ((this.packetAnimationTime * speed) + offset) % 1;

        // Smooth sine-wave opacity pulse
        packetMat.opacity = 0.4 + 0.5 * Math.sin(rawProgress * Math.PI);

        // Position along curved arc (use the pre-computed curve points)
        const curveIndex = rawProgress * (curvePoints.length - 1);
        const lowerIndex = Math.floor(curveIndex);
        const upperIndex = Math.min(lowerIndex + 1, curvePoints.length - 1);
        const localT = curveIndex - lowerIndex;
        packet.position.lerpVectors(curvePoints[lowerIndex], curvePoints[upperIndex], localT);

        this.commChainGroup.add(packet);
        this.commChainPackets.push(packet);
      }
    }
  }

  /**
   * Create an arced line between two 3D points that curves away from the globe.
   * This prevents lines from intersecting the globe surface.
   */
  private createArcedLine(start: THREE.Vector3, end: THREE.Vector3, segments: number = 16): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Base altitude above globe surface for the arc
    const baseAltitude = GLOBE_RADIUS + 5;

    // Calculate the angular distance to determine arc height
    const startNorm = start.clone().normalize();
    const endNorm = end.clone().normalize();
    const angularDist = Math.acos(Math.max(-1, Math.min(1, startNorm.dot(endNorm))));

    // Arc height scales with angular distance - longer arcs need higher peaks
    const arcHeight = Math.max(8, angularDist * GLOBE_RADIUS * 0.3);

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      // Spherical interpolation for direction (stays on sphere surface)
      const dir = new THREE.Vector3().lerpVectors(startNorm, endNorm, t).normalize();

      // Calculate how much to lift this point (parabolic arc - highest at middle)
      const arcFactor = 4 * t * (1 - t); // 0 at ends, 1 at middle
      const altitude = baseAltitude + arcHeight * arcFactor;

      // Position at altitude above globe
      const point = dir.multiplyScalar(altitude);
      points.push(point);
    }

    return points;
  }

  /**
   * Clear communication chain visualization.
   */
  private clearCommunicationChain(): void {
    // Remove and dispose lines
    for (const line of this.commChainLines) {
      this.commChainGroup.remove(line);
      line.geometry.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    }
    this.commChainLines = [];

    // Remove and dispose packets
    for (const packet of this.commChainPackets) {
      this.commChainGroup.remove(packet);
      packet.geometry.dispose();
      if (packet.material instanceof THREE.Material) {
        packet.material.dispose();
      }
    }
    this.commChainPackets = [];
  }

  /**
   * Update intercept prediction visualization for tracked interceptor.
   * Shows: predicted intercept point, chance of interception, engine flameout marker.
   */
  private updateInterceptPrediction(): void {
    // Clear existing visualization
    this.clearInterceptPrediction();

    if (!this.trackedMissileId || !this.gameState) return;

    // Get the tracked missile
    const interceptor = getMissiles(this.gameState).find(m => m.id === this.trackedMissileId);
    if (!interceptor || !isInterceptorType(interceptor)) return;
    if (interceptor.detonated || interceptor.intercepted) return;

    // Get the target ICBM
    const targetId = isRailInterceptor(interceptor)
      ? (interceptor as RailInterceptor).targetId
      : isGuidedInterceptor(interceptor)
        ? (interceptor as GuidedInterceptor).targetId
        : (interceptor as any).targetId;
    const targetIcbm = targetId ? this.gameState.missiles[targetId] : null;
    if (!targetIcbm || targetIcbm.detonated || targetIcbm.intercepted) return;

    // Guided interceptors: show predicted intercept point along ICBM's path
    if (isGuidedInterceptor(interceptor)) {
      const guidedMissile = interceptor as GuidedInterceptor;
      const icbm = targetIcbm as Missile;

      if (icbm.geoLaunchPosition && icbm.geoTargetPosition && icbm.geoCurrentPosition && icbm.flightDuration) {
        // Iteratively estimate intercept point
        const interceptorSpeed = guidedMissile.speed || 0.8; // degrees per second
        let timeToIntercept = 10; // initial guess in seconds

        // Refine estimate
        for (let i = 0; i < 3; i++) {
          // Where will ICBM be in timeToIntercept seconds?
          const progressDelta = (timeToIntercept * 1000) / icbm.flightDuration;
          const futureProgress = Math.min(0.98, icbm.progress + progressDelta);
          const futureGeo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, futureProgress);

          // How long to reach that point?
          const distToFuture = greatCircleDistance(guidedMissile.geoPosition, futureGeo);
          const distDegrees = distToFuture * (180 / Math.PI);
          timeToIntercept = distDegrees / interceptorSpeed;
        }

        // Final predicted position
        const progressDelta = (timeToIntercept * 1000) / icbm.flightDuration;
        const interceptProgress = Math.min(0.95, icbm.progress + progressDelta);
        const interceptGeo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, interceptProgress);
        const icbmApex = icbm.apexHeight || 30;
        const icbmAltitude = 4 * icbmApex * interceptProgress * (1 - interceptProgress);

        const markerPos = geoToSphere(interceptGeo, GLOBE_RADIUS + icbmAltitude * 0.3);
        const chance = guidedMissile.hasGuidance ? 0.75 : 0.15;
        this.createInterceptMarker(
          new THREE.Vector3(markerPos.x, markerPos.y, markerPos.z),
          chance
        );
      }
      return;
    }

    // Rail interceptors: show marker at ICBM's predicted position at intercept
    if (isRailInterceptor(interceptor)) {
      const railMissile = interceptor as RailInterceptor;
      const icbm = targetIcbm as Missile;

      // Get ICBM position at the intercept progress (where they'll meet)
      if (icbm.geoLaunchPosition && icbm.geoTargetPosition) {
        const interceptProgress = railMissile.targetProgressAtIntercept;
        const icbmGeo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, interceptProgress);
        const icbmApex = icbm.apexHeight || 30;
        const icbmAltitude = 4 * icbmApex * interceptProgress * (1 - interceptProgress);

        // Place marker at ICBM's position (on the globe surface, not at altitude)
        const markerPos = geoToSphere(icbmGeo, GLOBE_RADIUS + icbmAltitude * 0.3);
        const chance = railMissile.tracking.hasGuidance ? 0.7 : 0.1;
        this.createInterceptMarker(
          new THREE.Vector3(markerPos.x, markerPos.y, markerPos.z),
          chance
        );
      }
      return;
    }

    // Physics missiles: use server-provided predicted intercept point
    if (isPhysicsMissile(interceptor)) {
      this.updateInterceptPredictionForPhysicsMissile(interceptor, targetIcbm as Missile | PhysicsMissile);
      return;
    }

    // Skip if target is a rail interceptor
    if (isRailInterceptor(targetIcbm)) return;

    // Legacy interceptor: calculate intercept point locally
    const interceptPoint = this.calculateInterceptPoint(interceptor as Missile, targetIcbm as Missile);
    if (!interceptPoint) return;

    // Calculate interception chance
    const chance = this.calculateInterceptionChance(interceptor as Missile, targetIcbm as Missile, interceptPoint);

    // Create intercept marker (pulsing diamond shape)
    this.createInterceptMarker(interceptPoint.position, chance);

    // Create chance label
    this.createChanceLabel(interceptPoint.position, chance);

    // Only show flameout marker AFTER it has happened
    const flameoutProgress = this.calculateFlameoutProgress(interceptor);
    if (interceptor.progress > flameoutProgress) {
      this.createFlameoutMarker(interceptor, flameoutProgress);
    }

    // Show fuel and speed beside the missile
    this.createMissileStatsLabel(interceptor, flameoutProgress);
  }

  /**
   * Update intercept prediction for physics-based missiles.
   * Uses server-provided data for more accurate visualization.
   */
  private updateInterceptPredictionForPhysicsMissile(
    interceptor: PhysicsMissile,
    targetIcbm: Missile | PhysicsMissile
  ): void {
    // Use server-calculated predicted intercept point
    if (interceptor.predictedInterceptPoint) {
      const pt = interceptor.predictedInterceptPoint;
      const position = new THREE.Vector3(pt.x, pt.y, pt.z);

      // Calculate interception chance based on physics state
      const chance = this.calculatePhysicsMissileChance(interceptor);

      // Create intercept marker
      this.createInterceptMarker(position, chance);

      // Create chance label
      this.createChanceLabel(position, chance);
    }

    // Show flameout marker if engine has flamed out
    if (interceptor.engineFlameout) {
      this.createPhysicsFlameoutMarker(interceptor);
    }

    // Show fuel and time-to-intercept stats
    this.createPhysicsMissileStatsLabel(interceptor);
  }

  /**
   * Calculate interception chance for physics missiles.
   */
  private calculatePhysicsMissileChance(missile: PhysicsMissile): number {
    let chance = 0.7; // Base chance

    // Coast phase (no fuel) has very low chance
    if (missile.phase === 'coast' || missile.engineFlameout) {
      return 0.05;
    }

    // Terminal phase has higher chance
    if (missile.phase === 'terminal') {
      chance += 0.1;
    }

    // Low fuel reduces chance
    if (missile.fuel < 2) {
      chance -= 0.15;
    }

    // Close to intercept increases chance
    if (missile.timeToIntercept !== undefined && missile.timeToIntercept < 2) {
      chance += 0.1;
    }

    return Math.max(0.05, Math.min(0.85, chance));
  }

  /**
   * Create flameout marker for physics missiles.
   */
  private createPhysicsFlameoutMarker(missile: PhysicsMissile): void {
    // Position marker at flameout location (not current position)
    const pos = missile.flameoutPosition || missile.position;
    const markerGroup = new THREE.Group();

    // Red X shape for flameout
    const xMaterial = new THREE.LineBasicMaterial({ color: 0xff4444 });
    const size = 1.5;

    const xGeom1 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size, 0, -size),
      new THREE.Vector3(size, 0, size),
    ]);
    const xGeom2 = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-size, 0, size),
      new THREE.Vector3(size, 0, -size),
    ]);

    markerGroup.add(new THREE.Line(xGeom1, xMaterial));
    markerGroup.add(new THREE.Line(xGeom2, xMaterial));

    markerGroup.position.set(pos.x, pos.y, pos.z);
    markerGroup.lookAt(0, 0, 0);

    // Store reference so it gets cleaned up properly
    this.flameoutMarker = markerGroup;
    this.interceptPredictionGroup.add(markerGroup);
  }

  /**
   * Create stats label for physics missiles showing fuel and time to intercept.
   */
  private createPhysicsMissileStatsLabel(missile: PhysicsMissile): void {
    // Create stats display near the missile
    const fuelPercent = Math.round((missile.fuel / missile.maxFuel) * 100);
    const timeToInt = missile.timeToIntercept !== undefined
      ? `T-${missile.timeToIntercept.toFixed(1)}s`
      : '--';
    const phase = missile.phase.toUpperCase();

    // Create label (simplified - just add to debug if needed)
    // Full implementation would create a sprite or HTML overlay
  }

  /**
   * Calculate where the interceptor will meet the ICBM.
   */
  private calculateInterceptPoint(
    interceptor: Missile,
    icbm: Missile
  ): { position: THREE.Vector3; progress: number } | null {
    if (!interceptor.geoLaunchPosition || !icbm.geoLaunchPosition || !icbm.geoTargetPosition) {
      return null;
    }

    // Calculate when interceptor will reach the ICBM
    const interceptorSpeed = 1 / interceptor.flightDuration;
    const icbmSpeed = 1 / icbm.flightDuration;

    // Time until interceptor reaches progress=1 (or flameout if sooner)
    const flameoutProgress = this.calculateFlameoutProgress(interceptor);
    const effectiveInterceptorEnd = Math.min(1, flameoutProgress);
    const interceptorTimeToEnd = (effectiveInterceptorEnd - interceptor.progress) / interceptorSpeed;

    // Where will ICBM be at that time?
    const icbmProgressAtIntercept = Math.min(1, icbm.progress + icbmSpeed * interceptorTimeToEnd);

    // Get ICBM's predicted 3D position using proper altitude calculation
    const icbmGeoAtIntercept = geoInterpolate(
      icbm.geoLaunchPosition,
      icbm.geoTargetPosition,
      icbmProgressAtIntercept
    );

    // ICBM altitude follows parabolic arc: 4 * apex * p * (1-p)
    // Scale apex to globe units (apex is in abstract units, roughly 1 unit = 1 degree)
    const icbmAltitude = 4 * icbm.apexHeight * icbmProgressAtIntercept * (1 - icbmProgressAtIntercept);
    const altitudeInGlobeUnits = icbmAltitude * 0.3; // Scale factor for visualization

    const icbmPos = geoToSphere(icbmGeoAtIntercept, GLOBE_RADIUS + altitudeInGlobeUnits);

    return {
      position: new THREE.Vector3(icbmPos.x, icbmPos.y, icbmPos.z),
      progress: icbmProgressAtIntercept
    };
  }

  /**
   * Calculate the probability of successful interception.
   * Factors: fuel remaining (can't maneuver without fuel), ICBM descent phase
   */
  private calculateInterceptionChance(
    interceptor: Missile,
    icbm: Missile,
    interceptPoint: { position: THREE.Vector3; progress: number }
  ): number {
    const flameoutProgress = this.calculateFlameoutProgress(interceptor);

    // If already missed, chance is 0
    if (interceptor.missedTarget) {
      return 0;
    }

    // If past flameout, can't maneuver - chance drops drastically
    // Only a lucky hit if already on perfect trajectory
    if (interceptor.progress >= flameoutProgress) {
      return 0.05; // 5% - coasting, can't adjust
    }

    // Base hit probability
    let chance = 0.7;

    // Factor 1: Fuel remaining affects maneuverability
    const fuelRatio = 1 - (interceptor.progress / flameoutProgress);
    if (fuelRatio < 0.3) {
      // Low fuel = less ability to make course corrections
      chance -= (0.3 - fuelRatio) * 0.3;
    }

    // Factor 2: ICBM is descending (harder to hit during descent - faster, steeper angle)
    if (interceptPoint.progress > 0.5) {
      const descentPenalty = (interceptPoint.progress - 0.5) * 0.2;
      chance -= descentPenalty;
    }

    // Clamp to valid range
    return Math.max(0.05, Math.min(0.85, chance));
  }

  /**
   * Calculate when the interceptor engine flames out (runs out of fuel).
   * Returns progress value (0-1) at which flameout occurs.
   *
   * Fuel model:
   * - Interceptor has ~12 seconds of fuel
   * - Boost phase (0-25%) burns at 2x rate
   * - Track phase burns at 1x rate
   * - Flameout happens when fuel runs out (time-based, not progress-based)
   */
  private calculateFlameoutProgress(interceptor: Missile): number {
    const totalFuelSeconds = 12; // Total fuel capacity in seconds
    const boostBurnRate = 2.0;   // Boost burns fuel 2x faster
    const trackBurnRate = 1.0;   // Track burns at normal rate
    const boostEndProgress = interceptor.boostEndProgress ?? 0.25;

    // Calculate how long each phase takes in real time
    const flightDurationSec = interceptor.flightDuration / 1000;
    const boostDurationSec = boostEndProgress * flightDurationSec;

    // Fuel used during boost
    const boostFuelUsed = boostDurationSec * boostBurnRate;

    // Remaining fuel after boost
    const remainingFuel = Math.max(0, totalFuelSeconds - boostFuelUsed);

    // How long can we track with remaining fuel?
    const trackDurationOnFuel = remainingFuel / trackBurnRate;

    // Total time until flameout
    const flameoutTimeSec = boostDurationSec + trackDurationOnFuel;

    // Convert to progress (capped at 1.0 for normal flight)
    const flameoutProgress = Math.min(1.0, flameoutTimeSec / flightDurationSec);

    return flameoutProgress;
  }

  /**
   * Create the intercept point marker - a small diamond that shows where intercept will happen.
   */
  private createInterceptMarker(position: THREE.Vector3, chance: number): void {
    const markerGroup = new THREE.Group();
    markerGroup.position.copy(position);

    // Small diamond shape (octahedron) - much smaller
    const geometry = new THREE.OctahedronGeometry(0.5, 0);
    const color = chance > 0.5 ? 0x00ff88 : (chance > 0.25 ? 0xffff00 : 0xff4444);
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.7,
      wireframe: true,
    });
    const diamond = new THREE.Mesh(geometry, material);
    markerGroup.add(diamond);

    this.interceptMarker = markerGroup;
    this.interceptPredictionGroup.add(markerGroup);
  }

  /**
   * Create a small text label showing interception chance.
   */
  private createChanceLabel(position: THREE.Vector3, chance: number): void {
    // Create small canvas for text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 48;
    canvas.height = 16;

    // Draw minimal text - just the percentage
    const color = chance > 0.5 ? '#00ff88' : (chance > 0.25 ? '#ffff00' : '#ff4444');
    ctx.fillStyle = color;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(chance * 100)}%`, canvas.width / 2, 12);

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.copy(position);
    sprite.position.y += 1.5; // Small offset above marker
    sprite.scale.set(2, 0.7, 1);

    this.interceptChanceLabel = sprite;
    this.interceptPredictionGroup.add(sprite);
  }

  /**
   * Create a small marker on the trail showing where engine flameout occurs.
   */
  private createFlameoutMarker(interceptor: Missile, flameoutProgress: number): void {
    if (!interceptor.geoLaunchPosition) return;

    // Calculate position at flameout progress
    const boostEnd = interceptor.boostEndProgress ?? 0.25;
    const flameoutPos = this.getInterceptorPositionTowardTarget(
      interceptor.geoLaunchPosition,
      flameoutProgress,
      interceptor.targetId,
      boostEnd,
      undefined,
      interceptor.missedTarget,
      interceptor.missDirection
    );

    const markerGroup = new THREE.Group();
    markerGroup.position.set(flameoutPos.x, flameoutPos.y, flameoutPos.z);

    // Tiny dot marker
    const dotGeom = new THREE.SphereGeometry(0.15, 6, 6);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.8 });
    const dot = new THREE.Mesh(dotGeom, dotMat);
    markerGroup.add(dot);

    // Small "F" label
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 16;
    canvas.height = 16;

    ctx.fillStyle = '#ff8800';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('F', canvas.width / 2, 12);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const label = new THREE.Sprite(spriteMat);
    label.position.set(0, 0.5, 0);
    label.scale.set(0.8, 0.8, 1);
    markerGroup.add(label);

    this.flameoutMarker = markerGroup;
    this.interceptPredictionGroup.add(markerGroup);
  }

  /**
   * Create a SpaceX-style stage marker label for flight events.
   */
  private createStageLabel(text: string, color: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;

    // Convert color to hex string
    const hexColor = `#${color.toString(16).padStart(6, '0')}`;

    // Draw background with slight transparency for readability
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw text
    ctx.font = 'bold 16px "Courier New", monospace';
    ctx.fillStyle = hexColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 4, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.5, 0.6, 1);

    return sprite;
  }

  /**
   * Create a SpaceX-style stage marker with tick and label.
   */
  private createStageMarker(
    position: THREE.Vector3,
    label: string,
    color: number
  ): THREE.Group {
    const group = new THREE.Group();

    // Small dot marker at the position
    const dotGeom = new THREE.SphereGeometry(0.2, 6, 6);
    const dotMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9
    });
    const dot = new THREE.Mesh(dotGeom, dotMat);
    group.add(dot);

    // Text label sprite offset from the dot
    const labelSprite = this.createStageLabel(label, color);
    labelSprite.position.set(1.5, 0.3, 0);
    group.add(labelSprite);

    group.position.copy(position);

    return group;
  }

  /**
   * Add a stage marker for a missile and store it.
   */
  private addStageMarker(
    missileId: string,
    position: THREE.Vector3,
    label: string,
    color: number
  ): void {
    const marker = this.createStageMarker(position, label, color);

    // Store the marker
    if (!this.stageMarkers.has(missileId)) {
      this.stageMarkers.set(missileId, []);
    }
    this.stageMarkers.get(missileId)!.push(marker);

    // Add to scene
    this.missileGroup.add(marker);
  }

  /**
   * Get phase display info for SpaceX-style markers.
   */
  private getPhaseMarkerInfo(phase: string): { label: string; color: number } | null {
    switch (phase) {
      case 'boost':
        return { label: 'LNC', color: 0x00ffff };
      case 'pitch':
        return { label: 'PITCH', color: 0x00ffff };
      case 'cruise':
        return { label: 'CRUISE', color: 0x88ff88 };
      case 'terminal':
        return { label: 'TERM', color: 0xffff00 };
      case 'coast':
        return { label: 'COAST', color: 0x888888 };
      default:
        return null;
    }
  }

  /**
   * Check if a missile position is within radar coverage of the player.
   */
  private isMissileInRadarCoverage(missileGeo: GeoPosition): boolean {
    if (!this.gameState || !this.playerId) return false;

    const buildings = getBuildings(this.gameState);
    const radars = buildings.filter(b =>
      b.type === 'radar' && b.ownerId === this.playerId
    ) as Radar[];

    for (const radar of radars) {
      const radarGeo = radar.geoPosition;
      if (!radarGeo) continue;

      // Simple distance check using great circle distance approximation
      const dLat = (missileGeo.lat - radarGeo.lat) * Math.PI / 180;
      const dLng = (missileGeo.lng - radarGeo.lng) * Math.PI / 180;
      const lat1 = radarGeo.lat * Math.PI / 180;
      const lat2 = missileGeo.lat * Math.PI / 180;

      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distDegrees = c * 180 / Math.PI;

      // Use radar's configured range (in degrees, typically ~27)
      if (distDegrees <= this.RADAR_MAX_RANGE_DEGREES) {
        return true;
      }
    }

    // Also check satellite coverage
    const satellites = getSatellites(this.gameState);
    const friendlySatellites = satellites.filter(s => s.ownerId === this.playerId);

    for (const sat of friendlySatellites) {
      const satGeo = getSatelliteGroundPosition(sat, Date.now(), GLOBE_RADIUS);
      const dLat = (missileGeo.lat - satGeo.lat) * Math.PI / 180;
      const dLng = (missileGeo.lng - satGeo.lng) * Math.PI / 180;
      const lat1 = satGeo.lat * Math.PI / 180;
      const lat2 = missileGeo.lat * Math.PI / 180;

      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLng/2) * Math.sin(dLng/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distDegrees = c * 180 / Math.PI;

      if (distDegrees <= SATELLITE_VISION_RANGE_DEGREES) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clean up stage markers for a missile.
   */
  private disposeStageMarkers(missileId: string): void {
    const markers = this.stageMarkers.get(missileId);
    if (markers) {
      for (const marker of markers) {
        this.missileGroup.remove(marker);
        marker.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            if (obj.material instanceof THREE.Material) {
              obj.material.dispose();
            }
          } else if (obj instanceof THREE.Sprite) {
            if (obj.material.map) {
              obj.material.map.dispose();
            }
            obj.material.dispose();
          }
        });
      }
      this.stageMarkers.delete(missileId);
    }

    // Also clean up tracking state
    this.interceptorPhases.delete(missileId);
    this.missileRadarStatus.delete(missileId);
    this.icbmMarkerProgress.delete(missileId);
  }

  /**
   * Create fuel and speed stats label beside the tracked missile.
   */
  private createMissileStatsLabel(interceptor: Missile, flameoutProgress: number): void {
    if (!interceptor.geoLaunchPosition) return;

    // Get current missile position (use flameoutProgress to stop tracking after fuel runs out)
    const boostEnd = interceptor.boostEndProgress ?? 0.25;
    const missilePos = this.getInterceptorPositionTowardTarget(
      interceptor.geoLaunchPosition,
      interceptor.progress,
      interceptor.targetId,
      boostEnd,
      interceptor.flightPhase,
      interceptor.missedTarget,
      interceptor.missDirection,
      flameoutProgress
    );

    // Calculate fuel remaining based on elapsed time and burn rates
    const totalFuelSeconds = 12;
    const boostBurnRate = 2.0;
    const trackBurnRate = 1.0;
    const boostEndProgress = interceptor.boostEndProgress ?? 0.25;

    const flightDurationSec = interceptor.flightDuration / 1000;
    const elapsedSec = interceptor.progress * flightDurationSec;
    const boostDurationSec = boostEndProgress * flightDurationSec;

    let fuelUsed = 0;
    if (elapsedSec <= boostDurationSec) {
      // Still in boost
      fuelUsed = elapsedSec * boostBurnRate;
    } else {
      // Past boost
      fuelUsed = boostDurationSec * boostBurnRate + (elapsedSec - boostDurationSec) * trackBurnRate;
    }

    const fuelRemaining = Math.max(0, Math.round((1 - fuelUsed / totalFuelSeconds) * 100));

    // Calculate speed (relative units)
    const speed = interceptor.missedTarget ? 0 : Math.round((1 - interceptor.progress * 0.3) * 100);

    // Create small canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 48;
    canvas.height = 24;

    // Draw stats - compact format
    ctx.fillStyle = fuelRemaining > 20 ? '#00ff88' : '#ff8800';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`F:${fuelRemaining}%`, 2, 10);

    ctx.fillStyle = '#00ffff';
    ctx.fillText(`S:${speed}`, 2, 22);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);

    // Position beside the missile (offset to the side)
    sprite.position.set(missilePos.x, missilePos.y, missilePos.z);
    const offset = new THREE.Vector3(missilePos.x, missilePos.y, missilePos.z)
      .normalize()
      .multiplyScalar(2);
    sprite.position.add(offset);
    sprite.scale.set(1.5, 0.75, 1);

    this.missileStatsLabel = sprite;
    this.interceptPredictionGroup.add(sprite);
  }

  /**
   * Clear intercept prediction visualization.
   */
  private clearInterceptPrediction(): void {
    if (this.interceptMarker) {
      this.interceptPredictionGroup.remove(this.interceptMarker);
      this.interceptMarker.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
      this.interceptMarker = null;
    }

    if (this.interceptChanceLabel) {
      this.interceptPredictionGroup.remove(this.interceptChanceLabel);
      if (this.interceptChanceLabel.material instanceof THREE.SpriteMaterial) {
        this.interceptChanceLabel.material.map?.dispose();
        this.interceptChanceLabel.material.dispose();
      }
      this.interceptChanceLabel = null;
    }

    if (this.flameoutMarker) {
      this.interceptPredictionGroup.remove(this.flameoutMarker);
      this.flameoutMarker.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
        if (child instanceof THREE.Sprite && child.material instanceof THREE.SpriteMaterial) {
          child.material.map?.dispose();
          child.material.dispose();
        }
      });
      this.flameoutMarker = null;
    }

    if (this.missileStatsLabel) {
      this.interceptPredictionGroup.remove(this.missileStatsLabel);
      if (this.missileStatsLabel.material instanceof THREE.SpriteMaterial) {
        this.missileStatsLabel.material.map?.dispose();
        this.missileStatsLabel.material.dispose();
      }
      this.missileStatsLabel = null;
    }
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

  /**
   * Create a small ground impact explosion for missed interceptors.
   * This is smaller and less dramatic than nuclear detonations.
   */
  private createGroundImpactExplosion(pos3d: { x: number; y: number; z: number }): void {
    const explosionGroup = new THREE.Group();
    explosionGroup.position.set(pos3d.x, pos3d.y, pos3d.z);
    this.effectGroup.add(explosionGroup);

    // Small orange flash
    const flashGeom = new THREE.SphereGeometry(1.5, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 1,
    });
    const flash = new THREE.Mesh(flashGeom, flashMat);
    explosionGroup.add(flash);

    // Small debris ring
    const ringGeom = new THREE.RingGeometry(0.5, 2, 16);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xaa6633,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    // Orient ring perpendicular to surface normal
    const normal = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();
    ring.lookAt(normal.clone().add(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z)));
    explosionGroup.add(ring);

    // Animate
    let frame = 0;
    const maxFrames = 30; // Shorter animation than nuclear

    const animate = () => {
      frame++;
      const progress = frame / maxFrames;

      // Flash fades quickly
      flashMat.opacity = Math.max(0, 1 - progress * 2);
      flash.scale.setScalar(1 + progress * 2);

      // Ring expands and fades
      ring.scale.setScalar(1 + progress * 3);
      ringMat.opacity = Math.max(0, 0.6 - progress * 0.8);

      if (frame < maxFrames) {
        requestAnimationFrame(animate);
      } else {
        // Cleanup
        this.effectGroup.remove(explosionGroup);
        flashGeom.dispose();
        flashMat.dispose();
        ringGeom.dispose();
        ringMat.dispose();
      }
    };
    animate();
  }

  /**
   * Update fading missiles - missiles that have detonated/been intercepted
   * and are now fading out with their trails shrinking to the impact point
   */
  private updateFadingMissiles(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, fading] of this.fadingMissiles) {
      const elapsed = now - fading.fadeStartTime;
      const progress = Math.min(1, elapsed / fading.fadeDuration);

      if (progress >= 1) {
        // Fade complete - remove
        toRemove.push(id);
        continue;
      }

      // Ease-out for smooth deceleration
      const easedProgress = 1 - Math.pow(1 - progress, 2);

      // Fade out the missile head
      fading.objects.head.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material) {
          const mat = child.material as THREE.MeshBasicMaterial;
          if (mat.transparent !== undefined) {
            mat.transparent = true;
            mat.opacity = 1 - easedProgress;
          }
        }
      });

      // Shrink trail toward impact point
      if (fading.trailPoints.length > 1) {
        const numPoints = fading.trailPoints.length;
        // Calculate how many points to keep (shrinking from start toward end)
        const keepRatio = 1 - easedProgress;
        const pointsToRemove = Math.floor(numPoints * easedProgress);
        const remainingPoints = fading.trailPoints.slice(pointsToRemove);

        if (remainingPoints.length >= 2) {
          // Update trail geometry
          const positions = new Float32Array(remainingPoints.length * 3);
          for (let i = 0; i < remainingPoints.length; i++) {
            positions[i * 3] = remainingPoints[i].x;
            positions[i * 3 + 1] = remainingPoints[i].y;
            positions[i * 3 + 2] = remainingPoints[i].z;
          }
          fading.objects.trail.geometry.setAttribute(
            'position',
            new THREE.BufferAttribute(positions, 3)
          );
          fading.objects.trail.geometry.attributes.position.needsUpdate = true;
        }

        // Also fade the trail (start from normal opacity of 0.35, not 1.0)
        const trailMat = fading.objects.trail.material as THREE.LineBasicMaterial;
        if (trailMat) {
          trailMat.transparent = true;
          trailMat.opacity = 0.35 * (1 - easedProgress);
        }
      }

      // Animate explosion sphere (pulse and fade)
      if (fading.objects.explosionSphere) {
        const explosionMat = fading.objects.explosionSphere.material as THREE.MeshBasicMaterial;
        // Pulse size: start at 1, grow to 2, then shrink
        const pulseProgress = progress < 0.3 ? progress / 0.3 : 1 - (progress - 0.3) / 0.7;
        const scale = 1 + pulseProgress * 1.5;
        fading.objects.explosionSphere.scale.setScalar(scale);
        // Fade out
        explosionMat.opacity = 1 - easedProgress;
      }

      // Missile head stays in place (no movement toward impact)
    }

    // Remove completed fades
    for (const id of toRemove) {
      const fading = this.fadingMissiles.get(id);
      if (fading) {
        // Dispose and remove
        this.missileGroup.remove(fading.objects.trail);
        this.missileGroup.remove(fading.objects.head);
        fading.objects.trail.geometry.dispose();
        (fading.objects.trail.material as THREE.Material).dispose();
        fading.objects.head.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (child.material) {
              (child.material as THREE.Material).dispose();
            }
          }
        });
        // Dispose explosion sphere
        if (fading.objects.explosionSphere) {
          this.missileGroup.remove(fading.objects.explosionSphere);
          fading.objects.explosionSphere.geometry.dispose();
          (fading.objects.explosionSphere.material as THREE.Material).dispose();
        }
        this.fadingMissiles.delete(id);

        // Clean up stage markers for this missile
        this.disposeStageMarkers(id);
      }
    }
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
    if (!this.gameState) return true;

    // Early-game fallback: if player has no radars AND no satellites, show everything
    // This ensures AI cities are visible before the player builds any detection infrastructure
    const playerRadars = getBuildings(this.gameState).filter(
      b => b.type === 'radar' && b.ownerId === this.playerId && !b.destroyed
    );
    const playerSatellites = getSatellites(this.gameState).filter(
      s => s.ownerId === this.playerId && !s.destroyed
    );
    if (playerRadars.length === 0 && playerSatellites.length === 0) {
      return true;
    }

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

  /**
   * Get the 3D position of a missile for camera tracking.
   * Works with physics missiles, rail interceptors, guided interceptors, legacy interceptors, and ICBMs.
   */
  private getMissile3DPositionForTracking(missile: Missile | PhysicsMissile | RailInterceptor | GuidedInterceptor): THREE.Vector3 | null {
    const now = Date.now();

    // Guided interceptors use server-provided position
    if (isGuidedInterceptor(missile)) {
      const guidedMissile = missile as GuidedInterceptor;
      const geoPos = guidedMissile.geoPosition || guidedMissile.geoCurrentPosition;
      if (geoPos) {
        const altitude = guidedMissile.altitude || guidedMissile.currentAltitude || 0;
        const pos = geoToSphere(geoPos, GLOBE_RADIUS + altitude);
        return new THREE.Vector3(pos.x, pos.y, pos.z);
      }
      return null;
    }

    // Rail interceptors use pre-calculated rail path
    if (isRailInterceptor(missile)) {
      const railMissile = missile as RailInterceptor;
      if (railMissile.status === 'missed' && railMissile.missBehavior) {
        // Use current position during miss coast
        if (railMissile.geoCurrentPosition) {
          const altitude = railMissile.currentAltitude || 0;
          const pos = geoToSphere(railMissile.geoCurrentPosition, GLOBE_RADIUS + altitude);
          return new THREE.Vector3(pos.x, pos.y, pos.z);
        }
      }
      const pos = getInterceptorPosition3D(
        railMissile.rail.startGeo,
        railMissile.rail.endGeo,
        railMissile.progress,
        railMissile.rail.apexHeight,
        railMissile.rail.endAltitude,
        GLOBE_RADIUS
      );
      return new THREE.Vector3(pos.x, pos.y, pos.z);
    }

    // Physics missiles have direct 3D position
    if (isPhysicsMissile(missile)) {
      const pos = this.getInterpolatedPhysicsPosition(missile, now);
      return new THREE.Vector3(pos.x, pos.y, pos.z);
    }

    // For legacy missiles, get geo position and convert
    const legacyMissile = missile as Missile;
    const missileGeo = legacyMissile.geoCurrentPosition
      || (legacyMissile.currentPosition ? this.pixelToGeoFallback(legacyMissile.currentPosition) : null);

    if (!missileGeo) return null;

    // For ICBMs, calculate actual 3D position with altitude
    if (legacyMissile.type === 'icbm' && legacyMissile.geoLaunchPosition && legacyMissile.geoTargetPosition) {
      const maxAltitude = legacyMissile.apexHeight || 30;
      const flightDuration = legacyMissile.flightDuration || 30000;
      const seed = legacyMissile.id.charCodeAt(0);
      const pos = getMissilePosition3D(
        legacyMissile.geoLaunchPosition,
        legacyMissile.geoTargetPosition,
        legacyMissile.progress,
        maxAltitude,
        GLOBE_RADIUS,
        flightDuration,
        seed
      );
      return new THREE.Vector3(pos.x, pos.y, pos.z);
    }

    // For interceptors and others, use current geo position at estimated altitude
    const progress = legacyMissile.progress || 0;
    const apexHeight = legacyMissile.apexHeight || 20;
    // Parabolic altitude based on progress
    const altitude = 4 * apexHeight * progress * (1 - progress);
    const pos = geoToSphere(missileGeo, GLOBE_RADIUS + altitude);
    return new THREE.Vector3(pos.x, pos.y, pos.z);
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

  private handleMouseDown = (event: MouseEvent): void => {
    this.mouseDownPosition = { x: event.clientX, y: event.clientY };
  };

  private handleClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Check if this was a drag (mouse moved too much since mousedown)
    if (this.mouseDownPosition) {
      const dx = event.clientX - this.mouseDownPosition.x;
      const dy = event.clientY - this.mouseDownPosition.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      this.mouseDownPosition = null; // Reset for next click

      if (distance > this.DRAG_THRESHOLD) {
        return; // This was a drag, not a click - ignore
      }
    }

    // Check if click is over HUD first
    if (this.hudRenderer.handleClick(canvasX, canvasY)) {
      return; // Click handled by HUD
    }

    this.mouse.x = (canvasX / rect.width) * 2 - 1;
    this.mouse.y = -(canvasY / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // In placement mode, skip all object click handling that would move the camera.
    // Only allow globe clicks to proceed for building placement.
    if (this.placementMode) {
      const globeIntersects = this.raycaster.intersectObject(this.globe);
      if (globeIntersects.length > 0) {
        this.selectedCityInfo = null;
        if (this.onClickCallback) {
          const point = globeIntersects[0].point;
          const geoPos = this.spherePointToGeo(point);
          this.onClickCallback(geoPos);
        }
      }
      return;
    }

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
          // Get missile position and center on it
          if (this.gameState) {
            const missiles = getMissiles(this.gameState);
            const missile = missiles.find(m => m.id === missileId);
            if (missile) {
              const geoPos = missile.geoCurrentPosition
                || (missile.currentPosition ? this.pixelToGeoFallback(missile.currentPosition) : { lat: 0, lng: 0 });
              this.centerCameraOnGeo(geoPos);

              // Check if this is an enemy ICBM - offer manual intercept
              const isEnemyICBM = missile.ownerId !== this.playerId &&
                                  missile.type === 'icbm' &&
                                  !missile.detonated &&
                                  !missile.intercepted;

              if (isEnemyICBM && this.onEnemyICBMClickCallback) {
                // Trigger manual intercept UI
                this.onEnemyICBMClickCallback(missileId);
              }

              // Track the missile
              this.trackedMissileId = missileId;
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
      // Clicked on satellite orbit/vision/link but not body - don't fall through to clear selection
      return;
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
      while (obj && obj.userData?.type !== 'city' && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.type === 'city') {
        const cityData = obj.userData;
        // Get geo position from CITY_GEO_DATA
        const territoryId = cityData.territoryId;
        const cityName = cityData.name;
        const citiesInTerritory = CITY_GEO_DATA[territoryId];
        const cityGeoData = citiesInTerritory?.find(c => c.name === cityName);

        // If a building is selected (silo targeting), pass click to callback instead
        if (this.selectedBuilding && cityGeoData && this.onClickCallback) {
          this.onClickCallback(cityGeoData.position);
          return;
        }

        // Otherwise, normal city selection behavior
        this.trackedMissileId = null;
        if (cityGeoData) {
          this.centerCameraOnGeo(cityGeoData.position);
          // Show city info in HUD
          this.selectedCityInfo = {
            name: cityName,
            population: cityData.population,
            territoryId: territoryId,
          };
        }
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
    if (globeIntersects.length > 0) {
      // Clear city selection when clicking on globe
      this.selectedCityInfo = null;
      if (this.onClickCallback) {
        const point = globeIntersects[0].point;
        const geoPos = this.spherePointToGeo(point);
        this.onClickCallback(geoPos);
      }
    }
  };

  getSelectedCityInfo(): { name: string; population: number; territoryId: string } | null {
    return this.selectedCityInfo;
  }

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

    // Flush any pending OrbitControls state (zoom scale, rotation deltas) before animation
    // This prevents accumulated scroll wheel zoom from being applied at animation end
    // Must be done BEFORE capturing startPos so we animate from the flushed position
    this.controls.update();

    // Calculate target camera position (looking at the point from outside)
    const startPos = this.camera.position.clone();
    const startDist = startPos.length();
    const endDist = distance || startDist;
    let targetPos = geoToSphere(geoPos, endDist);
    let endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);

    // Use spherical interpolation (SLERP) for direction to follow globe surface
    const startDir = startPos.clone().normalize();
    let endDir = endPos.clone().normalize();

    const startTime = performance.now();
    const duration = 800; // ms

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      // Ease out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - t, 3);

      // If tracking a missile, update target to missile's current position
      // This ensures smooth handoff when animation ends
      if (this.trackedMissileId && this.gameState) {
        const missiles = getMissiles(this.gameState);
        const trackedMissile = missiles.find(m => m.id === this.trackedMissileId);
        if (trackedMissile && !trackedMissile.detonated && !trackedMissile.intercepted) {
          const missile3DPos = this.getMissile3DPositionForTracking(trackedMissile);
          if (missile3DPos) {
            endDir = missile3DPos.clone().normalize();
            // Update geoPos for the animation end target
            geoPos = trackedMissile.geoCurrentPosition
              || (trackedMissile.currentPosition ? this.pixelToGeoFallback(trackedMissile.currentPosition) : geoPos);
          }
        }
      }

      // SLERP for direction (stays on sphere surface, arcs over globe)
      const angle = startDir.angleTo(endDir);
      let currentDir: THREE.Vector3;
      if (angle > 0.01) {
        // Use SLERP formula: (sin((1-t)*θ)/sin(θ))*v0 + (sin(t*θ)/sin(θ))*v1
        const sinAngle = Math.sin(angle);
        const s0 = Math.sin((1 - eased) * angle) / sinAngle;
        const s1 = Math.sin(eased * angle) / sinAngle;
        currentDir = startDir.clone().multiplyScalar(s0)
          .addScaledVector(endDir, s1).normalize();
      } else {
        // For very small angles, linear interpolation is fine
        currentDir = startDir.clone().lerp(endDir, eased).normalize();
      }

      // Lerp distance separately
      const currentDist = startDist + (endDist - startDist) * eased;
      this.camera.position.copy(currentDir).multiplyScalar(currentDist);
      this.camera.lookAt(0, 0, 0);

      // Reset orbit target to origin during animation to prevent drift
      this.controls.target.set(0, 0, 0);

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation complete
        this.cameraAnimating = false;
        this.cameraAnimationStabilizeFrames = 5; // Skip updates for 5 frames to stabilize

        const finalDist = this.camera.position.length();

        // Set VERY permissive constraints to prevent any clamping during sync
        this.controls.minDistance = 1;
        this.controls.maxDistance = 1000;
        const savedMinPolar = this.controls.minPolarAngle;
        const savedMaxPolar = this.controls.maxPolarAngle;
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = Math.PI;

        // Set target to the current missile position (or where we animated to)
        // This minimizes the jump when tracking starts
        const targetOnSurface = geoToSphere(geoPos, GLOBE_RADIUS);
        this.controls.target.set(targetOnSurface.x, targetOnSurface.y, targetOnSurface.z);

        // Re-enable controls
        this.controls.enabled = true;

        // Save the desired camera state BEFORE any updates
        const savedCameraPos = this.camera.position.clone();
        const savedCameraQuat = this.camera.quaternion.clone();

        // Call update() with damping disabled to flush any stale OrbitControls state
        const wasDamping = this.controls.enableDamping;
        this.controls.enableDamping = false;
        this.controls.update();

        // FORCE camera back to the saved state
        this.camera.position.copy(savedCameraPos);
        this.camera.quaternion.copy(savedCameraQuat);

        // Call update() AGAIN to make OrbitControls adopt this state
        this.controls.update();

        // Restore camera state one final time in case update() changed it
        this.camera.position.copy(savedCameraPos);
        this.camera.quaternion.copy(savedCameraQuat);

        this.controls.enableDamping = wasDamping;

        // Restore polar angle constraints
        this.controls.minPolarAngle = savedMinPolar;
        this.controls.maxPolarAngle = savedMaxPolar;

        // Restore reasonable distance constraints (still permissive for current distance)
        this.controls.minDistance = Math.min(finalDist * 0.5, 120);
        this.controls.maxDistance = Math.max(finalDist * 2, 500);
      }
    };

    // Disable OrbitControls during animation to prevent conflicts
    this.controls.enabled = false;
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

      // Follow tracked missile if one is selected
      // Update both orbit target AND camera position to follow the missile
      if (this.trackedMissileId && this.gameState && !this.cameraAnimating) {
        const missiles = getMissiles(this.gameState);
        const trackedMissile = missiles.find(m => m.id === this.trackedMissileId);
        if (trackedMissile && !trackedMissile.detonated && !trackedMissile.intercepted) {
          // Get the missile's 3D position
          const missile3DPos = this.getMissile3DPositionForTracking(trackedMissile);
          if (missile3DPos) {
            // Skip target/camera movement while stabilizing after animation
            if (this.cameraAnimationStabilizeFrames === 0) {
              // Update orbit target with fast lerp for responsive tracking
              this.controls.target.lerp(missile3DPos, 0.5);

              // Adjust camera to look at new target while maintaining distance from ORIGIN
              // (not distance from target, which would cause zoom drift)
              const beforeDist = this.camera.position.length();
              const cameraDir = this.camera.position.clone().normalize();
              const targetDir = this.controls.target.clone().normalize();
              cameraDir.lerp(targetDir, 0.1);
              cameraDir.normalize();
              this.camera.position.copy(cameraDir.multiplyScalar(beforeDist));
            }
          }
        } else {
          // Missile no longer exists, stop tracking
          this.trackedMissileId = null;
        }
      }

      // Update camera to follow selected satellite
      // Update both orbit target AND camera position to follow the satellite
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

          // Skip target/camera movement while stabilizing after animation
          if (this.cameraAnimationStabilizeFrames === 0) {
            const beforeDist = this.camera.position.length();

            // Update orbit target with fast lerp for responsive tracking
            this.controls.target.lerp(satVec, 0.5);

            // Adjust camera to look at new target while maintaining distance from ORIGIN
            const cameraDir = this.camera.position.clone().normalize();
            const targetDir = this.controls.target.clone().normalize();
            cameraDir.lerp(targetDir, 0.1);
            cameraDir.normalize();
            this.camera.position.copy(cameraDir.multiplyScalar(beforeDist));
          }
        } else {
          // Satellite was destroyed, clear selection and return to origin
          this.selectedSatelliteId = null;
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }
      }

      // Skip all orbit controls updates during camera animation
      if (!this.cameraAnimating) {
        // Return orbit target to globe center when nothing is being tracked
        const isTrackingAnything = this.trackedMissileId || this.selectedSatelliteId;
        if (!isTrackingAnything && !this.controls.target.equals(new THREE.Vector3(0, 0, 0))) {
          // Smoothly return to origin (globe center)
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }

        // When tracking, we handle camera position manually - skip controls.update() to avoid rotation drift
        // Only call controls.update() when NOT tracking to allow normal orbit controls behavior
        if (!isTrackingAnything) {
          if (this.cameraAnimationStabilizeFrames === 0) {
            this.controls.update();
          }
        } else if (this.cameraAnimationStabilizeFrames === 0) {
          // When tracking, smoothly rotate camera toward target instead of snapping
          // This prevents the jerk when tracking starts after camera animation completes
          const targetQuat = new THREE.Quaternion();
          const tempCamera = this.camera.clone();
          tempCamera.lookAt(this.controls.target);
          targetQuat.copy(tempCamera.quaternion);

          // SLERP toward the target rotation for smooth tracking
          this.camera.quaternion.slerp(targetQuat, 0.1);
        }

        // Adjust camera constraints based on tracking state
        if (isTrackingAnything) {
          const currentDist = this.camera.position.distanceTo(this.controls.target);
          const targetDist = this.controls.target.length();
          // minDistance is camera-to-target distance, not camera-to-origin
          // To prevent camera clipping through globe when between target and origin:
          // |camera| = targetDist - cameraDist >= GLOBE_RADIUS + buffer
          // So: cameraDist <= targetDist - GLOBE_RADIUS - buffer
          const buffer = 20;
          const maxSafeMinDist = Math.max(20, targetDist - GLOBE_RADIUS - buffer);
          // Use a reasonable viewing distance, capped to prevent clipping
          this.controls.minDistance = Math.min(40, maxSafeMinDist);
          // Allow current distance, but cap at reasonable max
          this.controls.maxDistance = Math.max(200, currentDist * 1.1);
          this.controls.rotateSpeed = 0.3;
        } else {
          // Reset to defaults when not tracking, but don't force camera to snap out
          // by allowing the current camera distance as minimum
          const currentCameraDist = this.camera.position.length();
          this.controls.minDistance = Math.min(120, currentCameraDist * 0.95);
          this.controls.maxDistance = 500;
          this.controls.rotateSpeed = 0.5;
        }

        // Decrement stabilization counter
        if (this.cameraAnimationStabilizeFrames > 0) {
          this.cameraAnimationStabilizeFrames--;
        }
      }

      // Update radar sweep animation
      this.radarAngle += deltaTime * Math.PI * 0.5;
      this.animateRadarSweeps();

      // Update game objects
      this.updateGameObjects();

      // Update communication chain visualization (for tracked interceptor)
      this.updateCommunicationChain(deltaTime);

      // Update intercept prediction visualization (for tracked interceptor)
      this.updateInterceptPrediction();

      // Update fading missiles (post-detonation effects)
      this.updateFadingMissiles();

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
