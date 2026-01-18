import {
  type GameState,
  type Building,
  type Missile,
  type City,
  type Territory,
  type Vector2,
  type Radar,
  type Silo,
  getTerritories,
  getCities,
  getBuildings,
  getMissiles,
} from '@defcon/shared';

// DEFCON color palette
const COLORS = {
  background: '#0a0a14',
  grid: '#1a1a2e',
  border: '#2a4a2a',

  defcon: {
    5: '#00ff00',
    4: '#88ff00',
    3: '#ffff00',
    2: '#ff8800',
    1: '#ff0000',
  } as Record<number, string>,

  friendly: '#00ff88',
  friendlyGlow: 'rgba(0, 255, 136, 0.3)',
  enemy: '#ff4444',
  enemyGlow: 'rgba(255, 68, 68, 0.3)',
  neutral: '#8888ff',

  missile: '#ff0000',
  missileTrail: 'rgba(255, 0, 0, 0.3)',
  interceptor: '#00ffff',

  city: '#ffff00',
  cityDestroyed: '#444400',

  radar: 'rgba(0, 255, 136, 0.1)',
  radarSweep: 'rgba(0, 255, 136, 0.3)',
};

export class Renderer {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private gameState: GameState | null = null;
  private playerId: string | null = null;
  private animationFrame: number | null = null;
  private radarAngle = 0;
  private lastTime = 0;

  // Trail storage for missiles
  private missileTrails = new Map<string, Vector2[]>();

