'use strict';
// Simulate the big screen: connect a socket.io client, emit 'lantern-shown' for
// an id (which makes the server mark it appeared + broadcast 'lantern-appeared'),
// and let a test await the appeared broadcast.
const { io } = require('socket.io-client');

function connectScreen(base) {
  const sock = io(base, { transports: ['websocket'], reconnection: false });
  const ready = new Promise((res, rej) => {
    sock.on('connect', res);
    sock.on('connect_error', rej);
  });
  return {
    sock, ready,
    // emit lantern-shown and resolve when the matching lantern-appeared arrives
    showAndWait(id, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('lantern-appeared timeout')), timeoutMs);
        sock.on('lantern-appeared', d => {
          if (d && d.id === id) { clearTimeout(t); resolve(d); }
        });
        sock.emit('lantern-shown', { id });
      });
    },
    // wait for a single 'height-changed' event matching id
    waitHeightChanged(id, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('height-changed timeout')), timeoutMs);
        sock.on('height-changed', d => {
          if (d && d.id === id) { clearTimeout(t); resolve(d); }
        });
      });
    },
    close() { sock.close(); },
  };
}

module.exports = { connectScreen };
