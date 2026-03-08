const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── GAME STATE ────────────────────────────────────────────────────────────────

const rooms = {};      // roomId → GameRoom
const players = {};    // socketId → { roomId, color, name, avatar, coins, wins }

// ─── BOARD HELPERS ─────────────────────────────────────────────────────────────

function createBoard() {
  // 8x8 board, cells indexed [row][col]
  // 0 = empty, 1 = red piece, 2 = red king, 3 = black piece, 4 = black king
  const board = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = 3; // black pieces top
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = 1; // red pieces bottom
    }
  }
  return board;
}

function cloneBoard(board) {
  return board.map(r => [...r]);
}

function isKing(piece) { return piece === 2 || piece === 4; }
function pieceColor(piece) {
  if (piece === 1 || piece === 2) return 'red';
  if (piece === 3 || piece === 4) return 'black';
  return null;
}
function isEnemy(piece, color) {
  const pc = pieceColor(piece);
  return pc !== null && pc !== color;
}
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

// Get all legal moves for a piece (including captures)
// Returns array of { from, to, captures, board (after move) }
function getPieceMoves(board, r, c, mustCapture = false) {
  const piece = board[r][c];
  const color = pieceColor(piece);
  if (!color) return [];

  const moves = [];
  const king = isKing(piece);

  // Directions: red moves up (negative row), black moves down (positive row)
  let dirs;
  if (king) {
    dirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  } else if (color === 'red') {
    dirs = [[-1,-1],[-1,1]]; // red goes up
  } else {
    dirs = [[1,-1],[1,1]]; // black goes down
  }

  // ── Normal moves (if not mustCapture) ──
  if (!mustCapture) {
    for (const [dr, dc] of dirs) {
      if (king) {
        // King slides multiple squares
        let nr = r + dr, nc = c + dc;
        while (inBounds(nr, nc) && board[nr][nc] === 0) {
          moves.push({ from: [r,c], to: [nr,nc], captures: [], simple: true });
          nr += dr; nc += dc;
        }
      } else {
        const nr = r + dr, nc = c + dc;
        if (inBounds(nr, nc) && board[nr][nc] === 0) {
          moves.push({ from: [r,c], to: [nr,nc], captures: [], simple: true });
        }
      }
    }
  }

  // ── Capture moves ──
  const captureDirs = [[-1,-1],[-1,1],[1,-1],[1,1]]; // all 4 for captures
  function findCaptures(b, pr, pc, visited = new Set()) {
    const key = `${pr},${pc}`;
    const results = [];
    const capDirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
    const pk = isKing(b[pr][pc]);
    const pcol = pieceColor(b[pr][pc]);

    for (const [dr, dc] of capDirs) {
      if (pk) {
        // Slide until enemy, then jump over
        let nr = pr + dr, nc = pc + dc;
        while (inBounds(nr, nc) && b[nr][nc] === 0) { nr += dr; nc += dc; }
        if (!inBounds(nr, nc)) continue;
        const midPiece = b[nr][nc];
        if (!isEnemy(midPiece, pcol)) continue;
        const capR = nr, capC = nc;
        const capKey = `${capR},${capC}`;
        if (visited.has(capKey)) continue;
        // Land any empty after
        let lr = nr + dr, lc = nc + dc;
        while (inBounds(lr, lc) && b[lr][lc] === 0) {
          const nb = cloneBoard(b);
          nb[pr][pc] = 0;
          nb[capR][capC] = 0;
          nb[lr][lc] = b[pr][pc];
          // Promote if reached end
          if (pcol === 'red' && lr === 0) nb[lr][lc] = 2;
          if (pcol === 'black' && lr === 7) nb[lr][lc] = 4;
          const newVisited = new Set(visited);
          newVisited.add(capKey);
          const chains = findCaptures(nb, lr, lc, newVisited);
          if (chains.length === 0) {
            results.push({ from: [pr,pc], to: [lr,lc], captures: [[capR,capC]] });
          } else {
            for (const ch of chains) {
              results.push({ from: [pr,pc], to: ch.to, captures: [[capR,capC], ...ch.captures] });
            }
          }
          lr += dr; lc += dc;
        }
      } else {
        // Normal piece: jump one diagonal
        const mr = pr + dr, mc = pc + dc;
        const lr = pr + 2*dr, lc = pc + 2*dc;
        if (!inBounds(mr, mc) || !inBounds(lr, lc)) continue;
        if (!isEnemy(b[mr][mc], pcol)) continue;
        if (b[lr][lc] !== 0) continue;
        const capKey = `${mr},${mc}`;
        if (visited.has(capKey)) continue;
        const nb = cloneBoard(b);
        nb[pr][pc] = 0;
        nb[mr][mc] = 0;
        nb[lr][lc] = b[pr][pc];
        if (pcol === 'red' && lr === 0) nb[lr][lc] = 2;
        if (pcol === 'black' && lr === 7) nb[lr][lc] = 4;
        const newVisited = new Set(visited);
        newVisited.add(capKey);
        const chains = findCaptures(nb, lr, lc, newVisited);
        if (chains.length === 0) {
          results.push({ from: [pr,pc], to: [lr,lc], captures: [[mr,mc]] });
        } else {
          for (const ch of chains) {
            results.push({ from: [pr,pc], to: ch.to, captures: [[mr,mc], ...ch.captures] });
          }
        }
      }
    }
    return results;
  }

  const caps = findCaptures(board, r, c);
  moves.push(...caps);
  return moves;
}