  // Bound resize handler for proper event listener removal
  private handleResize = (): void => {
    this.resize();
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.container.appendChild(this.canvas);

    this.resize();
    window.addEventListener('resize', this.handleResize);

    this.startRenderLoop();
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize);
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    this.canvas.remove();
  }

  setGameState(state: GameState, playerId: string | null): void {
    this.gameState = state;
    this.playerId = playerId;
  }

  private resize = (): void => {
    const rect = this.container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  };

  private startRenderLoop(): void {
    const render = (time: number) => {
      const deltaTime = (time - this.lastTime) / 1000;
      this.lastTime = time;

      this.render(deltaTime);
      this.animationFrame = requestAnimationFrame(render);
    };
    this.animationFrame = requestAnimationFrame(render);
  }

  private render(deltaTime: number): void {
    const ctx = this.ctx;

    // Clear
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.gameState) return;

    // Update animations
    this.radarAngle += deltaTime * Math.PI * 0.5; // 90 degrees per second

    // Draw layers
    this.drawGrid();
    this.drawTerritories();
    this.drawRadarCoverage();
    this.drawCities();
    this.drawBuildings();
    this.drawMissiles(deltaTime);
    this.drawRadarSweep();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const gridSize = 50;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.3;

    // Vertical lines
    for (let x = 0; x < this.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y < this.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  private drawTerritories(): void {
    if (!this.gameState) return;
    const ctx = this.ctx;

    for (const territory of getTerritories(this.gameState)) {
      const isOwned = territory.ownerId !== null;
      const isMine = territory.ownerId === this.playerId;

      for (const boundary of territory.boundaries) {
        if (boundary.length < 3) continue;

        // Fill
        ctx.beginPath();
        ctx.moveTo(boundary[0].x, boundary[0].y);
        for (let i = 1; i < boundary.length; i++) {
          ctx.lineTo(boundary[i].x, boundary[i].y);
        }
        ctx.closePath();

        if (isOwned) {
          ctx.fillStyle = isMine
            ? 'rgba(0, 255, 136, 0.05)'
            : 'rgba(255, 68, 68, 0.05)';
          ctx.fill();
        }

        // Border
        ctx.strokeStyle = isMine ? COLORS.friendly : isOwned ? COLORS.enemy : COLORS.border;
        ctx.lineWidth = isMine ? 2 : 1;
        ctx.stroke();

        // Draw glow for owned territories
        if (isMine) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = COLORS.friendlyGlow;
          ctx.lineWidth = 4;
          ctx.filter = 'blur(4px)';
          ctx.stroke();
          ctx.restore();
        }
      }

      // Draw territory name at centroid
      ctx.fillStyle = '#444';
      ctx.font = '10px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(territory.name.toUpperCase(), territory.centroid.x, territory.centroid.y);
    }
  }

  private drawRadarCoverage(): void {
    if (!this.gameState || !this.playerId) return;
    const ctx = this.ctx;

    // Draw radar coverage for player's radars
    const playerRadars = getBuildings(this.gameState).filter(
      (b): b is Radar => b.type === 'radar' && b.ownerId === this.playerId && !b.destroyed
    );

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const radar of playerRadars) {
      const gradient = ctx.createRadialGradient(
        radar.position.x,
        radar.position.y,
        0,
        radar.position.x,
        radar.position.y,
        radar.range
      );
      gradient.addColorStop(0, 'rgba(0, 255, 136, 0.1)');
      gradient.addColorStop(0.7, 'rgba(0, 255, 136, 0.05)');
      gradient.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.arc(radar.position.x, radar.position.y, radar.range, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    ctx.restore();
  }

  private drawCities(): void {
    if (!this.gameState) return;
    const ctx = this.ctx;

    for (const city of getCities(this.gameState)) {
      const territory = this.gameState.territories[city.territoryId];
      const isMine = territory?.ownerId === this.playerId;

      // City marker
      const size = Math.max(4, Math.sqrt(city.population / 1000000) * 3);
      const color = city.destroyed
        ? COLORS.cityDestroyed
        : isMine
        ? COLORS.friendly
        : COLORS.enemy;

      // Glow
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(city.position.x, city.position.y, size + 4, 0, Math.PI * 2);
      ctx.fillStyle = city.destroyed ? 'transparent' : `${color}33`;
      ctx.fill();
      ctx.restore();

      // City dot
      ctx.beginPath();
      ctx.arc(city.position.x, city.position.y, size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // City name
      ctx.fillStyle = '#666';
      ctx.font = '8px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText(city.name, city.position.x, city.position.y + size + 12);

      // Population (if not destroyed)
      if (!city.destroyed) {
        const pop = (city.population / 1000000).toFixed(1) + 'M';
        ctx.fillStyle = '#444';
        ctx.fillText(pop, city.position.x, city.position.y + size + 22);
      }
    }
  }

  private drawBuildings(): void {
    if (!this.gameState) return;
    const ctx = this.ctx;

    for (const building of getBuildings(this.gameState)) {
      if (building.destroyed) continue;

      const isMine = building.ownerId === this.playerId;
      const color = isMine ? COLORS.friendly : COLORS.enemy;
      const glowColor = isMine ? COLORS.friendlyGlow : COLORS.enemyGlow;

      ctx.save();

      // Draw glow
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(building.position.x, building.position.y, 15, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.filter = 'blur(5px)';
      ctx.fill();
      ctx.filter = 'none';

      ctx.restore();

      // Draw building icon
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;

      switch (building.type) {
        case 'silo':
          this.drawSiloIcon(building.position, color, (building as Silo).mode);
          break;
        case 'radar':
          this.drawRadarIcon(building.position, color);
          break;
        case 'airfield':
          this.drawAirfieldIcon(building.position, color);
          break;
      }
    }
  }

  private drawSiloIcon(pos: Vector2, color: string, mode: string): void {
    const ctx = this.ctx;
    const size = 12;

    ctx.strokeStyle = color;
    ctx.fillStyle = 'transparent';
    ctx.lineWidth = 1.5;

    // Triangle shape
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y - size);
    ctx.lineTo(pos.x - size, pos.y + size);
    ctx.lineTo(pos.x + size, pos.y + size);
    ctx.closePath();
    ctx.stroke();

    // Mode indicator
    if (mode === 'icbm') {
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#00ffff';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRadarIcon(pos: Vector2, color: string): void {
    const ctx = this.ctx;
    const size = 10;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // Radar dish shape
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, size * 0.6, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();

    // Base
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    ctx.lineTo(pos.x, pos.y + size);
    ctx.stroke();
  }

  private drawAirfieldIcon(pos: Vector2, color: string): void {
    const ctx = this.ctx;
    const size = 12;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // Runway
    ctx.beginPath();
    ctx.moveTo(pos.x - size, pos.y);
    ctx.lineTo(pos.x + size, pos.y);
    ctx.stroke();

    // Plane shape
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y - size * 0.8);
    ctx.lineTo(pos.x - size * 0.5, pos.y);
    ctx.lineTo(pos.x, pos.y + size * 0.3);
    ctx.lineTo(pos.x + size * 0.5, pos.y);
    ctx.closePath();
    ctx.stroke();
  }

  private drawMissiles(deltaTime: number): void {
    if (!this.gameState) return;
    const ctx = this.ctx;

    for (const missile of getMissiles(this.gameState)) {
      // Skip missiles without currentPosition (shouldn't happen but be safe)
      const pos = missile.currentPosition;
      if (!pos) continue;

      if (missile.intercepted || missile.detonated) {
        // Draw explosion
        this.drawExplosion(pos);
        this.missileTrails.delete(missile.id);
        continue;
      }

      // Update trail
      let trail = this.missileTrails.get(missile.id);
      if (!trail) {
        trail = [];
        this.missileTrails.set(missile.id, trail);
      }
      trail.push({ ...pos });
      if (trail.length > 30) {
        trail.shift();
      }

      // Draw trail
      const isMine = missile.ownerId === this.playerId;
      const trailColor = isMine ? 'rgba(0, 255, 255, 0.3)' : 'rgba(255, 0, 0, 0.3)';

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (trail.length > 1) {
        for (let i = 1; i < trail.length; i++) {
          const alpha = i / trail.length;
          ctx.beginPath();
          ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
          ctx.lineTo(trail[i].x, trail[i].y);
          ctx.strokeStyle = trailColor;
          ctx.globalAlpha = alpha * 0.5;
          ctx.lineWidth = 1 + alpha * 2;
          ctx.stroke();
        }
      }

      ctx.restore();

      // Draw missile head
      const headColor = isMine ? COLORS.interceptor : COLORS.missile;

      // Glow
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = headColor + '40';
      ctx.filter = 'blur(4px)';
      ctx.fill();
      ctx.restore();

      // Head
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = headColor;
      ctx.fill();
    }
  }

  private drawExplosion(pos: Vector2): void {
    const ctx = this.ctx;

    // Simple explosion effect
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 50);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.2, 'rgba(255, 255, 0, 0.6)');
    gradient.addColorStop(0.5, 'rgba(255, 100, 0, 0.4)');
    gradient.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 50, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.restore();
  }

  private drawRadarSweep(): void {
    if (!this.gameState || !this.playerId) return;
    const ctx = this.ctx;

    const playerRadars = getBuildings(this.gameState).filter(
      (b): b is Radar => b.type === 'radar' && b.ownerId === this.playerId && !b.destroyed
    );

    for (const radar of playerRadars) {
      const angle = this.radarAngle;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Sweep line
      const endX = radar.position.x + Math.cos(angle) * radar.range;
      const endY = radar.position.y + Math.sin(angle) * radar.range;

      const gradient = ctx.createLinearGradient(
        radar.position.x,
        radar.position.y,
        endX,
        endY
      );
      gradient.addColorStop(0, 'rgba(0, 255, 136, 0.8)');
      gradient.addColorStop(1, 'rgba(0, 255, 136, 0.1)');

      ctx.beginPath();
      ctx.moveTo(radar.position.x, radar.position.y);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Sweep trail (fading arc)
      ctx.beginPath();
      ctx.moveTo(radar.position.x, radar.position.y);
      ctx.arc(
        radar.position.x,
        radar.position.y,
        radar.range,
        angle - 0.5,
        angle,
        false
      );
      ctx.closePath();

      const trailGradient = ctx.createRadialGradient(
        radar.position.x,
        radar.position.y,
        0,
        radar.position.x,
        radar.position.y,
        radar.range
      );
      trailGradient.addColorStop(0, 'rgba(0, 255, 136, 0.15)');
      trailGradient.addColorStop(1, 'rgba(0, 255, 136, 0.05)');

      ctx.fillStyle = trailGradient;
      ctx.fill();

      ctx.restore();
    }
  }
}
