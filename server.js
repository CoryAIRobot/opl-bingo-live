const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── Phrases ──
const PHRASES = [
  "I only had 2 drinks","Those aren't my pants","I was scared","That's not mine",
  "I was holding it for a friend","I don't consent to a search","Am I being detained?",
  "I know my rights","I didn't do anything wrong","I was just leaving",
  "My license is suspended","I live right around the corner","I just bought this car",
  "I didn't know about the warrant","She/He started it","I'm being honest with you, officer",
  "Can I just get a warning?","I wasn't speeding","I don't have my ID on me",
  "My kids are in the car","I'm not drunk, I'm tired","I have a medical condition",
  "Can you call my girlfriend?","I was borrowing the car","I plead the fifth",
  "I want a lawyer","You can search, I got nothing to hide","Someone runs from the cops",
  "Shirtless suspect","K9 gets deployed","Suspect is barefoot","Dan says 'breaking news'",
  "Sticks roasts somebody","Officer says 'stop resisting'","Do you have anything sharp on you?",
  "Step out of the vehicle","How much have you had to drink?",
  "Scale of 1 to 10 how drunk are you?","Car has no registration",
  "Pulled over with no headlights","It's my friend's car","I'm a sovereign citizen",
  "Suspect cries","Cops find drugs in the car","Someone is passed out behind the wheel",
  "Domestic disturbance call","I didn't hit nobody","Florida Man moment",
  "My back hurts / I can't breathe","Suspect has outstanding warrants",
  "I don't live here, I'm visiting","Dan Abrams laugh","Officer does a field sobriety test",
  "Suspect has no shoes","I wasn't driving, I was parked","It was just a misunderstanding",
  "We were just talking loud","Commercial break cliffhanger","I'm cooperating!",
  "Somebody lies about their name","Car smells like marijuana",
  "I got warrants in another state","Do you know who I am?","Officer finds a weapon",
  "Suspect tries to eat the evidence","I was just holding it","Taser gets deployed",
  "Someone is wearing pajamas","Car has a missing window or door",
  "Multiple people blame each other","I'm on probation","Ride-along officer watches awkwardly",
  "That's my baby mama's house","Suspect tries to walk away","Found something in the sock"
];

// ── Helpers ──
const rooms = new Map();

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCard() {
  const p = shuffle(PHRASES).slice(0, 24);
  p.splice(12, 0, '__FREE__');
  return p;
}

function checkBingo(marked) {
  const g = Array(25).fill(false);
  marked.forEach(i => g[i] = true);
  g[12] = true;
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every(c => g[r*5+c])) return true;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => g[r*5+c])) return true;
  if ([0,6,12,18,24].every(i => g[i])) return true;
  if ([4,8,12,16,20].every(i => g[i])) return true;
  return false;
}

