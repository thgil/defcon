import { create } from 'zustand';

export type TerminalTab = 'email' | 'installations' | 'commands' | 'options';

export type TerminalTheme = 'defcon' | 'uplink' | 'amber' | 'white' | 'matrix';

export const TERMINAL_THEMES: Record<TerminalTheme, { name: string; primary: string; background: string }> = {
  defcon: { name: 'DEFCON Green', primary: '#00ff88', background: '#0a0a0a' },
  uplink: { name: 'Uplink Blue', primary: '#00aaff', background: '#0a0a12' },
  amber: { name: 'Amber CRT', primary: '#ffaa00', background: '#0a0800' },
  white: { name: 'Monochrome', primary: '#ffffff', background: '#0a0a0a' },
  matrix: { name: 'Matrix', primary: '#00ff00', background: '#000800' },
};

export interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: number;
  read: boolean;
  isAI?: boolean;
  isSystem?: boolean;
  fromPlayerId?: string;
}

export interface CommandHistoryEntry {
  id: string;
  command: string;
  output: string[];
  timestamp: number;
  isError?: boolean;
}

interface TerminalState {
  // UI State
  isOpen: boolean;
  isMinimized: boolean;
  activeTab: TerminalTab;
  theme: TerminalTheme;
  position: { x: number; y: number };
  isDragging: boolean;

  // Content
  emails: Email[];
  commandHistory: CommandHistoryEntry[];
  currentInput: string;

  // Evil AI
  aiPresenceLevel: number;  // 0-100
  lastAIEventTime: number;
  glitchActive: boolean;
  glitchIntensity: number;  // 0-1

  // Actions
  toggle: () => void;
  open: () => void;
  close: () => void;
  minimize: () => void;
  restore: () => void;
  setActiveTab: (tab: TerminalTab) => void;
  setTheme: (theme: TerminalTheme) => void;
  setPosition: (position: { x: number; y: number }) => void;
  setDragging: (dragging: boolean) => void;

  // Email actions
  addEmail: (email: Omit<Email, 'id' | 'timestamp' | 'read'>) => void;
  markEmailRead: (emailId: string) => void;
  markAllEmailsRead: () => void;
  getUnreadCount: () => number;

  // Command actions
  setCurrentInput: (input: string) => void;
  executeCommand: (command: string, output: string[], isError?: boolean) => void;
  clearHistory: () => void;

  // AI actions
  increasePresence: (amount: number) => void;
  setGlitch: (active: boolean, intensity?: number) => void;
  triggerAIEvent: () => void;
}

let emailIdCounter = 0;
let commandIdCounter = 0;

export const useTerminalStore = create<TerminalState>((set, get) => ({
  // Initial state
  isOpen: true,
  isMinimized: true,
  activeTab: 'installations',
  theme: 'defcon',
  position: { x: 50, y: 50 },
  isDragging: false,

  emails: [],
  commandHistory: [],
  currentInput: '',

  aiPresenceLevel: 0,
  lastAIEventTime: 0,
  glitchActive: false,
  glitchIntensity: 0,

  // UI Actions
  toggle: () => set((state) => {
    if (!state.isOpen) {
      return { isOpen: true, isMinimized: false };
    }
    return { isMinimized: !state.isMinimized };
  }),
  open: () => set({ isOpen: true, isMinimized: false }),
  close: () => set({ isOpen: false, isMinimized: false }),
  minimize: () => set({ isMinimized: true }),
  restore: () => set({ isMinimized: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setTheme: (theme) => set({ theme }),
  setPosition: (position) => set({ position }),
  setDragging: (dragging) => set({ isDragging: dragging }),

  // Email actions
  addEmail: (emailData) => {
    const email: Email = {
      ...emailData,
      id: `email-${++emailIdCounter}`,
      timestamp: Date.now(),
      read: false,
    };
    set((state) => ({
      emails: [email, ...state.emails],
    }));
  },

  markEmailRead: (emailId) => {
    set((state) => ({
      emails: state.emails.map((e) =>
        e.id === emailId ? { ...e, read: true } : e
      ),
    }));
  },

  markAllEmailsRead: () => {
    set((state) => ({
      emails: state.emails.map((e) => ({ ...e, read: true })),
    }));
  },

  getUnreadCount: () => {
    return get().emails.filter((e) => !e.read).length;
  },

  // Command actions
  setCurrentInput: (input) => set({ currentInput: input }),

  executeCommand: (command, output, isError = false) => {
    const entry: CommandHistoryEntry = {
      id: `cmd-${++commandIdCounter}`,
      command,
      output,
      timestamp: Date.now(),
      isError,
    };
    set((state) => ({
      commandHistory: [...state.commandHistory, entry],
      currentInput: '',
    }));
  },

  clearHistory: () => set({ commandHistory: [] }),

  // AI actions
  increasePresence: (amount) => {
    set((state) => ({
      aiPresenceLevel: Math.min(100, state.aiPresenceLevel + amount),
    }));
  },

  setGlitch: (active, intensity = 0.5) => {
    set({ glitchActive: active, glitchIntensity: intensity });
  },

  triggerAIEvent: () => {
    set({ lastAIEventTime: Date.now() });
  },
}));
