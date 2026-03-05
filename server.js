'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

/* ═══════════════════════════════════════════════
   BOARD SETUP
   rows 0-7, cols 0-7
   pink  (kız)   starts on rows 5,6,7  → moves toward row 0 → kings at row 0
   blue  (erkek) starts on rows 0,1,2  → moves toward row 7 → kings at row 7
   dark squares: (row+col) % 2 === 1
════════════════════════════════════════════════ */
function initBoard() {
  const pieces = [];
  let id = 0;
  for (let r = 0; r <= 2; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1)
        pieces.push({ id: id++, color: 'blue', row: r, col: c, king: false, captured: false });
  for (let r = 5; r <= 7; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1)
        pieces.push({ id: id++, color: 'pink', row: r, col: c, king: false, captured: false });
  return pieces;
}

const ROOMS = new Map();
let roomSeq = 1;

function makeRoom(id) {
  return {
    id, players: {}, board: initBoard(),
    turn: 'blue', messages: [], paused: false, pausedBy: null,
    winner: null, started: false, created: Date.now(),
    video: null, // { url, serverTime, seekSeconds }
  };
}

function findOrCreateWaitingRoom() {
  for (const [, r] of ROOMS)
    if (!r.players.pink || !r.players.blue) return r;
  const id = 'R' + (roomSeq++);
  const r  = makeRoom(id);
  ROOMS.set(id, r);
  return r;
}

function boardState(room) {
  return {
    pieces: room.board, turn: room.turn, winner: room.winner,
    paused: room.paused, pausedBy: room.pausedBy,
    players: room.players, started: room.started, video: room.video,
  };
}

function broadcast(room, ev, data) { io.to('room:' + room.id).emit(ev, data); }
function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 200) room.messages.shift();
  broadcast(room, 'new_msg', msg);
}

/* ─── GAME LOGIC ─── */
function pieceAt(board, r, c) { return board.find(p => p.row === r && p.col === c && !p.captured) || null; }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function activePieces(board, color) { return board.filter(p => p.color === color && !p.captured); }

function getMoves(board, piece) {
  const moves = [], jumps = [];
  const dirs4 = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const dirs  = piece.king ? dirs4 : piece.color === 'blue' ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];

  if (piece.king) {
    for (const [dr, dc] of dirs4) {
      let r = piece.row + dr, c = piece.col + dc;
      let foundEnemy = null, enemyR = -1, enemyC = -1;
      while (inBounds(r, c)) {
        const occ = pieceAt(board, r, c);
        if (!occ) {
          if (!foundEnemy) moves.push({ toRow: r, toCol: c, captures: [] });
          else jumps.push({ toRow: r, toCol: c, captures: [foundEnemy.id] });
          r += dr; c += dc;
        } else if (!foundEnemy && occ.color !== piece.color) {
          foundEnemy = occ; enemyR = r; enemyC = c;
          r += dr; c += dc;
        } else break;
      }
    }
  } else {
    for (const [dr, dc] of dirs) {
      const nr = piece.row + dr, nc = piece.col + dc;
      if (inBounds(nr, nc) && !pieceAt(board, nr, nc))
        moves.push({ toRow: nr, toCol: nc, captures: [] });
      const mid = pieceAt(board, piece.row + dr, piece.col + dc);
      if (mid && mid.color !== piece.color) {
        const jr = piece.row + 2*dr, jc = piece.col + 2*dc;
        if (inBounds(jr, jc) && !pieceAt(board, jr, jc))
          jumps.push({ toRow: jr, toCol: jc, captures: [mid.id] });
      }
    }
  }
  return jumps.length > 0 ? jumps : moves;
}

function anyJumps(board, color) {
  return activePieces(board, color).some(p => getMoves(board, p).some(m => m.captures.length > 0));
}

function checkWinner(board) {
  if (activePieces(board, 'blue').length === 0) return 'pink';
  if (activePieces(board, 'pink').length === 0) return 'blue';
  return null;
}

