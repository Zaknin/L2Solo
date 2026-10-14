const assert = require('assert');
const fs = require('fs');
const path = require('path');
const isolated = require('./helpers/isolatedSocialDatabase')('purchase_amount', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);

// E286: an NPC purchase list line with an amount below 1 is refused before
// any payment.
const World = invoke('GameServer/World/World');
const Purchase = invoke('GameServer/Network/Request/Purchase');

const ServerResponse = invoke('GameServer/Network/Response');
ServerResponse.actionFailed = () => ({ kind: 'actionFailed' });

const SHOT = 1835;

function packet(lines) {
    const buffer = Buffer.alloc(9 + lines.length * 8);
    buffer.writeUInt8(0x1f, 0);
    buffer.writeInt32LE(lines.length, 5);
    lines.forEach(([selfId, amount], i) => {
        buffer.writeInt32LE(selfId, 9 + i * 8);
        buffer.writeInt32LE(amount, 13 + i * 8);
    });
    return buffer;
}
const player = () => ({ fetchId: () => 2000005, fetchName: () => 'Player', backpack: { fetchItems: () => [], fetchTotalAdena: () => 0 } });
const kinds = (sent) => sent.map((p) => p?.kind);

async function npcAmounts() {
    const calls = [];
    const original = World.purchaseItems;
    World.purchaseItems = (session, list, options) => { calls.push({ list, options }); };
    try {
        const shops = {
            npc: { activeNpcShop: { itemIds: new Set([SHOT]), prices: new Map([[SHOT, 10]]) } },
            admin: { activeAdminShop: { itemIds: new Set([SHOT]) } },
            none: {}
        };
        for (const [name, shop] of Object.entries(shops)) {
            for (const amount of [0, -1, -2147483648]) {
                const sent = [];
                const session = { actor: player(), dataSendToMe: (p) => sent.push(p), ...shop };
                await Purchase(session, packet([[SHOT, 1], [SHOT, amount]]));
                assert.strictEqual(calls.length, 0, `${name}: amount ${amount} reaches no payment`);
                assert.deepStrictEqual(kinds(sent), ['actionFailed'], `${name}: amount ${amount} gets actionFailed`);
            }
            const sent = [];
            const session = { actor: player(), dataSendToMe: (p) => sent.push(p), ...shops[name] };
            await Purchase(session, packet([[SHOT, 1], [SHOT, 3]]));
            assert.strictEqual(calls.length, 1, `${name}: a valid list still pays`);
            assert.deepStrictEqual(calls[0].list.map((l) => l.amount), [1, 3]);
            calls.length = 0;
        }
    } finally { World.purchaseItems = original; }
}

async function main() {
    try {
        await npcAmounts();
    } finally {
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
    console.log('NPC purchase amount guard OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
