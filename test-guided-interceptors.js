// Test script for guided interceptors
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:4002');

let playerId = null;
let gameStarted = false;

ws.on('open', () => {
  console.log('Connected to server');

  // Create a lobby
  ws.send(JSON.stringify({
    type: 'create_lobby',
    playerName: 'TestPlayer',
    lobbyName: 'Test Lobby'
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'lobby_update':
      playerId = msg.playerId;
      console.log('Joined lobby as:', playerId);

      // Select a territory
      if (!msg.players[0]?.territoryId) {
        ws.send(JSON.stringify({
          type: 'select_territory',
          territoryId: 'usa'
        }));
      }
      break;

    case 'game_start':
      console.log('Game started!');
      gameStarted = true;
      playerId = msg.playerId;

      // Wait a bit then skip to DEFCON 1
      setTimeout(() => {
        console.log('Skipping to DEFCON 1...');
        ws.send(JSON.stringify({
          type: 'debug',
          command: 'set_defcon',
          value: 1
        }));
      }, 1000);

      // Enable AI opponent
      setTimeout(() => {
        console.log('Enabling AI opponent (Russia)...');
        ws.send(JSON.stringify({
          type: 'enable_ai',
          region: 'russia'
        }));
      }, 2000);
      break;

    case 'game_state':
    case 'game_delta':
      if (gameStarted) {
        const missiles = msg.state?.missiles || {};
        const missileCount = Object.keys(missiles).length;

        // Count guided interceptors
        let guidedCount = 0;
        let icbmCount = 0;
        for (const m of Object.values(missiles)) {
          if (m.type === 'guided_interceptor') {
            guidedCount++;
            console.log(`Guided Interceptor: heading=${m.heading?.toFixed(1)}°, altitude=${m.altitude?.toFixed(1)}, fuel=${m.fuel?.toFixed(1)}s, status=${m.status}`);
          } else if (m.type === 'icbm') {
            icbmCount++;
          }
        }

        if (missileCount > 0) {
          console.log(`Active: ${icbmCount} ICBMs, ${guidedCount} guided interceptors`);
        }
      }
      break;

    case 'defcon_change':
      console.log('DEFCON level:', msg.newLevel);
      break;
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

// Start the game after selecting territory
setTimeout(() => {
  console.log('Starting game...');
  ws.send(JSON.stringify({ type: 'start_game' }));
}, 3000);

// Launch test missiles after DEFCON 1
setTimeout(() => {
  if (gameStarted) {
    console.log('Launching test missiles at USA...');
    ws.send(JSON.stringify({
      type: 'debug',
      command: 'launch_test_missiles',
      value: 3,
      targetRegion: 'usa'
    }));
  }
}, 8000);

// Exit after 30 seconds
setTimeout(() => {
  console.log('Test complete');
  ws.close();
}, 30000);
