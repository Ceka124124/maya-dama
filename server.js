'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout:  30000,
});

/* ═══════════════════════════════════════════════════
   DAMA (CHECKERS) GAME ENGINE
   Board: 8x8, rows 0-7, cols 0-7
   Pink  (kız)  = row 0 side  (top of board data, bottom visually for pink player)
   Blue  (erkek) = row 7 side (bottom of board data, top visually for blue player)
   Pieces: { id, color:'pink'|'blue', row, col, king:bool, captured:bool }
═══════════════════════════════════════════════════ */

const ROOMS = new Map(); // roomId → Room

function initBoard() {
  const pieces = [];
  let id = 0;
  // Blue pieces on rows 0,1,2 (dark squares)
  for (let r = 0; r <= 2; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        pieces.push({ id: id++, color: 'blue', row: r, col: c, king: false, captured: false });
      }
    }
  }
  // Pink pieces on rows 5,6,7 (dark squares)
  for (let r = 5; r <= 7; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        pieces.push({ id: id++, color: 'pink', row: r, col: c, king: false, captured: false });
      }
    }
  }
  return pieces;
}

function makeRoom(id) {
  return {
    id,
    players:  {},        // 'pink' | 'blue' → { socketId, name, gender }
    spectators: [],
    board:    initBoard(),
    turn:     'blue',    // blue starts
    messages: [],
    paused:   false,
    pausedBy: null,
    winner:   null,
    started:  false,
    created:  Date.now(),
    video:    null,      // { url, startTime }
  };
}

let roomSeq = 1;

function findOrCreateWaitingRoom() {
  for (const [, r] of ROOMS) {
    if (!r.players.pink || !r.players.blue) return r;
  }
  const id = 'R' + (roomSeq++);
  const r  = makeRoom(id);
  ROOMS.set(id, r);
  return r;
}

function boardState(room) {
  return {
    pieces:  room.board,
    turn:    room.turn,
    winner:  room.winner,
    paused:  room.paused,
    pausedBy:room.pausedBy,
    players: room.players,
    started: room.started,
    video:   room.video,
  };
}

function broadcast(room, event, data) {
  io.to('room:' + room.id).emit(event, data);
}

function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 200) room.messages.shift();
  broadcast(room, 'new_msg', msg);
}

/* ── MOVE VALIDATION ── */
function getActivePieces(board, color) {
  return board.filter(p => p.color === color && !p.captured);
}

function pieceAt(board, row, col) {
  return board.find(p => p.row === row && p.col === col && !p.captured) || null;
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// Returns all valid moves for a piece (including jumps)
// Returns array of { toRow, toCol, captures: [pieceId,...], path: [{r,c},...] }
function getValidMoves(board, piece) {
  const moves  = [];
  const jumps  = [];
  const dirs   = piece.king
    ? [[-1,-1],[-1,1],[1,-1],[1,1]]
    : piece.color === 'blue'
      ? [[1,-1],[1,1]]    // blue moves down
      : [[-1,-1],[-1,1]]; // pink moves up

  if (piece.king) {
    // King: can slide multiple squares, and jump over one enemy
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      // Slides
      let r = piece.row + dr, c = piece.col + dc;
      while (inBounds(r, c)) {
        const occ = pieceAt(board, r, c);
        if (!occ) {
          moves.push({ toRow: r, toCol: c, captures: [], path: [{r, c}] });
          r += dr; c += dc;
        } else if (occ.color !== piece.color) {
          // Can jump over it
          const lr = r + dr, lc = c + dc;
          if (inBounds(lr, lc) && !pieceAt(board, lr, lc)) {
            // Collect all landing squares after jump
            let lr2 = lr, lc2 = lc;
            while (inBounds(lr2, lc2) && !pieceAt(board, lr2, lc2)) {
              jumps.push({ toRow: lr2, toCol: lc2, captures: [occ.id], path: [{r: lr2, c: lc2}] });
              lr2 += dr; lc2 += dc;
            }
          }
          break;
        } else break;
      }
    }
  } else {
    // Normal piece
    for (const [dr, dc] of dirs) {
      const nr = piece.row + dr, nc = piece.col + dc;
      if (inBounds(nr, nc) && !pieceAt(board, nr, nc)) {
        moves.push({ toRow: nr, toCol: nc, captures: [], path: [{r: nr, c: nc}] });
      }
      // Jump
      const mr = piece.row + dr, mc = piece.col + dc;
      const mid = pieceAt(board, mr, mc);
      if (mid && mid.color !== piece.color) {
        const jr = piece.row + 2*dr, jc = piece.col + 2*dc;
        if (inBounds(jr, jc) && !pieceAt(board, jr, jc)) {
          jumps.push({ toRow: jr, toCol: jc, captures: [mid.id], path: [{r: jr, c: jc}] });
        }
      }
    }
  }

  // Mandatory jumps rule
  return jumps.length > 0 ? jumps : moves;
}

