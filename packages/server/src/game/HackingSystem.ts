import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Building,
  Radar,
  Silo,
  Satellite,
  SatelliteLaunchFacility,
  DefconLevel,
  HackType,
  ActiveHack,
  SystemCompromise,
  DetectedBuilding,
  IntrusionAlert,
  DEFCON_HACKING_CONFIG,
  HACK_DURATIONS,
  HACK_RISK_LEVELS,
  HACK_COMPLETION_TIME,
  getBuildings,
  getSatellites,
  GeoPosition,
  greatCircleDistance,
  HackingNode,
  HackingConnection,
  createDefaultHackingNetwork,
  isNodeUnderDdos,
  applyDdos,
  applyNodeCompromise,
  cutCable,
  applyFalseFlag,
  cleanupExpiredEffects,
  getIntercontinentalCables,
} from '@defcon/shared';

// Result of a hack tick update
export interface HackTickResult {
  completedHacks: { hack: ActiveHack; compromise: SystemCompromise }[];
  tracedHacks: ActiveHack[];
  progressUpdates: { hackId: string; progress: number; traceProgress: number }[];
  // Network warfare events
  targetIntelResults?: { hackId: string; siloId: string; targetPosition?: GeoPosition; targetCityName?: string }[];
}

// Result of starting a hack
export interface HackStartResult {
  success: boolean;
  hack?: ActiveHack;
  error?: string;
}

export class HackingSystem {
  // Active hacks indexed by hack ID
  private activeHacks: Map<string, ActiveHack> = new Map();

  // System compromises indexed by target building ID
  private compromises: Map<string, SystemCompromise[]> = new Map();

  // Intrusion alerts indexed by target owner ID
  private intrusionAlerts: Map<string, IntrusionAlert[]> = new Map();

  // Detected buildings per player
  private detectedBuildings: Map<string, DetectedBuilding[]> = new Map();

  // ============ NETWORK WARFARE STATE ============

  // Tapped radars: radarId -> attackerId (who is seeing through it)
  private tappedRadars: Map<string, { attackerId: string; expiresAt: number }> = new Map();

  // DDoS'd player source nodes: playerId -> { attackerId, expiresAt }
  private ddosTargets: Map<string, { attackerId: string; expiresAt: number }> = new Map();

  // Monitored silos: siloId -> { attackerId, expiresAt } (for launch warnings)
  private monitoredSilos: Map<string, { attackerId: string; expiresAt: number }> = new Map();

  // Hijacked satellites: satelliteId -> { attackerId, expiresAt }
  private hijackedSatellites: Map<string, { attackerId: string; expiresAt: number }> = new Map();

  // False flag nodes: nodeId -> { impersonatePlayerId, expiresAt }
  private falseFlagNodes: Map<string, { impersonatePlayerId: string; ownerId: string; expiresAt: number }> = new Map();

  // Network state for cable cutting
  private networkNodes: Record<string, HackingNode> = {};
  private networkConnections: Record<string, HackingConnection> = {};

  constructor() {
    // Initialize network for cable cutting
    const network = createDefaultHackingNetwork();
    this.networkNodes = network.nodes;
    this.networkConnections = network.connections;
  }

  /**
   * Get the hacking configuration for the current DEFCON level
   */
  getConfig(defconLevel: DefconLevel) {
    return DEFCON_HACKING_CONFIG[defconLevel];
  }