function broadcast(room, msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id !== excludeId && p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function getScoreboard(room) {
  const board = [];
  for (const [id, p] of room.players) {
    const marked = (p.markedIndices ? p.markedIndices.size : 0) + 1; // +1 for free space
    board.push({ id, name: p.name, emoji: p.emoji, marked, hasBingo: p.hasBingo || false });
  }
  board.sort((a, b) => b.marked - a.marked);
  return board;
}

function getAllCards(room) {
  const cards = {};
  for (const [id, p] of room.players) {
    cards[id] = { name: p.name, emoji: p.emoji, card: p.card, markedIndices: [...(p.markedIndices || [])] };
  }
  return cards;
}

function getRoomState(room, playerId) {
  const player = room.players.get(playerId);
  return {
    type: 'state',
    roomCode: room.code,
    isHost: room.hostId === playerId,
    gameStarted: room.gameStarted,
    card: player ? player.card : [],
    markedIndices: player ? [...(player.markedIndices || [])] : [],
    playerId,
    playerName: player ? player.name : '',
    scoreboard: getScoreboard(room),
    winners: room.winners,
    hostName: room.players.get(room.hostId)?.name || 'Host',
    allCards: room.gameStarted ? getAllCards(room) : {},
    chatHistory: room.chatHistory || []
  };
}

// ── HTTP Server (serves static files) ──
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  let filePath = req.url.split('?')[0];
  if (filePath === '/') filePath = '/index.html';
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data2); }
      });
    } else {
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let playerId = crypto.randomUUID();
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        // Allow reconnect with existing playerId
        if (msg.playerId) playerId = msg.playerId;
        let code = genCode();
        while (rooms.has(code)) code = genCode();
        const room = {
          code, hostId: playerId,
          players: new Map(),
          gameStarted: false, winners: [],
          chatHistory: [],
          createdAt: Date.now()
        };
        const card = makeCard();
        room.players.set(playerId, { ws, name: msg.name || 'Host', emoji: msg.emoji || '🚔', card, hasBingo: false, markedIndices: new Set() });
        rooms.set(code, room);
        currentRoom = room;
        ws.send(JSON.stringify({ type: 'welcome', playerId }));
        ws.send(JSON.stringify(getRoomState(room, playerId)));
        console.log(`Room ${code} created by ${msg.name}`);
        break;
      }

      case 'join': {
        if (msg.playerId) playerId = msg.playerId;
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found! Check your code.' })); return; }
        if (room.players.size >= 20 && !room.players.has(playerId)) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 20).' })); return; }
        const card = makeCard();
        room.players.set(playerId, { ws, name: msg.name || 'Player', emoji: msg.emoji || '🎲', card, hasBingo: false, markedIndices: new Set() });
        currentRoom = room;
        const joinSys = { type: 'systemChat', text: `${msg.emoji || '🎲'} ${msg.name || 'Player'} joined the game`, ts: Date.now() };
        room.chatHistory.push(joinSys);
        broadcast(room, { type: 'playerJoined', name: msg.name, emoji: msg.emoji || '🎲', scoreboard: getScoreboard(room) });
        ws.send(JSON.stringify({ type: 'welcome', playerId }));
        ws.send(JSON.stringify(getRoomState(room, playerId)));
        console.log(`${msg.name} joined room ${code}`);
        break;
      }

      case 'rejoin': {
        // Reconnect to existing game
        if (!msg.playerId || !msg.roomCode) {
          ws.send(JSON.stringify({ type: 'error', message: 'No session to rejoin.' }));
          return;
        }
        playerId = msg.playerId;
        const code = (msg.roomCode || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          ws.send(JSON.stringify({ type: 'rejoinFailed', message: 'Room no longer exists.' }));
          return;
        }
        const existing = room.players.get(playerId);
        if (!existing) {
          ws.send(JSON.stringify({ type: 'rejoinFailed', message: 'Player not found in room.' }));
          return;
        }
        // Restore the websocket connection
        existing.ws = ws;
        currentRoom = room;
        ws.send(JSON.stringify({ type: 'welcome', playerId }));
        ws.send(JSON.stringify(getRoomState(room, playerId)));
        broadcast(room, { type: 'playerRejoined', name: existing.name, emoji: existing.emoji, scoreboard: getScoreboard(room) });
        console.log(`${existing.name} rejoined room ${code}`);
        break;
      }

      case 'markSquare': {
        if (!currentRoom || !currentRoom.gameStarted) return;
        const player = currentRoom.players.get(playerId);
        if (!player) return;
        const index = msg.index;
        if (typeof index !== 'number' || index < 0 || index > 24 || index === 12) return;
        if (!player.markedIndices) player.markedIndices = new Set();
        // Toggle: mark or unmark
        const wasMarked = player.markedIndices.has(index);
        if (wasMarked) player.markedIndices.delete(index);
        else player.markedIndices.add(index);
        // Notify everyone of updated scoreboard + cards
        broadcast(currentRoom, {
          type: 'playerMarked',
          playerId,
          name: player.name,
          emoji: player.emoji,
          index,
          marked: !wasMarked,
          scoreboard: getScoreboard(currentRoom),
          allCards: getAllCards(currentRoom)
        });
        break;
      }

      case 'claimBingo': {
        if (!currentRoom || !currentRoom.gameStarted) return;
        const player = currentRoom.players.get(playerId);
        if (!player || player.hasBingo) return;
        const markedIndices = new Set(player.markedIndices || []);
        markedIndices.add(12); // free space
        if (checkBingo(markedIndices)) {
          player.hasBingo = true;
          const place = currentRoom.winners.length + 1;
          currentRoom.winners.push({ name: player.name, emoji: player.emoji, place });
          broadcast(currentRoom, {
            type: 'bingo', name: player.name, emoji: player.emoji, place,
            winners: currentRoom.winners, scoreboard: getScoreboard(currentRoom)
          });
        } else {
          ws.send(JSON.stringify({ type: 'falseBingo', message: "Not quite! You don't have BINGO yet 😅" }));
        }
        break;
      }

      case 'startGame': {
        if (!currentRoom || currentRoom.hostId !== playerId) return;
        currentRoom.gameStarted = true;
        currentRoom.winners = [];
        for (const [pid, p] of currentRoom.players) { p.card = makeCard(); p.hasBingo = false; p.markedIndices = new Set(); }
        for (const [pid, p] of currentRoom.players) {
          if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(getRoomState(currentRoom, pid)));
        }
        broadcast(currentRoom, { type: 'gameStarted', scoreboard: getScoreboard(currentRoom) });
        console.log(`Game started in room ${currentRoom.code}`);
        break;
      }

      case 'resetGame': {
        if (!currentRoom || currentRoom.hostId !== playerId) return;
        currentRoom.gameStarted = true;
        currentRoom.winners = [];
        for (const [pid, p] of currentRoom.players) { p.card = makeCard(); p.hasBingo = false; p.markedIndices = new Set(); }
        for (const [pid, p] of currentRoom.players) {
          if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(getRoomState(currentRoom, pid)));
        }
        broadcast(currentRoom, { type: 'gameStarted', scoreboard: getScoreboard(currentRoom) });
        break;
      }

      case 'chat': {
        if (!currentRoom) return;
        const sender = currentRoom.players.get(playerId);
        if (!sender) return;
        const text = (msg.text || '').trim().slice(0, 300);
        const image = msg.image || null; // base64 data URL
        if (!text && !image) return;
        const chatMsg = { type: 'chat', name: sender.name, emoji: sender.emoji, text, ts: Date.now() };
        if (image) chatMsg.image = image;
        currentRoom.chatHistory.push(chatMsg);
        if (currentRoom.chatHistory.length > 200) currentRoom.chatHistory.shift();
        broadcast(currentRoom, chatMsg);
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      const player = currentRoom.players.get(playerId);
      if (player) {
        player.ws = null; // Mark disconnected but keep the player
        player.disconnectedAt = Date.now();
        broadcast(currentRoom, { type: 'playerDisconnected', name: player.name, emoji: player.emoji, scoreboard: getScoreboard(currentRoom) });
        console.log(`${player.name} disconnected from room ${currentRoom.code} (kept for rejoin)`);
      }
    }
  });
});

// Cleanup every 2 min: remove disconnected players after 5 min, delete empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // Remove players disconnected > 5 min
    for (const [pid, p] of room.players) {
      if (!p.ws && p.disconnectedAt && now - p.disconnectedAt > 5 * 60 * 1000) {
        room.players.delete(pid);
        broadcast(room, { type: 'playerLeft', name: p.name, scoreboard: getScoreboard(room) });
        // Transfer host if needed
        if (room.hostId === pid && room.players.size > 0) {
          room.hostId = room.players.keys().next().value;
          const newHost = room.players.get(room.hostId);
          broadcast(room, { type: 'newHost', name: newHost?.name || 'Someone', hostId: room.hostId });
        }
      }
    }
    // Delete empty or stale rooms
    if (room.players.size === 0 || now - room.createdAt > 12 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 2 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚔 OPL Bingo Live running on port ${PORT}`);
});
