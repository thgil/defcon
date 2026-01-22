import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ConnectionManager } from './ConnectionManager';
import { LobbyManager } from './lobby/LobbyManager';
import { initializeLandDetection } from './game/landDetection';
import * as fs from 'fs';
import * as path from 'path';

const PORT = parseInt(process.env.PORT || '4002', 10);
const HOST = '0.0.0.0';

// Static file serving for production
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '../../client/dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStaticFile(filePath: string, res: import('http').ServerResponse): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// Create HTTP server for Fly.io compatibility
const server = createServer((req, res) => {
  const url = req.url || '/';

  // Health check endpoint
  if (url === '/health') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // Try to serve static files
  if (fs.existsSync(STATIC_DIR)) {
    // Clean the URL path
    let urlPath = url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Try exact path first
    if (serveStaticFile(filePath, res)) return;

    // For SPA routing, serve index.html for non-asset paths
    if (!path.extname(urlPath)) {
      const indexPath = path.join(STATIC_DIR, 'index.html');
      if (serveStaticFile(indexPath, res)) return;
    }
  }

  // Fallback response
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