  /**
   * Scan for enemy buildings within radar/satellite range
   */
  scanForBuildings(
    state: GameState,
    playerId: string
  ): DetectedBuilding[] {
    const config = this.getConfig(state.defconLevel);
    if (!config.scanEnabled) {
      return [];
    }

    const detectedList: DetectedBuilding[] = [];
    const now = Date.now();

    // Get player's radars
    const playerRadars = getBuildings(state).filter(
      (b): b is Radar =>
        b.type === 'radar' &&
        b.ownerId === playerId &&
        !b.destroyed &&
        b.active
    );

    // Get player's satellites
    const playerSatellites = getSatellites(state).filter(
      (s) => s.ownerId === playerId && !s.destroyed
    );

    // Get all enemy buildings
    const enemyBuildings = getBuildings(state).filter(
      (b) => b.ownerId !== playerId && !b.destroyed
    );

    for (const enemy of enemyBuildings) {
      const enemyGeo = enemy.geoPosition;
      if (!enemyGeo) continue;

      let detected = false;

      // Check radar coverage
      for (const radar of playerRadars) {
        const radarGeo = radar.geoPosition;
        if (!radarGeo) continue;

        const distance = greatCircleDistance(radarGeo, enemyGeo);
        const rangeDegrees = (radar.range / 100) * 9; // Match radar range calculation
        const distanceDegrees = distance * (180 / Math.PI);

        if (distanceDegrees <= rangeDegrees) {
          detected = true;
          break;
        }
      }

      // Check satellite coverage if not already detected
      if (!detected) {
        for (const satellite of playerSatellites) {
          const satGeo = satellite.geoPosition;
          if (!satGeo) continue;

          const distance = greatCircleDistance(satGeo, enemyGeo);
          const distanceDegrees = distance * (180 / Math.PI);
          const visionRange = 30; // Satellite vision range in degrees

          if (distanceDegrees <= visionRange) {
            detected = true;
            break;
          }
        }
      }

      if (detected) {
        // Determine available vulnerabilities based on building type
        const vulnerabilities = this.getVulnerabilities(enemy);

        detectedList.push({
          id: enemy.id,
          ownerId: enemy.ownerId,
          type: enemy.type,
          geoPosition: enemyGeo,
          detectedAt: now,
          lastSeenAt: now,
          vulnerabilities,
        });
      }
    }

    // Update stored detected buildings for this player
    this.detectedBuildings.set(playerId, detectedList);

    return detectedList;
  }

  /**
   * Get vulnerabilities for a building type
   * Returns hack types available based on building type and DEFCON level
   */
  private getVulnerabilities(building: Building, defconLevel?: DefconLevel): HackType[] {
    switch (building.type) {
      case 'radar':
        // tap_radar available at DEFCON 3+
        return ['blind_radar', 'spoof_radar', 'tap_radar'];
      case 'silo':
        // target_intel only at DEFCON 1, launch_warning at DEFCON 2+
        const siloHacks: HackType[] = ['lock_silo', 'delay_silo'];
        if (!defconLevel || defconLevel <= 2) {
          siloHacks.push('launch_warning');
        }
        if (!defconLevel || defconLevel === 1) {
          siloHacks.push('target_intel');
        }
        return siloHacks;
      case 'satellite_launch_facility':
        return ['disable_satellite', 'intercept_comms'];
      case 'airfield':
        return ['intercept_comms'];
      default:
        return [];
    }
  }

  /**
   * Get vulnerabilities for satellites (special target type)
   */
  getVulnerabilitiesForSatellite(): HackType[] {
    return ['hijack_satellite'];
  }

  /**
   * Get vulnerabilities for network nodes
   */
  getVulnerabilitiesForNode(): HackType[] {
    return ['ddos', 'compromise_node', 'false_flag'];
  }

  /**
   * Get vulnerabilities for network cables
   */
  getVulnerabilitiesForCable(): HackType[] {
    return ['cut_cable'];
  }

