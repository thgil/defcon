import { useEffect, useRef, useCallback } from 'react';
import { useAudioStore } from '../stores/audioStore';

const MUSIC_TRACKS = [
  '/assets/music/cyberpunk.mp3',
  '/assets/music/synthwave-dark.mp3',
  '/assets/music/Elysium Sound - From Another Planet _ Synthwave Cyberpunk.mp3',
  '/assets/music/Elysium Sound - Night Drive Middle Cyberpunk Retrowave 80s.mp3',
];

const MIN_DELAY = 5000;  // 5 seconds
const MAX_DELAY = 30000; // 30 seconds
const FADE_DURATION = 5000; // 5 seconds fade in for gradual volume ramp
const FADE_OUT_BEFORE_END = 3000; // Start fade out 3 seconds before track ends
const INITIAL_MUSIC_DELAY = 5000; // 5 seconds before first track starts

export function useBackgroundMusic() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const preloadRef = useRef<HTMLAudioElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const fadeIntervalRef = useRef<number | null>(null);
  const lastTrackRef = useRef<string | null>(null);
  const targetVolumeRef = useRef(0);
  const handlersAttachedRef = useRef(false);
  const fadeOutTriggeredRef = useRef(false);

  const musicVolume = useAudioStore((s) => s.musicVolume);
  const musicEnabled = useAudioStore((s) => s.musicEnabled);

  // Update target volume when store changes
  useEffect(() => {
    targetVolumeRef.current = musicVolume;
    // If not fading, apply volume immediately
    if (audioRef.current && !fadeIntervalRef.current) {
      audioRef.current.volume = musicVolume;
    }
  }, [musicVolume]);

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

  // Fade in effect
  const fadeIn = useCallback((audio: HTMLAudioElement, targetVolume: number, duration: number) => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current);
    }

    audio.volume = 0;
    const startTime = Date.now();

    fadeIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      audio.volume = progress * targetVolume;

      if (progress >= 1) {
        if (fadeIntervalRef.current) {
          clearInterval(fadeIntervalRef.current);
          fadeIntervalRef.current = null;
        }
      }
    }, 50);
  }, []);

  // Fade out effect
  const fadeOut = useCallback((audio: HTMLAudioElement, duration: number): Promise<void> => {
    return new Promise((resolve) => {
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }

      const startVolume = audio.volume;
      const startTime = Date.now();

      fadeIntervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(1, elapsed / duration);
        audio.volume = startVolume * (1 - progress);

        if (progress >= 1) {
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
            fadeIntervalRef.current = null;
          }
          resolve();
        }
      }, 50);
    });
  }, []);

  // Preload next track to prevent lag when it starts
  const preloadTrack = useCallback((trackUrl: string) => {
    if (!preloadRef.current) {
      preloadRef.current = new Audio();
    }
    preloadRef.current.src = trackUrl;
    preloadRef.current.preload = 'auto';
    // Just load it, don't play
    preloadRef.current.load();
  }, []);

  // Schedule next track after delay
  const scheduleNextTrack = useCallback(() => {
    if (!musicEnabled) return;

    const delay = getRandomDelay();
    const nextTrack = pickRandomTrack();
    console.log(`Next track in ${(delay / 1000).toFixed(1)}s`);

    // Preload the next track immediately so it's ready when delay ends
    preloadTrack(nextTrack);

    timeoutRef.current = window.setTimeout(() => {
      if (musicEnabled) {
        playTrack(nextTrack);
      }
    }, delay);
  }, [getRandomDelay, pickRandomTrack, musicEnabled, preloadTrack]);

  // Play a specific track with fade in
  const playTrack = useCallback((trackUrl: string) => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;

    // Attach event listeners once
    if (!handlersAttachedRef.current) {
      const handleTimeUpdate = () => {
        if (!audio.duration || fadeOutTriggeredRef.current) return;
        const timeRemaining = audio.duration - audio.currentTime;
        if (timeRemaining <= FADE_OUT_BEFORE_END / 1000 && timeRemaining > 0) {
          fadeOutTriggeredRef.current = true;
          fadeOut(audio, timeRemaining * 1000);
        }
      };

      const handleEnded = () => {
        fadeOutTriggeredRef.current = false;
        scheduleNextTrack();
      };

      const handlePlay = () => {
        fadeOutTriggeredRef.current = false;
      };

      audio.addEventListener('timeupdate', handleTimeUpdate);
      audio.addEventListener('ended', handleEnded);
      audio.addEventListener('play', handlePlay);
      handlersAttachedRef.current = true;
    }

    fadeOutTriggeredRef.current = false; // Reset for new track

    // Set volume to 0 BEFORE setting src and playing to prevent audio spike
    audio.volume = 0;
    audio.src = trackUrl;
    lastTrackRef.current = trackUrl;

    audio.play().then(() => {
      // Fade in from 0
      fadeIn(audio, targetVolumeRef.current, FADE_DURATION);
    }).catch(err => {
      console.log('Music autoplay blocked, waiting for user interaction');
    });
  }, [fadeIn, fadeOut, scheduleNextTrack]);

  // Start music 15 seconds after first user interaction
  useEffect(() => {
    let startupTimer: number | null = null;
    let firstTrack: string | null = null;

    const scheduleMusic = () => {
      if (!audioRef.current?.src && musicEnabled) {
        // Pick and preload the first track immediately
        firstTrack = pickRandomTrack();
        preloadTrack(firstTrack);

        startupTimer = window.setTimeout(() => {
          if (musicEnabled && firstTrack) {
            playTrack(firstTrack);
          }
        }, INITIAL_MUSIC_DELAY);
      }
      document.removeEventListener('click', scheduleMusic);
      document.removeEventListener('keydown', scheduleMusic);
      document.removeEventListener('wheel', scheduleMusic);
      document.removeEventListener('touchstart', scheduleMusic);
    };

    document.addEventListener('click', scheduleMusic);
    document.addEventListener('keydown', scheduleMusic);
    document.addEventListener('wheel', scheduleMusic, { passive: true });
    document.addEventListener('touchstart', scheduleMusic, { passive: true });

    return () => {
      document.removeEventListener('click', scheduleMusic);
      document.removeEventListener('keydown', scheduleMusic);
      document.removeEventListener('wheel', scheduleMusic);
      document.removeEventListener('touchstart', scheduleMusic);
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
    };
  }, [pickRandomTrack, playTrack, preloadTrack, musicEnabled]);

  // Handle enable/disable changes
  useEffect(() => {
    if (!musicEnabled) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (audioRef.current) {
        fadeOut(audioRef.current, 500).then(() => {
          audioRef.current?.pause();
        });
      }
    } else if (audioRef.current && !audioRef.current.src) {
      const track = pickRandomTrack();
      playTrack(track);
    } else if (audioRef.current?.paused && audioRef.current.src) {
      audioRef.current.play().then(() => {
        fadeIn(audioRef.current!, targetVolumeRef.current, FADE_DURATION);
      });
    }
  }, [musicEnabled, fadeOut, fadeIn, pickRandomTrack, playTrack]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (preloadRef.current) {
        preloadRef.current.src = '';
        preloadRef.current = null;
      }
    };
  }, []);
}
