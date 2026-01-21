import { v4 as uuidv4 } from 'uuid';
import {
  GameState,
  Building,
  Radar,
  Silo,
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
} from '@defcon/shared';

// Result of a hack tick update
export interface HackTickResult {
  completedHacks: { hack: ActiveHack; compromise: SystemCompromise }[];
  tracedHacks: ActiveHack[];
  progressUpdates: { hackId: string; progress: number; traceProgress: number }[];
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
   */
  private getVulnerabilities(building: Building): HackType[] {
    switch (building.type) {
      case 'radar':
        return ['blind_radar', 'spoof_radar'];
      case 'silo':
        return ['lock_silo', 'delay_silo'];
      case 'satellite_launch_facility':
        return ['disable_satellite', 'intercept_comms'];
      case 'airfield':
        return ['intercept_comms'];
      default:
        return [];
    }
  }

  /**
   * Start a new hack attempt
   */
  startHack(
    state: GameState,
    attackerId: string,
    targetId: string,
    hackType: HackType,
    proxyRoute?: string[]
  ): HackStartResult {
    const config = this.getConfig(state.defconLevel);

    // Check if hacking is enabled
    if (!config.hackingEnabled) {
      return { success: false, error: 'Hacking not available at this DEFCON level' };
    }

    // Find target building
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

    // Check if hack type is valid for this building
    const validHacks = this.getVulnerabilities(target);
    if (!validHacks.includes(hackType)) {
      return { success: false, error: `Invalid hack type for ${target.type}` };
    }

    // Check if attacker already has an active hack
    const existingHack = Array.from(this.activeHacks.values()).find(
      (h) => h.attackerId === attackerId && h.status !== 'completed' && h.status !== 'disconnected' && h.status !== 'traced'
    );
    if (existingHack) {
      return { success: false, error: 'Already have an active hack in progress' };
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
      targetOwnerId: target.ownerId,
      hackType,
      progress: 0,
      traceProgress: 0,
      startTime: Date.now(),
      status: 'connecting',
      proxyRoute,
    };

    this.activeHacks.set(hack.id, hack);

    // Create intrusion alert for target owner
    this.createIntrusionAlert(hack);

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

      // Check if target building still exists
      const target = state.buildings[hack.targetId];
      if (!target || target.destroyed) {
        hack.status = 'disconnected';
        this.removeIntrusionAlert(hack.targetId, hack.targetOwnerId);
        continue;
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

    // Add to compromises map
    const existing = this.compromises.get(hack.targetId) || [];
    existing.push(compromise);
    this.compromises.set(hack.targetId, existing);

    return compromise;
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
}