  /**
   * Start a new hack attempt
   */
  startHack(
    state: GameState,
    attackerId: string,
    targetId: string,
    hackType: HackType,
    proxyRoute?: string[],
    impersonatePlayerId?: string  // For false_flag hack
  ): HackStartResult {
    const config = this.getConfig(state.defconLevel);

    // Check if hacking is enabled
    if (!config.hackingEnabled) {
      return { success: false, error: 'Hacking not available at this DEFCON level' };
    }

    // Check if attacker is under DDoS
    if (this.isPlayerUnderDdos(attackerId)) {
      return { success: false, error: 'Your network is under DDoS attack - cannot initiate hacks' };
    }

    // Check if attacker already has an active hack
    const existingHack = Array.from(this.activeHacks.values()).find(
      (h) => h.attackerId === attackerId && h.status !== 'completed' && h.status !== 'disconnected' && h.status !== 'traced'
    );
    if (existingHack) {
      return { success: false, error: 'Already have an active hack in progress' };
    }

    // Handle special target types
    let targetOwnerId: string;
    let validHacks: HackType[];

    // Check for satellite target (sat:<id> format)
    if (targetId.startsWith('sat:')) {
      const satId = targetId.substring(4);
      const satellite = state.satellites[satId];
      if (!satellite || satellite.destroyed) {
        return { success: false, error: 'Satellite not found' };
      }
      if (satellite.ownerId === attackerId) {
        return { success: false, error: 'Cannot hack your own satellite' };
      }
      targetOwnerId = satellite.ownerId;
      validHacks = this.getVulnerabilitiesForSatellite();
    }
    // Check for player target (player:<id> format) - for DDoS attacks
    else if (targetId.startsWith('player:')) {
      const targetPlayerId = targetId.substring(7);
      const targetPlayer = state.players[targetPlayerId];
      if (!targetPlayer) {
        return { success: false, error: 'Player not found' };
      }
      if (targetPlayerId === attackerId) {
        return { success: false, error: 'Cannot DDoS yourself' };
      }
      targetOwnerId = targetPlayerId;  // The player being DDoS'd
      validHacks = ['ddos'];  // Only DDoS allowed for player targets
    }
    // Check for network node target (node:<id> format)
    else if (targetId.startsWith('node:')) {
      const nodeId = targetId.substring(5);
      const node = this.networkNodes[nodeId];
      if (!node) {
        return { success: false, error: 'Network node not found' };
      }
      // For nodes, targetOwnerId is the attacker (they own the effect)
      targetOwnerId = attackerId;
      validHacks = this.getVulnerabilitiesForNode();
    }
    // Check for cable target (cable:<id> format)
    else if (targetId.startsWith('cable:')) {
      const cableId = targetId.substring(6);
      const cable = this.networkConnections[cableId];
      if (!cable) {
        return { success: false, error: 'Cable not found' };
      }
      if (!cable.isIntercontinental) {
        return { success: false, error: 'Only intercontinental cables can be cut' };
      }
      targetOwnerId = attackerId;
      validHacks = this.getVulnerabilitiesForCable();
    }
    // Regular building target
    else {
      const target = state.buildings[targetId];
      if (!target || target.destroyed) {
        return { success: false, error: 'Target not found' };
      }

      // Check if target type is allowed at this DEFCON level
      if (!config.allowedTargets.includes(target.type)) {
        return { success: false, error: `Cannot hack ${target.type} at this DEFCON level` };
      }

      // Check if player is trying to hack own building
      if (target.ownerId === attackerId) {
        return { success: false, error: 'Cannot hack your own buildings' };
      }

      targetOwnerId = target.ownerId;
      validHacks = this.getVulnerabilities(target, state.defconLevel);
    }

    // Check if hack type is valid for this target
    if (!validHacks.includes(hackType)) {
      return { success: false, error: `Invalid hack type for this target` };
    }

    // Validate proxy route (all buildings must belong to attacker)
    if (proxyRoute && proxyRoute.length > 0) {
      for (const proxyId of proxyRoute) {
        const proxyBuilding = state.buildings[proxyId];
        if (!proxyBuilding || proxyBuilding.ownerId !== attackerId || proxyBuilding.destroyed) {
          return { success: false, error: 'Invalid proxy route' };
        }
      }
    }

    // Create hack
    const hack: ActiveHack = {
      id: uuidv4(),
      attackerId,
      targetId,
      targetOwnerId,
      hackType,
      progress: 0,
      traceProgress: 0,
      startTime: Date.now(),
      status: 'connecting',
      proxyRoute,
    };

    this.activeHacks.set(hack.id, hack);

    // Create intrusion alert for target owner (not for infrastructure hacks)
    if (!targetId.startsWith('node:') && !targetId.startsWith('cable:')) {
      this.createIntrusionAlert(hack);
    }

    return { success: true, hack };
  }

  /**
   * Disconnect from an active hack
   */
  disconnectHack(hackId: string, attackerId: string): boolean {
    const hack = this.activeHacks.get(hackId);
    if (!hack || hack.attackerId !== attackerId) {
      return false;
    }

    if (hack.status === 'completed' || hack.status === 'traced' || hack.status === 'disconnected') {
      return false;
    }

    hack.status = 'disconnected';
    this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);