// Get all moves for a color
function getAllMoves(board, color) {
  const allMoves = [];
  let hasCapture = false;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (pieceColor(board[r][c]) === color) {
        const moves = getPieceMoves(board, r, c);
        const caps = moves.filter(m => m.captures.length > 0);
        if (caps.length > 0) hasCapture = true;
        allMoves.push(...moves);
      }
    }
  }

  // Turkish checkers: capturing is mandatory
  if (hasCapture) return allMoves.filter(m => m.captures.length > 0);
  return allMoves;
}

function applyMove(board, move) {
  const nb = cloneBoard(board);
  const piece = nb[move.from[0]][move.from[1]];
  nb[move.from[0]][move.from[1]] = 0;
  for (const [cr, cc] of move.captures) nb[cr][cc] = 0;
  nb[move.to[0]][move.to[1]] = piece;
  const color = pieceColor(piece);
  if (color === 'red' && move.to[0] === 0) nb[move.to[0]][move.to[1]] = 2;
  if (color === 'black' && move.to[0] === 7) nb[move.to[0]][move.to[1]] = 4;
  return nb;
}

function checkWin(board) {
  let red = 0, black = 0;
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === 1 || board[r][c] === 2) red++;
      if (board[r][c] === 3 || board[r][c] === 4) black++;
    }
  if (red === 0) return 'black';
  if (black === 0) return 'red';
  return null;
}

// ─── BOT LOGIC (Minimax depth 3) ───────────────────────────────────────────────

function evaluate(board, botColor) {
  const enemyColor = botColor === 'red' ? 'black' : 'red';
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const pc = pieceColor(p);
      const king = isKing(p);
      const val = king ? 3 : 1;
      if (pc === botColor) score += val;
      else score -= val;
    }
  }
  return score;
}