/* ─── SOCKET ─── */
io.on('connection', socket => {

  socket.on('join_game', ({ name, gender, roomId: reqRoom } = {}, cb) => {
    const pName   = (name || 'Oyunçu').slice(0, 24);
    const pGender = gender === 'kız' ? 'kız' : 'erkek';
    // FIX #2: kız → pink, erkek → blue  (previously was wrong)
    const wantColor = pGender === 'kız' ? 'pink' : 'blue';
    const altColor  = wantColor === 'pink' ? 'blue' : 'pink';

    let room;
    if (reqRoom && ROOMS.has(reqRoom)) {
      room = ROOMS.get(reqRoom);
      // If that specific room is full, make new one
      if (room.players.pink && room.players.blue) {
        room = findOrCreateWaitingRoom();
      }
    } else {
      room = findOrCreateWaitingRoom();
    }

    // Pick color: preferred first, then alt, then new room
    let color;
    if (!room.players[wantColor])      color = wantColor;
    else if (!room.players[altColor])  color = altColor;
    else {
      // Both taken — new room
      const nr = makeRoom('R' + (roomSeq++));
      ROOMS.set(nr.id, nr);
      room  = nr;
      color = wantColor;
    }

    room.players[color] = { socketId: socket.id, name: pName, gender: pGender, color };
    socket.join('room:' + room.id);
    socket.data.roomId = room.id;
    socket.data.color  = color;

    if (room.players.pink && room.players.blue && !room.started) {
      room.started = true;
      room.paused  = false;
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: '🎮 Oyun başladı! Mavi (Erkek) başlayır.' });
    }

    socket.emit('history', room.messages);
    socket.emit('init', { color, roomId: room.id, players: room.players });
    broadcast(room, 'board', boardState(room));
    cb?.({ ok: true, color, roomId: room.id });
  });

  socket.on('rejoin', ({ roomId, color, name } = {}, cb) => {
    const room = ROOMS.get(roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq tapılmadı' });
    const p = room.players[color];
    if (!p) return cb?.({ ok: false, e: 'Oyunçu yoxdur' });

    p.socketId = socket.id;
    socket.join('room:' + room.id);
    socket.data.roomId = roomId;
    socket.data.color  = color;

    if (room.paused && room.pausedBy === color) {
      room.paused   = false;
      room.pausedBy = null;
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: `▶️ ${p.name} qayıtdı — oyun davam edir!` });
      broadcast(room, 'board', boardState(room));
    } else {
      socket.emit('board', boardState(room));
    }
    socket.emit('history', room.messages);
    cb?.({ ok: true, color, roomId });
  });

  socket.on('get_moves', ({ pieceId } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.paused || room.winner || !room.started) return cb?.({ moves: [] });
    const color = socket.data.color;
    if (room.turn !== color) return cb?.({ moves: [] });
    const piece = room.board.find(p => p.id === pieceId && !p.captured);
    if (!piece || piece.color !== color) return cb?.({ moves: [] });

    const pMoves = getMoves(room.board, piece);
    // If mandatory jumps exist globally, only allow jumps
    if (anyJumps(room.board, color) && pMoves.every(m => m.captures.length === 0))
      return cb?.({ moves: [] });
    cb?.({ moves: pMoves });
  });

  socket.on('move', ({ pieceId, toRow, toCol } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room)           return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.paused)     return cb?.({ ok: false, e: 'Oyun dayandırılıb' });
    if (room.winner)     return cb?.({ ok: false, e: 'Oyun bitib' });
    if (!room.started)   return cb?.({ ok: false, e: 'Oyun başlamayıb' });

    const color = socket.data.color;
    if (room.turn !== color) return cb?.({ ok: false, e: 'Sizin növbəniz deyil' });

    const piece = room.board.find(p => p.id === pieceId && !p.captured);
    if (!piece || piece.color !== color) return cb?.({ ok: false, e: 'Geçersiz taş' });

    const allMoves = getMoves(room.board, piece);
    const filtered = anyJumps(room.board, color) ? allMoves.filter(m => m.captures.length > 0) : allMoves;
    const chosen   = filtered.find(m => m.toRow === toRow && m.toCol === toCol);
    if (!chosen) return cb?.({ ok: false, e: 'Geçersiz hərəkət' });

    const prevRow = piece.row, prevCol = piece.col;
    piece.row = toRow;
    piece.col = toCol;

    const capturedPieces = [];
    chosen.captures.forEach(cid => {
      const cp = room.board.find(p => p.id === cid);
      if (cp) { cp.captured = true; capturedPieces.push({ ...cp }); }
    });

    let becameKing = false;
    if (!piece.king) {
      if (piece.color === 'blue' && toRow === 7) { piece.king = true; becameKing = true; }
      if (piece.color === 'pink' && toRow === 0) { piece.king = true; becameKing = true; }
    }

    const winner = checkWinner(room.board);
    if (winner) {
      room.winner = winner;
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: `🏆 ${room.players[winner]?.name} QAZANDI!` });
    }

    if (!winner) room.turn = color === 'blue' ? 'pink' : 'blue';

    broadcast(room, 'move', { pieceId, prevRow, prevCol, toRow, toCol, capturedPieces, becameKing, board: boardState(room) });
    if (becameKing)
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: `👑 ${room.players[color]?.name} DAMA OLDU!` });
    cb?.({ ok: true });
  });

  socket.on('emoji', ({ emoji } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const p = room.players[socket.data.color];
    broadcast(room, 'emoji', { emoji, color: socket.data.color, name: p?.name });
  });

  // FIX #1: Video sync — store seekSeconds so other client can sync to same position
  socket.on('set_video', ({ url, seekSeconds } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false });
    if (url) {
      room.video = {
        url,
        seekSeconds: seekSeconds || 0,
        serverTime: Date.now(), // track when seek happened
      };
    } else {
      room.video = null;
    }
    broadcast(room, 'board', boardState(room));
    cb?.({ ok: true });
  });

  // Seek sync event — client reports current position
  socket.on('video_seek', ({ seekSeconds } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || !room.video) return;
    room.video.seekSeconds = seekSeconds;
    room.video.serverTime  = Date.now();
    // Broadcast to the OTHER client only
    const oppColor = socket.data.color === 'pink' ? 'blue' : 'pink';
    const opp = room.players[oppColor];
    if (opp?.socketId) {
      io.to(opp.socketId).emit('video_seek', { seekSeconds });
    }
  });

  socket.on('msg', ({ text } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const p    = room.players[socket.data.color];
    const body = (text || '').trim().slice(0, 300);
    if (!body) return;
    addMsg(room, {
      id: crypto.randomUUID(), type: 'chat',
      name: p?.name || '?',
      color: socket.data.color === 'pink' ? '#ff69b4' : '#4a90ff',
      body,
    });
  });

  function onLeave() {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const color = socket.data.color;
    const p     = room.players[color];
    if (!p || p.socketId !== socket.id) return;

    if (room.started && !room.winner) {
      room.paused   = true;
      room.pausedBy = color;
      broadcast(room, 'board', boardState(room));
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: `⏸️ ${p.name} ayrıldı — oyun dayandırıldı. Qayıtdıqda davam edəcək.` });
    }
  }
  socket.on('disconnect', onLeave);
  socket.on('leave_game', onLeave);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Dama → http://localhost:${PORT}`));
