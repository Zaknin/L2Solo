'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

// E270 / E256: a meeting result read from the DB for one character is not
// shown to, or marked on, the character selected next on the same connection.
const presented = { notify: [], result: [] };
for (const [file, exports] of [
    ['PlayerMeetingNotifications', { notify: (session, row) => presented.notify.push(row.id) }],
    ['PlayerBoardWindow', { meetingResult: (session, row) => presented.result.push(row.id) }]
]) {
    const filename = path.join(__dirname, '../src/GameServer/AfkTrade', `${file}.js`);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');

function actor(id) {
    return { fetchId: () => id, isDead: () => false, fetchHp: () => 100,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
}
const session = { actor: actor(5) };
const inventory = [];
let releaseAnchor, anchorAsked = false;
const cancelled = { id: 9, actorA: 5, actorB: 6, state: 'cancelled', locX: 0, locY: 0, locZ: 0 };
const native = {
    recoverTradeMeetings: async () => [],
    fetchTradeMeetingByToken: async token => token === 'switch' ? cancelled : null,
    fetchTradeMeetingForOwner: id => id === 5
        ? new Promise(resolve => { anchorAsked = true; releaseAnchor = resolve; }) : Promise.resolve(null),
    fetchItems: async () => []
};
global.utils = { infoWarn() {} };
global.invoke = name => ({
    Database: native,
    'GameServer/Bot/Population/BotLifeState': { cachedState: () => null,
        subscribeChanges: () => () => {}, subscribeMarketReviewChanges: () => () => {} },
    'GameServer/AfkTrade/AfkTradeService': { subscribeBoardChanges: () => () => {},
        syncOnlineInventory: async id => { inventory.push(id); } },
    'GameServer/World/World': { registeredActorById: id => id === 5 ? { session } : null,
        subscribeUserChanges: () => () => {} }
})[name];

(async () => {
    try {
        await Service.init();
        const pending = Service.accept('switch');
        for (let i = 0; i < 50 && !anchorAsked; i++) await new Promise(resolve => setImmediate(resolve));
        assert(anchorAsked, 'the result waits on the meeting anchor read');
        session.actor = actor(7);
        releaseAnchor({ id: 11, actorA: 5, actorB: 8, state: 'accepted', locX: 10, locY: 20, locZ: 0 });
        await pending;
        assert.equal(session.tradeMeetingPresence, undefined, 'no marker of character 5 is set on the new character');
        assert.deepEqual(presented, { notify: [], result: [] }, 'no meeting result of character 5 reaches the new character');
        assert.deepEqual(inventory, [5], 'the inventory sync stays bound to the meeting character');
        console.log('Meeting result after character switch passed');
    } finally { Service.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
