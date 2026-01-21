const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:4002');
let step = 0;
let interceptorCount = 0;
let interceptionCount = 0;
let icbmCount = 0;

function log(msg) {
  console.log(`[${new Date().toISOString().substr(11,8)}] ${msg}`);
}

ws.on('open', () => {
  log('Connected to server');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);

  if (msg.type === 'lobby_error') {
    log(`LOBBY ERROR: ${msg.message}`);
    return;
  }

  if (msg.type === 'lobby_list' && step === 0) {
    step = 1;
    log('Step 1: Creating lobby...');
    ws.send(JSON.stringify({ type: 'create_lobby', playerName: 'TestPlayer', lobbyName: 'InterceptorTest' }));
  }

  else if (msg.type === 'lobby_update' && step === 1) {
    step = 2;
    log('Step 2: Selecting North America...');
    ws.send(JSON.stringify({ type: 'select_territory', territoryId: 'north_america' }));
  }

  else if (msg.type === 'lobby_update' && step === 2) {
    step = 3;
    log('Step 3: Setting ready...');
    ws.send(JSON.stringify({ type: 'set_ready', ready: true }));
  }

  else if (msg.type === 'lobby_update' && step === 3) {
    step = 4;
    log('Step 4: Starting game...');
    ws.send(JSON.stringify({ type: 'start_game' }));
  }

  else if (msg.type === 'game_start') {
    step = 5;
    log('Step 5: Game started!');

    // Enable AI for Europe immediately (during DEFCON 5 so it places buildings)
    setTimeout(() => {
      log('Enabling AI for Europe (at DEFCON 5)...');
      ws.send(JSON.stringify({ type: 'enable_ai', region: 'europe' }));
    }, 500);

    // Place silos and radars for player in North America
    setTimeout(() => {
      log('Placing player silos and radar...');
      ws.send(JSON.stringify({ type: 'place_building', buildingType: 'silo', position: { x: 150, y: 180 } }));
      ws.send(JSON.stringify({ type: 'place_building', buildingType: 'silo', position: { x: 200, y: 170 } }));
      ws.send(JSON.stringify({ type: 'place_building', buildingType: 'silo', position: { x: 250, y: 190 } }));
      ws.send(JSON.stringify({ type: 'place_building', buildingType: 'radar', position: { x: 180, y: 150 } }));
    }, 1000);

    // Wait for AI to place buildings, then set DEFCON to 1
    setTimeout(() => {
      log('Setting DEFCON to 1...');
      ws.send(JSON.stringify({ type: 'debug', command: 'set_defcon', value: 1 }));
    }, 4000);

    // Launch missiles toward NORTH AMERICA (player territory) - AI will fire at us
    // This tests OUR interceptors defending OUR territory
    setTimeout(() => {
      log('Launching missiles AT North America (testing our interceptors)...');
      ws.send(JSON.stringify({ type: 'debug', command: 'launch_test_missiles', value: 5, targetRegion: 'north_america' }));
    }, 6000);
  }

  else if (msg.type === 'game_state' && step === 5) {
    // Check initial state for buildings
    const silos = Object.values(msg.state.buildings || {}).filter(b => b.type === 'silo');
    const radars = Object.values(msg.state.buildings || {}).filter(b => b.type === 'radar');
    const aiSilos = silos.filter(s => s.ownerId !== msg.state.players[Object.keys(msg.state.players)[0]]?.id);
    log(`Buildings: ${silos.length} silos (${aiSilos.length} AI), ${radars.length} radars`);
  }

  else if (msg.type === 'game_delta' && step === 5) {
    const missiles = msg.missileUpdates || [];
    for (const m of missiles) {
      if (m.type === 'rail_interceptor') {
        interceptorCount++;
        log(`INTERCEPTOR: progress=${(m.progress*100).toFixed(1)}% apex=${m.rail?.apexHeight?.toFixed(1)} endAlt=${m.rail?.endAltitude?.toFixed(1)}`);
        log(`  start: (${m.rail?.startGeo?.lat?.toFixed(2)}, ${m.rail?.startGeo?.lng?.toFixed(2)})`);
        log(`  end: (${m.rail?.endGeo?.lat?.toFixed(2)}, ${m.rail?.endGeo?.lng?.toFixed(2)})`);
        log(`  status=${m.status} guidance=${m.tracking?.hasGuidance}`);
      } else if (m.type === 'icbm') {
        // Log ICBM progress periodically
        if (icbmCount++ % 50 === 0) {
          log(`ICBM progress: ${(m.progress*100).toFixed(1)}%`);
        }
      }
    }
    if (msg.events) {
      for (const e of msg.events) {
        if (e.type === 'interception') {
          interceptionCount++;
          log(`>>> INTERCEPTION: ${e.missileId.substring(0,8)} destroyed!`);
        }
        if (e.type === 'missile_launch') {
          log(`Missile launched: ${e.missileId.substring(0,8)}`);
        }
      }
    }
  }
});

ws.on('error', (err) => {
  log(`Error: ${err.message}`);
});

ws.on('close', () => {
  log(`Connection closed at step ${step}`);
});

// Keep alive for 180 seconds (3 minutes - enough for intercontinental missiles)
setTimeout(() => {
  log(`=== TEST COMPLETE ===`);
  log(`Rail interceptor updates: ${interceptorCount}`);
  log(`Interceptions: ${interceptionCount}`);
  ws.close();
  process.exit(0);
}, 180000);
