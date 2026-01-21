import { useEffect, useRef, useCallback, useState } from 'react';

const MUSIC_TRACKS = [
  '/assets/music/cyberpunk.mp3',
  '/assets/music/synthwave-dark.mp3',
  '/assets/music/synthwave-echo.mp3',
];

const MIN_DELAY = 5000;  // 5 seconds
const MAX_DELAY = 30000; // 30 seconds
const DEFAULT_VOLUME = 0.3;

interface MusicState {
  isPlaying: boolean;
  currentTrack: string | null;
  volume: number;
}

export function useBackgroundMusic() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const [state, setState] = useState<MusicState>({
    isPlaying: false,
    currentTrack: null,
    volume: DEFAULT_VOLUME,
  });
  const lastTrackRef = useRef<string | null>(null);
  const isEnabledRef = useRef(true);

  // Pick a random track (avoiding the last one if possible)
  const pickRandomTrack = useCallback(() => {
    if (MUSIC_TRACKS.length === 1) return MUSIC_TRACKS[0];

    let availableTracks = MUSIC_TRACKS.filter(t => t !== lastTrackRef.current);
    if (availableTracks.length === 0) availableTracks = MUSIC_TRACKS;

    return availableTracks[Math.floor(Math.random() * availableTracks.length)];
  }, []);

  // Get random delay between tracks
  const getRandomDelay = useCallback(() => {
    return MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  }, []);

  // Play a specific track
  const playTrack = useCallback((trackUrl: string) => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.volume = state.volume;
    }

    const audio = audioRef.current;
    audio.src = trackUrl;
    lastTrackRef.current = trackUrl;

    audio.play().then(() => {
      setState(s => ({ ...s, isPlaying: true, currentTrack: trackUrl }));
    }).catch(err => {
      // Auto-play blocked - user needs to interact first
      console.log('Music autoplay blocked, waiting for user interaction');
    });
  }, [state.volume]);

  // Schedule next track after delay
  const scheduleNextTrack = useCallback(() => {
    if (!isEnabledRef.current) return;

    const delay = getRandomDelay();
    console.log(`Next track in ${(delay / 1000).toFixed(1)}s`);

    timeoutRef.current = window.setTimeout(() => {
      if (isEnabledRef.current) {
        const track = pickRandomTrack();
        playTrack(track);
      }
    }, delay);
  }, [getRandomDelay, pickRandomTrack, playTrack]);

  // Handle track ending
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleEnded = () => {
      setState(s => ({ ...s, isPlaying: false, currentTrack: null }));
      scheduleNextTrack();
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [scheduleNextTrack]);

  // Start music on first user interaction
  useEffect(() => {
    const startMusic = () => {
      if (!audioRef.current?.src && isEnabledRef.current) {
        const track = pickRandomTrack();
        playTrack(track);
      }
      // Remove listeners after first interaction
      document.removeEventListener('click', startMusic);
      document.removeEventListener('keydown', startMusic);
    };

    document.addEventListener('click', startMusic);
    document.addEventListener('keydown', startMusic);

    return () => {
      document.removeEventListener('click', startMusic);
      document.removeEventListener('keydown', startMusic);
    };
  }, [pickRandomTrack, playTrack]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Volume control
  const setVolume = useCallback((volume: number) => {
    const clampedVolume = Math.max(0, Math.min(1, volume));
    setState(s => ({ ...s, volume: clampedVolume }));
    if (audioRef.current) {
      audioRef.current.volume = clampedVolume;
    }
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.muted = !audioRef.current.muted;
    }
  }, []);

  // Enable/disable music
  const setEnabled = useCallback((enabled: boolean) => {
    isEnabledRef.current = enabled;
    if (!enabled) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        setState(s => ({ ...s, isPlaying: false, currentTrack: null }));
      }
    } else if (!audioRef.current?.src) {
      const track = pickRandomTrack();
      playTrack(track);
    }
  }, [pickRandomTrack, playTrack]);

  // Skip to next track
  const skipTrack = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const track = pickRandomTrack();
    playTrack(track);
  }, [pickRandomTrack, playTrack]);

  return {
    ...state,
    setVolume,
    toggleMute,
    setEnabled,
    skipTrack,
  };
}