// Check if ANY piece of given color has mandatory jumps
function hasJumps(board, color) {
  return getActivePieces(board, color).some(p => {
    const dirs = p.king ? [[-1,-1],[-1,1],[1,-1],[1,1]] : p.color==='blue' ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];
    return dirs.some(([dr,dc]) => {
      const mr = p.row+dr, mc = p.col+dc;
      const mid = pieceAt(board, mr, mc);
      if (mid && mid.color !== p.color) {
        const jr = p.row+2*dr, jc = p.col+2*dc;
        if (p.king) {
          // king jump — check if any square beyond is free
          let r2 = p.row+dr, c2 = p.col+dc;
          while (inBounds(r2,c2)) {
            const occ = pieceAt(board,r2,c2);
            if (!occ) { r2+=dr; c2+=dc; continue; }
            if (occ.color !== p.color) {
              const lr = r2+dr, lc = c2+dc;
              if (inBounds(lr,lc) && !pieceAt(board,lr,lc)) return true;
            }
            break;
          }
        } else {
          if (inBounds(jr,jc) && !pieceAt(board,jr,jc)) return true;
        }
      }
      return false;
    });
  });
}

function checkWinner(board) {
  const blueLeft = getActivePieces(board, 'blue').length;
  const pinkLeft = getActivePieces(board, 'pink').length;
  if (blueLeft === 0) return 'pink';
  if (pinkLeft === 0) return 'blue';
  // Check if current player has no moves
  return null;
}

