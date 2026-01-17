import { create } from 'zustand';
import type {
  ClientMessage,
  ServerMessage,
  LobbyInfo,
  GameState,
  GameConfig,
  BuildingType,
  SiloMode,
  Vector2,
} from '@defcon/shared';
import { useAppStore } from './appStore';
import { useGameStore } from './gameStore';

interface LobbyState {
  lobby: LobbyInfo | null;
  playerId: string;
  players: Array<{
    id: string;
    name: string;
    ready: boolean;
    territoryId: string | null;
  }>;
  availableTerritories: string[];
  isHost: boolean;
}

interface NetworkState {
  connected: boolean;
  playerId: string | null;
  lobbies: LobbyInfo[];
  lobbyState: LobbyState | null;
  error: string | null;

  // Actions
  connect: () => void;
  disconnect: () => void;
  createLobby: (lobbyName: string, config?: Partial<GameConfig>) => void;
  joinLobby: (lobbyId: string) => void;
  leaveLobby: () => void;
  setReady: (ready: boolean) => void;
  selectTerritory: (territoryId: string) => void;
  startGame: () => void;
  placeBuilding: (buildingType: BuildingType, position: Vector2) => void;
  launchMissile: (siloId: string, targetPosition: Vector2, targetId?: string) => void;
  launchSatellite: (facilityId: string, inclination: number) => void;
  setSiloMode: (siloId: string, mode: SiloMode) => void;
  sendDebugCommand: (command: 'advance_defcon' | 'set_defcon' | 'add_missiles' | 'skip_timer', value?: number) => void;
  quickStart: () => void;
}

let ws: WebSocket | null = null;

export const useNetworkStore = create<NetworkState>((set, get) => ({
  connected: false,
  playerId: null,
  lobbies: [],
  lobbyState: null,
  error: null,

  connect: () => {
    if (ws) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:3001'
      : `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to server');
      set({ connected: true, error: null });
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      set({ connected: false, playerId: null });
      ws = null;
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      set({ error: 'Connection error' });
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        handleMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };
  },

  disconnect: () => {
    if (ws) {
      ws.close();
      ws = null;
    }
  },

  createLobby: (lobbyName: string, config?: Partial<GameConfig>) => {
    const playerName = useAppStore.getState().playerName;
    send({
      type: 'create_lobby',
      playerName,
      lobbyName,
      config,
    });
  },

  joinLobby: (lobbyId: string) => {
    const playerName = useAppStore.getState().playerName;
    send({
      type: 'join_lobby',
      lobbyId,
      playerName,
    });
  },

  leaveLobby: () => {
    send({ type: 'leave_lobby' });
    set({ lobbyState: null });
    useAppStore.getState().setScreen('lobby_browser');
  },

  setReady: (ready: boolean) => {
    send({ type: 'set_ready', ready });
  },

  selectTerritory: (territoryId: string) => {
    send({ type: 'select_territory', territoryId });
  },

  startGame: () => {
    send({ type: 'start_game' });
  },

  placeBuilding: (buildingType: BuildingType, position: Vector2) => {
    send({ type: 'place_building', buildingType, position });
  },

  launchMissile: (siloId: string, targetPosition: Vector2, targetId?: string) => {
    send({ type: 'launch_missile', siloId, targetPosition, targetId });
  },

  launchSatellite: (facilityId: string, inclination: number) => {
    send({ type: 'launch_satellite', facilityId, inclination });
  },

  setSiloMode: (siloId: string, mode: SiloMode) => {
    send({ type: 'set_silo_mode', siloId, mode });
  },

  sendDebugCommand: (command: 'advance_defcon' | 'set_defcon' | 'add_missiles' | 'skip_timer', value?: number) => {
    send({ type: 'debug', command, value });
  },

  quickStart: () => {
    const playerName = useAppStore.getState().playerName || 'Player';
    useAppStore.getState().setPlayerName(playerName);

    // Create lobby
    send({
      type: 'create_lobby',
      playerName,
      lobbyName: 'Quick Game',
      config: {
        defconTimings: {
          defcon5Duration: 10000,  // 10 seconds for testing
          defcon4Duration: 10000,
          defcon3Duration: 10000,
          defcon2Duration: 10000,
          defcon1Duration: 300000, // 5 minutes
        },
      },
    });

    // Set up auto-start sequence
    const unsubscribe = useNetworkStore.subscribe((state, prevState) => {
      // When we get lobby update, select territory and ready up
      if (state.lobbyState && !prevState.lobbyState) {
        setTimeout(() => {
          send({ type: 'select_territory', territoryId: 'north_america' });
          setTimeout(() => {
            send({ type: 'set_ready', ready: true });
            setTimeout(() => {
              send({ type: 'start_game' });
              unsubscribe();
            }, 100);
          }, 100);
        }, 100);
      }
    });
  },
}));

function send(message: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleMessage(message: ServerMessage) {
  const networkStore = useNetworkStore.getState();
  const appStore = useAppStore.getState();
  const gameStore = useGameStore.getState();

  switch (message.type) {
    case 'lobby_list':
      useNetworkStore.setState({ lobbies: message.lobbies });
      break;

    case 'lobby_update':
      useNetworkStore.setState({
        lobbyState: {
          lobby: message.lobby,
          playerId: message.playerId,
          players: message.players,
          availableTerritories: message.availableTerritories,
          isHost: message.isHost,
        },
      });
      appStore.setScreen('lobby_room');
      break;

    case 'lobby_error':
      useNetworkStore.setState({ error: message.message });
      break;

    case 'game_start':
      useNetworkStore.setState({ playerId: message.playerId });
      gameStore.initGame(message.initialState, message.playerId);
      appStore.setScreen('game');
      break;

    case 'game_state':
      gameStore.setFullState(message.state);
      break;

    case 'game_delta':
      gameStore.applyDelta(
        message.events,
        message.buildingUpdates,
        message.missileUpdates,
        message.removedMissileIds,
        message.satelliteUpdates,
        message.removedSatelliteIds
      );
      break;

    case 'game_end':
      gameStore.handleGameEnd(message.winner, message.scores);
      break;

    case 'error':
      useNetworkStore.setState({ error: message.message });
      break;
  }
}