function minimax(board, depth, maximizing, botColor, alpha, beta) {
  const enemyColor = botColor === 'red' ? 'black' : 'red';
  const win = checkWin(board);
  if (win) return win === botColor ? 1000 : -1000;
  if (depth === 0) return evaluate(board, botColor);

  const color = maximizing ? botColor : enemyColor;
  const moves = getAllMoves(board, color);
  if (moves.length === 0) return maximizing ? -1000 : 1000;

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      const nb = applyMove(board, m);
      const val = minimax(nb, depth - 1, false, botColor, alpha, beta);
      best = Math.max(best, val);
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const nb = applyMove(board, m);
      const val = minimax(nb, depth - 1, true, botColor, alpha, beta);
      best = Math.min(best, val);
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function getBotMove(board, botColor) {
  const moves = getAllMoves(board, botColor);
  if (moves.length === 0) return null;

  let bestVal = -Infinity;
  let bestMove = null;
  // Add slight randomness at equal scores
  const shuffled = moves.sort(() => Math.random() - 0.5);
  for (const m of shuffled) {
    const nb = applyMove(board, m);
    const val = minimax(nb, 3, false, botColor, -Infinity, Infinity);
    if (val > bestVal) { bestVal = val; bestMove = m; }
  }
  return bestMove;
}

// ─── ROOM MANAGEMENT ───────────────────────────────────────────────────────────

function createRoom(hostId, hostName, hostAvatar) {
  const roomId = uuidv4().slice(0, 6).toUpperCase();
  rooms[roomId] = {
    id: roomId,
    host: hostId,
    players: { red: hostId, black: null },
    names: { red: hostName, black: 'Waiting...' },
    avatars: { red: hostAvatar, black: null },
    board: createBoard(),
    turn: 'black', // black goes first (top)
    status: 'waiting', // waiting | playing | finished
    botMode: false,
    botColor: null,
    winner: null,
    combo: { red: 0, black: 0 },
    coins: { red: 0, black: 0 },
    chat: [],
  };
  return roomId;
}

function getPublicRooms() {
  return Object.values(rooms)
    .filter(r => r.status === 'waiting')
    .map(r => ({ id: r.id, host: r.names.red, players: r.players.black ? 2 : 1 }));
}

// ─── SOCKET EVENTS ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // ── JOIN / CREATE ROOM ──
  socket.on('createRoom', ({ name, avatar }) => {
    const roomId = createRoom(socket.id, name, avatar);
    players[socket.id] = { roomId, color: 'red', name, avatar, coins: 0, wins: 0 };
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, color: 'red' });
    io.emit('roomList', getPublicRooms());
  });

  socket.on('joinRoom', ({ roomId, name, avatar }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.status !== 'waiting') return socket.emit('error', 'Game already started');
    if (room.players.black) return socket.emit('error', 'Room is full');

    room.players.black = socket.id;
    room.names.black = name;
    room.avatars.black = avatar;
    room.status = 'playing';

    players[socket.id] = { roomId, color: 'black', name, avatar, coins: 0, wins: 0 };
    socket.join(roomId);

    io.to(roomId).emit('gameStart', {
      board: room.board,
      turn: room.turn,
      names: room.names,
      avatars: room.avatars,
      colors: { [room.players.red]: 'red', [room.players.black]: 'black' }
    });
    io.emit('roomList', getPublicRooms());
  });

  socket.on('getRooms', () => {
    socket.emit('roomList', getPublicRooms());
  });

  // ── BOT MODE ──
  socket.on('enableBot', () => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room) return;

    const botColor = p.color === 'red' ? 'black' : 'red';
    room.botMode = true;
    room.botColor = botColor;
    room.players[botColor] = 'BOT';
    room.names[botColor] = 'Bot';
    room.avatars[botColor] = null;
    room.status = 'playing';

    io.to(p.roomId).emit('gameStart', {
      board: room.board,
      turn: room.turn,
      names: room.names,
      avatars: room.avatars,
      colors: { [socket.id]: p.color },
      botMode: true,
      botColor
    });

    // If bot goes first
    if (room.turn === botColor) scheduleBotMove(p.roomId);
  });

  // ── PLAYER MOVE ──
  socket.on('playerMove', ({ from, to }) => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room || room.status !== 'playing') return;
    if (room.turn !== p.color) return socket.emit('error', 'Not your turn');

    // Validate move
    const legalMoves = getAllMoves(room.board, p.color);
    const match = legalMoves.find(m =>
      m.from[0] === from[0] && m.from[1] === from[1] &&
      m.to[0] === to[0] && m.to[1] === to[1]
    );
    if (!match) return socket.emit('illegalMove', 'Illegal move');

    // Apply
    room.board = applyMove(room.board, match);

    // Combo
    if (match.captures.length > 0) {
      room.combo[p.color]++;
    } else {
      room.combo[p.color] = 0;
    }

    // Check win
    const win = checkWin(room.board);
    if (win) {
      room.status = 'finished';
      room.winner = win;
      room.coins[win] += 10;
      io.to(p.roomId).emit('gameEnd', { winner: win, board: room.board });
      return;
    }

    // Switch turn
    room.turn = room.turn === 'red' ? 'black' : 'red';

    io.to(p.roomId).emit('boardUpdate', {
      board: room.board,
      turn: room.turn,
      lastMove: match,
      combo: room.combo
    });

    // Bot's turn?
    if (room.botMode && room.turn === room.botColor) {
      scheduleBotMove(p.roomId);
    }
  });

  // ── GET LEGAL MOVES ──
  socket.on('getLegalMoves', ({ row, col }) => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room) return;
    if (room.turn !== p.color) return socket.emit('legalMoves', []);

    const allMoves = getAllMoves(room.board, p.color);
    const pieceMoves = allMoves.filter(m => m.from[0] === row && m.from[1] === col);
    socket.emit('legalMoves', pieceMoves.map(m => ({ to: m.to, captures: m.captures })));
  });

  // ── CHAT ──
  socket.on('chatMessage', ({ text }) => {
    const p = players[socket.id];
    if (!p) return;
    const room = rooms[p.roomId];
    if (!room) return;
    const msg = { name: p.name, text, color: p.color, time: Date.now() };
    room.chat.push(msg);
    io.to(p.roomId).emit('chatMessage', msg);
  });

  // ── REACTION ──
  socket.on('reaction', ({ emoji }) => {
    const p = players[socket.id];
    if (!p) return;
    io.to(p.roomId).emit('reaction', { color: p.color, emoji });
  });

  // ── FUN BUTTONS ──
  socket.on('funAction', ({ action }) => {
    const p = players[socket.id];
    if (!p) return;
    io.to(p.roomId).emit('funAction', { color: p.color, action });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      const room = rooms[p.roomId];
      if (room && room.status === 'playing') {
        const winColor = p.color === 'red' ? 'black' : 'red';
        room.status = 'finished';
        io.to(p.roomId).emit('gameEnd', { winner: winColor, board: room.board, reason: 'disconnect' });
      }
      delete players[socket.id];
    }
    console.log('Disconnected:', socket.id);
    io.emit('roomList', getPublicRooms());
  });
});

