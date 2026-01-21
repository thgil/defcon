/**
 * Sound effects manager with positional audio (stereo panning)
 */

const SOUNDS = {
  icbmImpact: '/assets/sounds/icbm_impact.wav',
} as const;

type SoundName = keyof typeof SOUNDS;

interface SoundOptions {
  volume?: number;      // 0-1, default 0.5
  pan?: number;         // -1 (left) to 1 (right), default 0 (center)
}

class SoundEffectsManager {
  private audioContext: AudioContext | null = null;
  private buffers: Map<SoundName, AudioBuffer> = new Map();
  private masterVolume = 0.5;
  private enabled = true;

  constructor() {
    // Preload sounds on first user interaction
    const initAudio = () => {
      if (!this.audioContext) {
        this.audioContext = new AudioContext();
        this.preloadSounds();
      }
      document.removeEventListener('click', initAudio);
      document.removeEventListener('keydown', initAudio);
    };

    document.addEventListener('click', initAudio);
    document.addEventListener('keydown', initAudio);
  }

  private async preloadSounds() {
    if (!this.audioContext) return;

    for (const [name, url] of Object.entries(SOUNDS)) {
      try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        this.buffers.set(name as SoundName, audioBuffer);
        console.log(`Loaded sound: ${name}`);
      } catch (err) {
        console.warn(`Failed to load sound ${name}:`, err);
      }
    }
  }

  /**
   * Play a sound effect with optional stereo panning
   */
  play(name: SoundName, options: SoundOptions = {}) {
    if (!this.enabled || !this.audioContext) return;

    const buffer = this.buffers.get(name);
    if (!buffer) {
      console.warn(`Sound not loaded: ${name}`);
      return;
    }

    const { volume = 0.5, pan = 0 } = options;

    // Create source
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    // Create gain node for volume
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = volume * this.masterVolume;

    // Create stereo panner for positional audio
    const pannerNode = this.audioContext.createStereoPanner();
    pannerNode.pan.value = Math.max(-1, Math.min(1, pan));

    // Connect: source -> gain -> panner -> destination
    source.connect(gainNode);
    gainNode.connect(pannerNode);
    pannerNode.connect(this.audioContext.destination);

    // Play
    source.start(0);
  }

  /**
   * Play ICBM impact sound with position-based panning
   * @param screenX - X position on screen (0 = left edge, 1 = right edge)
   */
  playIcbmImpact(screenX: number) {
    // Convert screen position (0-1) to pan value (-1 to 1)
    const pan = (screenX * 2) - 1;
    this.play('icbmImpact', { volume: 0.7, pan });
  }

  setMasterVolume(volume: number) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }
}

// Singleton instance
export const soundEffects = new SoundEffectsManager();
