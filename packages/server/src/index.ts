import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ConnectionManager } from './ConnectionManager';
import { LobbyManager } from './lobby/LobbyManager';
import { initializeLandDetection } from './game/landDetection';

const PORT = parseInt(process.env.PORT || '4002', 10);
const HOST = '0.0.0.0';

// Create HTTP server for Fly.io compatibility
const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }
  res.writeHead(200);
  res.end('DEFCON WebSocket Server');
});

// Initialize land detection for building placement validation
initializeLandDetection();

const wss = new WebSocketServer({ server });
const lobbyManager = new LobbyManager();
const connectionManager = new ConnectionManager(lobbyManager);

wss.on('connection', (ws: WebSocket) => {
  connectionManager.handleConnection(ws);
});

server.listen(PORT, HOST, () => {
  console.log(`DEFCON server running on http://${HOST}:${PORT}`);
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});