/* ═══════════════════════════════════════════════════
   SOCKET
═══════════════════════════════════════════════════ */
io.on('connection', (socket) => {

  socket.on('join_game', ({ name, gender, roomId: requestedRoom } = {}, cb) => {
    const playerName = (name || 'Oyunçu').slice(0, 24);
    const playerGender = gender === 'kız' ? 'kız' : 'erkek';
    const preferredColor = playerGender === 'kız' ? 'pink' : 'blue';
    const otherColor     = preferredColor === 'pink' ? 'blue' : 'pink';

    let room;
    if (requestedRoom && ROOMS.has(requestedRoom)) {
      room = ROOMS.get(requestedRoom);
    } else {
      room = findOrCreateWaitingRoom();
    }

    // Assign color
    let assignedColor = null;
    if (!room.players[preferredColor]) {
      assignedColor = preferredColor;
    } else if (!room.players[otherColor]) {
      assignedColor = otherColor;
    } else {
      // Room full — spectator or new room
      const newRoom = makeRoom('R' + (roomSeq++));
      ROOMS.set(newRoom.id, newRoom);
      room = newRoom;
      assignedColor = preferredColor;
    }

    room.players[assignedColor] = { socketId: socket.id, name: playerName, gender: playerGender, color: assignedColor };
    socket.join('room:' + room.id);
    socket.data.roomId = room.id;
    socket.data.color  = assignedColor;

    if (room.players.pink && room.players.blue && !room.started) {
      room.started = true;
      room.paused  = false;
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: '🎮 Oyun başladı! Mavi başlayır.' });
    }

    socket.emit('history', room.messages);
    socket.emit('init', {
      color:   assignedColor,
      roomId:  room.id,
      players: room.players,
    });

    broadcast(room, 'board', boardState(room));
    cb?.({ ok: true, color: assignedColor, roomId: room.id });
  });

  /* RE-JOIN after disconnect */
  socket.on('rejoin', ({ roomId, color, name } = {}, cb) => {
    const room = ROOMS.get(roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq tapılmadı' });

    const p = room.players[color];
    if (!p) return cb?.({ ok: false, e: 'Oyunçu yoxdur' });

    // Update socket id
    p.socketId = socket.id;
    socket.join('room:' + room.id);
    socket.data.roomId = roomId;
    socket.data.color  = color;

    // Resume if was paused by this player
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

  /* GET VALID MOVES for a piece */
  socket.on('get_moves', ({ pieceId } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.paused || room.winner) return cb?.({ moves: [] });

    const color = socket.data.color;
    if (room.turn !== color) return cb?.({ moves: [] });

    const piece = room.board.find(p => p.id === pieceId && !p.captured);
    if (!piece || piece.color !== color) return cb?.({ moves: [] });

    // If any piece has mandatory jumps, only those pieces may move
    const mandatory = hasJumps(room.board, color);
    const pieceMoves = getValidMoves(room.board, piece);
    if (mandatory && pieceMoves.every(m => m.captures.length === 0)) {
      return cb?.({ moves: [] });
    }

    cb?.({ moves: pieceMoves });
  });

  /* MAKE MOVE */
  socket.on('move', ({ pieceId, toRow, toCol } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false, e: 'Otaq yoxdur' });
    if (room.paused) return cb?.({ ok: false, e: 'Oyun dayandırılıb' });
    if (room.winner) return cb?.({ ok: false, e: 'Oyun bitib' });
    if (!room.started) return cb?.({ ok: false, e: 'Oyun başlamayıb' });

    const color = socket.data.color;
    if (room.turn !== color) return cb?.({ ok: false, e: 'Sizin növbəniz deyil' });

    const piece = room.board.find(p => p.id === pieceId && !p.captured);
    if (!piece || piece.color !== color) return cb?.({ ok: false, e: 'Geçersiz taş' });

    const validMoves = getValidMoves(room.board, piece);
    const mandatory  = hasJumps(room.board, color);
    const filteredMoves = mandatory
      ? validMoves.filter(m => m.captures.length > 0)
      : validMoves;

    const chosen = filteredMoves.find(m => m.toRow === toRow && m.toCol === toCol);
    if (!chosen) return cb?.({ ok: false, e: 'Geçersiz hərəkət' });

    // Apply move
    const prevRow = piece.row, prevCol = piece.col;
    piece.row = toRow;
    piece.col = toCol;

    // Remove captured pieces
    const capturedPieces = [];
    chosen.captures.forEach(cid => {
      const cp = room.board.find(p => p.id === cid);
      if (cp) { cp.captured = true; capturedPieces.push({ ...cp }); }
    });

    // King promotion
    let becameKing = false;
    if (!piece.king) {
      if (piece.color === 'blue'  && toRow === 7) { piece.king = true; becameKing = true; }
      if (piece.color === 'pink'  && toRow === 0) { piece.king = true; becameKing = true; }
    }

    // Check winner
    const winner = checkWinner(room.board);
    if (winner) {
      room.winner = winner;
      const wp = room.players[winner];
      addMsg(room, { id: crypto.randomUUID(), type: 'system', body: `🏆 ${wp?.name || winner} QAZANDI!` });
    }

    // Switch turn
    if (!winner) {
      room.turn = color === 'blue' ? 'pink' : 'blue';
    }

    const moveData = {
      pieceId, prevRow, prevCol, toRow, toCol,
      capturedPieces,
      becameKing,
      board: boardState(room),
    };

    broadcast(room, 'move', moveData);

    if (becameKing) {
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: `👑 ${room.players[color]?.name} DAMA OLDU!` });
    }

    cb?.({ ok: true });
  });

  /* EMOJI REACTION */
  socket.on('emoji', ({ emoji } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const color = socket.data.color;
    const p     = room.players[color];
    broadcast(room, 'emoji', { emoji, color, name: p?.name || '?' });
  });

  /* VIDEO SHARE */
  socket.on('set_video', ({ url } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false });
    room.video = url ? { url, startTime: Math.floor(Date.now() / 1000) } : null;
    broadcast(room, 'board', boardState(room));
    cb?.({ ok: true });
  });

  /* CHAT */
  socket.on('msg', ({ text } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const color = socket.data.color;
    const p     = room.players[color];
    const body  = (text || '').trim().slice(0, 300);
    if (!body) return;
    addMsg(room, {
      id:    crypto.randomUUID(),
      type:  'chat',
      name:  p?.name || '?',
      color: color === 'pink' ? '#ff69b4' : '#4a90ff',
      body,
    });
  });

  /* DISCONNECT — pause game */
  function onLeave() {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const color = socket.data.color;
    const p     = room.players[color];
    if (!p || p.socketId !== socket.id) return;

    if (room.started && !room.winner) {
      room.paused  = true;
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
server.listen(PORT, () => console.log(`🎯 Dama Oyunu → http://localhost:${PORT}`));
