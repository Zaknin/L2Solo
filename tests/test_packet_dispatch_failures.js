const assert = require('assert');
const EventEmitter = require('events');

require('../src/Global');

const Server = require('../src/Server');

// Nothing may reach the process-wide rejection path: on Node 22 it ends the
// whole server. Record instead of exiting so each case can be asserted.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

function frame(payload) {
    const result = Buffer.alloc(payload.length + 2);
    result.writeUInt16LE(result.length, 0);
    Buffer.from(payload).copy(result, 2);
    return result;
}

function fakeSocket() {
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.remotePort = 1;
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    return socket;
}

// The real connection wiring, without opening a listening port.
function connect(dataReceive) {
    const socket = fakeSocket();
    const session = { received: [], dataReceive, error() {} };
    Server.prototype.onSocket.call({ name: 'Test', callback: () => session }, socket);
    return { socket, session };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
    {
        // L84: a handler throws on the first packet of a chunk; the second
        // packet of the same chunk must not reach the dropped session.
        const { socket, session } = connect(function (packet) {
            this.received.push(packet[2]);
            if (packet[2] === 0x01) throw new Error('bad packet');
        });

        socket.emit('data', Buffer.concat([frame([0x01]), frame([0x02])]));

        assert.deepStrictEqual(session.received, [0x01], 'no packet is dispatched after the connection was dropped');
        assert.strictEqual(socket.destroyed, true, 'the failing connection is dropped');
    }

    {
        // Normal path: every packet of a chunk is still dispatched.
        const { socket, session } = connect(function (packet) {
            this.received.push(packet[2]);
        });

        socket.emit('data', Buffer.concat([frame([0x01]), frame([0x02])]));

        assert.deepStrictEqual(session.received, [0x01, 0x02], 'healthy packets of one chunk are all dispatched');
        assert.strictEqual(socket.destroyed, false);
    }

    await settle();
    assert.deepStrictEqual(unhandled, [], 'no rejection escapes the connection boundary');
    console.log('packet dispatch failure handling ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
