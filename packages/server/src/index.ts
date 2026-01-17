import { WebSocketServer, WebSocket } from 'ws';
import { ConnectionManager } from './ConnectionManager';
import { LobbyManager } from './lobby/LobbyManager';

const PORT = parseInt(process.env.PORT || '3002', 10);

const wss = new WebSocketServer({ port: PORT });
const lobbyManager = new LobbyManager();
const connectionManager = new ConnectionManager(lobbyManager);

wss.on('connection', (ws: WebSocket) => {
  connectionManager.handleConnection(ws);
});

wss.on('listening', () => {
  console.log(`DEFCON server running on ws://localhost:${PORT}`);
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
