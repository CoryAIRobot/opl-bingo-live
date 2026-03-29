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

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function getScoreboard(room) {
  const board = [];
  for (const [id, p] of room.players) {
    const marked = p.card.filter((ph, i) => i === 12 || room.calledPhrases.has(ph.toUpperCase())).length;
    board.push({ id, name: p.name, emoji: p.emoji, marked, hasBingo: p.hasBingo || false });
  }
  board.sort((a, b) => b.marked - a.marked);
  return board;
}

function getAllCards(room) {
  const cards = {};
  for (const [id, p] of room.players) {
    cards[id] = { name: p.name, emoji: p.emoji, card: p.card };
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
    calledPhrases: [...room.calledPhrases],
    calledBy: Object.fromEntries(room.calledBy),
    card: player ? player.card : [],
    playerId,
    playerName: player ? player.name : '',
    scoreboard: getScoreboard(room),
    winners: room.winners,
    hostName: room.players.get(room.hostId)?.name || 'Host',
    allCards: room.gameStarted ? getAllCards(room) : {}
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

  // Send welcome with player ID
  ws.send(JSON.stringify({ type: 'welcome', playerId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create': {
        let code = genCode();
        while (rooms.has(code)) code = genCode();
        const room = {
          code, hostId: playerId,
          players: new Map(),
          calledPhrases: new Set(),
          calledBy: new Map(),
          gameStarted: false, winners: [],
          createdAt: Date.now()
        };
        const card = makeCard();
        room.players.set(playerId, { ws, name: msg.name || 'Host', emoji: msg.emoji || '🚔', card, hasBingo: false });
        rooms.set(code, room);
        currentRoom = room;
        ws.send(JSON.stringify(getRoomState(room, playerId)));
        console.log(`Room ${code} created by ${msg.name}`);
        break;
      }

      case 'join': {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found! Check your code.' })); return; }
        if (room.players.size >= 20) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 20).' })); return; }
        const card = makeCard();
        room.players.set(playerId, { ws, name: msg.name || 'Player', emoji: msg.emoji || '🎲', card, hasBingo: false });
        currentRoom = room;
        broadcast(room, { type: 'playerJoined', name: msg.name, emoji: msg.emoji || '🎲', scoreboard: getScoreboard(room) });
        ws.send(JSON.stringify(getRoomState(room, playerId)));
        console.log(`${msg.name} joined room ${code}`);
        break;
      }

      case 'callPhrase': {
        if (!currentRoom || !currentRoom.gameStarted) return;
        const upper = msg.phrase.toUpperCase();
        if (currentRoom.calledPhrases.has(upper)) return;
        currentRoom.calledPhrases.add(upper);
        const callerName = currentRoom.players.get(playerId)?.name || '???';
        currentRoom.calledBy.set(upper, callerName);
        broadcast(currentRoom, {
          type: 'phraseCalled', phrase: upper, calledBy: callerName,
          calledPhrases: [...currentRoom.calledPhrases],
          calledByMap: Object.fromEntries(currentRoom.calledBy),
          scoreboard: getScoreboard(currentRoom),
          allCards: getAllCards(currentRoom)
        });
        break;
      }

      case 'claimBingo': {
        if (!currentRoom || !currentRoom.gameStarted) return;
        const player = currentRoom.players.get(playerId);
        if (!player || player.hasBingo) return;
        const markedIndices = new Set();
        player.card.forEach((ph, i) => { if (i === 12 || currentRoom.calledPhrases.has(ph.toUpperCase())) markedIndices.add(i); });
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
        currentRoom.calledPhrases = new Set();
        currentRoom.calledBy = new Map();
        currentRoom.winners = [];
        for (const [pid, p] of currentRoom.players) { p.card = makeCard(); p.hasBingo = false; }
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
        currentRoom.calledPhrases = new Set();
        currentRoom.calledBy = new Map();
        currentRoom.winners = [];
        for (const [pid, p] of currentRoom.players) { p.card = makeCard(); p.hasBingo = false; }
        for (const [pid, p] of currentRoom.players) {
          if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(getRoomState(currentRoom, pid)));
        }
        broadcast(currentRoom, { type: 'gameStarted', scoreboard: getScoreboard(currentRoom) });
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
      currentRoom.players.delete(playerId);
      if (currentRoom.players.size === 0) {
        rooms.delete(currentRoom.code);
        console.log(`Room ${currentRoom.code} deleted (empty)`);
      } else {
        broadcast(currentRoom, { type: 'playerLeft', name: player?.name || '???', scoreboard: getScoreboard(currentRoom) });
        if (currentRoom.hostId === playerId) {
          currentRoom.hostId = currentRoom.players.keys().next().value;
          const newHost = currentRoom.players.get(currentRoom.hostId);
          broadcast(currentRoom, { type: 'newHost', name: newHost?.name || 'Someone', hostId: currentRoom.hostId });
        }
      }
    }
  });
});

// Cleanup stale rooms every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || now - room.createdAt > 12 * 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`🚔 OPL Bingo Live running on port ${PORT}`);
});
