const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

let gameState = {
  players: {},
  grid: null, // Initialized when first player joins
};

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('join_game', (data) => {
    // Assign player to a team/ID
    const playerNumber = Object.keys(gameState.players).length + 1;
    if (playerNumber > 4) return socket.emit('error', 'Room full');

    gameState.players[socket.id] = {
      id: playerNumber,
      name: data.name || `Player ${playerNumber}`,
      socketId: socket.id
    };

    // Send current state and assigned ID back to player
    socket.emit('init_player', { playerId: playerNumber });
    io.emit('player_joined', gameState.players);
  });

  socket.on('paint_action', (data) => {
    // Data contains { tiles: [{x, y}], colorId }
    // Broadcast the paint action to all other clients
    socket.broadcast.emit('remote_paint', data);
  });

  socket.on('build_action', (data) => {
    // Data contains { type, x, y, ownerId }
    socket.broadcast.emit('remote_build', data);
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('player_left', socket.id);
  });
});

server.listen(3000, () => console.log('Server running on port 3000'));