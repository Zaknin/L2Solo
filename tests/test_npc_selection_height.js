const assert = require('node:assert/strict');
require('../src/Global');

const select = invoke('GameServer/Actor/Generics/Select');
const World = invoke('GameServer/World/World');
const Manager = invoke('GameServer/Bot/BotManager');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Generics = invoke('GameServer/Actor/Generics');
const original = { fetchNpc: World.fetchNpc, items: World.items, user: World.user, sessions: Manager.sessions,
    findProjection: AfkTrade.findProjection, attackRequest: Generics.attackRequest };

(async () => {
    const npc = { z: -3680, fetchId: () => 1037718, fetchLevel: () => 50,
        fetchLocZ() { return this.z; }, setLocZ(z) { this.z = z; } };
    let attacks = 0;
    const packets = [], vitals = [];
    try {
        Manager.sessions = [];
        AfkTrade.findProjection = () => null;
        World.fetchNpc = async () => npc;
        Generics.attackRequest = () => { attacks++; };
        for (const accountId of ['player_height', 'bot_height']) {
            for (const z of [-12096, -3704, 256]) {
                const attacksBefore = attacks;
                const actor = { destId: null, fetchId: () => 2004242, fetchLevel: () => 45,
                    fetchLocZ: () => z, fetchDestId() { return this.destId; },
                    setDestId(id) { this.destId = id; }, statusUpdateVitals(target) { vitals.push(target); } };
                const session = { actor, accountId, dataSendToMe(packet) { packets.push(packet); } };
                select(session, actor, { id: npc.fetchId() });
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(actor.fetchDestId(), npc.fetchId(), 'First click must select the NPC');
                assert.equal(npc.fetchLocZ(), -3680, 'Selection must preserve the NPC floor even when the selector is on another layer');
                assert.equal(vitals.at(-1), npc, 'Selection must still show the NPC vitals');
                assert.equal(packets.at(-1).readInt32LE(1), npc.fetchId());
                assert.equal(attacks, attacksBefore, 'First click must not issue an attack');
                select(session, actor, { id: npc.fetchId() });
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(attacks, attacksBefore + (accountId.startsWith('bot_') ? 0 : 1));
            }
        }
        assert.equal(attacks, 3, 'Player double clicks must still attack; repeated bot selection must not');

        // An id no lookup knows (a ground item already picked up, a door id):
        // the C4 client waits for an answer to Action and freezes without one.
        World.fetchNpc = async () => { throw new Error('npc_not_found'); };
        World.items = { spawns: [] };
        World.user = { sessions: [], revision: 0 };
        const clicker = { destId: null, fetchId: () => 2004243, fetchDestId() { return this.destId; },
            setDestId(id) { this.destId = id; } };
        const clickPackets = [];
        select({ actor: clicker, accountId: 'player_ghost', dataSendToMe(packet) { clickPackets.push(packet); } },
            clicker, { id: 700009 });
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(clickPackets.map(packet => packet[0]), [0x25], 'A click on an unknown id must answer ActionFailed');
    } finally {
        World.fetchNpc = original.fetchNpc;
        World.items = original.items;
        World.user = original.user;
        Manager.sessions = original.sessions;
        AfkTrade.findProjection = original.findProjection;
        Generics.attackRequest = original.attackRequest;
    }
    console.log('NPC selection preserves position and click behavior');
})().catch(error => { console.error(error); process.exitCode = 1; });
