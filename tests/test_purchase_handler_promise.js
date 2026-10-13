const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('purchase_promise', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

// The packet layer (Server.js) drops the connection when a handler's
// Promise rejects, but only if the handler returns that Promise. An
// unobserved rejection ends the whole server under Node 22.
const purchase = invoke('GameServer/Network/Request/Purchase');

function packet(lines) {
    const buffer = Buffer.alloc(1 + 8 + lines.length * 8);
    buffer.writeUInt8(0x1f, 0);
    buffer.writeInt32LE(0, 1);
    buffer.writeInt32LE(lines.length, 5);
    lines.forEach(([selfId, amount], index) => {
        buffer.writeInt32LE(selfId, 9 + index * 8);
        buffer.writeInt32LE(amount, 13 + index * 8);
    });
    return buffer;
}

async function main() {
    const unhandled = [];
    const listener = error => unhandled.push(error?.message || String(error));
    process.on('unhandledRejection', listener);
    try {
        // A purchase packet from a connection without a character: the
        // handler fails outside its trade try block.
        const session = { actor: null, dataSendToMe() {} };
        const result = purchase(session, packet([[1060, 1]]));
        assert(result && typeof result.then === 'function', 'the purchase handler returns its Promise to the packet layer');
        await assert.rejects(result);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(unhandled, [], 'no unobserved rejection');
    } finally {
        process.off('unhandledRejection', listener);
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
    console.log('Purchase handler returns its Promise');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
