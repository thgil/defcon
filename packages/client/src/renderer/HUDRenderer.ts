import type { GameState, Building, Silo, SatelliteLaunchFacility, DefconLevel, Player } from '@defcon/shared';
import type { GameAlert } from '../stores/gameStore';

const DEFCON_COLORS: Record<DefconLevel, string> = {
  5: '#00ff00',
  4: '#88ff00',
  3: '#ffff00',
  2: '#ff8800',
  1: '#ff0000',
};

const FONT = '12px "Courier New", monospace';
const FONT_SMALL = '10px "Courier New", monospace';
const FONT_LARGE = '16px "Courier New", monospace';
const FONT_TITLE = '24px "Courier New", monospace';

// Debug panel regions for AI selection
const AI_REGIONS = [
  { id: 'north_america', name: 'North America' },
  { id: 'south_america', name: 'South America' },
  { id: 'europe', name: 'Europe' },
  { id: 'russia', name: 'Russia' },
  { id: 'africa', name: 'Africa' },
  { id: 'asia', name: 'Asia' },
];

// Target regions for test missiles
const TARGET_REGIONS = [
  { id: 'any', name: 'Any Region' },
  ...AI_REGIONS,
];

interface Button {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  action: () => void;
  disabled?: boolean;
  active?: boolean;
}

