const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const waitingPlayers = [];
const rooms = {};

function createInitialBoard() {
  const board = Array(8).fill(null).map(() => Array(8).fill(null));
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 8; col++)
      if ((row + col) % 2 === 1) board[row][col] = { color: 'pink', isKing: false };
  for (let row = 5; row < 8; row++)
    for (let col = 0; col < 8; col++)
      if ((row + col) % 2 === 1) board[row][col] = { color: 'blue', isKing: false };
  return board;
}

function getCaptures(board, row, col, color, isKing) {
  const caps = [];
  let dirs = color === 'pink' ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];
  if (isKing) dirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr,dc] of dirs) {
    if (isKing) {
      for (let d=1;d<8;d++) {
        const nr=row+dr*d, nc=col+dc*d;
        if (nr<0||nr>7||nc<0||nc>7) break;
        if (board[nr][nc]) {
          if (board[nr][nc].color !== color) {
            const jr=nr+dr, jc=nc+dc;
            if (jr>=0&&jr<=7&&jc>=0&&jc<=7&&!board[jr][jc]) caps.push({to:[jr,jc],captured:[[nr,nc]]});
          }
          break;
        }
      }
    } else {
      const nr=row+dr, nc=col+dc;
      if (nr>=0&&nr<=7&&nc>=0&&nc<=7&&board[nr][nc]&&board[nr][nc].color!==color) {
        const jr=nr+dr, jc=nc+dc;
        if (jr>=0&&jr<=7&&jc>=0&&jc<=7&&!board[jr][jc]) caps.push({to:[jr,jc],captured:[[nr,nc]]});
      }
    }
  }
  return caps;
}

function getValidMoves(board, row, col, mustCapture) {
  const piece = board[row][col];
  if (!piece) return [];
  const { color, isKing } = piece;
  const caps = getCaptures(board, row, col, color, isKing);
  if (caps.length > 0) return caps;
  if (mustCapture) return [];
  const moves = [];
  let dirs = color === 'pink' ? [[1,-1],[1,1]] : [[-1,-1],[-1,1]];
  if (isKing) dirs = [[-1,-1],[-1,1],[1,-1],[1,1]];
  for (const [dr,dc] of dirs) {
    if (isKing) {
      for (let d=1;d<8;d++) {
        const nr=row+dr*d, nc=col+dc*d;
        if (nr<0||nr>7||nc<0||nc>7) break;
        if (board[nr][nc]) break;
        moves.push({to:[nr,nc],captured:[]});
      }
    } else {
      const nr=row+dr, nc=col+dc;
      if (nr>=0&&nr<=7&&nc>=0&&nc<=7&&!board[nr][nc]) moves.push({to:[nr,nc],captured:[]});
    }
  }
  return moves;
}

function hasAnyCapture(board, color) {
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (board[r][c]&&board[r][c].color===color&&getCaptures(board,r,c,board[r][c].color,board[r][c].isKing).length>0) return true;
  return false;
}

function getAllValidMoves(board, color) {
  const mc = hasAnyCapture(board, color);
  const all = {};
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (board[r][c]&&board[r][c].color===color) {
      const mvs = getValidMoves(board,r,c,mc);
      if (mvs.length>0) all[`${r},${c}`]=mvs;
    }
  return all;
}

function checkWinner(board) {
  let p=0,b=0;
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (board[r][c]) board[r][c].color==='pink'?p++:b++;
  if (p===0) return 'blue';
  if (b===0) return 'pink';
  return null;
}