    return true;
  }

  /**
   * Purge a compromise from a building
   */
  purgeCompromise(targetId: string, ownerId: string): boolean {
    const compromiseList = this.compromises.get(targetId);
    if (!compromiseList || compromiseList.length === 0) {
      return false;
    }

    // Find and remove the compromise if owner matches
    const compromiseIndex = compromiseList.findIndex((c) => c.targetOwnerId === ownerId);
    if (compromiseIndex === -1) {
      return false;
    }

    compromiseList.splice(compromiseIndex, 1);
    if (compromiseList.length === 0) {
      this.compromises.delete(targetId);
    }

    return true;
  }

  /**
   * Update all active hacks (called every tick)
   */
  update(state: GameState, deltaSeconds: number): HackTickResult {
    const config = this.getConfig(state.defconLevel);
    const result: HackTickResult = {
      completedHacks: [],
      tracedHacks: [],
      progressUpdates: [],
    };

    for (const [hackId, hack] of this.activeHacks) {
      if (hack.status === 'completed' || hack.status === 'traced' || hack.status === 'disconnected') {
        continue;
      }

      // Check if target still exists (skip for special targets like cables/nodes/players)
      if (!hack.targetId.startsWith('cable:') && !hack.targetId.startsWith('node:') && !hack.targetId.startsWith('sat:') && !hack.targetId.startsWith('player:')) {
        const target = state.buildings[hack.targetId];
        if (!target || target.destroyed) {
          hack.status = 'disconnected';
          this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);
          continue;
        }
      }

      // Check if any proxy in route was destroyed
      if (hack.proxyRoute) {
        const proxyDestroyed = hack.proxyRoute.some((proxyId) => {
          const proxy = state.buildings[proxyId];
          return !proxy || proxy.destroyed;
        });
        if (proxyDestroyed) {
          hack.status = 'disconnected';
          this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);
          continue;
        }
      }

      // Calculate progress increment
      const baseTime = HACK_COMPLETION_TIME[hack.hackType];
      const hackSpeedMultiplier = config.hackSpeed;
      const progressPerSecond = (100 / (baseTime / 1000)) * hackSpeedMultiplier;

      // Debug: log every 20 ticks (~1 second)
      if (Math.floor(hack.progress) % 10 === 0 && hack.progress < 100) {
        console.log(`[HACK PROGRESS] ${hack.hackType}: ${hack.progress.toFixed(1)}%, delta=${deltaSeconds.toFixed(3)}s, rate=${progressPerSecond.toFixed(1)}%/s`);
      }

      // Calculate trace increment
      const riskLevel = HACK_RISK_LEVELS[hack.hackType];
      const traceSpeedMultiplier = config.traceSpeed;
      // Proxy route reduces trace speed (each proxy adds 20% reduction)
      const proxyReduction = hack.proxyRoute ? Math.pow(0.8, hack.proxyRoute.length) : 1;
      const tracePerSecond = (100 / 20) * riskLevel * traceSpeedMultiplier * proxyReduction; // Base: 20 seconds to full trace

      // Update progress
      hack.progress = Math.min(100, hack.progress + progressPerSecond * deltaSeconds);
      hack.traceProgress = Math.min(100, hack.traceProgress + tracePerSecond * deltaSeconds);

      // Transition from connecting to active
      if (hack.status === 'connecting' && hack.progress >= 10) {
        hack.status = 'active';
      }

      // Update intrusion alert
      this.updateIntrusionAlert(hack);

      // Check if traced
      if (hack.traceProgress >= 100) {
        hack.status = 'traced';
        result.tracedHacks.push(hack);
        this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);
        continue;
      }

      // Check if completed
      if (hack.progress >= 100) {
        hack.status = 'completed';
        const compromise = this.applyCompromise(hack);
        result.completedHacks.push({ hack, compromise });
        this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);
        continue;
      }

      // Add progress update
      result.progressUpdates.push({
        hackId: hack.id,
        progress: hack.progress,
        traceProgress: hack.traceProgress,
      });
    }

    // Clean up expired compromises
    this.cleanupExpiredCompromises();

    // Clean up expired network warfare effects
    this.cleanupExpiredNetworkEffects();

    return result;
  }

  /**
   * Apply a compromise effect to a building
   */
  private applyCompromise(hack: ActiveHack): SystemCompromise {
    const duration = HACK_DURATIONS[hack.hackType];
    const now = Date.now();

    const compromise: SystemCompromise = {
      id: uuidv4(),
      targetId: hack.targetId,
      targetOwnerId: hack.targetOwnerId,
      attackerId: hack.attackerId,
      hackType: hack.hackType,
      appliedAt: now,
      expiresAt: duration > 0 ? now + duration : 0,
    };

    // Apply special effects for network warfare hacks
    this.applyNetworkWarfareEffect(hack, compromise);

    // Add to compromises map
    const existing = this.compromises.get(hack.targetId) || [];
    existing.push(compromise);
    this.compromises.set(hack.targetId, existing);

    return compromise;
  }

  /**
   * Apply network warfare specific effects when a hack completes
   */
  private applyNetworkWarfareEffect(hack: ActiveHack, compromise: SystemCompromise): void {
    const duration = HACK_DURATIONS[hack.hackType];
    const expiresAt = duration > 0 ? Date.now() + duration : 0;

    switch (hack.hackType) {
      case 'tap_radar':
        // Track tapped radar
        this.tappedRadars.set(hack.targetId, {
          attackerId: hack.attackerId,
          expiresAt,
        });
        break;

      case 'ddos':
        // DDoS targets the enemy player's ability to hack
        this.ddosTargets.set(hack.targetOwnerId, {
          attackerId: hack.attackerId,
          expiresAt,
        });
        break;

      case 'compromise_node':
        // Mark node as compromised (if targeting a node)
        if (hack.targetId.startsWith('node:')) {
          const nodeId = hack.targetId.substring(5);
          const node = this.networkNodes[nodeId];
          if (node) {
            applyNodeCompromise(node, hack.attackerId, duration);
          }
        }
        break;

      case 'launch_warning':
        // Monitor the silo for launch warnings
        this.monitoredSilos.set(hack.targetId, {
          attackerId: hack.attackerId,
          expiresAt,
        });
        break;

      case 'hijack_satellite':
        // Hijack satellite vision (target is sat:<id>)
        if (hack.targetId.startsWith('sat:')) {
          const satId = hack.targetId.substring(4);
          this.hijackedSatellites.set(satId, {
            attackerId: hack.attackerId,
            expiresAt,
          });
        }
        break;

      case 'cut_cable':
        // Cut the cable (target is cable:<id>)
        if (hack.targetId.startsWith('cable:')) {
          const cableId = hack.targetId.substring(6);
          const cable = this.networkConnections[cableId];
          if (cable) {
            cutCable(cable, hack.attackerId, duration);
          }
        }
        break;

      case 'false_flag':
        // Apply false flag to a node (target is node:<id>)
        if (hack.targetId.startsWith('node:')) {
          const nodeId = hack.targetId.substring(5);
          const node = this.networkNodes[nodeId];
          if (node) {
            // The impersonate ID should be passed through the hack somehow
            // For now, use a placeholder - this needs to be passed via protocol
            this.falseFlagNodes.set(nodeId, {
              impersonatePlayerId: hack.targetOwnerId, // Will be overridden
              ownerId: hack.attackerId,
              expiresAt,
            });
          }
        }
        break;
    }
  }

  /**
   * Remove expired compromises
   */
  private cleanupExpiredCompromises(): void {
    const now = Date.now();

    for (const [targetId, compromiseList] of this.compromises) {
      const remaining = compromiseList.filter(
        (c) => c.expiresAt === 0 || c.expiresAt > now
      );

      if (remaining.length === 0) {
        this.compromises.delete(targetId);
      } else if (remaining.length !== compromiseList.length) {
        this.compromises.set(targetId, remaining);
      }
    }
  }

  /**
   * Create an intrusion alert for the target owner
   */
  private createIntrusionAlert(hack: ActiveHack): void {
    const alert: IntrusionAlert = {
      id: uuidv4(),
      targetId: hack.targetId,
      detectedAt: Date.now(),
      traceProgress: 0,
    };

    const existing = this.intrusionAlerts.get(hack.targetOwnerId) || [];
    existing.push(alert);
    this.intrusionAlerts.set(hack.targetOwnerId, existing);
  }

  /**
   * Update intrusion alert trace progress
   */
  private updateIntrusionAlert(hack: ActiveHack): void {
    const alerts = this.intrusionAlerts.get(hack.targetOwnerId);
    if (!alerts) return;

    const alert = alerts.find((a) => a.targetId === hack.targetId);
    if (alert) {
      alert.traceProgress = hack.traceProgress;
      if (hack.traceProgress >= 100) {
        alert.attackerRevealed = hack.attackerId;
      }
    }
  }

  /**
   * Remove intrusion alert
   */
  private removeIntrusionAlert(targetId: string, ownerId: string): void {
    const alerts = this.intrusionAlerts.get(ownerId);
    if (!alerts) return;

    const index = alerts.findIndex((a) => a.targetId === targetId);
    if (index !== -1) {
      alerts.splice(index, 1);
      if (alerts.length === 0) {
        this.intrusionAlerts.delete(ownerId);
      }
    }
  }

  /**
   * Get intrusion alerts for a player
   */
  getIntrusionAlerts(playerId: string): IntrusionAlert[] {
    return this.intrusionAlerts.get(playerId) || [];
  }

  /**
   * Get compromises affecting a player's buildings
   */
  getCompromisesForPlayer(playerId: string): SystemCompromise[] {
    const result: SystemCompromise[] = [];

    for (const compromiseList of this.compromises.values()) {
      for (const compromise of compromiseList) {
        if (compromise.targetOwnerId === playerId) {
          result.push(compromise);
        }
      }
    }

    return result;
  }

  /**
   * Check if a building is compromised with a specific hack type
   */
  isCompromised(targetId: string, hackType?: HackType): boolean {
    const compromises = this.compromises.get(targetId);
    if (!compromises || compromises.length === 0) return false;

    if (hackType) {
      return compromises.some((c) => c.hackType === hackType);
    }

    return true;
  }

  /**
   * Get active compromise of a specific type for a building
   */
  getCompromise(targetId: string, hackType: HackType): SystemCompromise | undefined {
    const compromises = this.compromises.get(targetId);
    if (!compromises) return undefined;

    return compromises.find((c) => c.hackType === hackType);
  }

  /**
   * Get all compromises for a building
   */
  getCompromisesForBuilding(targetId: string): SystemCompromise[] {
    return this.compromises.get(targetId) || [];
  }

  /**
   * Get active hack for a player
   */
  getActiveHack(attackerId: string): ActiveHack | undefined {
    return Array.from(this.activeHacks.values()).find(
      (h) => h.attackerId === attackerId &&
        h.status !== 'completed' &&
        h.status !== 'traced' &&
        h.status !== 'disconnected'
    );
  }

  /**
   * Get hack by ID
   */
  getHack(hackId: string): ActiveHack | undefined {
    return this.activeHacks.get(hackId);
  }

  /**
   * Get detected buildings for a player
   */
  getDetectedBuildings(playerId: string): DetectedBuilding[] {
    return this.detectedBuildings.get(playerId) || [];
  }

  // ============ NETWORK WARFARE METHODS ============

  /**
   * Check if a player is under DDoS attack (can't initiate new hacks)
   */
  isPlayerUnderDdos(playerId: string): boolean {
    const ddos = this.ddosTargets.get(playerId);
    if (!ddos) return false;
    if (Date.now() > ddos.expiresAt) {
      this.ddosTargets.delete(playerId);
      return false;
    }
    return true;
  }

  /**
   * Check if a radar is being tapped by an attacker
   */
  isRadarTapped(radarId: string): { tapped: boolean; attackerId?: string } {
    const tap = this.tappedRadars.get(radarId);
    if (!tap) return { tapped: false };
    if (Date.now() > tap.expiresAt) {
      this.tappedRadars.delete(radarId);
      return { tapped: false };
    }
    return { tapped: true, attackerId: tap.attackerId };
  }

  /**
   * Get all radars tapped by a player (for fog-of-war integration)
   */
  getRadarsTappedByPlayer(playerId: string): string[] {
    const now = Date.now();
    const tappedRadarIds: string[] = [];

    for (const [radarId, tap] of this.tappedRadars) {
      if (tap.attackerId === playerId && now <= tap.expiresAt) {
        tappedRadarIds.push(radarId);
      }
    }

    return tappedRadarIds;
  }

  /**
   * Check if a silo is being monitored for launch warnings
   */
  isSiloMonitored(siloId: string): { monitored: boolean; attackerId?: string } {
    const monitor = this.monitoredSilos.get(siloId);
    if (!monitor) return { monitored: false };
    if (Date.now() > monitor.expiresAt) {
      this.monitoredSilos.delete(siloId);
      return { monitored: false };
    }
    return { monitored: true, attackerId: monitor.attackerId };
  }

  /**
   * Get all silos being monitored (for launch warning integration)
   */
  getMonitoredSilos(): Map<string, { attackerId: string; expiresAt: number }> {
    const now = Date.now();
    // Clean up expired entries
    for (const [siloId, monitor] of this.monitoredSilos) {
      if (now > monitor.expiresAt) {
        this.monitoredSilos.delete(siloId);
      }
    }
    return this.monitoredSilos;
  }

  /**
   * Check if a satellite is hijacked
   */
  isSatelliteHijacked(satelliteId: string): { hijacked: boolean; attackerId?: string } {
    const hijack = this.hijackedSatellites.get(satelliteId);
    if (!hijack) return { hijacked: false };
    if (Date.now() > hijack.expiresAt) {
      this.hijackedSatellites.delete(satelliteId);
      return { hijacked: false };
    }
    return { hijacked: true, attackerId: hijack.attackerId };
  }

  /**
   * Get all satellites hijacked by a player (for fog-of-war integration)
   */
  getSatellitesHijackedByPlayer(playerId: string): string[] {
    const now = Date.now();
    const hijackedSatIds: string[] = [];

    for (const [satId, hijack] of this.hijackedSatellites) {
      if (hijack.attackerId === playerId && now <= hijack.expiresAt) {
        hijackedSatIds.push(satId);
      }
    }

    return hijackedSatIds;
  }

  /**
   * Get intercontinental cables that can be targeted
   */
  getTargetableCables(): HackingConnection[] {
    return getIntercontinentalCables(this.networkConnections);
  }

  /**
   * Get network state for client
   */
  getNetworkState(): { nodes: Record<string, HackingNode>; connections: Record<string, HackingConnection> } {
    return {
      nodes: this.networkNodes,
      connections: this.networkConnections,
    };
  }

  /**
   * Check if trace should reveal a different attacker (false flag)
   */
  getFalseFlagAttacker(routeNodeIds: string[], realAttackerId: string): string | null {
    const now = Date.now();

    for (const nodeId of routeNodeIds) {
      const falseFlag = this.falseFlagNodes.get(nodeId);
      if (falseFlag && falseFlag.ownerId === realAttackerId && now <= falseFlag.expiresAt) {
        return falseFlag.impersonatePlayerId;
      }
    }

    return null;
  }

  /**
   * Set false flag impersonation target for a node
   */
  setFalseFlagTarget(nodeId: string, impersonatePlayerId: string): boolean {
    const falseFlag = this.falseFlagNodes.get(nodeId);
    if (!falseFlag) return false;

    falseFlag.impersonatePlayerId = impersonatePlayerId;
    return true;
  }

  /**
   * Clean up expired network warfare effects
   */
  cleanupExpiredNetworkEffects(): void {
    const now = Date.now();

    // Clean up tapped radars
    for (const [radarId, tap] of this.tappedRadars) {
      if (now > tap.expiresAt) {
        this.tappedRadars.delete(radarId);
      }
    }

    // Clean up DDoS targets
    for (const [playerId, ddos] of this.ddosTargets) {
      if (now > ddos.expiresAt) {
        this.ddosTargets.delete(playerId);
      }
    }

    // Clean up monitored silos
    for (const [siloId, monitor] of this.monitoredSilos) {
      if (now > monitor.expiresAt) {
        this.monitoredSilos.delete(siloId);
      }
    }

    // Clean up hijacked satellites
    for (const [satId, hijack] of this.hijackedSatellites) {
      if (now > hijack.expiresAt) {
        this.hijackedSatellites.delete(satId);
      }
    }

    // Clean up false flag nodes
    for (const [nodeId, falseFlag] of this.falseFlagNodes) {
      if (now > falseFlag.expiresAt) {
        this.falseFlagNodes.delete(nodeId);
      }
    }

    // Clean up network node/cable effects
    cleanupExpiredEffects(this.networkNodes, this.networkConnections, now);
  }

  /**
   * Get silo target position (for target_intel hack result)
   */
  getSiloTarget(silo: Silo): GeoPosition | undefined {
    return silo.targetedPosition;
  }
}
