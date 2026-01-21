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
  AircraftType,
  GeoPosition,
  HackType,
} from '@defcon/shared';
import { useAppStore } from './appStore';
import { useGameStore } from './gameStore';
import { useTerminalStore } from './terminalStore';

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
  launchAircraft: (airfieldId: string, aircraftType: AircraftType, waypoints: GeoPosition[]) => void;
  setSiloMode: (siloId: string, mode: SiloMode) => void;
  sendDebugCommand: (command: 'advance_defcon' | 'set_defcon' | 'add_missiles' | 'skip_timer' | 'launch_test_missiles', value?: number, targetRegion?: string) => void;
  enableAI: (region: string) => void;
  disableAI: () => void;
  quickStart: () => void;
  requestInterceptInfo: (targetMissileId: string) => void;
  manualIntercept: (targetMissileId: string, siloIds: string[]) => void;
  sendTerminalEmail: (toPlayerId: string, subject: string, body: string) => void;
  // Hacking actions
  hackScan: () => void;
  hackStart: (targetId: string, hackType: HackType, proxyRoute?: string[]) => void;
  hackDisconnect: (hackId: string) => void;
  hackPurge: (targetId: string) => void;
  hackTrace: () => void;
}

let ws: WebSocket | null = null;
let isConnecting = false;

export const useNetworkStore = create<NetworkState>((set, get) => ({
  connected: false,
  playerId: null,
  lobbies: [],
  lobbyState: null,
  error: null,

  connect: () => {
    // Prevent concurrent connection attempts
    if (ws || isConnecting) return;
    isConnecting = true;

    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:4002'
      : (import.meta.env.VITE_WS_URL || `wss://${window.location.host}/ws`);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to server');
      isConnecting = false;
      set({ connected: true, error: null });
    };

    ws.onclose = () => {
      console.log('Disconnected from server');
      isConnecting = false;
      set({ connected: false, playerId: null });
      ws = null;
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      isConnecting = false;
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

  launchAircraft: (airfieldId: string, aircraftType: AircraftType, waypoints: GeoPosition[]) => {
    send({ type: 'launch_aircraft', airfieldId, aircraftType, waypoints });
  },

  setSiloMode: (siloId: string, mode: SiloMode) => {
    send({ type: 'set_silo_mode', siloId, mode });
  },

  sendDebugCommand: (command: 'advance_defcon' | 'set_defcon' | 'add_missiles' | 'skip_timer' | 'launch_test_missiles', value?: number, targetRegion?: string) => {
    send({ type: 'debug', command, value, targetRegion });
  },

  enableAI: (region: string) => {
    send({ type: 'enable_ai', region });
  },

  disableAI: () => {
    send({ type: 'disable_ai' });
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

    // Set up auto-start sequence with cleanup timeout
    let subscriptionCleanedUp = false;
    const unsubscribe = useNetworkStore.subscribe((state, prevState) => {
      // When we get lobby update, select territory and ready up
      if (state.lobbyState && !prevState.lobbyState && !subscriptionCleanedUp) {
        subscriptionCleanedUp = true;
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

    // Safety cleanup: unsubscribe after 30 seconds if nothing happened
    setTimeout(() => {
      if (!subscriptionCleanedUp) {
        subscriptionCleanedUp = true;
        unsubscribe();
        console.warn('[quickStart] Auto-start subscription timed out');
      }
    }, 30000);
  },

  requestInterceptInfo: (targetMissileId: string) => {
    send({ type: 'request_intercept_info', targetMissileId });
  },

  manualIntercept: (targetMissileId: string, siloIds: string[]) => {
    send({ type: 'manual_intercept', targetMissileId, siloIds });
  },

  sendTerminalEmail: (toPlayerId: string, subject: string, body: string) => {
    send({ type: 'terminal_email', toPlayerId, subject, body });
  },

  // Hacking actions
  hackScan: () => {
    send({ type: 'hack_scan' });
  },

  hackStart: (targetId: string, hackType: HackType, proxyRoute?: string[]) => {
    send({ type: 'hack_start', targetId, hackType, proxyRoute });
  },

  hackDisconnect: (hackId: string) => {
    send({ type: 'hack_disconnect', hackId });
  },

  hackPurge: (targetId: string) => {
    send({ type: 'hack_purge', targetId });
  },

  hackTrace: () => {
    send({ type: 'hack_trace' });
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
        message.tick,
        message.timestamp,
        message.events,
        message.buildingUpdates,
        message.missileUpdates,
        message.removedMissileIds,
        message.satelliteUpdates,
        message.removedSatelliteIds,
        message.aircraftUpdates,
        message.removedAircraftIds
      );
      break;

    case 'game_end':
      gameStore.handleGameEnd(message.winner, message.scores);
      break;

    case 'error':
      useNetworkStore.setState({ error: message.message });
      break;

    case 'intercept_info':
      gameStore.setInterceptInfo(message.targetMissileId, message.availableSilos, message.existingInterceptors || []);
      break;

    case 'terminal_email_received':
      // Add email to terminal store
      useTerminalStore.getState().addEmail({
        from: message.fromPlayerName,
        to: 'COMMANDER',
        subject: message.subject,
        body: message.body,
        fromPlayerId: message.fromPlayerId,
      });
      break;

    // Hacking messages
    case 'hack_scan_result':
      useTerminalStore.getState().setDetectedBuildings(message.detectedBuildings);
      break;

    case 'hack_progress':
      useTerminalStore.getState().updateHackProgress(
        message.hackId,
        message.progress,
        message.traceProgress,
        message.status
      );
      break;

    case 'hack_complete':
      useTerminalStore.getState().setActiveHack(null);
      useTerminalStore.getState().addCompromise(message.compromise);
      // Add success email
      useTerminalStore.getState().addEmail({
        from: 'SYSTEM',
        to: 'COMMANDER',
        subject: `HACK SUCCESSFUL: ${message.hackType.toUpperCase()}`,
        body: `Target system compromised.\nBuilding ID: ${message.targetId}\nEffect: ${message.hackType}\n\nAccess granted. Effect will expire automatically.`,
        isSystem: true,
      });
      break;

    case 'hack_traced':
      useTerminalStore.getState().setActiveHack(null);
      // Add failure email
      useTerminalStore.getState().addEmail({
        from: 'SYSTEM',
        to: 'COMMANDER',
        subject: 'HACK FAILED: TRACED',
        body: `WARNING: Connection traced!\nTarget: ${message.targetId}\n\nYour position may have been compromised. Enemy counter-measures active.`,
        isSystem: true,
      });
      break;

    case 'hack_disconnected':
      useTerminalStore.getState().setActiveHack(null);
      break;

    case 'system_compromised':
      // Someone hacked us - add alert email
      useTerminalStore.getState().addEmail({
        from: 'SECURITY ALERT',
        to: 'COMMANDER',
        subject: `INTRUSION DETECTED: ${message.hackType.toUpperCase()}`,
        body: `WARNING: System compromised!\nBuilding ID: ${message.targetId}\nAttack Type: ${message.hackType}\n\nRun 'purge ${message.targetId}' to remove the intrusion.`,
        isSystem: true,
      });
      break;

    case 'intrusion_alert':
      useTerminalStore.getState().addIntrusionAlert(message.alert);
      break;

    case 'intrusion_status':
      useTerminalStore.getState().setIntrusionAlerts(message.activeIntrusions);
      useTerminalStore.getState().setCompromisedBuildings(message.compromisedBuildings);
      break;
  }
}