export class HUDRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private gameState: GameState | null = null;
  private playerId: string | null = null;
  private selectedBuilding: Building | null = null;

  // UI state
  private buttons: Button[] = [];
  private hoveredButton: Button | null = null;

  // Callbacks
  private onModeChange: ((siloId: string, mode: 'air_defense' | 'icbm') => void) | null = null;
  private onPlacementMode: ((type: string | null) => void) | null = null;
  private onViewToggle: ((toggle: 'radar' | 'grid' | 'labels' | 'trails', value: boolean) => void) | null = null;
  private onLaunchSatellite: ((facilityId: string, inclination: number) => void) | null = null;
  private onDebugCommand: ((command: string, value?: number, targetRegion?: string) => void) | null = null;
  private onEnableAI: ((region: string) => void) | null = null;
  private onDisableAI: (() => void) | null = null;
  private onLayerToggle: ((layer: 'coastlines' | 'borders' | 'airspaces') => boolean) | null = null;

  // Placement state
  private placementMode: string | null = null;
  private placementCounts = { silo: 0, radar: 0, airfield: 0, satellite_launch_facility: 0 };
  private maxPlacements = { silo: 6, radar: 4, airfield: 2, satellite_launch_facility: 1 };

  // Satellite launch UI state
  private selectedInclination: number = 45;

  // View toggles state
  private viewToggles = {
    radar: true,
    grid: true,
    labels: true,
    trails: true,
  };

  // Debug panel state
  private debugPanelVisible = true;
  private selectedAIRegion = 'russia';
  private selectedTargetRegion = 'any';

  // Layer visibility state (for canvas-based toggles)
  private layerVisibility = {
    coastlines: true,
    borders: true,
    airspaces: true,
  };

  // Fog of war visibility
  private fogOfWarEnabled = true;
  private onFogOfWarToggle: ((enabled: boolean) => void) | null = null;

  // Timer interpolation state
  private lastStateUpdateTime = performance.now();
  private lastDefconTimer = 0;
  private lastDefconLevel = 5;

  // Alert display
  private alerts: GameAlert[] = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.pointerEvents = 'none'; // Let clicks pass through to 3D
    this.canvas.style.zIndex = '10';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.scale(dpr, dpr);
  }

  setCallbacks(
    onModeChange: (siloId: string, mode: 'air_defense' | 'icbm') => void,
    onPlacementMode: (type: string | null) => void,
    onViewToggle?: (toggle: 'radar' | 'grid' | 'labels' | 'trails', value: boolean) => void,
    onLaunchSatellite?: (facilityId: string, inclination: number) => void
  ): void {
    this.onModeChange = onModeChange;
    this.onPlacementMode = onPlacementMode;
    this.onViewToggle = onViewToggle || null;
    this.onLaunchSatellite = onLaunchSatellite || null;
  }

  setViewToggles(toggles: { radar: boolean; grid: boolean; labels: boolean; trails: boolean }): void {
    this.viewToggles = { ...toggles };
  }

  setDebugCallbacks(
    onDebugCommand: (command: string, value?: number, targetRegion?: string) => void,
    onEnableAI: (region: string) => void,
    onDisableAI: () => void,
    onLayerToggle: (layer: 'coastlines' | 'borders' | 'airspaces') => boolean,
    onFogOfWarToggle?: (enabled: boolean) => void
  ): void {
    this.onDebugCommand = onDebugCommand;
    this.onEnableAI = onEnableAI;
    this.onDisableAI = onDisableAI;
    this.onLayerToggle = onLayerToggle;
    this.onFogOfWarToggle = onFogOfWarToggle || null;
  }

  setDebugPanelVisible(visible: boolean): void {
    this.debugPanelVisible = visible;
  }

  toggleDebugPanel(): void {
    this.debugPanelVisible = !this.debugPanelVisible;
  }

  setLayerVisibility(visibility: { coastlines: boolean; borders: boolean; airspaces: boolean }): void {
    this.layerVisibility = { ...visibility };
  }

  updateState(
    gameState: GameState | null,
    playerId: string | null,
    selectedBuilding: Building | null,
    placementMode: string | null
  ): void {
    // Track timer changes for interpolation
    if (gameState) {
      // Only update baseline if timer changed or DEFCON level changed
      if (gameState.defconTimer !== this.lastDefconTimer ||
          gameState.defconLevel !== this.lastDefconLevel) {
        this.lastStateUpdateTime = performance.now();
        this.lastDefconTimer = gameState.defconTimer;
        this.lastDefconLevel = gameState.defconLevel;
      }
    }

    this.gameState = gameState;
    this.playerId = playerId;
    this.selectedBuilding = selectedBuilding;
    this.placementMode = placementMode;

    // Update placement counts
    if (gameState && playerId) {
      const myBuildings = Object.values(gameState.buildings).filter(b => b.ownerId === playerId);
      this.placementCounts = {
        silo: myBuildings.filter(b => b.type === 'silo').length,
        radar: myBuildings.filter(b => b.type === 'radar').length,
        airfield: myBuildings.filter(b => b.type === 'airfield').length,
        satellite_launch_facility: myBuildings.filter(b => b.type === 'satellite_launch_facility').length,
      };
      this.maxPlacements = {
        silo: gameState.config.startingUnits.silos,
        radar: gameState.config.startingUnits.radars,
        airfield: gameState.config.startingUnits.airfields,
        satellite_launch_facility: gameState.config.startingUnits.satellite_launch_facilities,
      };
    }
  }

  render(): void {
    if (!this.gameState || !this.playerId) return;

    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);

    // Clear canvas (transparent so 3D shows through)
    this.ctx.clearRect(0, 0, width, height);

    // Reset buttons for this frame
    this.buttons = [];

    // Draw DEFCON indicator (top center)
    this.drawDefconIndicator(width);

    // Draw player info (top left)
    this.drawPlayerInfo();

    // Draw placement panel (left side during DEFCON 5)
    if (this.gameState.defconLevel === 5) {
      this.drawPlacementPanel(height);
    }

    // Draw selected building panel (bottom left)
    if (this.selectedBuilding) {
      this.drawSelectedBuildingPanel(height);
    }

    // Draw scoreboard (top right)
    this.drawScoreboard(width);

    // Draw debug panel (below scoreboard, top right)
    if (this.debugPanelVisible) {
      this.drawDebugPanel(width);
    }

    // Draw layer toggles (bottom right, above status bar)
    this.drawLayerToggles(width, height);

    // Draw view toggles (above layer toggles)
    this.drawViewToggles(width, height);

    // Draw bottom status bar
    this.drawStatusBar(width, height);

    // Draw alerts (center-left)
    this.drawAlerts(height);
  }

  setAlerts(alerts: GameAlert[]): void {
    this.alerts = alerts;
  }

  private drawAlerts(height: number): void {
    if (this.alerts.length === 0) return;

    const now = Date.now();
    const alertX = 20;
    let alertY = height / 2 - (this.alerts.length * 30);

    for (const alert of this.alerts) {
      // Calculate fade based on time remaining
      const timeLeft = alert.expiresAt - now;
      const fadeStart = 2000; // Start fading 2 seconds before expiry
      const opacity = timeLeft < fadeStart ? timeLeft / fadeStart : 1;

      if (opacity <= 0) continue;

      // Flashing effect for launch detected
      const flash = alert.type === 'launch_detected' && Math.sin(now / 150) > 0;

      // Background
      this.ctx.fillStyle = `rgba(80, 0, 0, ${0.9 * opacity})`;
      this.ctx.fillRect(alertX, alertY, 280, 28);

      // Border (flashing)
      this.ctx.strokeStyle = flash ? `rgba(255, 100, 100, ${opacity})` : `rgba(255, 0, 0, ${opacity})`;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(alertX, alertY, 280, 28);

      // Warning icon
      this.ctx.fillStyle = `rgba(255, 200, 0, ${opacity})`;
      this.ctx.font = FONT_LARGE;
      this.ctx.textAlign = 'left';
      this.ctx.fillText('⚠', alertX + 8, alertY + 20);

      // Alert text
      this.ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
      this.ctx.font = FONT;
      this.ctx.fillText(alert.message, alertX + 30, alertY + 18);

      alertY += 35;
    }
  }

  private drawDefconIndicator(width: number): void {
    const state = this.gameState!;
    const color = DEFCON_COLORS[state.defconLevel];
    const centerX = width / 2;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(centerX - 100, 8, 200, 50);
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(centerX - 100, 8, 200, 50);

    // DEFCON text
    this.ctx.fillStyle = color;
    this.ctx.font = FONT_TITLE;
    this.ctx.textAlign = 'center';
    this.ctx.fillText(`DEFCON ${state.defconLevel}`, centerX, 38);

    // Timer - interpolate client-side for smooth updates
    const elapsedSinceUpdate = performance.now() - this.lastStateUpdateTime;
    const interpolatedTimer = Math.max(0, this.lastDefconTimer - elapsedSinceUpdate);
    const timeLeft = Math.ceil(interpolatedTimer / 1000);
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    this.ctx.font = FONT;
    this.ctx.fillStyle = '#888';
    this.ctx.fillText(`${minutes}:${seconds.toString().padStart(2, '0')}`, centerX, 52);
  }

  private drawPlayerInfo(): void {
    const state = this.gameState!;
    const player = state.players[this.playerId!];
    if (!player) return;

    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(8, 8, 180, 60);
    this.ctx.strokeStyle = '#00ff88';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(8, 8, 180, 60);

    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = FONT_LARGE;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(player.name, 16, 28);

    this.ctx.font = FONT;
    this.ctx.fillStyle = '#888';
    this.ctx.fillText(`Population: ${(player.populationRemaining / 1000000).toFixed(1)}M`, 16, 44);
    this.ctx.fillText(`Score: ${player.score}`, 16, 58);
  }

  private drawPlacementPanel(height: number): void {
    const panelX = 8;
    const panelY = 80;
    const panelWidth = 180;
    const panelHeight = 172;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#00ff88';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Title
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = FONT_LARGE;
    this.ctx.textAlign = 'left';
    this.ctx.fillText('PLACE UNITS', panelX + 8, panelY + 20);

    // Placement buttons
    const buttonY = panelY + 32;
    const buttonHeight = 28;
    const buttonSpacing = 32;

    const types: Array<{ type: 'silo' | 'radar' | 'airfield' | 'satellite_launch_facility'; label: string }> = [
      { type: 'silo', label: 'SILO' },
      { type: 'radar', label: 'RADAR' },
      { type: 'airfield', label: 'AIRFIELD' },
      { type: 'satellite_launch_facility', label: 'SAT UPLINK' },
    ];

    types.forEach((item, i) => {
      const y = buttonY + i * buttonSpacing;
      const remaining = this.maxPlacements[item.type] - this.placementCounts[item.type];
      const isActive = this.placementMode === item.type;
      const isDisabled = remaining <= 0;

      this.drawButton({
        x: panelX + 8,
        y,
        width: panelWidth - 16,
        height: buttonHeight,
        label: `${item.label} (${remaining}/${this.maxPlacements[item.type]})`,
        action: () => {
          if (this.onPlacementMode) {
            this.onPlacementMode(isActive ? null : item.type);
          }
        },
        disabled: isDisabled,
        active: isActive,
      });
    });

    // Hint text
    this.ctx.fillStyle = '#666';
    this.ctx.font = FONT;
    this.ctx.fillText('Right-click to cancel', panelX + 8, panelY + panelHeight - 8);
  }

  private drawSelectedBuildingPanel(height: number): void {
    const building = this.selectedBuilding!;
    const panelX = 8;
    const statusBarHeight = 30;
    const panelHeight = 130;
    const panelY = height - statusBarHeight - panelHeight - 8; // Above status bar with margin
    const panelWidth = 200;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#00ff88';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Title
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = FONT_LARGE;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(building.type.toUpperCase(), panelX + 8, panelY + 20);

    if (building.type === 'silo') {
      const silo = building as Silo;

      // Mode display
      this.ctx.font = FONT;
      this.ctx.fillStyle = '#888';
      this.ctx.fillText(`Mode: ${silo.mode === 'air_defense' ? 'DEFEND' : 'ATTACK'}`, panelX + 8, panelY + 40);

      // Ammo display
      const ammoText = silo.mode === 'air_defense'
        ? `Interceptors: ${silo.airDefenseAmmo}`
        : `Missiles: ${silo.missileCount}`;
      this.ctx.fillText(ammoText, panelX + 8, panelY + 56);

      // Mode switch buttons
      const buttonY = panelY + 68;
      const buttonWidth = (panelWidth - 24) / 2;

      this.drawButton({
        x: panelX + 8,
        y: buttonY,
        width: buttonWidth,
        height: 26,
        label: 'DEFEND',
        action: () => {
          if (this.onModeChange) {
            this.onModeChange(silo.id, 'air_defense');
          }
        },
        disabled: silo.mode === 'air_defense',
        active: silo.mode === 'air_defense',
      });

      this.drawButton({
        x: panelX + 12 + buttonWidth,
        y: buttonY,
        width: buttonWidth,
        height: 26,
        label: 'ATTACK',
        action: () => {
          if (this.onModeChange) {
            this.onModeChange(silo.id, 'icbm');
          }
        },
        disabled: silo.mode === 'icbm',
        active: silo.mode === 'icbm',
      });

      // Hint for attack mode
      if (silo.mode === 'icbm' && this.gameState!.defconLevel === 1) {
        this.ctx.fillStyle = '#ff4444';
        this.ctx.font = FONT;
        this.ctx.fillText('Click target to launch', panelX + 8, panelY + 115);
      }
    } else if (building.type === 'radar') {
      this.ctx.font = FONT;
      this.ctx.fillStyle = '#888';
      this.ctx.fillText(`Range: ${this.gameState!.config.radarRange}`, panelX + 8, panelY + 40);
      this.ctx.fillText('Status: ACTIVE', panelX + 8, panelY + 56);
    } else if (building.type === 'airfield') {
      this.ctx.font = FONT;
      this.ctx.fillStyle = '#888';
      this.ctx.fillText('Fighters: 0', panelX + 8, panelY + 40);
      this.ctx.fillText('Bombers: 0', panelX + 8, panelY + 56);
    } else if (building.type === 'satellite_launch_facility') {
      const facility = building as SatelliteLaunchFacility;

      // Satellite count
      this.ctx.font = FONT;
      this.ctx.fillStyle = '#888';
      this.ctx.fillText(`Satellites: ${facility.satellites}`, panelX + 8, panelY + 40);

      // Cooldown status
      const now = Date.now();
      const cooldownRemaining = Math.max(0, facility.lastLaunchTime + facility.launchCooldown - now);
      if (cooldownRemaining > 0) {
        this.ctx.fillStyle = '#ff4444';
        this.ctx.fillText(`Cooldown: ${(cooldownRemaining / 1000).toFixed(0)}s`, panelX + 8, panelY + 56);
      } else {
        this.ctx.fillStyle = '#00ff88';
        this.ctx.fillText('Ready to launch', panelX + 8, panelY + 56);
      }

      // Only show launch controls after DEFCON 5
      if (this.gameState!.defconLevel < 5) {
        // Inclination selector
        this.ctx.fillStyle = '#888';
        this.ctx.fillText(`Inclination: ${this.selectedInclination}°`, panelX + 8, panelY + 72);

        // Inclination buttons
        const incButtonY = panelY + 80;
        const incButtonWidth = 30;

        this.drawButton({
          x: panelX + 8,
          y: incButtonY,
          width: incButtonWidth,
          height: 20,
          label: '-15',
          action: () => {
            this.selectedInclination = Math.max(0, this.selectedInclination - 15);
          },
        });

        this.drawButton({
          x: panelX + 42,
          y: incButtonY,
          width: incButtonWidth,
          height: 20,
          label: '+15',
          action: () => {
            this.selectedInclination = Math.min(90, this.selectedInclination + 15);
          },
        });

        // Launch button
        const canLaunch = facility.satellites > 0 && cooldownRemaining <= 0;
        this.drawButton({
          x: panelX + 80,
          y: incButtonY,
          width: 110,
          height: 20,
          label: 'LAUNCH',
          disabled: !canLaunch,
          action: () => {
            if (canLaunch && this.onLaunchSatellite) {
              this.onLaunchSatellite(facility.id, this.selectedInclination);
            }
          },
        });
      } else {
        this.ctx.fillStyle = '#888';
        this.ctx.fillText('Available at DEFCON 4', panelX + 8, panelY + 72);
      }
    }
  }

  private drawScoreboard(width: number): void {
    const state = this.gameState!;
    const players = Object.values(state.players);

    const panelX = width - 188;
    const panelY = 8;
    const panelWidth = 180;
    const panelHeight = 20 + players.length * 18;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#444';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Players
    this.ctx.font = FONT;
    this.ctx.textAlign = 'left';

    players.forEach((player, i) => {
      const y = panelY + 16 + i * 18;
      const isMe = player.id === this.playerId;

      this.ctx.fillStyle = isMe ? '#00ff88' : '#888';
      this.ctx.fillText(player.name, panelX + 8, y);

      this.ctx.textAlign = 'right';
      this.ctx.fillText(`${player.score}`, panelX + panelWidth - 8, y);
      this.ctx.textAlign = 'left';
    });
  }

  private drawDebugPanel(width: number): void {
    const state = this.gameState!;
    const players = Object.values(state.players);
    const scoreboardHeight = 20 + players.length * 18;

    const panelX = width - 188;
    const panelY = 8 + scoreboardHeight + 8;
    const panelWidth = 180;
    const panelHeight = 320;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#ff00ff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Title
    this.ctx.fillStyle = '#ff00ff';
    this.ctx.font = FONT_LARGE;
    this.ctx.textAlign = 'left';
    this.ctx.fillText('DEBUG', panelX + 8, panelY + 18);

    // Current DEFCON
    this.ctx.font = FONT;
    this.ctx.fillStyle = '#888';
    this.ctx.fillText(`DEFCON: ${state.defconLevel}`, panelX + 8, panelY + 36);

    // Advance DEFCON button
    let buttonY = panelY + 44;
    this.drawButton({
      x: panelX + 8,
      y: buttonY,
      width: panelWidth - 16,
      height: 22,
      label: 'Advance DEFCON',
      action: () => {
        if (this.onDebugCommand) {
          this.onDebugCommand('advance_defcon');
        }
      },
    });

    // DEFCON level buttons
    buttonY += 28;
    const defconButtonWidth = (panelWidth - 16 - 16) / 5;
    [5, 4, 3, 2, 1].forEach((level, i) => {
      this.drawButton({
        x: panelX + 8 + i * (defconButtonWidth + 4),
        y: buttonY,
        width: defconButtonWidth,
        height: 22,
        label: `${level}`,
        active: state.defconLevel === level,
        disabled: state.defconLevel === level,
        action: () => {
          if (this.onDebugCommand) {
            this.onDebugCommand('set_defcon', level);
          }
        },
      });
    });

    // Skip timer and refill ammo buttons
    buttonY += 28;
    const halfWidth = (panelWidth - 20) / 2;
    this.drawButton({
      x: panelX + 8,
      y: buttonY,
      width: halfWidth,
      height: 22,
      label: 'Skip Timer',
      action: () => {
        if (this.onDebugCommand) {
          this.onDebugCommand('skip_timer');
        }
      },
    });

    this.drawButton({
      x: panelX + 12 + halfWidth,
      y: buttonY,
      width: halfWidth,
      height: 22,
      label: 'Refill Ammo',
      action: () => {
        if (this.onDebugCommand) {
          this.onDebugCommand('add_missiles');
        }
      },
    });

    // Test missiles section
    buttonY += 32;
    this.ctx.fillStyle = '#888';
    this.ctx.font = FONT_SMALL;
    this.ctx.fillText('Test Missiles', panelX + 8, buttonY);

    // Target region selector (simulated with buttons for each region)
    buttonY += 10;
    const thirdWidth = (panelWidth - 20) / 3;
    [3, 5, 10].forEach((count, i) => {
      this.drawButton({
        x: panelX + 8 + i * (thirdWidth + 4),
        y: buttonY,
        width: thirdWidth,
        height: 22,
        label: `${count}`,
        disabled: state.defconLevel !== 1,
        action: () => {
          if (this.onDebugCommand) {
            const target = this.selectedTargetRegion === 'any' ? undefined : this.selectedTargetRegion;
            this.onDebugCommand('launch_test_missiles', count, target);
          }
        },
      });
    });

    // AI section
    buttonY += 36;
    this.ctx.fillStyle = '#888';
    this.ctx.font = FONT_SMALL;
    this.ctx.fillText('Enemy AI', panelX + 8, buttonY);

    const aiPlayer = players.find(p => p.isAI);
    buttonY += 10;

    if (aiPlayer) {
      // AI is active - show disable button
      this.ctx.fillStyle = '#ff4444';
      this.ctx.font = FONT_SMALL;
      this.ctx.fillText(`${aiPlayer.name} (Active)`, panelX + 8, buttonY + 10);

      buttonY += 18;
      this.drawButton({
        x: panelX + 8,
        y: buttonY,
        width: panelWidth - 16,
        height: 22,
        label: 'Disable AI',
        action: () => {
          if (this.onDisableAI) {
            this.onDisableAI();
          }
        },
      });
    } else {
      // AI not active - show region selector and enable button
      const availableRegions = AI_REGIONS.filter(region => {
        const territory = state.territories[region.id];
        return !territory?.ownerId;
      });

      if (availableRegions.length > 0) {
        // Region selector as a row of small buttons
        const regionButtonWidth = (panelWidth - 20) / 3;
        availableRegions.slice(0, 3).forEach((region, i) => {
          this.drawButton({
            x: panelX + 8 + i * (regionButtonWidth + 4),
            y: buttonY,
            width: regionButtonWidth,
            height: 20,
            label: region.name.substring(0, 8),
            active: this.selectedAIRegion === region.id,
            action: () => {
              this.selectedAIRegion = region.id;
            },
          });
        });

        if (availableRegions.length > 3) {
          buttonY += 24;
          availableRegions.slice(3).forEach((region, i) => {
            this.drawButton({
              x: panelX + 8 + i * (regionButtonWidth + 4),
              y: buttonY,
              width: regionButtonWidth,
              height: 20,
              label: region.name.substring(0, 8),
              active: this.selectedAIRegion === region.id,
              action: () => {
                this.selectedAIRegion = region.id;
              },
            });
          });
        }

        buttonY += 26;
        this.drawButton({
          x: panelX + 8,
          y: buttonY,
          width: panelWidth - 16,
          height: 22,
          label: 'Enable AI',
          action: () => {
            if (this.onEnableAI) {
              this.onEnableAI(this.selectedAIRegion);
            }
          },
        });
      } else {
        this.ctx.fillStyle = '#666';
        this.ctx.font = FONT_SMALL;
        this.ctx.fillText('No available regions', panelX + 8, buttonY + 12);
      }
    }

    // Fog of War toggle
    buttonY = panelY + panelHeight - 56;
    this.drawButton({
      x: panelX + 8,
      y: buttonY,
      width: panelWidth - 16,
      height: 22,
      label: this.fogOfWarEnabled ? 'Disable Fog of War' : 'Enable Fog of War',
      active: !this.fogOfWarEnabled,
      action: () => {
        this.fogOfWarEnabled = !this.fogOfWarEnabled;
        if (this.onFogOfWarToggle) {
          this.onFogOfWarToggle(this.fogOfWarEnabled);
        }
      },
    });

    // Press D to toggle hint
    this.ctx.fillStyle = '#444';
    this.ctx.font = FONT_SMALL;
    this.ctx.fillText('Press D to toggle', panelX + 8, panelY + panelHeight - 6);
  }

  private drawLayerToggles(width: number, height: number): void {
    const statusBarHeight = 30;
    const viewTogglePanelHeight = 24 + 16; // height of view toggles panel
    const toggleHeight = 24;
    const toggleWidth = 70;
    const toggleSpacing = 4;
    const panelPadding = 8;

    const toggles: Array<{ key: 'coastlines' | 'borders' | 'airspaces'; label: string }> = [
      { key: 'coastlines', label: 'COAST' },
      { key: 'borders', label: 'BORDERS' },
      { key: 'airspaces', label: 'AIR' },
    ];

    const panelWidth = toggles.length * (toggleWidth + toggleSpacing) - toggleSpacing + panelPadding * 2;
    const panelHeight = toggleHeight + panelPadding * 2;
    const panelX = width - panelWidth - 8;
    const panelY = height - statusBarHeight - viewTogglePanelHeight - panelHeight - 16;

    // Panel background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#333';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Draw toggle buttons
    toggles.forEach((toggle, i) => {
      const x = panelX + panelPadding + i * (toggleWidth + toggleSpacing);
      const y = panelY + panelPadding;
      const isActive = this.layerVisibility[toggle.key];

      this.drawButton({
        x,
        y,
        width: toggleWidth,
        height: toggleHeight,
        label: toggle.label,
        action: () => {
          if (this.onLayerToggle) {
            const newValue = this.onLayerToggle(toggle.key);
            this.layerVisibility[toggle.key] = newValue;
          }
        },
        active: isActive,
      });
    });
  }

  private drawStatusBar(width: number, height: number): void {
    const barHeight = 30;
    const y = height - barHeight;

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.fillRect(0, y, width, barHeight);
    this.ctx.strokeStyle = '#333';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, y);
    this.ctx.lineTo(width, y);
    this.ctx.stroke();

    // Game tick info
    this.ctx.fillStyle = '#444';
    this.ctx.font = FONT;
    this.ctx.textAlign = 'left';
    this.ctx.fillText(`Tick: ${this.gameState!.tick}`, 8, y + 20);

    // Phase info
    this.ctx.textAlign = 'right';
    const phase = this.gameState!.phase.toUpperCase();
    this.ctx.fillText(`Phase: ${phase}`, width - 8, y + 20);
  }

  private drawViewToggles(width: number, height: number): void {
    const statusBarHeight = 30;
    const toggleHeight = 24;
    const toggleWidth = 60;
    const toggleSpacing = 4;
    const panelPadding = 8;

    const toggles: Array<{ key: 'radar' | 'grid' | 'labels' | 'trails'; label: string }> = [
      { key: 'radar', label: 'RADAR' },
      { key: 'grid', label: 'GRID' },
      { key: 'labels', label: 'LABELS' },
      { key: 'trails', label: 'TRAILS' },
    ];

    const panelWidth = toggles.length * (toggleWidth + toggleSpacing) - toggleSpacing + panelPadding * 2;
    const panelHeight = toggleHeight + panelPadding * 2;
    const panelX = width - panelWidth - 8;
    const panelY = height - statusBarHeight - panelHeight - 8;

    // Panel background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
    this.ctx.strokeStyle = '#333';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

    // Draw toggle buttons
    toggles.forEach((toggle, i) => {
      const x = panelX + panelPadding + i * (toggleWidth + toggleSpacing);
      const y = panelY + panelPadding;
      const isActive = this.viewToggles[toggle.key];

      this.drawButton({
        x,
        y,
        width: toggleWidth,
        height: toggleHeight,
        label: toggle.label,
        action: () => {
          this.viewToggles[toggle.key] = !this.viewToggles[toggle.key];
          if (this.onViewToggle) {
            this.onViewToggle(toggle.key, this.viewToggles[toggle.key]);
          }
        },
        active: isActive,
      });
    });
  }

  private drawButton(button: Button): void {
    this.buttons.push(button);

    const isHovered = this.hoveredButton === button ||
      (this.hoveredButton &&
       this.hoveredButton.x === button.x &&
       this.hoveredButton.y === button.y);

    // Background
    if (button.active) {
      this.ctx.fillStyle = 'rgba(0, 255, 136, 0.2)';
    } else if (isHovered && !button.disabled) {
      this.ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    } else {
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    }
    this.ctx.fillRect(button.x, button.y, button.width, button.height);

    // Border
    if (button.active) {
      this.ctx.strokeStyle = '#00ff88';
    } else if (button.disabled) {
      this.ctx.strokeStyle = '#333';
    } else {
      this.ctx.strokeStyle = '#666';
    }
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(button.x, button.y, button.width, button.height);

    // Text
    if (button.disabled) {
      this.ctx.fillStyle = '#444';
    } else if (button.active) {
      this.ctx.fillStyle = '#00ff88';
    } else {
      this.ctx.fillStyle = '#888';
    }
    this.ctx.font = FONT;
    this.ctx.textAlign = 'center';
    this.ctx.fillText(button.label, button.x + button.width / 2, button.y + button.height / 2 + 4);
  }

  // Called by GlobeRenderer to handle clicks
  // Returns true if click was handled by UI, false if it should pass to 3D
  handleClick(x: number, y: number): boolean {
    // Check if clicking any button
    for (const button of this.buttons) {
      if (x >= button.x && x <= button.x + button.width &&
          y >= button.y && y <= button.y + button.height) {
        if (!button.disabled) {
          button.action();
        }
        return true; // Click handled by UI
      }
    }

    // Check if click is over any UI panel (even if not on a button)
    return this.isOverUI(x, y);
  }

  // Called by GlobeRenderer on mouse move
  handleMouseMove(x: number, y: number): void {
    // Check if hovering over any button
    this.hoveredButton = null;
    for (const button of this.buttons) {
      if (x >= button.x && x <= button.x + button.width &&
          y >= button.y && y <= button.y + button.height) {
        this.hoveredButton = button;
        return;
      }
    }
  }

  // Returns the appropriate cursor for the current mouse position
  getCursor(x: number, y: number): string {
    for (const button of this.buttons) {
      if (x >= button.x && x <= button.x + button.width &&
          y >= button.y && y <= button.y + button.height) {
        return button.disabled ? 'not-allowed' : 'pointer';
      }
    }
    return 'default';
  }

  // Check if a point is over UI (to prevent clicks passing through to 3D)
  isOverUI(x: number, y: number): boolean {
    // Check all UI regions
    const height = this.canvas.height / (window.devicePixelRatio || 1);
    const width = this.canvas.width / (window.devicePixelRatio || 1);

    // Top left player info
    if (x >= 8 && x <= 188 && y >= 8 && y <= 68) return true;

    // Top center DEFCON
    const centerX = width / 2;
    if (x >= centerX - 100 && x <= centerX + 100 && y >= 8 && y <= 58) return true;

    // Top right scoreboard
    const players = this.gameState ? Object.values(this.gameState.players) : [];
    const scoreboardHeight = 20 + players.length * 18;
    if (x >= width - 188 && y >= 8 && y <= 8 + scoreboardHeight) return true;

    // Debug panel (below scoreboard)
    if (this.debugPanelVisible) {
      const debugPanelY = 8 + scoreboardHeight + 8;
      const debugPanelHeight = 290;
      if (x >= width - 188 && x <= width - 8 &&
          y >= debugPanelY && y <= debugPanelY + debugPanelHeight) return true;
    }

    // Left placement panel (during DEFCON 5)
    if (this.gameState?.defconLevel === 5 && x >= 8 && x <= 188 && y >= 80 && y <= 260) return true;

    // Bottom left selected building panel (above status bar)
    const statusBarHeight = 30;
    const panelHeight = 130;
    const panelTop = height - statusBarHeight - panelHeight - 8;
    if (this.selectedBuilding && x >= 8 && x <= 208 && y >= panelTop && y <= panelTop + panelHeight) return true;

    // Bottom right view toggles panel
    const toggleWidth = 60;
    const toggleSpacing = 4;
    const togglePanelPadding = 8;
    const togglePanelWidth = 4 * (toggleWidth + toggleSpacing) - toggleSpacing + togglePanelPadding * 2;
    const togglePanelHeight = 24 + togglePanelPadding * 2;
    const togglePanelX = width - togglePanelWidth - 8;
    const togglePanelY = height - statusBarHeight - togglePanelHeight - 8;
    if (x >= togglePanelX && x <= togglePanelX + togglePanelWidth &&
        y >= togglePanelY && y <= togglePanelY + togglePanelHeight) return true;

    // Bottom right layer toggles panel (above view toggles)
    const viewTogglePanelHeight = 24 + 16;
    const layerToggleWidth = 70;
    const layerPanelWidth = 3 * (layerToggleWidth + toggleSpacing) - toggleSpacing + togglePanelPadding * 2;
    const layerPanelHeight = 24 + togglePanelPadding * 2;
    const layerPanelX = width - layerPanelWidth - 8;
    const layerPanelY = height - statusBarHeight - viewTogglePanelHeight - layerPanelHeight - 16;
    if (x >= layerPanelX && x <= layerPanelX + layerPanelWidth &&
        y >= layerPanelY && y <= layerPanelY + layerPanelHeight) return true;

    // Bottom status bar
    if (y >= height - statusBarHeight) return true;

    return false;
  }

  dispose(): void {
    this.canvas.remove();
  }
}