// ─── BOT SCHEDULER ─────────────────────────────────────────────────────────────

function scheduleBotMove(roomId) {
  const delay = 800 + Math.random() * 1200; // 0.8–2s
  setTimeout(() => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing' || !room.botMode) return;
    if (room.turn !== room.botColor) return;

    const move = getBotMove(room.board, room.botColor);
    if (!move) {
      // Bot can't move → player wins
      const win = room.botColor === 'red' ? 'black' : 'red';
      room.status = 'finished';
      room.winner = win;
      io.to(roomId).emit('gameEnd', { winner: win, board: room.board });
      return;
    }

    room.board = applyMove(room.board, move);
    if (move.captures.length > 0) room.combo[room.botColor]++;
    else room.combo[room.botColor] = 0;

    const win = checkWin(room.board);
    if (win) {
      room.status = 'finished';
      room.winner = win;
      io.to(roomId).emit('gameEnd', { winner: win, board: room.board });
      return;
    }

    room.turn = room.turn === 'red' ? 'black' : 'red';
    io.to(roomId).emit('boardUpdate', {
      board: room.board,
      turn: room.turn,
      lastMove: move,
      combo: room.combo,
      botMove: true
    });

    // Chain bot capture
    if (room.turn === room.botColor) scheduleBotMove(roomId);
  }, delay);
}

// ─── START ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Checkers server running on http://localhost:${PORT}`));