io.on('connection', (socket) => {
  socket.on('findMatch', ({ name, gender }) => {
    socket.playerName = name;
    socket.playerGender = gender;
    socket.playerColor = gender === 'female' ? 'pink' : 'blue';

    if (waitingPlayers.length > 0) {
      const opp = waitingPlayers.shift();
      // Assign colors: respect gender preference, but if clash, give second player the opposite
      let c1 = opp.playerColor;
      let c2 = socket.playerColor;
      if (c1 === c2) {
        // Second player gets the opposite color
        c2 = c1 === 'pink' ? 'blue' : 'pink';
      }
      const roomId = `room_${Date.now()}`;
      const board = createInitialBoard();
      // Blue always moves first (blue pieces start at rows 5-7, move upward toward row 0)
      const firstTurn = 'blue';
      rooms[roomId] = {
        players: [
          {id:opp.id, name:opp.playerName, color:c1, gender:opp.playerGender},
          {id:socket.id, name:socket.playerName, color:c2, gender:socket.playerGender}
        ],
        board, turn: firstTurn,
        capturedPieces: {pink:[], blue:[]},
        paused: false, pausedBy: null,
        validMoves: getAllValidMoves(board, firstTurn)
      };
      opp.join(roomId); socket.join(roomId);
      const room = rooms[roomId];
      io.to(opp.id).emit('gameStart', {roomId,color:c1,opponentName:socket.playerName,opponentGender:socket.playerGender,board,turn:firstTurn,validMoves:room.validMoves,players:room.players});
      io.to(socket.id).emit('gameStart', {roomId,color:c2,opponentName:opp.playerName,opponentGender:opp.playerGender,board,turn:firstTurn,validMoves:room.validMoves,players:room.players});
    } else {
      waitingPlayers.push(socket);
      socket.emit('waiting');
    }
  });

  socket.on('makeMove', ({ roomId, from, to, captured }) => {
    const room = rooms[roomId];
    if (!room || room.paused) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.color !== room.turn) return;
    const [fr,fc]=from, [tr,tc]=to;
    const piece = room.board[fr][fc];
    if (!piece) return;
    room.board[tr][tc] = {...piece};
    room.board[fr][fc] = null;
    const capList = captured||[];
    capList.forEach(([cr,cc]) => { if(room.board[cr][cc]){room.capturedPieces[player.color].push({...room.board[cr][cc]});room.board[cr][cc]=null;} });
    let becameKing = false;
    if (piece.color==='pink'&&tr===7){room.board[tr][tc].isKing=true;becameKing=true;}
    if (piece.color==='blue'&&tr===0){room.board[tr][tc].isKing=true;becameKing=true;}
    let canContinue = false;
    if (capList.length>0&&!becameKing) {
      const more = getCaptures(room.board,tr,tc,piece.color,room.board[tr][tc].isKing);
      if (more.length>0) { canContinue=true; room.validMoves={[`${tr},${tc}`]:more}; }
    }
    if (!canContinue) { room.turn=room.turn==='pink'?'blue':'pink'; room.validMoves=getAllValidMoves(room.board,room.turn); }
    const winner = checkWinner(room.board);
    io.to(roomId).emit('boardUpdate', {board:room.board,turn:room.turn,validMoves:room.validMoves,capturedPieces:room.capturedPieces,lastMove:{from,to,captured:capList,color:player.color},winner,canContinue,continueFrom:canContinue?[tr,tc]:null});
  });

  socket.on('chatMessage', ({roomId,message,name}) => io.to(roomId).emit('chatMessage',{name,message,id:socket.id}));
  socket.on('sendEmoji', ({roomId,emoji,name}) => io.to(roomId).emit('emojiReaction',{emoji,name,id:socket.id}));
  socket.on('startVideo', ({roomId,videoUrl,name}) => io.to(roomId).emit('videoStarted',{videoUrl,name}));

  socket.on('playerPaused', ({roomId,name}) => {
    const room=rooms[roomId];
    if(room){room.paused=true;room.pausedBy=name;io.to(roomId).emit('gamePaused',{name});}
  });

  socket.on('playerResumed', ({roomId}) => {
    const room=rooms[roomId];
    if(room){room.paused=false;room.pausedBy=null;io.to(roomId).emit('gameResumed');}
  });

  socket.on('rejoinGame', ({roomId,name}) => {
    const room=rooms[roomId];
    if(!room){
      socket.emit('rejoinFailed');
      return;
    }
    socket.join(roomId);
    const player=room.players.find(p=>p.name===name);
    if(player){
      player.id=socket.id;
      socket.emit('gameRejoin',{board:room.board,turn:room.turn,validMoves:room.validMoves,capturedPieces:room.capturedPieces,color:player.color,players:room.players,paused:room.paused});
      if(room.paused){room.paused=false;io.to(roomId).emit('gameResumed');io.to(roomId).emit('playerRejoined',{name});}
    } else {
      socket.emit('rejoinFailed');
    }
  });

  socket.on('disconnect', () => {
    const idx=waitingPlayers.findIndex(p=>p.id===socket.id);
    if(idx!==-1) waitingPlayers.splice(idx,1);
    for(const roomId in rooms){
      const room=rooms[roomId];
      const player=room.players.find(p=>p.id===socket.id);
      if(player){
        room.paused=true;room.pausedBy=player.name;
        io.to(roomId).emit('gamePaused',{name:player.name,disconnected:true});
        setTimeout(()=>{if(rooms[roomId]&&rooms[roomId].paused)delete rooms[roomId];},600000);
        break;
      }
    }
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT,()=>console.log(`3D Checkers running on port ${PORT}`));
