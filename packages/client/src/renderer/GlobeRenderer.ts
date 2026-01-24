import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ConicPolygonGeometry from 'three-conic-polygon-geometry';
import { soundEffects } from '../audio/SoundEffects';
import {
  type GameState,
  type Building,
  type Missile,
  type GuidedInterceptor,
  type Aircraft,
  type AircraftType,
  type City,
  type Territory,
  type GeoPosition,
  type Silo,
  type SiloMode,
  type Radar,
  type Satellite,
  type SatelliteLaunchFacility,
  type Airfield,
  type HackingNode,
  type HackingConnection,
  type HackingRoute,
  type NetworkHackTrace,
  type HackingNetworkState,
  geoToSphere,
  sphereToGeo,
  getMissilePosition3D,
  getMissileDirection3D,
  geoInterpolate,
  greatCircleDistance,
  getTerritories,
  getCities,
  getBuildings,
  getMissiles,
  getSatellites,
  getAircraft,
  getSatellitePosition3D,
  getSatelliteGroundPosition,
  SatelliteOrbitalParams,
  TERRITORY_GEO_DATA,
  CITY_GEO_DATA,
  isGuidedInterceptor,
  isInterceptor as isInterceptorType,
  GLOBAL_MISSILE_SPEED_MULTIPLIER,
  createConnectionId,
  getRouteSegmentProgress,
  getIcbmAltitude,
  calculateBearing,
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
  // Hacking network colors
  hackingNode: 0x00ffff,
  hackingNodeGlow: 0x00aaff,
  hackingConnection: 0x004466,
  hackingConnectionActive: 0x00aaff,
  hackingTrace: 0x00ff88,
  hackingTraceGlow: 0x00ffaa,
};

// Player color mapping (for spectator/demo mode with multiple distinct players)
const PLAYER_COLOR_MAP: Record<string, number> = {
  green: 0x00ff88,
  red: 0xff4444,
  blue: 0x4488ff,
  yellow: 0xffcc00,
  cyan: 0x00ffff,
  magenta: 0xff44ff,
};

const GLOBE_RADIUS = 100;
const MISSILE_MIN_ALTITUDE = 8;  // Minimum altitude for very short flights
const MISSILE_MAX_ALTITUDE = 50; // Maximum altitude for intercontinental flights (higher for more dramatic arcs)

// Satellite configuration (should match server SATELLITE_CONFIG)
const SATELLITE_ORBITAL_ALTITUDE = 120;  // Globe units above surface (above interceptor range)
const SATELLITE_VISION_RANGE_DEGREES = 12;
const SATELLITE_RADAR_COMM_RANGE = 90;  // Range to communicate with radar (degrees) - line of sight from orbit
const SATELLITE_SAT_COMM_RANGE = 90;    // Range for satellite-to-satellite relay (degrees)

// Hacking network configuration
const HACKING_CONNECTION_HEIGHT = 15;   // Height above globe for connection arcs
const HACKING_NODE_PULSE_SPEED = 2;     // Pulse animation speed
const HACKING_TRACE_SEGMENTS = 64;      // Number of segments for curved paths
const HACKING_TRACE_HEAD_LENGTH = 0.08; // Length of the trace head (0-1)

// DDoS multi-trace configuration - network flooding simulation
const DDOS_MAX_PARTICLES = 1024;        // Maximum particles (branches: 1->2->4->...->1024)
const DDOS_TRACE_SIZE = 0.75;           // Size of trace dots
const DDOS_TRACE_SPEED = 25;            // Constant speed in globe units per second
const DDOS_COLOR = 0xffaa00;            // Bright orange for attack visualization

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
  private deltaTime = 0; // Current frame delta time in seconds
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
  private hackingNetworkGroup: THREE.Group;

  // View toggles state
  private viewToggles = {
    radar: true,
    grid: true,
    labels: true,
    trails: true,
    coastlines: true,
    borders: true,
    airspaces: false,
    network: false,
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

  // Hacking network visualization state
  private hackingNetworkState: HackingNetworkState | null = null;
  private hackingNodeMarkers = new Map<string, THREE.Group>();
  private hackingConnectionLines = new Map<string, THREE.Line>();
  private hackingActiveTraces = new Map<string, {
    traceHead: THREE.Mesh;
    traceLine: THREE.Line;
    tracePoints: THREE.Vector3[];  // Pre-calculated curve points
    glowLine: THREE.Line;
    // Counter-trace (trace-back from target to source)
    counterTraceHead: THREE.Mesh;
    counterTraceLine: THREE.Line;
    counterGlowLine: THREE.Line;
  }>();
  private hackingAnimationTime = 0;
  // Smoothed display progress for each hack (lerps toward server progress)
  private hackingDisplayProgress = new Map<string, { progress: number; traceProgress: number }>();
  // DDoS multi-trace system for flood visualization
  private ddosTraces = new Map<string, {
    traceHeads: THREE.Mesh[];           // Array of small spheres (pool)
    activeCount: number;                // How many particles are currently active
    particleStates: Array<{
      active: boolean;                  // Is this particle slot active?
      currentNodeId: string;            // Node we're at/heading from
      nextNodeId: string;               // Next destination
      progress: number;                 // 0-1 along current edge
      edgeDistance: number;             // Distance of current edge in globe units
      speedMultiplier: number;          // Per-particle speed variation (0.5-1.5)
      visitedNodes: Set<string>;        // Nodes this particle has visited (avoid backtracking)
      routeIndex: number;               // Index in routeNodeIds (-1 = off-route particle)
    }>;
    sourceNodeId: string;
    targetNodeId: string;
    routeNodeIds: string[];             // The intended path to follow
    geometry: THREE.SphereGeometry;     // Shared geometry
    material: THREE.MeshBasicMaterial;  // Shared material template
    lastSpawnTime: number;              // Last time a particle was spawned from source
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
  private missileRadarStatus = new Map<string, boolean>(); // Track radar coverage for LOS markers
  private icbmMarkerProgress = new Map<string, Set<string>>(); // Track which ICBM markers have been added

  // Dropped booster stages (visual effect at BECO)
  private droppedBoosters = new Map<string, {
    mesh: THREE.Group;
    trail: THREE.Line;
    startGeo: GeoPosition;
    startAltitude: number;       // Altitude at separation (globe units)
    initialVelocityUp: number;   // Initial upward velocity (globe units/sec) - usually positive, then gravity takes over
    initialVelocityForward: number; // Initial forward velocity (degrees/sec along great circle)
    heading: number;             // Direction of forward movement (degrees)
    startTime: number;
    duration: number;            // How long until it hits the ground (ms)
    trailHistory: THREE.Vector3[]; // Actual positions traveled
  }>();

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
  private onBuildingClickCallback: ((building: Building | null) => void) | null = null;
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
  // Linked target ICBM (auto-selected when clicking an interceptor with a target)
  private linkedTargetId: string | null = null;
  private cameraTargetGeo: GeoPosition | null = null;
  private cameraAnimating: boolean = false;
  private cameraAnimationStabilizeFrames: number = 0;

  // Communication chain visualization (shown when interceptor is selected)
  private commChainGroup: THREE.Group;
  private commChainLines: THREE.Line[] = [];
  private commChainPackets: THREE.Mesh[] = [];
  private packetAnimationTime: number = 0;

  // ICBM tracking visualization (shown when enemy ICBM is selected)
  private icbmTrackingGroup: THREE.Group;
  private icbmTrackingLines: THREE.Line[] = [];
  private icbmTrackingSpheres: THREE.Mesh[] = [];
  private icbmTrackingAnimationTime: number = 0;

  // Satellite-Radar communication links (shown when satellite or radar is selected)
  private satCommGroup: THREE.Group;
  private satCommLines: THREE.Line[] = [];

  // Aircraft rendering
  private aircraftGroup: THREE.Group;
  private aircraftObjects = new Map<string, {
    mesh: THREE.Group;
    waypointLine?: THREE.Line;
  }>();
  private selectedAircraftId: string | null = null;

  // Intercept prediction visualization (shown when interceptor is tracked)
  private interceptPredictionGroup: THREE.Group;
  private interceptMarker: THREE.Group | null = null;
  private perceivedInterceptMarker: THREE.Group | null = null;
  private interceptChanceLabel: THREE.Sprite | null = null;
  private flameoutMarker: THREE.Group | null = null;
  private missileStatsLabel: THREE.Sprite | null = null;
  private interceptorProjectedPath: THREE.Line | null = null;
  private targetIcbmProjectedPath: THREE.Line | null = null;

  // Fog of war toggle (for debug mode)
  private fogOfWarDisabled: boolean = false;

  // Fog of war expansion animation state
  private radarAnimatedRanges: number[] = new Array(8).fill(0);
  private satelliteAnimatedRanges: number[] = new Array(8).fill(0);
  private radarTargetRanges: number[] = new Array(8).fill(0);
  private satelliteTargetRanges: number[] = new Array(8).fill(0);
  private lastRadarIds: Set<string> = new Set();
  private lastSatelliteIds: Set<string> = new Set();
  private readonly VISION_EXPAND_SPEED = 0.8; // Range units per second (~0.6s to full)

  // Hero text for landing page (3D text that can be occluded by globe)
  private heroTextGroup: THREE.Group | null = null;
  private heroGlitchState: {
    subtitleCanvas: HTMLCanvasElement | null;
    subtitleCtx: CanvasRenderingContext2D | null;
    subtitleTexture: THREE.CanvasTexture | null;
    originalSubtitle: string;
    lastGlitchTime: number;
    isGlitching: boolean;
    glitchEndTime: number;
  } = {
    subtitleCanvas: null,
    subtitleCtx: null,
    subtitleTexture: null,
    originalSubtitle: 'GLOBAL THERMONUCLEAR WAR',
    lastGlitchTime: 0,
    isGlitching: false,
    glitchEndTime: 0,
  };

  // Demo camera mode (for landing page smooth scroll-driven camera)
  private demoCameraMode: boolean = false;
  private demoCameraTargets = {
    distance: 380,
    verticalOffset: 180,
    targetLat: 0,
    targetLng: 0,
    trackType: null as 'missile' | 'satellite' | 'radar' | null, // What to track (position-based, no selection)
    lerpFactor: 0.08, // Higher = snappier response
  };
  // Current interpolated camera state for spherical interpolation (prevents through-globe lerping)
  private demoCameraState = {
    currentLat: 25,
    currentLng: -90,
    currentDistance: 550,
  };
  // Persistent missile tracking for demo mode (avoids switching missiles mid-flight)
  private demoTrackedMissileId: string | null = null;
  // Force radar visibility for demo
  private forceRadarVisible: boolean = false;
  // Auto-rotation for demo mode (gentle globe drift)
  private demoAutoRotate: boolean = true;
  private demoAutoRotateSpeed: number = 0.02; // Degrees per frame
  private demoRotationOffset: number = 0; // Accumulated rotation offset

  constructor(container: HTMLElement) {
    this.container = container;

    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.background);

    // Create star field for atmosphere
    this.createStarField();

    // Camera
    const rect = container.getBoundingClientRect();
    this.camera = new THREE.PerspectiveCamera(
      45,
      rect.width / rect.height,
      0.1,
      10000
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
    this.controls.maxDistance = 2000;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    // Prevent gimbal lock - restrict vertical rotation
    this.controls.minPolarAngle = Math.PI * 0.02;  // ~4° from top (near north pole)
    this.controls.maxPolarAngle = Math.PI * 0.98;  // ~4° from bottom (near south pole)

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
    this.airspaceGroup.visible = this.viewToggles.airspaces;
    this.hackingNetworkGroup = new THREE.Group();
    this.hackingNetworkGroup.visible = this.viewToggles.network;

    this.placementPreviewGroup = new THREE.Group();
    this.commChainGroup = new THREE.Group();
    this.interceptPredictionGroup = new THREE.Group();
    this.satCommGroup = new THREE.Group();
    this.aircraftGroup = new THREE.Group();
    this.icbmTrackingGroup = new THREE.Group();

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
    this.scene.add(this.satCommGroup);
    this.scene.add(this.aircraftGroup);
    this.scene.add(this.hackingNetworkGroup);
    this.scene.add(this.icbmTrackingGroup);

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

  setOnBuildingClick(callback: (building: Building | null) => void): void {
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

  setOnLaunchAircraft(callback: (airfieldId: string, aircraftType: AircraftType, waypoints: GeoPosition[]) => void): void {
    this.hudRenderer.setAircraftCallbacks(callback);
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
    onDisableAI: () => void,
    onSetGameSpeed?: (speed: 1 | 2 | 5) => void
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
      },
      onSetGameSpeed
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

    // Reset animations when toggled on so visibility expands from sources
    if (enabled) {
      this.radarAnimatedRanges.fill(0);
      this.satelliteAnimatedRanges.fill(0);
      this.lastRadarIds.clear();
      this.lastSatelliteIds.clear();
    }
  }

  toggleDebugPanel(): void {
    this.hudRenderer.toggleDebugPanel();
  }

  // ============================================
  // Landing page / Demo mode controls
  // ============================================

  /**
   * Get color for a player by ownerId
   * In spectator/demo mode (playerId is null), returns the player's actual color
   * In game mode, returns friendly/enemy colors based on playerId
   */
  private getColorForOwner(ownerId: string | null): number {
    if (!ownerId) return COLORS.neutral;

    // In demo/spectator mode (no playerId), use actual player colors
    if (this.playerId === null && this.gameState) {
      const player = this.gameState.players[ownerId];
      if (player?.color) {
        return PLAYER_COLOR_MAP[player.color] || COLORS.neutral;
      }
    }

    // In game mode, use friendly/enemy coloring
    return ownerId === this.playerId ? COLORS.friendly : COLORS.enemy;
  }

  /**
   * Enable/disable interactive orbit controls
   * Used to lock the camera on the landing page
   */
  setInteractive(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /**
   * Set camera distance from globe center
   * Smoothly animates to the target distance
   */
  setCameraDistance(distance: number): void {
    const currentPos = this.camera.position.clone();
    const currentDist = currentPos.length();

    if (Math.abs(currentDist - distance) < 1) return;

    // Smoothly interpolate distance
    const newDist = currentDist + (distance - currentDist) * 0.05;
    currentPos.normalize().multiplyScalar(newDist);

    this.camera.position.copy(currentPos);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * Set camera target to look at a specific geographic location
   * Smoothly animates the camera to view that region
   */
  setCameraTarget(lat: number, lng: number): void {
    // Convert lat/lng to 3D position on sphere surface
    const phi = (90 - lat) * (Math.PI / 180);
    const theta = (lng + 180) * (Math.PI / 180);

    // Calculate target position on globe surface
    const targetX = -GLOBE_RADIUS * Math.sin(phi) * Math.cos(theta);
    const targetY = GLOBE_RADIUS * Math.cos(phi);
    const targetZ = GLOBE_RADIUS * Math.sin(phi) * Math.sin(theta);

    // Get current camera direction
    const currentPos = this.camera.position.clone();
    const currentDir = currentPos.clone().normalize();
    const currentDist = currentPos.length();

    // Target direction (looking at the target from outside)
    const targetDir = new THREE.Vector3(targetX, targetY, targetZ).normalize();

    // Smoothly interpolate camera direction
    const newDir = currentDir.lerp(targetDir, 0.03).normalize();
    const newPos = newDir.multiplyScalar(currentDist);

    this.camera.position.copy(newPos);
    this.camera.lookAt(0, 0, 0);
  }

  /**
   * Set camera position with vertical offset while looking above globe center
   * Used for landing page hero effect - camera looks above globe so globe appears at bottom
   * @param distance - Distance from origin
   * @param verticalOffset - Y offset (positive = look above globe, globe appears lower on screen)
   */
  setCameraPositionWithOffset(distance: number, verticalOffset: number): void {
    // Position camera on Z axis
    const targetPos = new THREE.Vector3(0, 0, distance);

    // Smoothly interpolate to target position
    this.camera.position.lerp(targetPos, 0.05);
    // Look above the globe center - this makes the globe appear in the lower part of the view
    this.camera.lookAt(0, verticalOffset, 0);
  }

  /**
   * Force network visibility state (for scroll-triggered demos)
   */
  forceNetworkVisible(visible: boolean): void {
    this.viewToggles.network = visible;
    this.hackingNetworkGroup.visible = visible;
    this.hudRenderer.setViewToggles(this.viewToggles);
  }

  /**
   * Enable demo camera mode - disables orbit controls and uses lerped scroll-driven camera
   */
  setDemoCameraMode(enabled: boolean): void {
    this.demoCameraMode = enabled;
    if (enabled) {
      this.controls.enabled = false;

      // Set initial camera position to match hero section starting values
      // This prevents the camera from lerping at startup
      const startDistance = 550;
      const startVerticalOffset = 180;
      const startLat = 25;
      const startLng = -90; // +Z axis (front of globe)

      // Use the SAME formula as the render loop to calculate position
      // This ensures no lerping is needed at startup
      const phi = (90 - startLat) * (Math.PI / 180);
      const theta = (startLng + 180) * (Math.PI / 180);

      const targetX = -GLOBE_RADIUS * Math.sin(phi) * Math.cos(theta);
      const targetY = GLOBE_RADIUS * Math.cos(phi);
      const targetZ = GLOBE_RADIUS * Math.sin(phi) * Math.sin(theta);
      const targetDir = new THREE.Vector3(targetX, targetY, targetZ).normalize();
      const cameraPos = targetDir.clone().multiplyScalar(startDistance);

      this.camera.position.copy(cameraPos);
      this.camera.lookAt(0, startVerticalOffset, 0);

      // Also initialize the demo camera targets to match
      this.demoCameraTargets.distance = startDistance;
      this.demoCameraTargets.verticalOffset = startVerticalOffset;
      this.demoCameraTargets.targetLat = startLat;
      this.demoCameraTargets.targetLng = startLng;

      // Initialize demo camera state to match (for spherical interpolation)
      this.demoCameraState.currentLat = startLat;
      this.demoCameraState.currentLng = startLng;
      this.demoCameraState.currentDistance = startDistance;

      // Reset rotation offset so it doesn't affect initial position
      this.demoRotationOffset = 0;
    }
  }

  /**
   * Set demo camera target parameters - camera will smoothly lerp to these
   * Used for scroll-driven landing page cinematic camera
   */
  setDemoCameraTarget(params: {
    distance?: number;
    verticalOffset?: number;
    targetLat?: number;
    targetLng?: number;
    trackType?: 'missile' | 'satellite' | 'radar' | null;
    lerpFactor?: number;
  }): void {
    if (params.distance !== undefined) {
      this.demoCameraTargets.distance = params.distance;
    }
    if (params.verticalOffset !== undefined) {
      this.demoCameraTargets.verticalOffset = params.verticalOffset;
    }
    if (params.targetLat !== undefined) {
      this.demoCameraTargets.targetLat = params.targetLat;
    }
    if (params.targetLng !== undefined) {
      this.demoCameraTargets.targetLng = params.targetLng;
    }
    if (params.trackType !== undefined) {
      this.demoCameraTargets.trackType = params.trackType;
    }
    if (params.lerpFactor !== undefined) {
      this.demoCameraTargets.lerpFactor = params.lerpFactor;
    }
  }

  /**
   * Force radar coverage visibility for demo (independent of view toggles)
   */
  setForceRadarVisible(visible: boolean): void {
    this.forceRadarVisible = visible;
  }

  /**
   * Control demo auto-rotation
   */
  setDemoAutoRotate(enabled: boolean, speed?: number): void {
    this.demoAutoRotate = enabled;
    if (speed !== undefined) {
      this.demoAutoRotateSpeed = speed;
    }
  }

  /**
   * Reset demo rotation offset (e.g., when entering a new section)
   */
  resetDemoRotationOffset(): void {
    this.demoRotationOffset = 0;
  }

  /**
   * Check if a missile is still valid for tracking
   * Returns true if the missile exists, is still in flight, and has valid position data
   */
  isMissileValidForTracking(missileId: string): boolean {
    if (!this.gameState) return false;
    const missiles = getMissiles(this.gameState);
    const missile = missiles.find(m => m.id === missileId);
    if (!missile) return false;
    // Check basic state
    if (missile.detonated || missile.intercepted || (missile.progress ?? 0) >= 0.95) return false;
    // Check for valid geo position data (required for 3D tracking)
    if (!missile.geoLaunchPosition || !missile.geoTargetPosition) return false;
    return true;
  }

  /**
   * Get an active missile ID for demo tracking
   * Returns an ICBM that is still in flight and in a good viewing position
   * Prefers missiles in the North Atlantic area to avoid camera spinning around the globe
   */
  getActiveMissileIdForDemo(): string | null {
    if (!this.gameState) return null;
    const missiles = getMissiles(this.gameState);

    // Filter for active ICBMs with valid geo data for 3D tracking
    // Use very permissive progress range - we'll prefer mid-flight missiles via scoring
    const activeMissiles = missiles.filter(m =>
      m.type === 'icbm' &&
      !m.detonated &&
      !m.intercepted &&
      (m.progress ?? 0) > 0.02 && // Just needs to have launched
      (m.progress ?? 0) < 0.95 && // Not yet impacted
      m.geoLaunchPosition && // Required for 3D position calculation
      m.geoTargetPosition    // Required for 3D position calculation
    );

    if (activeMissiles.length === 0) return null;

    // Score missiles - prefer ones in good viewing position with flight time remaining
    // Lower score = better
    const scoredMissiles = activeMissiles.map(m => {
      const pos = m.geoCurrentPosition || m.geoLaunchPosition;
      if (!pos) return { missile: m, score: 1000 }; // No position = bad score

      const progress = m.progress ?? 0;

      // Prefer mid-flight missiles (not too early, not too late)
      // Ideal progress is around 0.3-0.6
      const progressScore = Math.abs(progress - 0.45) * 100;

      // Prefer missiles with more flight time remaining
      const timeRemaining = Math.max(0, 0.95 - progress) * 30;

      // Small penalty for missiles on far side of globe (but don't exclude them)
      let locationPenalty = 0;
      if (pos.lng > 120 || pos.lng < -170) {
        locationPenalty = 50; // Mild penalty, not exclusion
      }

      const score = progressScore + locationPenalty - timeRemaining;
      return { missile: m, score };
    });

    // Sort by score (lowest = best) and return the best one
    scoredMissiles.sort((a, b) => a.score - b.score);
    return scoredMissiles[0]?.missile.id || null;
  }

  /**
   * Create star field background for atmospheric effect
   */
  private createStarField(): void {
    const starCount = 2000;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      // Distribute stars in a sphere around the scene
      const radius = 1500 + Math.random() * 2000;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);

      // Vary star sizes
      sizes[i] = 0.5 + Math.random() * 2;

      // Subtle color variation (mostly white with hints of blue/yellow)
      const colorVariation = Math.random();
      if (colorVariation < 0.7) {
        // White stars
        colors[i * 3] = 0.8 + Math.random() * 0.2;
        colors[i * 3 + 1] = 0.8 + Math.random() * 0.2;
        colors[i * 3 + 2] = 0.8 + Math.random() * 0.2;
      } else if (colorVariation < 0.85) {
        // Slightly blue
        colors[i * 3] = 0.6 + Math.random() * 0.2;
        colors[i * 3 + 1] = 0.7 + Math.random() * 0.2;
        colors[i * 3 + 2] = 0.9 + Math.random() * 0.1;
      } else {
        // Slightly yellow/orange
        colors[i * 3] = 0.9 + Math.random() * 0.1;
        colors[i * 3 + 1] = 0.8 + Math.random() * 0.15;
        colors[i * 3 + 2] = 0.5 + Math.random() * 0.2;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1.5,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
    });

    const stars = new THREE.Points(geometry, material);
    this.scene.add(stars);
  }

  /**
   * Create 3D hero text for landing page
   * Text is rendered to a canvas and applied to planes positioned in 3D space
   */
  createHeroText(): void {
    if (this.heroTextGroup) return; // Already created

    this.heroTextGroup = new THREE.Group();

    // Create main title "DEFCON" - classic terminal style like the original game
    const titleCanvas = document.createElement('canvas');
    const titleCtx = titleCanvas.getContext('2d')!;
    titleCanvas.width = 2048;
    titleCanvas.height = 512;

    titleCtx.clearRect(0, 0, titleCanvas.width, titleCanvas.height);

    // Clean, stark typography - like the original DEFCON game
    titleCtx.font = '900 280px "Helvetica Neue", "Arial", sans-serif';
    titleCtx.textAlign = 'center';
    titleCtx.textBaseline = 'middle';

    // Subtle outer glow - understated
    titleCtx.shadowColor = 'rgba(255, 255, 255, 0.15)';
    titleCtx.shadowBlur = 60;
    titleCtx.fillStyle = '#ffffff';
    titleCtx.fillText('DEFCON', titleCanvas.width / 2, titleCanvas.height / 2);

    // Main text - clean white with slight transparency
    titleCtx.shadowColor = 'rgba(255, 255, 255, 0.3)';
    titleCtx.shadowBlur = 8;
    titleCtx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    titleCtx.fillText('DEFCON', titleCanvas.width / 2, titleCanvas.height / 2);

    const titleTexture = new THREE.CanvasTexture(titleCanvas);
    titleTexture.needsUpdate = true;
    const titleMaterial = new THREE.MeshBasicMaterial({
      map: titleTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const titleGeometry = new THREE.PlaneGeometry(200, 50);
    const titleMesh = new THREE.Mesh(titleGeometry, titleMaterial);
    titleMesh.position.set(0, -20, 0);
    this.heroTextGroup.add(titleMesh);

    // Create subtitle "GLOBAL THERMONUCLEAR WAR" - terminal style with glitch support
    const subtitleCanvas = document.createElement('canvas');
    const subtitleCtx = subtitleCanvas.getContext('2d')!;
    subtitleCanvas.width = 2048;
    subtitleCanvas.height = 128;

    // Store for glitch updates
    this.heroGlitchState.subtitleCanvas = subtitleCanvas;
    this.heroGlitchState.subtitleCtx = subtitleCtx;
    this.heroGlitchState.originalSubtitle = 'GLOBAL THERMONUCLEAR WAR';

    this.drawSubtitleText(subtitleCtx, subtitleCanvas, this.heroGlitchState.originalSubtitle);

    const subtitleTexture = new THREE.CanvasTexture(subtitleCanvas);
    this.heroGlitchState.subtitleTexture = subtitleTexture;
    const subtitleMaterial = new THREE.MeshBasicMaterial({
      map: subtitleTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const subtitleGeometry = new THREE.PlaneGeometry(200, 14);
    const subtitleMesh = new THREE.Mesh(subtitleGeometry, subtitleMaterial);
    subtitleMesh.position.set(0, -55, 0);
    this.heroTextGroup.add(subtitleMesh);

    // Create warning tagline - more ominous
    const taglineCanvas = document.createElement('canvas');
    const taglineCtx = taglineCanvas.getContext('2d')!;
    taglineCanvas.width = 2048;
    taglineCanvas.height = 128;

    taglineCtx.clearRect(0, 0, taglineCanvas.width, taglineCanvas.height);
    taglineCtx.font = '36px "Courier New", monospace';
    taglineCtx.textAlign = 'center';
    taglineCtx.textBaseline = 'middle';
    taglineCtx.fillStyle = '#ff4444';
    taglineCtx.fillText('« EVERYBODY DIES »', taglineCanvas.width / 2, taglineCanvas.height / 2);

    const taglineTexture = new THREE.CanvasTexture(taglineCanvas);
    const taglineMaterial = new THREE.MeshBasicMaterial({
      map: taglineTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const taglineGeometry = new THREE.PlaneGeometry(140, 10);
    const taglineMesh = new THREE.Mesh(taglineGeometry, taglineMaterial);
    taglineMesh.position.set(0, -78, 0);
    this.heroTextGroup.add(taglineMesh);

    // Create scroll hint - subtle
    const hintCanvas = document.createElement('canvas');
    const hintCtx = hintCanvas.getContext('2d')!;
    hintCanvas.width = 512;
    hintCanvas.height = 128;

    hintCtx.clearRect(0, 0, hintCanvas.width, hintCanvas.height);
    hintCtx.font = '28px "Courier New", monospace';
    hintCtx.textAlign = 'center';
    hintCtx.textBaseline = 'middle';
    hintCtx.fillStyle = '#00aa66';
    hintCtx.fillText('▼', hintCanvas.width / 2, 30);
    hintCtx.font = '20px "Courier New", monospace';
    hintCtx.fillStyle = '#446655';
    hintCtx.fillText('SCROLL TO INITIATE', hintCanvas.width / 2, 80);

    const hintTexture = new THREE.CanvasTexture(hintCanvas);
    const hintMaterial = new THREE.MeshBasicMaterial({
      map: hintTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const hintGeometry = new THREE.PlaneGeometry(50, 12);
    const hintMesh = new THREE.Mesh(hintGeometry, hintMaterial);
    hintMesh.position.set(0, -115, 0);
    this.heroTextGroup.add(hintMesh);

    // Position the text above and in front of globe (2.5 radii up)
    this.heroTextGroup.position.set(0, GLOBE_RADIUS * 2.5, GLOBE_RADIUS * 0.8);

    this.scene.add(this.heroTextGroup);
  }

  /**
   * Draw subtitle text (used for normal and glitched states)
   */
  private drawSubtitleText(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, text: string, glitchOffset: number = 0): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Terminal-style monospace font
    ctx.font = '500 52px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '8px';

    const y = canvas.height / 2;

    // Chromatic aberration effect during glitch
    if (glitchOffset > 0) {
      // Red channel offset left
      ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
      ctx.fillText(text, canvas.width / 2 - glitchOffset, y);

      // Cyan channel offset right
      ctx.fillStyle = 'rgba(0, 255, 255, 0.7)';
      ctx.fillText(text, canvas.width / 2 + glitchOffset, y);
    }

    // Main text
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(text, canvas.width / 2, y);

    // Add subtle scanlines - only on existing text pixels
    ctx.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < canvas.height; i += 3) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fillRect(0, i, canvas.width, 1);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Update hero text glitch effect - call from render loop
   */
  updateHeroGlitch(): void {
    if (!this.heroGlitchState.subtitleCtx || !this.heroGlitchState.subtitleCanvas || !this.heroGlitchState.subtitleTexture) return;

    const now = performance.now();
    const glitchChars = '!@#$%^&*()_+-=[]{}|;:,.<>?/\\~`░▒▓█▀▄■□●○◆◇';

    // Check if we should start a new glitch - more frequent for visibility
    if (!this.heroGlitchState.isGlitching && now - this.heroGlitchState.lastGlitchTime > 1500 + Math.random() * 2000) {
      // 60% chance to glitch
      if (Math.random() < 0.6) {
        this.heroGlitchState.isGlitching = true;
        this.heroGlitchState.glitchEndTime = now + 150 + Math.random() * 350;
      }
      this.heroGlitchState.lastGlitchTime = now;
    }

    // Handle active glitch
    if (this.heroGlitchState.isGlitching) {
      if (now > this.heroGlitchState.glitchEndTime) {
        // End glitch - restore original
        this.heroGlitchState.isGlitching = false;
        this.drawSubtitleText(
          this.heroGlitchState.subtitleCtx,
          this.heroGlitchState.subtitleCanvas,
          this.heroGlitchState.originalSubtitle
        );
      } else {
        // Generate glitched text
        const original = this.heroGlitchState.originalSubtitle;
        let glitched = '';
        const glitchIntensity = 0.25 + Math.random() * 0.3; // More intense glitch

        for (let i = 0; i < original.length; i++) {
          if (original[i] === ' ') {
            glitched += ' ';
          } else if (Math.random() < glitchIntensity) {
            glitched += glitchChars[Math.floor(Math.random() * glitchChars.length)];
          } else {
            glitched += original[i];
          }
        }

        const chromaOffset = Math.random() * 8;
        this.drawSubtitleText(
          this.heroGlitchState.subtitleCtx,
          this.heroGlitchState.subtitleCanvas,
          glitched,
          chromaOffset
        );
      }

      this.heroGlitchState.subtitleTexture.needsUpdate = true;
    }
  }

  /**
   * Show or hide the hero text
   */
  setHeroTextVisible(visible: boolean): void {
    if (this.heroTextGroup) {
      this.heroTextGroup.visible = visible;
    }
  }

  /**
   * Update hero text opacity based on scroll progress
   */
  setHeroTextOpacity(opacity: number): void {
    if (!this.heroTextGroup) return;

    this.heroTextGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
        child.material.opacity = opacity;
      }
    });
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
      uniform vec3 uCameraPos;
      varying vec3 vWorldPosition;
      varying float vEdgeFade;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;

        // Calculate fresnel/edge fade in vertex shader
        vec3 worldNormal = normalize(worldPos.xyz); // For sphere centered at origin
        vec3 viewDir = normalize(uCameraPos - worldPos.xyz);
        float fresnel = dot(viewDir, worldNormal);
        vEdgeFade = smoothstep(0.0, 0.2, fresnel);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform vec3 radarPositions[8];
      uniform int radarCount;
      uniform float radarRanges[8];
      uniform vec3 satellitePositions[8];
      uniform int satelliteCount;
      uniform float satelliteRanges[8];
      varying vec3 vWorldPosition;
      varying float vEdgeFade;

      void main() {
        float visibility = 0.0;
        vec3 normalizedPos = normalize(vWorldPosition);

        // Check radar coverage (per-source animated ranges)
        for (int i = 0; i < 8; i++) {
          if (i >= radarCount) break;
          vec3 radarDir = normalize(radarPositions[i]);
          float dist = acos(clamp(dot(normalizedPos, radarDir), -1.0, 1.0));
          float range = radarRanges[i];
          float coverage = 1.0 - smoothstep(range * 0.7, range, dist);
          visibility = max(visibility, coverage);
        }

        // Check satellite coverage (per-source animated ranges)
        for (int i = 0; i < 8; i++) {
          if (i >= satelliteCount) break;
          vec3 satDir = normalize(satellitePositions[i]);
          float dist = acos(clamp(dot(normalizedPos, satDir), -1.0, 1.0));
          float range = satelliteRanges[i];
          float coverage = 1.0 - smoothstep(range * 0.7, range, dist);
          visibility = max(visibility, coverage);
        }

        // Atmosphere edge color (matches inner atmosphere 0x2a5577)
        vec3 atmosphereColor = vec3(0.165, 0.333, 0.467);

        // At edges (vEdgeFade=0): use atmosphere color, low alpha
        // At center (vEdgeFade=1): use black, full fog alpha
        float darkness = 0.65 * (1.0 - visibility);
        vec3 fogColor = mix(atmosphereColor, vec3(0.0), vEdgeFade);
        float alpha = mix(0.0, darkness, vEdgeFade);

        gl_FragColor = vec4(fogColor, alpha);
      }
    `;

    this.fogOfWarMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        radarPositions: { value: new Array(8).fill(null).map(() => new THREE.Vector3(0, -1, 0)) },
        radarCount: { value: 0 },
        radarRanges: { value: new Array(8).fill(0) }, // Per-source animated ranges
        satellitePositions: { value: new Array(8).fill(null).map(() => new THREE.Vector3(0, -1, 0)) },
        satelliteCount: { value: 0 },
        satelliteRanges: { value: new Array(8).fill(0) }, // Per-source animated ranges
        uCameraPos: { value: new THREE.Vector3(0, 0, 300) },
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

    // Target range constants
    const RADAR_TARGET_RANGE = 0.5; // ~30 degrees in radians
    const SATELLITE_TARGET_RANGE = SATELLITE_VISION_RANGE_DEGREES * (Math.PI / 180);

    // Collect radar positions and IDs (ground stations)
    const radarData: { id: string; position: THREE.Vector3 }[] = [];
    for (const building of getBuildings(this.gameState)) {
      if (building.type !== 'radar' || building.destroyed) continue;
      if (building.ownerId !== this.playerId) continue;

      const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
      const pos = geoToSphere(geoPos, GLOBE_RADIUS);
      radarData.push({
        id: building.id,
        position: new THREE.Vector3(pos.x, pos.y, pos.z),
      });

      if (radarData.length >= 8) break;
    }

    // Add AWACS aircraft radar coverage
    if (radarData.length < 8) {
      for (const aircraft of getAircraft(this.gameState)) {
        if (aircraft.ownerId !== this.playerId) continue;
        if (aircraft.type !== 'radar' || aircraft.status !== 'flying') continue;

        const pos = geoToSphere(aircraft.geoPosition, GLOBE_RADIUS);
        radarData.push({
          id: aircraft.id,
          position: new THREE.Vector3(pos.x, pos.y, pos.z),
        });

        if (radarData.length >= 8) break;
      }
    }

    // Detect new radars and set target ranges
    const currentRadarIds = new Set(radarData.map(r => r.id));
    for (let i = 0; i < 8; i++) {
      if (i < radarData.length) {
        this.radarTargetRanges[i] = RADAR_TARGET_RANGE;
        // If this is a new radar, start animated range from 0
        if (!this.lastRadarIds.has(radarData[i].id)) {
          this.radarAnimatedRanges[i] = 0;
        }
      } else {
        // No radar at this slot
        this.radarTargetRanges[i] = 0;
        this.radarAnimatedRanges[i] = 0;
      }
    }
    this.lastRadarIds = currentRadarIds;

    // Animate radar ranges toward targets
    for (let i = 0; i < 8; i++) {
      const diff = this.radarTargetRanges[i] - this.radarAnimatedRanges[i];
      if (Math.abs(diff) > 0.001) {
        const step = this.VISION_EXPAND_SPEED * this.deltaTime;
        if (diff > 0) {
          this.radarAnimatedRanges[i] = Math.min(
            this.radarTargetRanges[i],
            this.radarAnimatedRanges[i] + step
          );
        } else {
          this.radarAnimatedRanges[i] = Math.max(
            this.radarTargetRanges[i],
            this.radarAnimatedRanges[i] - step
          );
        }
      } else {
        this.radarAnimatedRanges[i] = this.radarTargetRanges[i];
      }
    }

    // Build radar positions array (padded)
    const radarPositions: THREE.Vector3[] = radarData.map(r => r.position);
    while (radarPositions.length < 8) {
      radarPositions.push(new THREE.Vector3(0, -1, 0)); // South pole, unused
    }

    // Collect connected satellite positions with actual satellite IDs
    const satelliteData: { id: string; position: THREE.Vector3 }[] = [];
    const now = Date.now();
    for (const satellite of getSatellites(this.gameState)) {
      if (satellite.ownerId !== this.playerId || satellite.destroyed) continue;
      if (!this.satelliteHasGroundLink(satellite)) continue;

      const orbitalParams: SatelliteOrbitalParams = {
        launchTime: satellite.launchTime,
        orbitalPeriod: satellite.orbitalPeriod,
        orbitalAltitude: satellite.orbitalAltitude,
        inclination: satellite.inclination,
        startingLongitude: satellite.startingLongitude,
      };
      const geoPos = getSatelliteGroundPosition(orbitalParams, now, GLOBE_RADIUS);
      const pos = geoToSphere(geoPos, GLOBE_RADIUS);
      satelliteData.push({
        id: satellite.id, // Use actual satellite ID for stable tracking
        position: new THREE.Vector3(pos.x, pos.y, pos.z),
      });

      if (satelliteData.length >= 8) break;
    }

    // Detect new satellites and set target ranges
    const currentSatelliteIds = new Set(satelliteData.map(s => s.id));
    for (let i = 0; i < 8; i++) {
      if (i < satelliteData.length) {
        this.satelliteTargetRanges[i] = SATELLITE_TARGET_RANGE;
        // If this is a new satellite, start animated range from 0
        if (!this.lastSatelliteIds.has(satelliteData[i].id)) {
          this.satelliteAnimatedRanges[i] = 0;
        }
      } else {
        // No satellite at this slot
        this.satelliteTargetRanges[i] = 0;
        this.satelliteAnimatedRanges[i] = 0;
      }
    }
    this.lastSatelliteIds = currentSatelliteIds;

    // Animate satellite ranges toward targets
    for (let i = 0; i < 8; i++) {
      const diff = this.satelliteTargetRanges[i] - this.satelliteAnimatedRanges[i];
      if (Math.abs(diff) > 0.001) {
        const step = this.VISION_EXPAND_SPEED * this.deltaTime;
        if (diff > 0) {
          this.satelliteAnimatedRanges[i] = Math.min(
            this.satelliteTargetRanges[i],
            this.satelliteAnimatedRanges[i] + step
          );
        } else {
          this.satelliteAnimatedRanges[i] = Math.max(
            this.satelliteTargetRanges[i],
            this.satelliteAnimatedRanges[i] - step
          );
        }
      } else {
        this.satelliteAnimatedRanges[i] = this.satelliteTargetRanges[i];
      }
    }

    // Build satellite positions array (padded)
    const satellitePositions: THREE.Vector3[] = satelliteData.map(s => s.position);
    while (satellitePositions.length < 8) {
      satellitePositions.push(new THREE.Vector3(0, -1, 0)); // South pole, unused
    }

    // Update shader uniforms
    this.fogOfWarMaterial.uniforms.radarPositions.value = radarPositions;
    this.fogOfWarMaterial.uniforms.radarCount.value = radarData.length;
    this.fogOfWarMaterial.uniforms.radarRanges.value = [...this.radarAnimatedRanges];
    this.fogOfWarMaterial.uniforms.satellitePositions.value = satellitePositions;
    this.fogOfWarMaterial.uniforms.satelliteCount.value = satelliteData.length;
    this.fogOfWarMaterial.uniforms.satelliteRanges.value = [...this.satelliteAnimatedRanges];
    this.fogOfWarMaterial.uniforms.uCameraPos.value.copy(this.camera.position);
  }

  private createStarfield(): void {
    const starCount = 2000;
    const positions = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      // Random position on a large sphere (beyond max zoom distance)
      const radius = 5000 + Math.random() * 1000;
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
    this.updateMissileMarkerVisibility();
    this.updateSatellites();
    this.updateSatelliteCommLinks();
    this.updateAircraft();
  }

  // Only show stage markers (MECO, BECO, APO, etc.) and trail for the tracked missile
  private updateMissileMarkerVisibility(): void {
    for (const [missileId, markers] of this.stageMarkers) {
      const isTracked = missileId === this.trackedMissileId;
      for (const marker of markers) {
        marker.visible = isTracked;
      }
    }

    // Only show trail line and future path for tracked missile
    for (const [missileId, objects] of this.missileObjects) {
      const isTracked = missileId === this.trackedMissileId;
      if (objects.trail) {
        objects.trail.visible = isTracked;
      }

      // Update future path (dashed line from current position to target)
      if (isTracked && !objects.isInterceptor && this.gameState) {
        const missiles = getMissiles(this.gameState);
        const missile = missiles.find(m => m.id === missileId);
        if (missile && !missile.detonated && !missile.intercepted) {
          const now = Date.now();
          const elapsed = now - missile.launchTime;
          const progress = Math.min(elapsed / objects.flightDuration, 1);

          const startGeo = missile.geoLaunchPosition || (missile.launchPosition ? this.pixelToGeoFallback(missile.launchPosition) : { lat: 0, lng: 0 });
          const targetGeo = missile.geoTargetPosition || (missile.targetPosition ? this.pixelToGeoFallback(missile.targetPosition) : { lat: 0, lng: 0 });

          const futurePoints = this.calculateRemainingRoutePath(startGeo, targetGeo, progress, objects.maxAltitude, objects.flightDuration, objects.seed);

          if (objects.plannedRoute) {
            // Update existing geometry
            objects.plannedRoute.geometry.dispose();
            objects.plannedRoute.geometry = new THREE.BufferGeometry().setFromPoints(futurePoints);
            objects.plannedRoute.computeLineDistances();
            objects.plannedRoute.visible = true;
          } else {
            // Create new planned route
            const routeGeom = new THREE.BufferGeometry().setFromPoints(futurePoints);
            const routeMat = new THREE.LineDashedMaterial({
              color: 0x888888,
              transparent: true,
              opacity: 0.4,
              dashSize: 3,
              gapSize: 2,
            });
            objects.plannedRoute = new THREE.Line(routeGeom, routeMat);
            objects.plannedRoute.computeLineDistances();
            this.missileGroup.add(objects.plannedRoute);
          }
        }
      } else if (objects.plannedRoute) {
        objects.plannedRoute.visible = false;
      }
    }
  }

  // Get all radar positions owned by the player
  private getPlayerRadarPositions(): GeoPosition[] {
    if (!this.gameState || !this.playerId) return [];

    const positions: GeoPosition[] = [];
    // Ground radar stations
    for (const building of getBuildings(this.gameState)) {
      if (building.ownerId === this.playerId && building.type === 'radar' && !building.destroyed) {
        const geoPos = building.geoPosition || this.pixelToGeoFallback(building.position);
        positions.push(geoPos);
      }
    }
    // AWACS aircraft (radar type aircraft that are flying)
    for (const aircraft of getAircraft(this.gameState)) {
      if (aircraft.ownerId === this.playerId && aircraft.type === 'radar' && aircraft.status === 'flying') {
        positions.push(aircraft.geoPosition);
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

  // Catmull-Rom spline interpolation for GeoPositions
  private catmullRomGeoInterpolate(controlPoints: GeoPosition[], progress: number): GeoPosition {
    if (controlPoints.length < 2) {
      return controlPoints[0] || { lat: 0, lng: 0 };
    }

    // Clamp progress
    progress = Math.max(0, Math.min(1, progress));

    // Number of segments
    const numSegments = controlPoints.length - 1;

    // Find which segment we're in
    const scaledProgress = progress * numSegments;
    const segmentIndex = Math.min(Math.floor(scaledProgress), numSegments - 1);
    const t = scaledProgress - segmentIndex;

    // Get the 4 control points for Catmull-Rom (with clamping at ends)
    const p0 = controlPoints[Math.max(0, segmentIndex - 1)];
    const p1 = controlPoints[segmentIndex];
    const p2 = controlPoints[Math.min(controlPoints.length - 1, segmentIndex + 1)];
    const p3 = controlPoints[Math.min(controlPoints.length - 1, segmentIndex + 2)];

    // Catmull-Rom basis functions
    const t2 = t * t;
    const t3 = t2 * t;
    const b0 = -0.5 * t3 + t2 - 0.5 * t;
    const b1 = 1.5 * t3 - 2.5 * t2 + 1;
    const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const b3 = 0.5 * t3 - 0.5 * t2;

    return {
      lat: b0 * p0.lat + b1 * p1.lat + b2 * p2.lat + b3 * p3.lat,
      lng: b0 * p0.lng + b1 * p1.lng + b2 * p2.lng + b3 * p3.lng,
    };
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

    // Create/update coverage beams for player's AWACS aircraft
    for (const aircraft of getAircraft(this.gameState)) {
      if (aircraft.type !== 'radar' || aircraft.status !== 'flying') continue;
      if (aircraft.ownerId !== this.playerId) continue;

      const awacsId = `awacs_${aircraft.id}`;
      existingRadarIds.delete(awacsId);

      // AWACS moves, so always recreate the beam at current position
      const existingBeam = this.radarCoverageBeams.get(awacsId);
      if (existingBeam) {
        this.radarCoverageGroup.remove(existingBeam);
        this.disposeGroup(existingBeam);
        this.radarSweepLines.delete(awacsId);
      }

      const beam = this.createRadarBeam(aircraft.geoPosition, awacsId);
      this.radarCoverageGroup.add(beam);
      this.radarCoverageBeams.set(awacsId, beam);
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
      const color = this.getColorForOwner(territory.ownerId);

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
        } else if (hasOwner) {
          color = this.getColorForOwner(territory.ownerId);
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

          // Create text label (mesh lies flat on surface)
          const label = this.createTextMesh(cityData.name, color);
          label.name = 'label';
          label.position.set(0, size + 1, 0); // Position above the marker
          // label.rotation.x = -Math.PI / 2; // Lay flat on surface
          label.rotation.z = Math.PI; // Face readable direction
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

  // Creates a text mesh that lies flat on the surface (normal to globe)
  private createTextMesh(text: string, color: number): THREE.Mesh {
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

    // Create texture and plane mesh
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const geometry = new THREE.PlaneGeometry(8, 2);
    const mesh = new THREE.Mesh(geometry, material);

    return mesh;
  }

  private disposeCityGroup(group: THREE.Group): void {
    group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const mat = child.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
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

      // Handle selection ring
      const isSelected = this.selectedBuilding?.id === building.id;
      let ring = marker.getObjectByName('selectionRing') as THREE.Mesh | undefined;

      if (isSelected && !ring) {
        // Create selection ring
        const ringGeom = new THREE.RingGeometry(2.5, 3, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0x00ffff,
          transparent: true,
          opacity: 0.7,
          side: THREE.DoubleSide,
        });
        ring = new THREE.Mesh(ringGeom, ringMat);
        ring.name = 'selectionRing';
        ring.position.z = 0.1; // Slightly in front of the marker
        marker.add(ring);
      } else if (!isSelected && ring) {
        // Remove selection ring
        marker.remove(ring);
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
      }
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
    const color = this.getColorForOwner(building.ownerId);

    switch (building.type) {
      case 'silo': {
        const silo = building as Silo;
        // Invisible hitbox sphere for easier clicking (matches missile hitbox size)
        const hitboxGeom = new THREE.SphereGeometry(2.5, 8, 8);
        const hitboxMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        });
        const hitbox = new THREE.Mesh(hitboxGeom, hitboxMat);
        group.add(hitbox);

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

    // Add label above the building
    const labelText = this.getBuildingLabel(building.type);
    const label = this.createTextMesh(labelText, color);
    label.position.set(0, 4, 0); // Position above the marker
    label.rotation.z = Math.PI; // Face readable direction
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
        const isInterceptor = isInterceptorType(missile);

        // Show explosion effect (only once per missile)
        if (!this.shownExplosions.has(missile.id)) {
          if (missile.intercepted) {
            // Intercepted: show cyan intercept explosion at actual missile altitude
            // Calculate proper 3D position using missile trajectory
            const maxAltitude = (missile as any).apexHeight ?? calculateMissileAltitude(startGeo, targetGeo);
            const missileProgress = missile.progress ?? 0;
            const flightDuration = missile.flightDuration ?? 30000;
            const seed = this.hashStringToNumber(missile.id);
            const pos3d = getMissilePosition3D(startGeo, targetGeo, missileProgress, maxAltitude, GLOBE_RADIUS, flightDuration, seed);
            this.createInterceptExplosion(pos3d);
          } else if (isInterceptor && missile.detonated) {
            // Interceptor hit its target - don't show a separate explosion
            // The ICBM being intercepted will show the cyan intercept explosion
            // (Ground impact explosions for missed interceptors are handled separately)
          } else {
            // Detonated ICBM: show nuclear explosion (large, orange) at ground target
            this.showExplosionAt(explosionGeo);
          }
          this.shownExplosions.add(missile.id);
        }

        // Move missile to fading state instead of immediate removal
        const objects = this.missileObjects.get(missile.id);
        if (objects) {
          // Get impact position in 3D - use proper altitude for intercepted missiles
          let impactPos3d;
          if (missile.intercepted) {
            const maxAltitude = (missile as any).apexHeight ?? calculateMissileAltitude(startGeo, targetGeo);
            const missileProgress = missile.progress ?? 0;
            const flightDuration = missile.flightDuration ?? 30000;
            const seed = this.hashStringToNumber(missile.id);
            impactPos3d = getMissilePosition3D(startGeo, targetGeo, missileProgress, maxAltitude, GLOBE_RADIUS, flightDuration, seed);
          } else {
            impactPos3d = geoToSphere(explosionGeo, GLOBE_RADIUS + 2);
          }
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
      // In demo/spectator mode, use distinct player colors
      // Apply uncertainty tint for unclear contacts
      const isInterceptor = isInterceptorType(missile);
      let color: number;
      if (isInterceptor) {
        color = COLORS.interceptor; // Cyan for all interceptors
      } else if (this.playerId === null) {
        // Demo/spectator mode: use player's actual color
        color = this.getColorForOwner(missile.ownerId);
      } else if (isMine) {
        color = 0x2266ff; // Blue for player's own missiles
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
      let interpolatedProgress = missileProgress;
      let interpState = this.missileInterpolation.get(missile.id);

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
        const isMissed = isGuidedInterceptor(missile)
          ? (missile as GuidedInterceptor).status === 'missed' || (missile as GuidedInterceptor).status === 'crashed'
          : (missile as any).missedTarget;
        const maxProgress = (isInterceptor && isMissed) ? 1.5 : 1.0;
        interpolatedProgress = Math.min(interpolatedProgress, maxProgress);
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
          linewidth: 2,
        });
        const trail = new THREE.Line(trailGeom, trailMat);

        // Create missile head (smaller for interceptors, colored by ownership)
        const head = this.createICBMHead(isInterceptor, isMine);

        this.missileGroup.add(trail);
        this.missileGroup.add(head);

        // Planned route is created dynamically for tracked missiles only
        let plannedRoute: THREE.Line | undefined;

        // For interceptors, initialize trail history with launch position
        const interceptorTrailHistory = isInterceptor ? [new THREE.Vector3(
          geoToSphere(startGeo, GLOBE_RADIUS).x,
          geoToSphere(startGeo, GLOBE_RADIUS).y,
          geoToSphere(startGeo, GLOBE_RADIUS).z
        )] : undefined;

        // Get targetId from the appropriate field based on missile type
        const targetMissileId = isGuidedInterceptor(missile)
          ? (missile as GuidedInterceptor).targetId
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
      // Guided interceptors handle fuel differently
      const flameoutProgress = isInterceptor && !isGuidedInterceptor(missile)
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
        isGuidedInterceptor(missile)
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
          if (targetIcbm && targetIcbm.geoLaunchPosition && targetIcbm.geoTargetPosition) {
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

          // Create dropped booster visual at BECO
          if (!this.droppedBoosters.has(missile.id)) {
            const boosterColor = missile.ownerId === this.playerId ? 0x113388 : 0x881100;
            const booster = this.createDroppedBooster(boosterColor);
            booster.position.copy(becoVec);

            // Calculate booster falling trajectory
            // Start: BECO position (in geo coordinates) at current altitude
            const becoAltitude = getIcbmAltitude(0.20, maxAltitude, 0.6);
            const becoGeo = sphereToGeo(becoVec, GLOBE_RADIUS + becoAltitude);

            // Calculate ICBM's velocity at BECO to give booster initial momentum
            // At 20% progress during boost, ICBM is still climbing
            // Vertical velocity: derivative of altitude curve at progress=0.20
            // The altitude curve peaks at 60% progress, so at 20% we're still ascending
            const altitudeDerivative = this.getAltitudeDerivative(0.20, maxAltitude, 0.6);
            // Convert to globe units per second based on flight duration
            const flightDurationSec = (objects.flightDuration || 60000) / 1000;
            const initialVelocityUp = altitudeDerivative / flightDurationSec * 0.3; // Reduced - booster is heavy

            // Forward velocity: ICBM's ground speed at BECO
            // Great circle distance / flight duration gives average speed in degrees/sec
            const totalDistance = greatCircleDistance(startGeo, targetGeo) * (180 / Math.PI);
            const avgSpeed = totalDistance / flightDurationSec;
            const initialVelocityForward = avgSpeed * 0.4; // Booster maintains some forward momentum

            // Heading: direction from start to target
            const heading = calculateBearing(startGeo, targetGeo);

            // Duration: time to fall from becoAltitude to surface
            // Using simple physics: h = v0*t - 0.5*g*t^2, solve for t when h=0
            // With air resistance, it falls slower, so we use a longer duration
            const gravity = 2.0; // globe units per second^2 (tuned for visual effect)
            // Quadratic formula: t = (v0 + sqrt(v0^2 + 2*g*h)) / g
            const discriminant = initialVelocityUp * initialVelocityUp + 2 * gravity * becoAltitude;
            const fallTime = (initialVelocityUp + Math.sqrt(Math.max(0, discriminant))) / gravity;
            const boosterDuration = Math.max(8000, fallTime * 1000 * 1.5); // At least 8 seconds, with drag factor

            // Create trail for booster (fainter than missile trail)
            const trailGeom = new THREE.BufferGeometry();
            const trailMat = new THREE.LineBasicMaterial({
              color: boosterColor,
              transparent: true,
              opacity: 0.2,
            });
            const trail = new THREE.Line(trailGeom, trailMat);
            this.missileGroup.add(trail);

            this.droppedBoosters.set(missile.id, {
              mesh: booster,
              trail,
              startGeo: becoGeo,
              startAltitude: becoAltitude,
              initialVelocityUp,
              initialVelocityForward,
              heading,
              startTime: Date.now(),
              duration: boosterDuration,
              trailHistory: [becoVec.clone()],
            });
            this.missileGroup.add(booster);

            // Hide booster parts on the original missile (tail, fins, exhaust)
            const boosterTail = objects.head.getObjectByName('boosterTail');
            if (boosterTail) boosterTail.visible = false;
            for (let i = 0; i < 4; i++) {
              const fin = objects.head.getObjectByName(`boosterFin${i}`);
              if (fin) fin.visible = false;
            }
            // Exhaust is already handled by updateMissileExhaust (turns off at 20%)
          }
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

    // Update dropped boosters - they fall with physics-based trajectory
    for (const [missileId, booster] of this.droppedBoosters) {
      const elapsedMs = Date.now() - booster.startTime;
      const elapsedSec = elapsedMs / 1000;

      // Physics constants (tuned for visual effect)
      const gravity = 1.5;        // Globe units per second^2
      const dragCoefficient = 0.3; // Air resistance factor

      // Calculate current vertical velocity with drag
      // v(t) = v0 * e^(-drag*t) - (g/drag) * (1 - e^(-drag*t))
      const expDecay = Math.exp(-dragCoefficient * elapsedSec);
      const currentVerticalVelocity = booster.initialVelocityUp * expDecay -
        (gravity / dragCoefficient) * (1 - expDecay);

      // Calculate altitude using integral of velocity
      // h(t) = h0 + (v0/drag) * (1 - e^(-drag*t)) - (g/drag) * (t - (1-e^(-drag*t))/drag)
      const altitude = booster.startAltitude +
        (booster.initialVelocityUp / dragCoefficient) * (1 - expDecay) -
        (gravity / dragCoefficient) * (elapsedSec - (1 - expDecay) / dragCoefficient);

      // Check if booster has hit the ground
      if (altitude <= 0) {
        // Booster has landed - remove it
        this.missileGroup.remove(booster.mesh);
        this.missileGroup.remove(booster.trail);
        this.disposeGroup(booster.mesh);
        booster.trail.geometry.dispose();
        (booster.trail.material as THREE.Material).dispose();
        this.droppedBoosters.delete(missileId);
        continue;
      }

      // Calculate horizontal position with decaying forward velocity
      // Forward velocity decays due to drag: vf(t) = vf0 * e^(-drag*t)
      // Distance traveled: integral = (vf0/drag) * (1 - e^(-drag*t))
      const forwardDistance = (booster.initialVelocityForward / dragCoefficient) * (1 - expDecay);

      // Move forward along the heading direction from start position
      const headingRad = booster.heading * (Math.PI / 180);
      const currentGeo = {
        lat: booster.startGeo.lat + forwardDistance * Math.cos(headingRad),
        lng: booster.startGeo.lng + forwardDistance * Math.sin(headingRad) / Math.cos(booster.startGeo.lat * Math.PI / 180),
      };

      // Convert to 3D position
      const pos3d = geoToSphere(currentGeo, GLOBE_RADIUS + altitude);
      booster.mesh.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Orient booster along its falling trajectory (nose pointing in direction of motion)
      // Calculate velocity direction in 3D
      const currentForwardVelocity = booster.initialVelocityForward * expDecay;

      // Get the surface normal at current position (points "up" from globe center)
      const surfaceNormal = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();

      // Calculate forward direction on the surface (tangent to globe in heading direction)
      const north = new THREE.Vector3(0, 1, 0);
      const east = new THREE.Vector3().crossVectors(north, surfaceNormal).normalize();
      const northTangent = new THREE.Vector3().crossVectors(surfaceNormal, east).normalize();

      // Forward direction based on heading
      const forwardDir = new THREE.Vector3()
        .addScaledVector(northTangent, Math.cos(headingRad))
        .addScaledVector(east, Math.sin(headingRad))
        .normalize();

      // Combine forward and downward velocity to get overall direction
      // Vertical component (negative = falling)
      const velocityDir = new THREE.Vector3()
        .addScaledVector(forwardDir, currentForwardVelocity)
        .addScaledVector(surfaceNormal, currentVerticalVelocity)
        .normalize();

      // Point the booster along its velocity vector
      const lookTarget = new THREE.Vector3().copy(booster.mesh.position).add(velocityDir);
      booster.mesh.lookAt(lookTarget);

      // Add current position to trail history (limit to 50 points)
      const currentPos = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z);
      booster.trailHistory.push(currentPos);
      if (booster.trailHistory.length > 50) {
        booster.trailHistory.shift();
      }

      // Update trail geometry from history
      const positions = new Float32Array(booster.trailHistory.length * 3);
      for (let i = 0; i < booster.trailHistory.length; i++) {
        positions[i * 3] = booster.trailHistory[i].x;
        positions[i * 3 + 1] = booster.trailHistory[i].y;
        positions[i * 3 + 2] = booster.trailHistory[i].z;
      }
      booster.trail.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // Fade out when close to the ground (last 30% of altitude)
      const fadeStartAltitude = booster.startAltitude * 0.3;
      if (altitude < fadeStartAltitude) {
        const fadeProgress = 1 - (altitude / fadeStartAltitude);
        const opacity = 1 - fadeProgress;
        booster.mesh.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
            child.material.opacity = Math.max(0.1, opacity);
          }
        });
        (booster.trail.material as THREE.LineBasicMaterial).opacity = 0.2 * Math.max(0.1, opacity);
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
      this.uncertainContacts.delete(id);
      this.shownExplosions.delete(id);
      this.groundImpactMissiles.delete(id);

      // Clean up dropped booster if exists
      const booster = this.droppedBoosters.get(id);
      if (booster) {
        this.missileGroup.remove(booster.mesh);
        this.missileGroup.remove(booster.trail);
        this.disposeGroup(booster.mesh);
        booster.trail.geometry.dispose();
        (booster.trail.material as THREE.Material).dispose();
        this.droppedBoosters.delete(id);
      }

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

    // Invisible hitbox for easier clicking (reduced from original to fix silo selection)
    const hitboxSize = isInterceptor ? 2.8 : 2.0;
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

    // Tail section (tapered) - part of booster stage that separates at BECO
    const tailGeom = new THREE.CylinderGeometry(1.0 * scale, 0.6 * scale, 2 * scale, 8);
    const tailMat = new THREE.MeshBasicMaterial({ color: secondaryColor });
    const tail = new THREE.Mesh(tailGeom, tailMat);
    tail.name = 'boosterTail';
    tail.rotation.x = Math.PI / 2;
    tail.position.z = -3.5 * scale;
    group.add(tail);

    // Fins (4 stabilizers) - part of booster stage that separates at BECO
    const finGeom = new THREE.BoxGeometry(0.15 * scale, 2.5 * scale, 1.5 * scale);
    const finMat = new THREE.MeshBasicMaterial({ color: primaryColor });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeom, finMat);
      fin.name = `boosterFin${i}`;
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
   * Calculate the derivative of the ICBM altitude curve at a given progress.
   * Used to determine the vertical velocity component for dropped boosters.
   */
  private getAltitudeDerivative(progress: number, maxAltitude: number, apexProgress: number): number {
    // The altitude curve is: sin(pi * (progress / apexProgress)^0.7)^1.3 * maxAltitude for progress < apex
    // We'll use numerical differentiation for simplicity
    const epsilon = 0.001;
    const alt1 = getIcbmAltitude(progress - epsilon, maxAltitude, apexProgress);
    const alt2 = getIcbmAltitude(progress + epsilon, maxAltitude, apexProgress);
    return (alt2 - alt1) / (2 * epsilon); // Derivative in altitude units per progress unit
  }

  /**
   * Create a visual for a dropped booster stage (separates at BECO).
   * This is the rear portion of the ICBM that falls back to Earth.
   */
  private createDroppedBooster(color: number): THREE.Group {
    const group = new THREE.Group();
    const scale = 0.3125;  // Match ICBM scale

    // Tail section (the booster stage)
    const tailGeom = new THREE.CylinderGeometry(1.0 * scale, 0.6 * scale, 2 * scale, 8);
    const tailMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
    const tail = new THREE.Mesh(tailGeom, tailMat);
    tail.rotation.x = Math.PI / 2;
    group.add(tail);

    // Fins (4 stabilizers)
    const finGeom = new THREE.BoxGeometry(0.15 * scale, 2.5 * scale, 1.5 * scale);
    const finMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeom, finMat);
      const angle = (i * Math.PI) / 2;
      fin.position.set(Math.cos(angle) * 1.2 * scale, Math.sin(angle) * 1.2 * scale, 0);
      fin.rotation.z = angle;
      group.add(fin);
    }

    // Dead engine nozzle
    const nozzleGeom = new THREE.ConeGeometry(0.4 * scale, 0.8 * scale, 8);
    const nozzleMat = new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 1.0 });
    const nozzle = new THREE.Mesh(nozzleGeom, nozzleMat);
    nozzle.rotation.x = -Math.PI / 2;
    nozzle.position.z = -1.2 * scale;
    group.add(nozzle);

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
    missile?: Missile | GuidedInterceptor
  ): void {
    const exhaust = head.getObjectByName('exhaust') as THREE.Mesh | undefined;
    const exhaustGlow = head.getObjectByName('exhaustGlow') as THREE.Mesh | undefined;

    if (!exhaust || !exhaustGlow) return;

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

  // Calculate remaining route path from current progress to target
  private calculateRemainingRoutePath(startGeo: GeoPosition, endGeo: GeoPosition, currentProgress: number, maxAltitude: number, flightDuration: number, seed?: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Draw path from current position to target
    const steps = 40;
    const startT = Math.min(currentProgress, 0.99);
    for (let i = 0; i <= steps; i++) {
      const t = startT + (1 - startT) * (i / steps);
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

    // Skip interceptors - this method is for ICBMs only
    if (isInterceptorType(targetIcbm)) return null;

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

    // Skip interceptors - this method is for ICBMs only
    if (isInterceptorType(targetIcbm)) return null;

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
    if (isGuidedInterceptor(trackedMissile)) {
      // Guided interceptor: use position from server
      const guidedMissile = trackedMissile as GuidedInterceptor;
      const altitude = guidedMissile.altitude || guidedMissile.currentAltitude || 0;
      const geoPos = guidedMissile.geoPosition || guidedMissile.geoCurrentPosition;
      if (geoPos) {
        const groundPos = geoToSphere(geoPos, GLOBE_RADIUS + altitude);
        interceptorVec = new THREE.Vector3(groundPos.x, groundPos.y, groundPos.z);
      } else {
        interceptorVec = new THREE.Vector3(0, 0, 0);
      }
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
   * Preserves the actual altitude of start and end points (e.g., for ICBMs in flight).
   */
  private createArcedLine(start: THREE.Vector3, end: THREE.Vector3, segments: number = 16): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];

    // Get the actual altitudes of start and end points (distance from globe center)
    const startAltitude = start.length();
    const endAltitude = end.length();

    // Get normalized directions
    const startNorm = start.clone().normalize();
    const endNorm = end.clone().normalize();

    // Calculate the angular distance to determine arc height
    const angularDist = Math.acos(Math.max(-1, Math.min(1, startNorm.dot(endNorm))));

    // Arc height scales with angular distance - longer arcs need higher peaks
    // Use a smaller factor for shorter distances
    const arcHeight = Math.max(5, angularDist * GLOBE_RADIUS * 0.2);

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      // Spherical interpolation for direction
      const dir = new THREE.Vector3().lerpVectors(startNorm, endNorm, t).normalize();

      // Interpolate altitude between start and end
      const baseAltitude = startAltitude + (endAltitude - startAltitude) * t;

      // Add arc height (parabolic - highest at middle)
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
   * Update ICBM tracking visualization.
   * Shows radar detection lines (orange) and interceptor tracking lines (cyan)
   * when an enemy ICBM is selected (tracked).
   */
  private updateIcbmTrackingVisualization(deltaTime: number): void {
    // Clear existing visualization
    this.clearIcbmTrackingVisualization();

    if (!this.trackedMissileId || !this.gameState || !this.playerId) return;

    // Get the tracked missile and verify it's an enemy ICBM
    const trackedMissile = this.gameState.missiles[this.trackedMissileId];
    if (!trackedMissile) return;

    // Only show for enemy ICBMs (not interceptors, not own missiles)
    if (trackedMissile.ownerId === this.playerId) return;
    if (isInterceptorType(trackedMissile) || isGuidedInterceptor(trackedMissile)) return;
    if (trackedMissile.detonated || trackedMissile.intercepted) return;

    // Get ICBM's current 3D position
    const icbm3D = this.getTargetIcbm3DPosition(this.trackedMissileId);
    if (!icbm3D) return;
    const icbmVec = new THREE.Vector3(icbm3D.x, icbm3D.y, icbm3D.z);

    // Get ICBM's geo position for radar range checks
    const icbmGeo = trackedMissile.geoCurrentPosition || trackedMissile.geoLaunchPosition;
    if (!icbmGeo) return;

    // Calculate ICBM altitude for horizon checks
    const progress = trackedMissile.progress ?? 0;
    const apexHeight = (trackedMissile as any).apexHeight ?? 30;
    const icbmAltitudeGlobe = getIcbmAltitude(progress, apexHeight);
    // Convert globe units to km (approximate: globe radius 100 = Earth radius 6371km)
    const icbmAltitudeKm = (icbmAltitudeGlobe / GLOBE_RADIUS) * this.EARTH_RADIUS_KM;

    // Update animation time
    this.icbmTrackingAnimationTime += deltaTime;

    // Colors for visualization
    const radarColor = 0xff8800;     // Orange for radar detection
    const interceptorColor = 0x00ffff; // Cyan for interceptor tracking

    // Find detecting radars and draw lines
    const detectingRadars = this.findDetectingRadars(icbmGeo, icbmAltitudeKm);
    for (const { radar, position3D } of detectingRadars) {
      this.createTrackingLineWithSphere(position3D, icbmVec, radarColor);
    }

    // Find tracking interceptors and draw lines
    const trackingInterceptors = this.findTrackingInterceptors(this.trackedMissileId);
    for (const { interceptor, position3D } of trackingInterceptors) {
      this.createTrackingLineWithSphere(position3D, icbmVec, interceptorColor);
    }

    // Animate spheres
    this.animateTrackingSpheres();
  }

  /**
   * Find all player radars that are currently detecting the ICBM.
   */
  private findDetectingRadars(icbmGeo: GeoPosition, icbmAltitudeKm: number): Array<{
    radar: Radar;
    position3D: THREE.Vector3;
  }> {
    const result: Array<{ radar: Radar; position3D: THREE.Vector3 }> = [];

    if (!this.gameState || !this.playerId) return result;

    // Calculate horizon-limited range based on ICBM altitude
    const horizonRangeKm = Math.sqrt(2 * this.EARTH_RADIUS_KM * this.RADAR_HEIGHT_KM) +
                           Math.sqrt(2 * this.EARTH_RADIUS_KM * Math.max(0, icbmAltitudeKm));
    const horizonRangeDegrees = (horizonRangeKm / this.EARTH_RADIUS_KM) * (180 / Math.PI);
    const effectiveRangeDegrees = Math.min(horizonRangeDegrees, this.RADAR_MAX_RANGE_DEGREES);

    // Check all player's radars
    for (const building of getBuildings(this.gameState)) {
      if (building.ownerId !== this.playerId) continue;
      if (building.type !== 'radar') continue;
      if (building.destroyed) continue;

      const radar = building as Radar;
      const radarGeo = radar.geoPosition || this.pixelToGeoFallback(radar.position);
      const angularDistance = this.calculateAngularDistance(icbmGeo, radarGeo);

      if (angularDistance <= effectiveRangeDegrees) {
        // Radar is detecting this ICBM
        const pos3D = geoToSphere(radarGeo, GLOBE_RADIUS + 3);
        result.push({
          radar,
          position3D: new THREE.Vector3(pos3D.x, pos3D.y, pos3D.z),
        });
      }
    }

    // Also check AWACS aircraft
    for (const aircraft of getAircraft(this.gameState)) {
      if (aircraft.ownerId !== this.playerId) continue;
      if (aircraft.type !== 'radar') continue;
      if (aircraft.status !== 'flying') continue;

      const angularDistance = this.calculateAngularDistance(icbmGeo, aircraft.geoPosition);
      // AWACS has higher altitude, so better radar horizon
      const awacsAltitudeKm = (aircraft.altitude / GLOBE_RADIUS) * this.EARTH_RADIUS_KM;
      const awacsHorizonKm = Math.sqrt(2 * this.EARTH_RADIUS_KM * awacsAltitudeKm) +
                              Math.sqrt(2 * this.EARTH_RADIUS_KM * Math.max(0, icbmAltitudeKm));
      const awacsRangeDegrees = Math.min(
        (awacsHorizonKm / this.EARTH_RADIUS_KM) * (180 / Math.PI),
        this.RADAR_MAX_RANGE_DEGREES
      );

      if (angularDistance <= awacsRangeDegrees) {
        const pos3D = geoToSphere(aircraft.geoPosition, GLOBE_RADIUS + aircraft.altitude);
        result.push({
          radar: { type: 'radar' } as Radar, // Dummy radar type for AWACS
          position3D: new THREE.Vector3(pos3D.x, pos3D.y, pos3D.z),
        });
      }
    }

    return result;
  }

  /**
   * Find all player interceptors that are tracking this ICBM.
   */
  private findTrackingInterceptors(targetIcbmId: string): Array<{
    interceptor: GuidedInterceptor;
    position3D: THREE.Vector3;
  }> {
    const result: Array<{ interceptor: GuidedInterceptor; position3D: THREE.Vector3 }> = [];

    if (!this.gameState || !this.playerId) return result;

    // Check all missiles
    for (const missile of getMissiles(this.gameState)) {
      // Must be player's missile
      if (missile.ownerId !== this.playerId) continue;

      // Must be targeting this ICBM
      if (missile.targetId !== targetIcbmId) continue;

      // Must be active (not detonated or intercepted)
      if (missile.detonated || missile.intercepted) continue;

      // Must be an interceptor
      if (!isGuidedInterceptor(missile) && !isInterceptorType(missile)) continue;

      // Get interceptor position
      let pos3D: THREE.Vector3;
      if (isGuidedInterceptor(missile)) {
        const guidedMissile = missile as GuidedInterceptor;
        const altitude = guidedMissile.altitude || guidedMissile.currentAltitude || 0;
        const geoPos = guidedMissile.geoPosition || guidedMissile.geoCurrentPosition;
        if (geoPos) {
          const groundPos = geoToSphere(geoPos, GLOBE_RADIUS + altitude);
          pos3D = new THREE.Vector3(groundPos.x, groundPos.y, groundPos.z);
        } else {
          continue;
        }
      } else {
        // Legacy interceptor - use geo position with estimated altitude
        const geoPos = missile.geoCurrentPosition;
        if (!geoPos) continue;
        const groundPos = geoToSphere(geoPos, GLOBE_RADIUS + 10); // Estimate altitude
        pos3D = new THREE.Vector3(groundPos.x, groundPos.y, groundPos.z);
      }

      result.push({
        interceptor: missile as GuidedInterceptor,
        position3D: pos3D,
      });
    }

    return result;
  }

  /**
   * Create a tracking line with an animated sphere traveling along it.
   */
  private createTrackingLineWithSphere(
    start: THREE.Vector3,
    end: THREE.Vector3,
    color: number
  ): void {
    // Create arced line
    const curvePoints = this.createArcedLine(start, end, 24);
    const lineGeom = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const lineMat = new THREE.LineDashedMaterial({
      color,
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity: 0.5,
    });
    const line = new THREE.Line(lineGeom, lineMat);
    line.computeLineDistances();
    this.icbmTrackingGroup.add(line);
    this.icbmTrackingLines.push(line);

    // Create traveling sphere
    const sphereGeom = new THREE.SphereGeometry(0.8, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
    });
    const sphere = new THREE.Mesh(sphereGeom, sphereMat);

    // Store curve points for animation
    sphere.userData.curvePoints = curvePoints;

    this.icbmTrackingGroup.add(sphere);
    this.icbmTrackingSpheres.push(sphere);
  }

  /**
   * Animate tracking spheres on a 5-second cycle.
   */
  private animateTrackingSpheres(): void {
    const cycleDuration = 5.0; // seconds
    const cycleProgress = (this.icbmTrackingAnimationTime % cycleDuration) / cycleDuration;

    for (const sphere of this.icbmTrackingSpheres) {
      const curvePoints = sphere.userData.curvePoints as THREE.Vector3[];
      if (!curvePoints || curvePoints.length < 2) continue;

      // Position along curve
      const curveIndex = cycleProgress * (curvePoints.length - 1);
      const lowerIndex = Math.floor(curveIndex);
      const upperIndex = Math.min(lowerIndex + 1, curvePoints.length - 1);
      const localT = curveIndex - lowerIndex;
      sphere.position.lerpVectors(curvePoints[lowerIndex], curvePoints[upperIndex], localT);

      // Pulse scale with sin wave
      const scale = 0.8 + 0.4 * Math.sin(cycleProgress * Math.PI * 2);
      sphere.scale.setScalar(scale);

      // Fade opacity at start and end of cycle
      const mat = sphere.material as THREE.MeshBasicMaterial;
      if (cycleProgress < 0.1) {
        // Fade in
        mat.opacity = cycleProgress / 0.1 * 0.9;
      } else if (cycleProgress > 0.9) {
        // Fade out
        mat.opacity = (1 - cycleProgress) / 0.1 * 0.9;
      } else {
        mat.opacity = 0.9;
      }
    }
  }

  /**
   * Clear ICBM tracking visualization.
   */
  private clearIcbmTrackingVisualization(): void {
    // Remove and dispose lines
    for (const line of this.icbmTrackingLines) {
      this.icbmTrackingGroup.remove(line);
      line.geometry.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    }
    this.icbmTrackingLines = [];

    // Remove and dispose spheres
    for (const sphere of this.icbmTrackingSpheres) {
      this.icbmTrackingGroup.remove(sphere);
      sphere.geometry.dispose();
      if (sphere.material instanceof THREE.Material) {
        sphere.material.dispose();
      }
    }
    this.icbmTrackingSpheres = [];
  }

  /**
   * Update satellite-radar communication links.
   * Shows dashed cyan lines between selected satellite and nearby radars,
   * or between selected radar and nearby satellites.
   */
  private updateSatelliteCommLinks(): void {
    // Clear existing links
    this.clearSatelliteCommLinks();

    if (!this.gameState || !this.playerId) return;

    // Check if a satellite is selected
    const selectedSatellite = this.selectedSatelliteId
      ? getSatellites(this.gameState).find(s => s.id === this.selectedSatelliteId)
      : null;

    // Check if a radar is selected
    const selectedRadar = this.selectedBuilding?.type === 'radar' ? this.selectedBuilding as Radar : null;

    // Only show links when satellite or radar is selected
    if (!selectedSatellite && !selectedRadar) return;

    // Get all radars owned by the player
    const playerRadars = getBuildings(this.gameState)
      .filter((b): b is Radar => b.type === 'radar' && !b.destroyed && b.ownerId === this.playerId);

    // Get all satellites owned by the player
    const playerSatellites = getSatellites(this.gameState)
      .filter(s => !s.destroyed && s.ownerId === this.playerId);

    // Range limit in degrees (30 degrees for satellite-radar comm)
    const SAT_RADAR_COMM_RANGE_DEGREES = 30;

    if (selectedSatellite) {
      // Show lines from selected satellite to all nearby radars
      const satGeo = selectedSatellite.geoPosition;
      if (!satGeo) return;

      for (const radar of playerRadars) {
        const radarGeo = radar.geoPosition || this.pixelToGeoFallback(radar.position);
        const angularDistRad = greatCircleDistance(satGeo, radarGeo);
        const angularDistDeg = angularDistRad * (180 / Math.PI);

        if (angularDistDeg <= SAT_RADAR_COMM_RANGE_DEGREES) {
          this.createSatCommLine(satGeo, radarGeo);
        }
      }
    } else if (selectedRadar) {
      // Show lines from selected radar to all nearby satellites
      const radarGeo = selectedRadar.geoPosition || this.pixelToGeoFallback(selectedRadar.position);

      for (const satellite of playerSatellites) {
        const satGeo = satellite.geoPosition;
        if (!satGeo) continue;

        const angularDistRad = greatCircleDistance(radarGeo, satGeo);
        const angularDistDeg = angularDistRad * (180 / Math.PI);

        if (angularDistDeg <= SAT_RADAR_COMM_RANGE_DEGREES) {
          this.createSatCommLine(satGeo, radarGeo);
        }
      }
    }
  }

  /**
   * Create a single satellite-radar communication line.
   */
  private createSatCommLine(satGeo: GeoPosition, radarGeo: GeoPosition): void {
    // Get 3D positions - satellite at orbital altitude, radar near surface
    const satPos = geoToSphere(satGeo, GLOBE_RADIUS + SATELLITE_ORBITAL_ALTITUDE);
    const radarPos = geoToSphere(radarGeo, GLOBE_RADIUS + 3);

    const startVec = new THREE.Vector3(satPos.x, satPos.y, satPos.z);
    const endVec = new THREE.Vector3(radarPos.x, radarPos.y, radarPos.z);

    // Create curved line that arcs above the globe
    const curvePoints = this.createArcedLine(startVec, endVec, 24);

    const lineGeom = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0x00ffff, // Cyan
      dashSize: 4,
      gapSize: 2,
      transparent: true,
      opacity: 0.7,
    });
    const line = new THREE.Line(lineGeom, lineMat);
    line.computeLineDistances();

    this.satCommGroup.add(line);
    this.satCommLines.push(line);
  }

  /**
   * Clear satellite-radar communication links.
   */
  private clearSatelliteCommLinks(): void {
    for (const line of this.satCommLines) {
      this.satCommGroup.remove(line);
      line.geometry.dispose();
      if (line.material instanceof THREE.Material) {
        line.material.dispose();
      }
    }
    this.satCommLines = [];
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
    const targetId = isGuidedInterceptor(interceptor)
      ? (interceptor as GuidedInterceptor).targetId
      : (interceptor as any).targetId;
    const targetIcbm = targetId ? this.gameState.missiles[targetId] : null;
    if (!targetIcbm || targetIcbm.detonated || targetIcbm.intercepted) return;

    // Guided interceptors: show predicted intercept point along ICBM's path
    if (isGuidedInterceptor(interceptor)) {
      const guidedMissile = interceptor as GuidedInterceptor;
      const icbm = targetIcbm as Missile;

      if (icbm.geoLaunchPosition && icbm.geoTargetPosition && icbm.geoCurrentPosition && icbm.flightDuration) {
        const icbmApex = icbm.apexHeight || 30;
        // Read tracking error from the ICBM itself (shared across all interceptors targeting it)
        const errorMagnitude = icbm.radarTrackingError ?? 0.1;

        // Use server-provided aim point if available (this is the actual aim point with errors)
        if (guidedMissile.predictedInterceptGeo && guidedMissile.predictedInterceptAltitude !== undefined) {
          // Create marker for where interceptor is ACTUALLY aiming (from server)
          const aimMarkerPos = geoToSphere(guidedMissile.predictedInterceptGeo, GLOBE_RADIUS + guidedMissile.predictedInterceptAltitude);
          const aimMarkerPosition = new THREE.Vector3(aimMarkerPos.x, aimMarkerPos.y, aimMarkerPos.z);
          this.createPerceivedInterceptMarker(aimMarkerPosition, errorMagnitude);

          // Get interceptor's current 3D position and create projected path to aim point
          if (guidedMissile.geoPosition) {
            const altitude = guidedMissile.altitude || 0;
            const interceptorPos3D = geoToSphere(guidedMissile.geoPosition, GLOBE_RADIUS + altitude);
            const interceptorPosition = new THREE.Vector3(interceptorPos3D.x, interceptorPos3D.y, interceptorPos3D.z);
            this.createInterceptorProjectedPath(interceptorPosition, aimMarkerPosition);
          }
        }

        // Calculate where ICBM will actually be at the same time (for comparison)
        // Use the interceptor's estimated time to reach its aim point
        if (guidedMissile.geoPosition && guidedMissile.predictedInterceptGeo) {
          const interceptorSpeed = guidedMissile.speed || 0.8;
          const distToAim = greatCircleDistance(guidedMissile.geoPosition, guidedMissile.predictedInterceptGeo);
          const distDegrees = distToAim * (180 / Math.PI);
          const timeToIntercept = distDegrees / interceptorSpeed;

          // Where will ICBM actually be at that time?
          const actualProgressDelta = (timeToIntercept * 1000) / icbm.flightDuration;
          const actualInterceptProgress = Math.min(0.95, icbm.progress + actualProgressDelta);
          const actualInterceptGeo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, actualInterceptProgress);
          const actualAltitude = getIcbmAltitude(actualInterceptProgress, icbmApex, 0.6);

          const actualMarkerPos = geoToSphere(actualInterceptGeo, GLOBE_RADIUS + actualAltitude);
          const actualMarkerPosition = new THREE.Vector3(actualMarkerPos.x, actualMarkerPos.y, actualMarkerPos.z);
          const chance = guidedMissile.hasGuidance ? 0.75 : 0.15;
          this.createInterceptMarker(actualMarkerPosition, chance);
        }

        // Render target ICBM's projected path if this interceptor is selected
        if (this.linkedTargetId === icbm.id) {
          this.createTargetIcbmProjectedPath(icbm);
        }
      }
      return;
    }

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

    // ICBM altitude follows asymmetric ballistic arc: apex * sin^0.6(π * progress)
    const icbmAltitude = getIcbmAltitude(icbmProgressAtIntercept, icbm.apexHeight, 0.6);

    const icbmPos = geoToSphere(icbmGeoAtIntercept, GLOBE_RADIUS + icbmAltitude);

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
   * Create a marker showing where the interceptor THINKS the ICBM will be (with tracking errors).
   * Yellow/orange color to distinguish from the actual intercept point.
   */
  private createPerceivedInterceptMarker(position: THREE.Vector3, errorMagnitude: number): void {
    const markerGroup = new THREE.Group();
    markerGroup.position.copy(position);

    // Smaller diamond shape for perceived position
    const geometry = new THREE.OctahedronGeometry(0.4, 0);
    // Color based on error magnitude: more error = more orange/red
    const errorLevel = Math.min(1, errorMagnitude * 10); // 0.1 error = full intensity
    const r = 1.0;
    const g = 1.0 - errorLevel * 0.5; // Yellow to orange
    const b = 0;
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r, g, b),
      transparent: true,
      opacity: 0.8,
      wireframe: true,
    });
    const diamond = new THREE.Mesh(geometry, material);
    markerGroup.add(diamond);

    // Add a small label "AIM"
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 32;
    canvas.height = 12;
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AIM', canvas.width / 2, 10);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(0, 0.8, 0);
    sprite.scale.set(1.5, 0.5, 1);
    markerGroup.add(sprite);

    this.perceivedInterceptMarker = markerGroup;
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

    if (this.perceivedInterceptMarker) {
      this.interceptPredictionGroup.remove(this.perceivedInterceptMarker);
      this.perceivedInterceptMarker.traverse((child) => {
        if (child instanceof THREE.Mesh) {
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
      this.perceivedInterceptMarker = null;
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

    if (this.interceptorProjectedPath) {
      this.interceptPredictionGroup.remove(this.interceptorProjectedPath);
      this.interceptorProjectedPath.geometry.dispose();
      if (this.interceptorProjectedPath.material instanceof THREE.Material) {
        this.interceptorProjectedPath.material.dispose();
      }
      this.interceptorProjectedPath = null;
    }

    if (this.targetIcbmProjectedPath) {
      this.interceptPredictionGroup.remove(this.targetIcbmProjectedPath);
      this.targetIcbmProjectedPath.geometry.dispose();
      if (this.targetIcbmProjectedPath.material instanceof THREE.Material) {
        this.targetIcbmProjectedPath.material.dispose();
      }
      this.targetIcbmProjectedPath = null;
    }
  }

  /**
   * Create a dashed line from the interceptor's current position to the predicted intercept point.
   */
  private createInterceptorProjectedPath(interceptorPos: THREE.Vector3, interceptPoint: THREE.Vector3): void {
    // Create dashed line geometry
    const points = [interceptorPos.clone(), interceptPoint.clone()];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    // Use a cyan dashed line material
    const material = new THREE.LineDashedMaterial({
      color: 0x00ffff,
      dashSize: 2,
      gapSize: 1,
      linewidth: 1,
      transparent: true,
      opacity: 0.7,
    });

    const line = new THREE.Line(geometry, material);
    line.computeLineDistances(); // Required for dashed lines

    this.interceptorProjectedPath = line;
    this.interceptPredictionGroup.add(line);
  }

  /**
   * Create a line showing the target ICBM's projected path from current position to target.
   */
  private createTargetIcbmProjectedPath(icbm: Missile): void {
    if (!icbm.geoCurrentPosition || !icbm.geoTargetPosition || !icbm.geoLaunchPosition) return;

    const icbmApex = icbm.apexHeight || 30;

    // Create points along the ICBM's remaining path
    const points: THREE.Vector3[] = [];
    const numSegments = 32;

    for (let i = 0; i <= numSegments; i++) {
      // Interpolate progress from current to target
      const t = i / numSegments;
      const progress = icbm.progress + (1 - icbm.progress) * t;

      // Get geo position at this progress
      const geo = geoInterpolate(icbm.geoLaunchPosition, icbm.geoTargetPosition, progress);

      // Get altitude at this progress using the ballistic arc
      const altitude = getIcbmAltitude(progress, icbmApex, 0.6);

      // Convert to 3D position
      const pos3D = geoToSphere(geo, GLOBE_RADIUS + altitude);
      points.push(new THREE.Vector3(pos3D.x, pos3D.y, pos3D.z));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    // Use red/orange dashed line to distinguish from interceptor path
    const material = new THREE.LineDashedMaterial({
      color: 0xff6600,
      dashSize: 2,
      gapSize: 1,
      linewidth: 1,
      transparent: true,
      opacity: 0.6,
    });

    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();

    this.targetIcbmProjectedPath = line;
    this.interceptPredictionGroup.add(line);
  }

  private showExplosionAt(geoPos: GeoPosition): void {
    const pos3d = geoToSphere(geoPos, GLOBE_RADIUS + 3); // Place slightly above surface
    const explosionGroup = new THREE.Group();
    explosionGroup.position.set(pos3d.x, pos3d.y, pos3d.z);
    this.effectGroup.add(explosionGroup);

    // Play impact sound with positional audio (stereo panning)
    const worldPos = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z);
    const screenPos = worldPos.clone().project(this.camera);
    // screenPos.x is -1 (left) to 1 (right), convert to 0-1 range for sound manager
    const screenX = (screenPos.x + 1) / 2;
    soundEffects.playIcbmImpact(screenX);

    // Initial bright flash (larger, white, fades quickly)
    const flashGeom = new THREE.SphereGeometry(4, 16, 16);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      depthTest: true, // Render on top of globe
    });
    const flash = new THREE.Mesh(flashGeom, flashMat);
    explosionGroup.add(flash);

    // Core fireball (brighter orange, grows then fades)
    const fireballGeom = new THREE.SphereGeometry(1.2, 16, 16);
    const fireballMat = new THREE.MeshBasicMaterial({
      color: 0xff6600,
      transparent: true,
      opacity: 1.0,
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
   * Create a small cyan explosion for successful interceptor hits.
   * This is distinct from nuclear detonations (orange) and ground impacts (orange/brown).
   */
  private createInterceptExplosion(pos3d: { x: number; y: number; z: number }): void {
    const explosionGroup = new THREE.Group();
    explosionGroup.position.set(pos3d.x, pos3d.y, pos3d.z);
    this.effectGroup.add(explosionGroup);

    // Small cyan/white flash
    const flashGeom = new THREE.SphereGeometry(1.0, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
    });
    const flash = new THREE.Mesh(flashGeom, flashMat);
    explosionGroup.add(flash);

    // Cyan core
    const coreGeom = new THREE.SphereGeometry(0.6, 8, 8);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 1,
    });
    const core = new THREE.Mesh(coreGeom, coreMat);
    explosionGroup.add(core);

    // Expanding cyan ring
    const ringGeom = new THREE.RingGeometry(0.3, 1.0, 16);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ddff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    // Orient ring perpendicular to surface normal
    const normal = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();
    ring.lookAt(normal.clone().add(new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z)));
    explosionGroup.add(ring);

    // Animate - quick 0.3s effect (~20 frames at 60fps)
    let frame = 0;
    const maxFrames = 20;

    const animate = () => {
      frame++;
      const progress = frame / maxFrames;

      // Flash fades quickly
      flashMat.opacity = Math.max(0, 1 - progress * 3);
      flash.scale.setScalar(1 + progress * 2);

      // Core fades and grows
      coreMat.opacity = Math.max(0, 1 - progress * 1.5);
      core.scale.setScalar(1 + progress * 1.5);

      // Ring expands and fades
      ring.scale.setScalar(1 + progress * 4);
      ringMat.opacity = Math.max(0, 0.8 - progress);

      if (frame < maxFrames) {
        requestAnimationFrame(animate);
      } else {
        // Cleanup
        this.effectGroup.remove(explosionGroup);
        flashGeom.dispose();
        flashMat.dispose();
        coreGeom.dispose();
        coreMat.dispose();
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
      const color = this.getColorForOwner(satellite.ownerId);

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

    const now = Date.now();
    const satellites = getSatellites(this.gameState).filter(
      s => s.ownerId === this.playerId && !s.destroyed
    );

    // Auto-select when there's only one satellite
    if (!this.selectedSatelliteId && !selectedRadar) {
      if (satellites.length === 1) {
        this.selectedSatelliteId = satellites[0].id;
      } else {
        return; // No auto-selection possible, and nothing manually selected
      }
    }

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

  /**
   * Update aircraft positions and rendering.
   */
  private updateAircraft(): void {
    if (!this.gameState) return;

    const existingIds = new Set(this.aircraftObjects.keys());

    for (const aircraft of getAircraft(this.gameState)) {
      if (aircraft.status !== 'flying') continue;

      existingIds.delete(aircraft.id);

      const isMine = aircraft.ownerId === this.playerId;

      // Position at aircraft altitude
      const pos3d = geoToSphere(aircraft.geoPosition, GLOBE_RADIUS + aircraft.altitude);

      let objects = this.aircraftObjects.get(aircraft.id);

      if (!objects) {
        // Create new aircraft mesh
        const mesh = this.createAircraftMesh(aircraft.type, aircraft.ownerId);
        mesh.scale.setScalar(0.8);
        mesh.userData = { type: 'aircraft', id: aircraft.id, aircraft };
        this.aircraftGroup.add(mesh);
        objects = { mesh };
        this.aircraftObjects.set(aircraft.id, objects);
      }

      // Update position
      objects.mesh.position.set(pos3d.x, pos3d.y, pos3d.z);

      // Make aircraft face outward from globe center, then rotate to heading
      const outward = new THREE.Vector3(pos3d.x, pos3d.y, pos3d.z).normalize();
      objects.mesh.lookAt(0, 0, 0);
      objects.mesh.rotateX(Math.PI);

      // Rotate to heading (0 = north, 90 = east)
      const headingRad = (aircraft.heading * Math.PI) / 180;
      objects.mesh.rotateZ(headingRad + Math.PI / 2);

      // Update aircraft data for click handling
      objects.mesh.userData.aircraft = aircraft;

      // Show waypoint path when aircraft is selected
      const isSelected = this.selectedAircraftId === aircraft.id;
      if (isSelected && isMine && !objects.waypointLine) {
        // Build control points for spline: current position -> remaining waypoints -> airfield
        const controlPoints: GeoPosition[] = [aircraft.geoPosition];

        for (let i = aircraft.currentWaypointIndex; i < aircraft.waypoints.length; i++) {
          controlPoints.push(aircraft.waypoints[i]);
        }

        // Add return to airfield
        const airfield = this.gameState.buildings[aircraft.airfieldId] as Airfield | undefined;
        if (airfield?.geoPosition) {
          controlPoints.push(airfield.geoPosition);
        }

        if (controlPoints.length > 1) {
          // Generate spline path with many sample points
          const pathPoints: THREE.Vector3[] = [];
          const numSamples = controlPoints.length * 20; // 20 samples per segment

          for (let i = 0; i <= numSamples; i++) {
            const t = i / numSamples;
            const geoPos = this.catmullRomGeoInterpolate(controlPoints, t);
            const pos = geoToSphere(geoPos, GLOBE_RADIUS + aircraft.altitude);
            pathPoints.push(new THREE.Vector3(pos.x, pos.y, pos.z));
          }

          const lineGeom = new THREE.BufferGeometry().setFromPoints(pathPoints);
          const lineMat = new THREE.LineDashedMaterial({
            color: isMine ? 0x00ff88 : 0xff4444,
            dashSize: 3,
            gapSize: 2,
            transparent: true,
            opacity: 0.6,
          });
          objects.waypointLine = new THREE.Line(lineGeom, lineMat);
          objects.waypointLine.computeLineDistances();
          this.aircraftGroup.add(objects.waypointLine);
        }
      } else if (!isSelected && objects.waypointLine) {
        // Remove waypoint line
        this.aircraftGroup.remove(objects.waypointLine);
        objects.waypointLine.geometry.dispose();
        (objects.waypointLine.material as THREE.Material).dispose();
        objects.waypointLine = undefined;
      }
    }

    // Remove departed/destroyed aircraft
    for (const id of existingIds) {
      const objects = this.aircraftObjects.get(id);
      if (objects) {
        this.aircraftGroup.remove(objects.mesh);
        this.disposeGroup(objects.mesh);
        if (objects.waypointLine) {
          this.aircraftGroup.remove(objects.waypointLine);
          objects.waypointLine.geometry.dispose();
          (objects.waypointLine.material as THREE.Material).dispose();
        }
        this.aircraftObjects.delete(id);
      }
    }
  }

  /**
   * Create an aircraft mesh based on type.
   */
  private createAircraftMesh(type: string, ownerId: string): THREE.Group {
    const group = new THREE.Group();
    const color = this.getColorForOwner(ownerId);

    if (type === 'fighter') {
      // Small triangle for fighter
      const points = [
        new THREE.Vector3(0, 1.5, 0),    // Nose
        new THREE.Vector3(-0.8, -0.5, 0), // Left wing
        new THREE.Vector3(0, -0.2, 0),    // Tail notch
        new THREE.Vector3(0.8, -0.5, 0),  // Right wing
        new THREE.Vector3(0, 1.5, 0),     // Back to nose
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color });
      const outline = new THREE.Line(geometry, material);
      group.add(outline);

      // Fill
      const fillGeom = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        0, 1.5, 0.05,
        -0.8, -0.5, 0.05,
        0.8, -0.5, 0.05,
      ]);
      fillGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      group.add(fill);
    } else if (type === 'bomber') {
      // Larger shape for bomber
      const points = [
        new THREE.Vector3(0, 2, 0),       // Nose
        new THREE.Vector3(-1.5, 0, 0),    // Left wing tip
        new THREE.Vector3(-0.5, -0.5, 0), // Left tail
        new THREE.Vector3(0, -0.3, 0),    // Tail center
        new THREE.Vector3(0.5, -0.5, 0),  // Right tail
        new THREE.Vector3(1.5, 0, 0),     // Right wing tip
        new THREE.Vector3(0, 2, 0),       // Back to nose
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color });
      const outline = new THREE.Line(geometry, material);
      group.add(outline);

      // Fill
      const fillGeom = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        // Triangle 1: nose to wings
        0, 2, 0.05,
        -1.5, 0, 0.05,
        1.5, 0, 0.05,
        // Triangle 2: wings to tail
        -1.5, 0, 0.05,
        0, -0.3, 0.05,
        1.5, 0, 0.05,
      ]);
      fillGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      group.add(fill);
    } else if (type === 'radar') {
      // AWACS/Radar plane - distinctive disc-on-top shape
      const points = [
        new THREE.Vector3(0, 2.5, 0),       // Nose
        new THREE.Vector3(-2, 0, 0),        // Left wing tip
        new THREE.Vector3(-0.5, -0.8, 0),   // Left tail
        new THREE.Vector3(0, -0.5, 0),      // Tail center
        new THREE.Vector3(0.5, -0.8, 0),    // Right tail
        new THREE.Vector3(2, 0, 0),         // Right wing tip
        new THREE.Vector3(0, 2.5, 0),       // Back to nose
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({ color });
      const outline = new THREE.Line(geometry, material);
      group.add(outline);

      // Radar disc on top
      const discGeom = new THREE.RingGeometry(0.4, 0.8, 16);
      const discMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
      });
      const disc = new THREE.Mesh(discGeom, discMat);
      disc.position.set(0, 0.5, 0.2);
      group.add(disc);

      // Fill body
      const fillGeom = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        0, 2.5, 0.05,
        -2, 0, 0.05,
        2, 0, 0.05,
        -2, 0, 0.05,
        0, -0.5, 0.05,
        2, 0, 0.05,
      ]);
      fillGeom.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      const fillMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      });
      const fill = new THREE.Mesh(fillGeom, fillMat);
      group.add(fill);
    }

    return group;
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
   * Works with guided interceptors, legacy interceptors, and ICBMs.
   */
  private getMissile3DPositionForTracking(missile: Missile | GuidedInterceptor): THREE.Vector3 | null {
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
    // Ballistic altitude based on progress (asymmetric arc with shallow reentry)
    const altitude = getIcbmAltitude(progress, apexHeight, 0.6);
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

    // In waypoint mode, add waypoints when clicking on the globe
    if (this.hudRenderer.isInWaypointMode()) {
      const globeIntersects = this.raycaster.intersectObject(this.globe);
      if (globeIntersects.length > 0) {
        const point = globeIntersects[0].point;
        const geoPos = this.spherePointToGeo(point);
        this.hudRenderer.addWaypoint(geoPos);
      }
      return;
    }

    // Check for missile and building clicks together to resolve conflicts by distance
    const missileIntersects = this.raycaster.intersectObjects(
      this.missileGroup.children,
      true
    );
    const buildingIntersects = this.raycaster.intersectObjects(
      this.buildingGroup.children,
      true
    );

    // Get closest intersect distances
    const missileDistance = missileIntersects.length > 0 ? missileIntersects[0].distance : Infinity;
    const buildingDistance = buildingIntersects.length > 0 ? buildingIntersects[0].distance : Infinity;

    // Process building click if building is closer (or no missile hit)
    if (buildingIntersects.length > 0 && buildingDistance <= missileDistance) {
      let obj = buildingIntersects[0].object;
      // Walk up to find the group with building data
      while (obj && !obj.userData?.building && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.building) {
        const building = obj.userData.building as Building;
        // Stop any missile tracking
        this.trackedMissileId = null;
        // Clear linked target
        this.linkedTargetId = null;
        // Clear satellite selection
        this.selectedSatelliteId = null;
        // Clear aircraft selection
        this.selectedAircraftId = null;
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

    // Process missile click if missile is closer (or no building hit)
    if (missileIntersects.length > 0) {
      let obj = missileIntersects[0].object;
      // Walk up to find the parent with missile ID
      while (obj && obj.parent && obj.parent !== this.missileGroup) {
        obj = obj.parent as THREE.Object3D;
      }
      // Find which missile this belongs to
      for (const [missileId, missileObjs] of this.missileObjects) {
        if (missileObjs.head === obj || missileObjs.trail === obj) {
          // Start tracking the missile - don't animate camera, maintain current rotation
          // The tracking code will smoothly move the target to follow the missile
          if (this.gameState) {
            const missiles = getMissiles(this.gameState);
            const missile = missiles.find(m => m.id === missileId);
            if (missile) {
              // Check if this is an enemy ICBM - offer manual intercept
              const isEnemyICBM = missile.ownerId !== this.playerId &&
                                  missile.type === 'icbm' &&
                                  !missile.detonated &&
                                  !missile.intercepted;

              if (isEnemyICBM && this.onEnemyICBMClickCallback) {
                // Trigger manual intercept UI
                this.onEnemyICBMClickCallback(missileId);
              }

              // Track the missile - camera will smoothly follow via controls.target.lerp
              this.trackedMissileId = missileId;
              this.selectedSatelliteId = null;
              this.selectedAircraftId = null;
              this.selectedBuilding = null;
              this.selectedCityInfo = null;

              // If this is an interceptor with a target, also link to the target ICBM
              if (isInterceptorType(missile) && (missile as any).targetId) {
                this.linkedTargetId = (missile as any).targetId;
              } else {
                this.linkedTargetId = null;
              }
            }
          }
          return;
        }
      }
    }

    // Check for aircraft clicks
    const aircraftIntersects = this.raycaster.intersectObjects(
      this.aircraftGroup.children,
      true
    );

    if (aircraftIntersects.length > 0) {
      let obj = aircraftIntersects[0].object;
      // Walk up to find the group with aircraft data
      while (obj && !obj.userData?.aircraft && obj.parent) {
        obj = obj.parent as THREE.Object3D;
      }
      if (obj?.userData?.aircraft) {
        const aircraft = obj.userData.aircraft as Aircraft;
        // Only allow selecting player's own aircraft
        if (aircraft.ownerId === this.playerId) {
          this.trackedMissileId = null;
          this.selectedBuilding = null;
          this.selectedCityInfo = null;
          this.selectedSatelliteId = null;
          this.selectedAircraftId = aircraft.id;
          // Update HUD
          if (this.gameState) {
            this.hudRenderer.updateState(this.gameState, this.playerId, null, this.placementMode);
          }
          return;
        }
      }
      return;
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
          // Start tracking - don't animate camera, maintain current rotation
          this.trackedMissileId = null;
          this.selectedBuilding = null;
          this.selectedCityInfo = null;
          this.selectedAircraftId = null;
          this.selectedSatelliteId = satellite.id;
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

    // Stop tracking and clear all selections when clicking elsewhere
    this.trackedMissileId = null;
    this.linkedTargetId = null;
    this.selectedSatelliteId = null;
    this.selectedBuilding = null;
    this.selectedCityInfo = null;

    // Notify callback that building was deselected
    if (this.onBuildingClickCallback) {
      this.onBuildingClickCallback(null);
    }

    // Update HUD with null selected building
    if (this.gameState) {
      this.hudRenderer.updateState(this.gameState, this.playerId, null, this.placementMode);
    }

    // Check for globe clicks
    const globeIntersects = this.raycaster.intersectObject(this.globe);
    if (globeIntersects.length > 0) {
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
        this.controls.maxDistance = 10000;
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
        this.controls.maxDistance = Math.max(finalDist * 2, 2000);
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
      this.deltaTime = (time - this.lastTime) / 1000;
      this.lastTime = time;
      const deltaTime = this.deltaTime; // Local alias for existing code

      // Demo camera mode - smooth spherical interpolation for landing page
      // Uses lat/lng/distance interpolation to always rotate around the globe (never through it)
      if (this.demoCameraMode) {
        const targets = this.demoCameraTargets;
        const state = this.demoCameraState;

        // Frame-rate independent lerp factor
        const baseLerp = targets.lerpFactor;
        const lerp = 1 - Math.pow(1 - baseLerp, deltaTime * 60);

        // Determine target lat/lng based on trackType (no object selection, just position following)
        let targetLat = targets.targetLat;
        let targetLng = targets.targetLng;
        let targetDistance = targets.distance;
        let lookAtTarget: THREE.Vector3 | null = null; // For missile/satellite, look at the object itself

        // Apply gentle auto-rotation when enabled and not tracking an object
        if (this.demoAutoRotate && targets.trackType !== 'missile' && targets.trackType !== 'satellite') {
          this.demoRotationOffset += this.demoAutoRotateSpeed * deltaTime * 60;
          // Normalize to prevent unbounded growth
          while (this.demoRotationOffset > 180) this.demoRotationOffset -= 360;
          while (this.demoRotationOffset < -180) this.demoRotationOffset += 360;
        }

        // Resolve trackType to lat/lng (get position from tracked object)
        if (targets.trackType === 'missile' && this.gameState) {
          const missiles = getMissiles(this.gameState);

          // Check if current tracked missile is still valid
          let currentMissile = this.demoTrackedMissileId
            ? missiles.find(m => m.id === this.demoTrackedMissileId)
            : null;

          const isMissileValid = currentMissile &&
            !currentMissile.detonated &&
            !currentMissile.intercepted &&
            (currentMissile.progress ?? 0) > 0.05 &&
            (currentMissile.progress ?? 0) < 0.9;

          if (!isMissileValid) {
            // Current missile is invalid - find a new one
            const newMissileId = this.getActiveMissileIdForDemo();
            this.demoTrackedMissileId = newMissileId;
            currentMissile = newMissileId ? missiles.find(m => m.id === newMissileId) : null;
          }

          // Track the current missile's position
          if (currentMissile && !currentMissile.detonated && !currentMissile.intercepted) {
            const missile3DPos = this.getMissile3DPositionForTracking(currentMissile);
            if (missile3DPos && missile3DPos.length() > GLOBE_RADIUS * 0.5) {
              // Convert 3D position to lat/lng for spherical interpolation
              const missileGeo = sphereToGeo(missile3DPos, GLOBE_RADIUS);
              targetLat = missileGeo.lat;
              targetLng = missileGeo.lng;
              lookAtTarget = missile3DPos; // Look at the missile itself
            }
          }
        } else if (targets.trackType === 'satellite' && this.gameState) {
          // Clear missile tracking when in satellite mode
          this.demoTrackedMissileId = null;
          // Find any visible satellite
          const satellites = getSatellites(this.gameState);
          const activeSat = satellites.find(s => !s.destroyed);
          if (activeSat) {
            const now = Date.now();
            const orbitalParams: SatelliteOrbitalParams = {
              launchTime: activeSat.launchTime,
              orbitalPeriod: activeSat.orbitalPeriod,
              orbitalAltitude: activeSat.orbitalAltitude,
              inclination: activeSat.inclination,
              startingLongitude: activeSat.startingLongitude,
            };
            const satPos3d = getSatellitePosition3D(orbitalParams, now, GLOBE_RADIUS);
            const satVec = new THREE.Vector3(satPos3d.x, satPos3d.y, satPos3d.z);
            // Convert satellite 3D position to lat/lng for spherical interpolation
            const satGeo = sphereToGeo(satPos3d, GLOBE_RADIUS);
            targetLat = satGeo.lat;
            targetLng = satGeo.lng;
            lookAtTarget = satVec; // Look at the satellite itself
          }
        } else {
          // For trackType === 'radar' or null, clear missile tracking
          this.demoTrackedMissileId = null;
        }
        // For trackType === 'radar' or null, just use targetLat/targetLng from targets

        // Apply auto-rotation offset to longitude (except during hero zoom)
        const isHeroZoom = targets.verticalOffset > 50;
        if (!isHeroZoom && targets.trackType !== 'missile' && targets.trackType !== 'satellite') {
          targetLng = (targetLng ?? 0) + this.demoRotationOffset;
        }

        // Spherical interpolation: lerp lat, lng (with angle wrapping), and distance separately
        // This ensures the camera always rotates around the globe, never through it

        // Helper for angle lerping (handles -180/+180 wrap)
        const lerpAngle = (current: number, target: number, t: number): number => {
          let delta = target - current;
          // Take shortest path around the circle (use while to handle any delta magnitude)
          while (delta > 180) delta -= 360;
          while (delta < -180) delta += 360;
          return current + delta * t;
        };

        // Interpolate spherical coordinates
        state.currentLat = state.currentLat + ((targetLat ?? state.currentLat) - state.currentLat) * lerp;
        state.currentLng = lerpAngle(state.currentLng, targetLng ?? state.currentLng, lerp);
        // Normalize currentLng to [-180, 180] range
        while (state.currentLng > 180) state.currentLng -= 360;
        while (state.currentLng < -180) state.currentLng += 360;
        state.currentDistance = state.currentDistance + (targetDistance - state.currentDistance) * lerp;

        // Calculate camera position from interpolated spherical coordinates
        const phi = (90 - state.currentLat) * (Math.PI / 180);
        const theta = (state.currentLng + 180) * (Math.PI / 180);
        const cameraX = -state.currentDistance * Math.sin(phi) * Math.cos(theta);
        const cameraY = state.currentDistance * Math.cos(phi);
        const cameraZ = state.currentDistance * Math.sin(phi) * Math.sin(theta);

        this.camera.position.set(cameraX, cameraY, cameraZ);

        // Determine what to look at
        if (lookAtTarget) {
          // Look at the tracked object (missile or satellite)
          this.camera.lookAt(lookAtTarget);
        } else if (targets.verticalOffset > 1) {
          // Look above globe center for hero section (globe appears lower on screen)
          this.camera.lookAt(0, targets.verticalOffset, 0);
        } else {
          // Look at globe center
          this.camera.lookAt(0, 0, 0);
        }

        // Force radar visible if set
        if (this.forceRadarVisible) {
          this.radarCoverageGroup.visible = true;
        }
      }

      // Follow tracked missile if one is selected (non-demo mode)
      // Update both orbit target AND camera position to follow the missile
      if (!this.demoCameraMode && this.trackedMissileId && this.gameState && !this.cameraAnimating) {
        const missiles = getMissiles(this.gameState);
        const trackedMissile = missiles.find(m => m.id === this.trackedMissileId);
        if (trackedMissile && !trackedMissile.detonated && !trackedMissile.intercepted) {
          // Get the missile's 3D position
          const missile3DPos = this.getMissile3DPositionForTracking(trackedMissile);
          if (missile3DPos) {
            // Skip target movement while stabilizing after animation
            if (this.cameraAnimationStabilizeFrames === 0) {
              // Calculate current offset from target to camera (preserves user's rotation)
              const cameraOffset = this.camera.position.clone().sub(this.controls.target);

              // Lerp target toward missile position
              this.controls.target.lerp(missile3DPos, 0.25);

              // Move camera position to maintain same offset from new target position
              // This translates the camera along with the target while preserving rotation
              this.camera.position.copy(this.controls.target).add(cameraOffset);
            }
          }
        } else {
          // Missile no longer exists, stop tracking
          this.trackedMissileId = null;
        }
      }

      // Update camera to follow selected satellite (non-demo mode)
      // Update both orbit target AND camera position to follow the satellite
      if (!this.demoCameraMode && this.selectedSatelliteId && this.gameState && !this.cameraAnimating) {
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

          // Skip target movement while stabilizing after animation
          if (this.cameraAnimationStabilizeFrames === 0) {
            // Calculate current offset from target to camera (preserves user's rotation)
            const cameraOffset = this.camera.position.clone().sub(this.controls.target);

            // Lerp target toward satellite position
            this.controls.target.lerp(satVec, 0.25);

            // Move camera position to maintain same offset from new target position
            // This translates the camera along with the target while preserving rotation
            this.camera.position.copy(this.controls.target).add(cameraOffset);
          }
        } else {
          // Satellite was destroyed, clear selection and return to origin
          this.selectedSatelliteId = null;
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }
      }

      // Update camera to follow selected aircraft (non-demo mode)
      if (!this.demoCameraMode && this.selectedAircraftId && this.gameState && !this.cameraAnimating) {
        const selectedAircraft = getAircraft(this.gameState).find(a => a.id === this.selectedAircraftId);
        if (selectedAircraft && selectedAircraft.status === 'flying') {
          const aircraftPos = geoToSphere(selectedAircraft.geoPosition, GLOBE_RADIUS + selectedAircraft.altitude);
          const aircraftVec = new THREE.Vector3(aircraftPos.x, aircraftPos.y, aircraftPos.z);

          // Skip target movement while stabilizing after animation
          if (this.cameraAnimationStabilizeFrames === 0) {
            // Calculate current offset from target to camera (preserves user's rotation)
            const cameraOffset = this.camera.position.clone().sub(this.controls.target);

            // Lerp target toward aircraft position
            this.controls.target.lerp(aircraftVec, 0.25);

            // Move camera position to maintain same offset from new target position
            this.camera.position.copy(this.controls.target).add(cameraOffset);
          }
        } else {
          // Aircraft landed or destroyed, clear selection
          this.selectedAircraftId = null;
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }
      }

      // Skip all orbit controls updates during camera animation or demo mode
      if (!this.cameraAnimating && !this.demoCameraMode) {
        // Return orbit target to globe center when nothing is being tracked
        const isTrackingAnything = this.trackedMissileId || this.selectedSatelliteId || this.selectedAircraftId;
        if (!isTrackingAnything && !this.controls.target.equals(new THREE.Vector3(0, 0, 0))) {
          // Smoothly return to origin (globe center)
          this.controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.05);
        }

        // Always call controls.update() to allow user rotation, even when tracking
        // The target position is updated separately to follow tracked objects
        if (this.cameraAnimationStabilizeFrames === 0) {
          this.controls.update();
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
          this.controls.maxDistance = Math.max(2000, currentDist * 1.1);
          this.controls.rotateSpeed = 0.3;
        } else {
          // Reset to defaults when not tracking, but don't force camera to snap out
          // by allowing the current camera distance as minimum
          const currentCameraDist = this.camera.position.length();
          this.controls.minDistance = Math.min(120, currentCameraDist * 0.95);
          this.controls.maxDistance = 2000;
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

      // Animate building selection ring
      this.animateSelectionRing(time);

      // Update communication chain visualization (for tracked interceptor)
      this.updateCommunicationChain(deltaTime);

      // Update ICBM tracking visualization (for tracked enemy ICBM)
      this.updateIcbmTrackingVisualization(deltaTime);

      // Update intercept prediction visualization (for tracked interceptor)
      this.updateInterceptPrediction();

      // Update fading missiles (post-detonation effects)
      this.updateFadingMissiles();

      // Animate hacking network
      this.animateHackingNetwork(deltaTime);

      // Update hero text glitch effect
      this.updateHeroGlitch();

      // Apply view toggle visibility
      this.applyViewToggles();

      // Dynamic near plane adjustment to prevent Z-fighting at far distances
      // Scale near plane based on camera distance to maintain depth buffer precision
      const cameraDist = this.camera.position.length();
      const nearPlane = Math.max(0.1, cameraDist * 0.0005);
      this.camera.near = nearPlane;
      this.camera.updateProjectionMatrix();

      // Render 3D scene
      this.renderer.render(this.scene, this.camera);

      // Render HUD (canvas overlay) - skip in demo mode
      if (!this.demoCameraMode) {
        this.hudRenderer.render();
      }

      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);
  }

  /**
   * Animate the pulsing selection ring on the selected building.
   */
  private animateSelectionRing(time: number): void {
    if (!this.selectedBuilding) return;

    const marker = this.buildingMarkers.get(this.selectedBuilding.id);
    if (!marker) return;

    const ring = marker.getObjectByName('selectionRing') as THREE.Mesh | undefined;
    if (!ring) return;

    // Pulse scale between 0.9 and 1.1
    const pulseSpeed = 3; // Pulses per second
    const scale = 1 + 0.1 * Math.sin(time * pulseSpeed);
    ring.scale.setScalar(scale);

    // Also pulse opacity slightly
    if (ring.material instanceof THREE.MeshBasicMaterial) {
      ring.material.opacity = 0.5 + 0.3 * Math.sin(time * pulseSpeed);
    }
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

    // Apply hacking network visibility
    this.hackingNetworkGroup.visible = this.viewToggles.network;
  }

  // Public setter for view toggles
  setViewToggle(toggle: 'radar' | 'grid' | 'labels' | 'trails' | 'network', value: boolean): void {
    this.viewToggles[toggle] = value;
  }

  getViewToggles(): { radar: boolean; grid: boolean; labels: boolean; trails: boolean; network: boolean } {
    return { ...this.viewToggles };
  }

  // ============================================================================
  // Hacking Network Visualization
  // ============================================================================

  /**
   * Set the hacking network state from the store
   */
  setHackingNetworkState(state: HackingNetworkState): void {
    const previousState = this.hackingNetworkState;
    this.hackingNetworkState = state;

    // Update visibility from state
    this.viewToggles.network = state.networkVisible;
    this.hackingNetworkGroup.visible = state.networkVisible;

    // Only rebuild if state changed significantly
    if (!previousState ||
        Object.keys(state.nodes).length !== Object.keys(previousState.nodes).length ||
        Object.keys(state.connections).length !== Object.keys(previousState.connections).length) {
      this.rebuildHackingNetwork();
    }

    // Update active traces
    this.updateHackingTraces();
  }

  /**
   * Toggle hacking network visibility
   */
  toggleHackingNetwork(): void {
    this.viewToggles.network = !this.viewToggles.network;
    this.hackingNetworkGroup.visible = this.viewToggles.network;
  }

  /**
   * Rebuild the entire hacking network visualization
   */
  private rebuildHackingNetwork(): void {
    if (!this.hackingNetworkState) return;

    // Clear existing objects
    this.clearHackingNetwork();

    // Create node markers
    for (const node of Object.values(this.hackingNetworkState.nodes)) {
      const marker = this.createHackingNodeMarker(node);
      this.hackingNodeMarkers.set(node.id, marker);
      this.hackingNetworkGroup.add(marker);
    }

    // Create connection lines
    for (const connection of Object.values(this.hackingNetworkState.connections)) {
      const fromNode = this.hackingNetworkState.nodes[connection.fromNodeId];
      const toNode = this.hackingNetworkState.nodes[connection.toNodeId];

      if (fromNode && toNode) {
        const line = this.createHackingConnectionLine(fromNode, toNode, connection);
        this.hackingConnectionLines.set(connection.id, line);
        this.hackingNetworkGroup.add(line);
      }
    }
  }

  /**
   * Clear all hacking network visualization objects
   */
  private clearHackingNetwork(): void {
    // Clear node markers
    for (const marker of this.hackingNodeMarkers.values()) {
      this.hackingNetworkGroup.remove(marker);
      this.disposeGroup(marker);
    }
    this.hackingNodeMarkers.clear();

    // Clear connection lines
    for (const line of this.hackingConnectionLines.values()) {
      this.hackingNetworkGroup.remove(line);
      (line.geometry as THREE.BufferGeometry).dispose();
      (line.material as THREE.Material).dispose();
    }
    this.hackingConnectionLines.clear();

    // Clear active traces
    this.clearHackingTraces();
  }

  /**
   * Clear all active hack trace visualizations
   */
  private clearHackingTraces(): void {
    for (const trace of this.hackingActiveTraces.values()) {
      this.hackingNetworkGroup.remove(trace.traceHead);
      this.hackingNetworkGroup.remove(trace.traceLine);
      this.hackingNetworkGroup.remove(trace.glowLine);
      (trace.traceHead.geometry as THREE.BufferGeometry).dispose();
      (trace.traceHead.material as THREE.Material).dispose();
      (trace.traceLine.geometry as THREE.BufferGeometry).dispose();
      (trace.traceLine.material as THREE.Material).dispose();
      (trace.glowLine.geometry as THREE.BufferGeometry).dispose();
      (trace.glowLine.material as THREE.Material).dispose();
    }
    this.hackingActiveTraces.clear();
    this.hackingDisplayProgress.clear();
  }

  /**
   * Create a marker for a hacking node
   */
  private createHackingNodeMarker(node: HackingNode): THREE.Group {
    const group = new THREE.Group();
    const pos = geoToSphere(node.position, GLOBE_RADIUS + 1);

    // Outer glow ring
    const glowGeometry = new THREE.RingGeometry(1.5, 2.5, 16);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.hackingNodeGlow,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const glowRing = new THREE.Mesh(glowGeometry, glowMaterial);
    glowRing.name = 'glow';

    // Inner core
    const coreGeometry = new THREE.CircleGeometry(1.2, 16);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.hackingNode,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.name = 'core';

    // Center point
    const centerGeometry = new THREE.CircleGeometry(0.5, 8);
    const centerMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    const center = new THREE.Mesh(centerGeometry, centerMaterial);

    group.add(glowRing);
    group.add(core);
    group.add(center);

    // Position the group
    group.position.set(pos.x, pos.y, pos.z);

    // Orient to face outward from globe center
    group.lookAt(0, 0, 0);
    group.rotateX(Math.PI); // Flip to face away from center

    // Store node data for later use
    group.userData = { node };

    return group;
  }

  /**
   * Create a curved connection line between two nodes
   * Uses a quadratic bezier curve that arcs above the globe surface
   */
  private createHackingConnectionLine(
    fromNode: HackingNode,
    toNode: HackingNode,
    connection: HackingConnection
  ): THREE.Line {
    const points = this.calculateCurvedPath(fromNode.position, toNode.position);

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: COLORS.hackingConnection,
      transparent: true,
      opacity: connection.encrypted ? 0.3 : 0.5,
      linewidth: connection.bandwidth * 2,
    });

    const line = new THREE.Line(geometry, material);
    line.userData = { connection, fromNode, toNode };

    return line;
  }

  /**
   * Calculate curved path points between two geographic positions
   * Creates a great-circle arc that rises above the globe surface
   */
  private calculateCurvedPath(from: GeoPosition, to: GeoPosition): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const segments = HACKING_TRACE_SEGMENTS;

    // Calculate great-circle distance to determine arc height
    const distance = greatCircleDistance(from, to);
    const distanceDegrees = distance * (180 / Math.PI);

    // Arc height scales with distance (more distance = higher arc)
    const maxHeight = HACKING_CONNECTION_HEIGHT * Math.min(1, distanceDegrees / 90);

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;

      // Get position along great-circle path
      const geoPos = geoInterpolate(from, to, t);

      // Calculate height above surface using a parabolic curve
      // Height is 0 at endpoints and max at midpoint
      const heightFactor = 4 * t * (1 - t); // Parabola: max at t=0.5
      const height = maxHeight * heightFactor;

      // Convert to 3D position with additional height
      const pos = geoToSphere(geoPos, GLOBE_RADIUS + 2 + height);
      points.push(new THREE.Vector3(pos.x, pos.y, pos.z));
    }

    return points;
  }

  /**
   * Update all active hack traces
   */
  private updateHackingTraces(): void {
    if (!this.hackingNetworkState) return;

    const currentHackIds = new Set(Object.keys(this.hackingNetworkState.activeHacks));
    if (currentHackIds.size > 0) {
      console.log('[GlobeRenderer] updateHackingTraces - activeHacks:', currentHackIds.size,
        Object.values(this.hackingNetworkState.activeHacks).map(h => ({ id: h.id, hackType: h.hackType })));
    }
    const existingTraceIds = new Set(this.hackingActiveTraces.keys());
    const existingDDoSIds = new Set(this.ddosTraces.keys());

    // Create traces for new hacks
    for (const hack of Object.values(this.hackingNetworkState.activeHacks)) {
      // For DDoS hacks, create multi-trace system only when hack succeeds
      if (hack.hackType === 'ddos' && hack.status === 'complete') {
        if (!this.ddosTraces.has(hack.id)) {
          console.log('[DDoS] Creating multi-trace system for hack', hack.id);
          this.createDDoSTraces(hack);
        }
      }

      // Also create regular trace for all hacks (DDoS will have both)
      if (!this.hackingActiveTraces.has(hack.id)) {
        const trace = this.createHackingTrace(hack);
        if (trace) {
          this.hackingActiveTraces.set(hack.id, trace);
        }
      }
    }

    // Remove traces for completed/removed hacks
    for (const id of existingTraceIds) {
      if (!currentHackIds.has(id)) {
        const trace = this.hackingActiveTraces.get(id);
        if (trace) {
          this.hackingNetworkGroup.remove(trace.traceHead);
          this.hackingNetworkGroup.remove(trace.traceLine);
          this.hackingNetworkGroup.remove(trace.glowLine);
          this.hackingNetworkGroup.remove(trace.counterTraceHead);
          this.hackingNetworkGroup.remove(trace.counterTraceLine);
          this.hackingNetworkGroup.remove(trace.counterGlowLine);
          (trace.traceHead.geometry as THREE.BufferGeometry).dispose();
          (trace.traceHead.material as THREE.Material).dispose();
          (trace.traceLine.geometry as THREE.BufferGeometry).dispose();
          (trace.traceLine.material as THREE.Material).dispose();
          (trace.glowLine.geometry as THREE.BufferGeometry).dispose();
          (trace.glowLine.material as THREE.Material).dispose();
          (trace.counterTraceHead.geometry as THREE.BufferGeometry).dispose();
          (trace.counterTraceHead.material as THREE.Material).dispose();
          (trace.counterTraceLine.geometry as THREE.BufferGeometry).dispose();
          (trace.counterTraceLine.material as THREE.Material).dispose();
          (trace.counterGlowLine.geometry as THREE.BufferGeometry).dispose();
          (trace.counterGlowLine.material as THREE.Material).dispose();
          this.hackingActiveTraces.delete(id);
          this.hackingDisplayProgress.delete(id);
        }
      }
    }

    // Remove DDoS traces for completed/removed hacks
    for (const id of existingDDoSIds) {
      if (!currentHackIds.has(id)) {
        this.removeDDoSTraces(id);
      }
    }
  }

  /**
   * Calculate route points for a hack (extracted for reuse)
   */
  private calculateRoutePoints(hack: NetworkHackTrace): THREE.Vector3[] {
    if (!this.hackingNetworkState || hack.route.nodeIds.length < 2) return [];

    const allPoints: THREE.Vector3[] = [];

    for (let i = 0; i < hack.route.nodeIds.length - 1; i++) {
      const fromNode = this.hackingNetworkState.nodes[hack.route.nodeIds[i]];
      const toNode = this.hackingNetworkState.nodes[hack.route.nodeIds[i + 1]];

      if (!fromNode || !toNode) continue;

      const segmentPoints = this.calculateCurvedPath(fromNode.position, toNode.position);

      if (i > 0) {
        segmentPoints.shift();
      }

      allPoints.push(...segmentPoints);
    }

    return allPoints;
  }

  /**
   * Create visualization for an active hack trace
   */
  private createHackingTrace(hack: NetworkHackTrace): {
    traceHead: THREE.Mesh;
    traceLine: THREE.Line;
    tracePoints: THREE.Vector3[];
    glowLine: THREE.Line;
    counterTraceHead: THREE.Mesh;
    counterTraceLine: THREE.Line;
    counterGlowLine: THREE.Line;
  } | null {
    if (!this.hackingNetworkState || hack.route.nodeIds.length < 2) return null;

    // Calculate the full path through all nodes in the route
    const allPoints: THREE.Vector3[] = [];

    for (let i = 0; i < hack.route.nodeIds.length - 1; i++) {
      const fromNode = this.hackingNetworkState.nodes[hack.route.nodeIds[i]];
      const toNode = this.hackingNetworkState.nodes[hack.route.nodeIds[i + 1]];

      if (!fromNode || !toNode) continue;

      const segmentPoints = this.calculateCurvedPath(fromNode.position, toNode.position);

      // Avoid duplicating the endpoint (which is the start of the next segment)
      if (i > 0) {
        segmentPoints.shift();
      }

      allPoints.push(...segmentPoints);
    }

    if (allPoints.length < 2) return null;

    // Parse the hack color
    const color = new THREE.Color(hack.color);
    // Counter-trace uses red/orange color
    const counterColor = new THREE.Color('#ff4444');

    // Create trace head (glowing sphere) - green, travels source -> target
    const headGeometry = new THREE.SphereGeometry(1.2, 16, 16);
    const headMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 1.0,
    });
    const traceHead = new THREE.Mesh(headGeometry, headMaterial);

    // Create the trace line (shows the path traveled)
    const traceGeometry = new THREE.BufferGeometry();
    const traceMaterial = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.9,
      linewidth: 2,
    });
    const traceLine = new THREE.Line(traceGeometry, traceMaterial);

    // Create glow line (wider, more transparent)
    const glowGeometry = new THREE.BufferGeometry();
    const glowMaterial = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.3,
      linewidth: 4,
    });
    const glowLine = new THREE.Line(glowGeometry, glowMaterial);

    // Counter-trace head (red sphere) - travels target -> source
    const counterHeadGeometry = new THREE.SphereGeometry(1.2, 16, 16);
    const counterHeadMaterial = new THREE.MeshBasicMaterial({
      color: counterColor,
      transparent: true,
      opacity: 1.0,
    });
    const counterTraceHead = new THREE.Mesh(counterHeadGeometry, counterHeadMaterial);

    // Counter-trace line
    const counterTraceGeometry = new THREE.BufferGeometry();
    const counterTraceMaterial = new THREE.LineBasicMaterial({
      color: counterColor,
      transparent: true,
      opacity: 0.9,
      linewidth: 2,
    });
    const counterTraceLine = new THREE.Line(counterTraceGeometry, counterTraceMaterial);

    // Counter glow line
    const counterGlowGeometry = new THREE.BufferGeometry();
    const counterGlowMaterial = new THREE.LineBasicMaterial({
      color: counterColor,
      transparent: true,
      opacity: 0.3,
      linewidth: 4,
    });
    const counterGlowLine = new THREE.Line(counterGlowGeometry, counterGlowMaterial);

    this.hackingNetworkGroup.add(traceHead);
    this.hackingNetworkGroup.add(traceLine);
    this.hackingNetworkGroup.add(glowLine);
    this.hackingNetworkGroup.add(counterTraceHead);
    this.hackingNetworkGroup.add(counterTraceLine);
    this.hackingNetworkGroup.add(counterGlowLine);

    return {
      traceHead,
      traceLine,
      tracePoints: allPoints,
      glowLine,
      counterTraceHead,
      counterTraceLine,
      counterGlowLine,
    };
  }

  /**
   * Create DDoS multi-trace visualization - starts with 1 particle, branches out exponentially
   */
  private createDDoSTraces(hack: NetworkHackTrace): void {
    if (!this.hackingNetworkState || hack.route.nodeIds.length < 2) return;

    const sourceNodeId = hack.route.nodeIds[0];
    const targetNodeId = hack.route.nodeIds[hack.route.nodeIds.length - 1];

    // Create shared geometry and material
    const geometry = new THREE.SphereGeometry(DDOS_TRACE_SIZE, 8, 8);
    const material = new THREE.MeshBasicMaterial({
      color: DDOS_COLOR,
      transparent: false,
      depthTest: true,
    });

    // Create pool of trace head meshes (all invisible initially)
    const traceHeads: THREE.Mesh[] = [];
    const particleStates: Array<{
      active: boolean;
      currentNodeId: string;
      nextNodeId: string;
      progress: number;
      edgeDistance: number;
      speedMultiplier: number;
      visitedNodes: Set<string>;
      routeIndex: number;
    }> = [];

    for (let i = 0; i < DDOS_MAX_PARTICLES; i++) {
      const head = new THREE.Mesh(geometry, material.clone());
      head.visible = false;
      this.hackingNetworkGroup.add(head);
      traceHeads.push(head);

      // Initialize all particles as inactive
      particleStates.push({
        active: false,
        currentNodeId: sourceNodeId,
        nextNodeId: sourceNodeId,
        progress: 0,
        edgeDistance: 10,
        speedMultiplier: 1,
        visitedNodes: new Set(),
        routeIndex: 0,
      });
    }

    // Activate first particle at source, heading to next node on route
    const firstNext = hack.route.nodeIds[1]; // Follow the route, not random

    particleStates[0].active = true;
    particleStates[0].currentNodeId = sourceNodeId;
    particleStates[0].nextNodeId = firstNext;
    particleStates[0].progress = 0;
    particleStates[0].edgeDistance = this.getNodeDistance(sourceNodeId, firstNext);
    particleStates[0].speedMultiplier = 0.5 + Math.random() * 1.0;
    particleStates[0].visitedNodes.add(sourceNodeId);
    particleStates[0].routeIndex = 1; // Now heading to route node index 1

    // Set initial position for first particle
    const sourceNode = this.hackingNetworkState.nodes[sourceNodeId];
    if (sourceNode) {
      const pos = geoToSphere(sourceNode.position, GLOBE_RADIUS + 3);
      traceHeads[0].position.set(pos.x, pos.y, pos.z);
      traceHeads[0].visible = true;
    }

    console.log('[DDoS] Created particle pool with 1 active particle, max', DDOS_MAX_PARTICLES);

    this.ddosTraces.set(hack.id, {
      traceHeads,
      activeCount: 1,
      particleStates,
      sourceNodeId,
      targetNodeId,
      routeNodeIds: hack.route.nodeIds,
      geometry,
      material,
      lastSpawnTime: 0,
    });
  }

  /**
   * Get 3D distance between two nodes in globe units
   */
  private getNodeDistance(nodeId1: string, nodeId2: string): number {
    if (!this.hackingNetworkState) return 10; // Default distance
    const node1 = this.hackingNetworkState.nodes[nodeId1];
    const node2 = this.hackingNetworkState.nodes[nodeId2];
    if (!node1 || !node2) return 10;

    const pos1 = geoToSphere(node1.position, GLOBE_RADIUS + 3);
    const pos2 = geoToSphere(node2.position, GLOBE_RADIUS + 3);

    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    const dz = pos2.z - pos1.z;

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Remove DDoS traces when hack completes
   */
  private removeDDoSTraces(hackId: string): void {
    const ddos = this.ddosTraces.get(hackId);
    if (ddos) {
      for (const head of ddos.traceHeads) {
        this.hackingNetworkGroup.remove(head);
        (head.material as THREE.Material).dispose();
      }
      ddos.geometry.dispose();
      ddos.material.dispose();
      this.ddosTraces.delete(hackId);
      console.log('[DDoS] Removed traces for hack', hackId);
    }
  }

  /**
   * Get nodes connected to a given node
   */
  private getConnectedNodeIds(nodeId: string): string[] {
    if (!this.hackingNetworkState) return [];

    const connected: string[] = [];
    for (const conn of Object.values(this.hackingNetworkState.connections)) {
      if (conn.fromNodeId === nodeId) {
        connected.push(conn.toNodeId);
      } else if (conn.toNodeId === nodeId) {
        connected.push(conn.fromNodeId);
      }
    }
    return connected;
  }

  /**
   * Animate hacking network (called each frame)
   */
  private animateHackingNetwork(deltaTime: number): void {
    if (!this.hackingNetworkState || !this.viewToggles.network) return;

    this.hackingAnimationTime += deltaTime;

    // Animate node pulses
    const pulseValue = (Math.sin(this.hackingAnimationTime * HACKING_NODE_PULSE_SPEED) + 1) / 2;

    for (const marker of this.hackingNodeMarkers.values()) {
      const glow = marker.getObjectByName('glow') as THREE.Mesh;
      const core = marker.getObjectByName('core') as THREE.Mesh;

      if (glow && glow.material instanceof THREE.MeshBasicMaterial) {
        glow.material.opacity = 0.2 + pulseValue * 0.4;
        glow.scale.setScalar(1 + pulseValue * 0.3);
      }

      if (core && core.material instanceof THREE.MeshBasicMaterial) {
        core.material.opacity = 0.6 + pulseValue * 0.3;
      }
    }

    // Animate active traces
    for (const [hackId, trace] of this.hackingActiveTraces) {
      const hack = this.hackingNetworkState.activeHacks[hackId];
      if (!hack) continue;

      // Get or initialize smoothed display progress
      let displayState = this.hackingDisplayProgress.get(hackId);
      if (!displayState) {
        displayState = { progress: hack.progress, traceProgress: hack.traceProgress || 0 };
        this.hackingDisplayProgress.set(hackId, displayState);
      }

      // Lerp display progress toward server progress (smooth interpolation)
      const lerpSpeed = 5; // Units per second - adjust for smoothness
      const lerpFactor = Math.min(1, deltaTime * lerpSpeed);
      displayState.progress += (hack.progress - displayState.progress) * lerpFactor;
      displayState.traceProgress += ((hack.traceProgress || 0) - displayState.traceProgress) * lerpFactor;

      const progress = displayState.progress;
      const traceProgress = displayState.traceProgress;
      const points = trace.tracePoints;
      const totalPoints = points.length;

      if (totalPoints < 2) continue;

      // === HACK PROGRESS (source -> target, green) ===
      // Calculate head position
      const headIndex = Math.floor(progress * (totalPoints - 1));
      const headT = (progress * (totalPoints - 1)) - headIndex;

      let headPos: THREE.Vector3;
      if (headIndex >= totalPoints - 1) {
        headPos = points[totalPoints - 1].clone();
      } else {
        headPos = points[headIndex].clone().lerp(points[headIndex + 1], headT);
      }

      trace.traceHead.position.copy(headPos);

      // Add pulsing glow to head
      const headPulse = 1 + Math.sin(this.hackingAnimationTime * 8) * 0.1;
      trace.traceHead.scale.setScalar(headPulse);

      // Update trace line to show path traveled
      const traceEndIndex = Math.ceil(progress * (totalPoints - 1));
      const traceStartIndex = Math.max(0, traceEndIndex - Math.floor(totalPoints * HACKING_TRACE_HEAD_LENGTH));

      const hackTracePoints = points.slice(traceStartIndex, traceEndIndex + 1);
      if (hackTracePoints.length >= 2) {
        (trace.traceLine.geometry as THREE.BufferGeometry).setFromPoints(hackTracePoints);
        (trace.glowLine.geometry as THREE.BufferGeometry).setFromPoints(hackTracePoints);
      }

      // === COUNTER-TRACE (target -> source, red) ===
      // Calculate counter-trace head position (goes backwards along the path)
      const counterProgress = traceProgress;
      const counterHeadIndex = Math.floor((1 - counterProgress) * (totalPoints - 1));
      const counterHeadT = ((1 - counterProgress) * (totalPoints - 1)) - counterHeadIndex;

      let counterHeadPos: THREE.Vector3;
      if (counterHeadIndex >= totalPoints - 1) {
        counterHeadPos = points[totalPoints - 1].clone();
      } else if (counterHeadIndex < 0) {
        counterHeadPos = points[0].clone();
      } else {
        counterHeadPos = points[counterHeadIndex].clone().lerp(points[Math.min(counterHeadIndex + 1, totalPoints - 1)], counterHeadT);
      }

      trace.counterTraceHead.position.copy(counterHeadPos);

      // Pulsing for counter-trace head
      const counterPulse = 1 + Math.sin(this.hackingAnimationTime * 10) * 0.15;
      trace.counterTraceHead.scale.setScalar(counterPulse);

      // Update counter-trace line (from end of path back to counter head)
      const counterEndIndex = Math.floor((1 - counterProgress) * (totalPoints - 1));
      const counterStartIndex = Math.min(totalPoints - 1, counterEndIndex + Math.floor(totalPoints * HACKING_TRACE_HEAD_LENGTH));

      const counterTracePoints = points.slice(counterEndIndex, counterStartIndex + 1);
      if (counterTracePoints.length >= 2) {
        (trace.counterTraceLine.geometry as THREE.BufferGeometry).setFromPoints(counterTracePoints);
        (trace.counterGlowLine.geometry as THREE.BufferGeometry).setFromPoints(counterTracePoints);
      }

      // Show/hide counter-trace based on whether tracing is active
      const counterVisible = traceProgress > 0;
      trace.counterTraceHead.visible = counterVisible;
      trace.counterTraceLine.visible = counterVisible;
      trace.counterGlowLine.visible = counterVisible;

      // Fade out completed/traced hacks
      if (hack.status === 'complete' || hack.status === 'traced') {
        const headMat = trace.traceHead.material as THREE.MeshBasicMaterial;
        const traceMat = trace.traceLine.material as THREE.LineBasicMaterial;
        const glowMat = trace.glowLine.material as THREE.LineBasicMaterial;
        const counterHeadMat = trace.counterTraceHead.material as THREE.MeshBasicMaterial;
        const counterTraceMat = trace.counterTraceLine.material as THREE.LineBasicMaterial;
        const counterGlowMat = trace.counterGlowLine.material as THREE.LineBasicMaterial;

        headMat.opacity = Math.max(0, headMat.opacity - deltaTime * 0.5);
        traceMat.opacity = Math.max(0, traceMat.opacity - deltaTime * 0.5);
        glowMat.opacity = Math.max(0, glowMat.opacity - deltaTime * 0.5);
        counterHeadMat.opacity = Math.max(0, counterHeadMat.opacity - deltaTime * 0.5);
        counterTraceMat.opacity = Math.max(0, counterTraceMat.opacity - deltaTime * 0.5);
        counterGlowMat.opacity = Math.max(0, counterGlowMat.opacity - deltaTime * 0.5);
      }
    }

    // Animate connection lines for active hacks (make them brighter)
    const activeNodeIds = new Set<string>();
    for (const hack of Object.values(this.hackingNetworkState.activeHacks)) {
      if (hack.status === 'active' || hack.status === 'routing') {
        for (const nodeId of hack.route.nodeIds) {
          activeNodeIds.add(nodeId);
        }
      }
    }

    // Highlight connections that are part of active routes
    for (const [connId, line] of this.hackingConnectionLines) {
      const conn = line.userData.connection as HackingConnection;
      const isActive = activeNodeIds.has(conn.fromNodeId) && activeNodeIds.has(conn.toNodeId);

      const material = line.material as THREE.LineBasicMaterial;
      if (isActive) {
        material.color.setHex(COLORS.hackingConnectionActive);
        material.opacity = 0.7 + pulseValue * 0.3;
      } else {
        material.color.setHex(COLORS.hackingConnection);
        material.opacity = conn.encrypted ? 0.3 : 0.5;
      }
    }

    // Animate DDoS multi-traces - branching network flood
    for (const [hackId, ddos] of this.ddosTraces) {
      const hack = this.hackingNetworkState.activeHacks[hackId];
      if (!hack) continue;

      // Continuous spawning from source at intervals
      const currentTime = this.hackingAnimationTime * 1000; // Convert to ms
      const spawnInterval = 200; // Spawn new particle every 200ms
      if (ddos.activeCount < DDOS_MAX_PARTICLES / 2 &&
          currentTime - ddos.lastSpawnTime > spawnInterval) {
        // Find an inactive slot and spawn at source
        for (let j = 0; j < DDOS_MAX_PARTICLES; j++) {
          if (!ddos.particleStates[j].active) {
            const newState = ddos.particleStates[j];
            newState.active = true;
            newState.currentNodeId = ddos.sourceNodeId;
            newState.nextNodeId = ddos.routeNodeIds[1]; // Head to first route node
            newState.progress = Math.random() * 0.3; // Staggered start
            newState.edgeDistance = this.getNodeDistance(ddos.sourceNodeId, ddos.routeNodeIds[1]);
            newState.speedMultiplier = 0.5 + Math.random() * 1.0;
            newState.visitedNodes = new Set([ddos.sourceNodeId]);
            newState.routeIndex = 1;

            // Position at source
            const sourceNode = this.hackingNetworkState!.nodes[ddos.sourceNodeId];
            if (sourceNode) {
              const pos = geoToSphere(sourceNode.position, GLOBE_RADIUS + 3);
              ddos.traceHeads[j].position.set(pos.x, pos.y, pos.z);
            }

            ddos.activeCount++;
            ddos.lastSpawnTime = currentTime;
            break;
          }
        }
      }

      // Process each active particle
      for (let i = 0; i < DDOS_MAX_PARTICLES; i++) {
        const state = ddos.particleStates[i];
        const head = ddos.traceHeads[i];

        if (!state.active) {
          head.visible = false;
          continue;
        }

        head.visible = true;

        // Move along edge at constant speed
        const progressIncrement = (DDOS_TRACE_SPEED * state.speedMultiplier * deltaTime) / state.edgeDistance;
        state.progress += progressIncrement;

        if (state.progress >= 1) {
          // Arrived at node
          state.progress = 0;
          state.currentNodeId = state.nextNodeId;
          state.visitedNodes.add(state.currentNodeId);

          const routeNodeIds = ddos.routeNodeIds;
          const routeIndex = state.routeIndex;

          // Check if this is an on-route particle that can advance
          if (routeIndex >= 0 && routeIndex < routeNodeIds.length - 1 &&
              state.currentNodeId === routeNodeIds[routeIndex]) {
            // On route - advance to next route node
            state.routeIndex = routeIndex + 1;
            state.nextNodeId = routeNodeIds[state.routeIndex];
            state.edgeDistance = this.getNodeDistance(state.currentNodeId, state.nextNodeId);
            state.speedMultiplier = 0.5 + Math.random() * 1.0;

            // Branch: spawn particles to off-route nodes for visual diversity
            const allConnected = this.getConnectedNodeIds(state.currentNodeId)
              .filter(id => this.hackingNetworkState!.nodes[id]);
            const offRouteNodes = allConnected.filter(id =>
              id !== state.nextNodeId && !state.visitedNodes.has(id)
            );

            // Spawn some particles to off-route branches (limited for performance)
            for (let b = 0; b < Math.min(offRouteNodes.length, 2) && ddos.activeCount < DDOS_MAX_PARTICLES; b++) {
              // Find an inactive slot
              for (let j = 0; j < DDOS_MAX_PARTICLES; j++) {
                if (!ddos.particleStates[j].active) {
                  const newState = ddos.particleStates[j];
                  newState.active = true;
                  newState.currentNodeId = state.currentNodeId;
                  newState.nextNodeId = offRouteNodes[b];
                  newState.progress = Math.random() * 0.3; // Staggered start to reduce clumping
                  newState.edgeDistance = this.getNodeDistance(state.currentNodeId, offRouteNodes[b]);
                  newState.speedMultiplier = 0.5 + Math.random() * 1.0;
                  newState.visitedNodes = new Set(state.visitedNodes);
                  newState.routeIndex = -1; // Off-route marker

                  // Position new particle at current node
                  const nodeData = this.hackingNetworkState!.nodes[state.currentNodeId];
                  if (nodeData) {
                    const pos = geoToSphere(nodeData.position, GLOBE_RADIUS + 3);
                    ddos.traceHeads[j].position.set(pos.x, pos.y, pos.z);
                  }

                  ddos.activeCount++;
                  break;
                }
              }
            }
          } else if (routeIndex >= 0 && state.currentNodeId === routeNodeIds[routeNodeIds.length - 1]) {
            // Reached target - deactivate this particle
            state.active = false;
            head.visible = false;
            ddos.activeCount--;
          } else {
            // Off-route particle - wander randomly or die
            const allConnected = this.getConnectedNodeIds(state.currentNodeId)
              .filter(id => this.hackingNetworkState!.nodes[id]);
            const unvisited = allConnected.filter(id => !state.visitedNodes.has(id));

            if (unvisited.length > 0) {
              // Pick a random unvisited neighbor
              state.nextNodeId = unvisited[Math.floor(Math.random() * unvisited.length)];
              state.edgeDistance = this.getNodeDistance(state.currentNodeId, state.nextNodeId);
              state.speedMultiplier = 0.5 + Math.random() * 1.0;
            } else if (allConnected.length > 0) {
              // Dead end - pick any neighbor (even visited) to continue exploring
              state.nextNodeId = allConnected[Math.floor(Math.random() * allConnected.length)];
              state.edgeDistance = this.getNodeDistance(state.currentNodeId, state.nextNodeId);
              state.speedMultiplier = 0.5 + Math.random() * 1.0;
              state.visitedNodes.clear(); // Reset visited so particle can explore again
            } else {
              // Truly isolated node - deactivate this particle
              state.active = false;
              head.visible = false;
              ddos.activeCount--;
            }
          }
        }

        // Calculate 3D position by interpolating between nodes
        const fromNode = this.hackingNetworkState?.nodes[state.currentNodeId];
        const toNode = this.hackingNetworkState?.nodes[state.nextNodeId];

        if (fromNode && toNode) {
          const t = state.progress;

          // Use geoInterpolate for great-circle path (same as connection lines)
          const geoPos = geoInterpolate(fromNode.position, toNode.position, t);

          // Calculate distance-dependent arc height (same formula as calculateCurvedPath)
          const distance = greatCircleDistance(fromNode.position, toNode.position);
          const distanceDegrees = distance * (180 / Math.PI);
          const maxHeight = HACKING_CONNECTION_HEIGHT * Math.min(1, distanceDegrees / 90);
          const heightFactor = 4 * t * (1 - t); // Parabola peaking at t=0.5
          const height = maxHeight * heightFactor;

          // Convert to 3D with elevation (particles slightly higher than connection lines)
          const pos = geoToSphere(geoPos, GLOBE_RADIUS + 3 + height);
          head.position.set(pos.x, pos.y, pos.z);
        }
      }

      // Pulse active heads
      const pulse = 0.9 + Math.sin(this.hackingAnimationTime * 5) * 0.1;
      for (let i = 0; i < DDOS_MAX_PARTICLES; i++) {
        if (ddos.particleStates[i].active) {
          ddos.traceHeads[i].scale.setScalar(pulse);
        }
      }
    }
  }

  /**
   * Update hacking network each frame (called from render loop)
   */
  updateHackingNetworkAnimation(deltaTime: number): void {
    this.animateHackingNetwork(deltaTime);
  }

  // Public method to focus camera on a specific location
  focusOnGeo(geo: GeoPosition): void {
    const pos = geoToSphere(geo, GLOBE_RADIUS * 2);
    this.camera.position.set(pos.x, pos.y, pos.z);
    this.camera.lookAt(0, 0, 0);
  }
}
