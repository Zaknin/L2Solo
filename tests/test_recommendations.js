const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-recommendations');
require('../src/Global');
fixture.assertConfigured(options.default);
invoke('GameServer/DataCache').init();
const Database = invoke('Database');
const Rules = require('../src/GameServer/Recommendations/Rules');
const Runtime = invoke('GameServer/Recommendations/Runtime');
const Response = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const realNow = Date.now;
let at = Rules.day(realNow()) * Rules.DAY_MS + 3600000;
Date.now = () => at;
const sql = (query, args = []) => Database.execute([query, args]);
const get = async id => (await sql('SELECT * FROM characters WHERE id=?', [id]))[0];
async function seed(id, level = 40, bot = false) {
    const username = `${bot ? 'bot_' : 'user_'}recommend_${id}`;
    await sql('INSERT INTO accounts(username,password) VALUES (?,?)', [username, 'fixture']);
    await sql(`INSERT INTO characters(id,username,name,level,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, username, `Recommender${id}`, level]);
    if (bot) await sql(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,updatedAt,statsJson)
        VALUES (?,?,?,?,'cold','hunting',?,'{}')`, [id, username, `Recommender${id}`, level, at]);
}
async function event(key, sourceId, targetId, type = 'hunted_together', extra = {}) {
    const result = await Database.commitInteractionMemory([{ key, sourceId, targetId, type, at, ...extra }]);
    assert.equal(result.ok, true);
    return result;
}
async function main() {
    Database.init();
    for (const [id, level] of [[1, 9], [2, 10], [3, 19], [4, 20], [5, 39], [6, 40], [7, 80], [8, 1], [9, 40], [10, 40]]) await seed(id, level);
    assert.deepEqual((await Database.refreshRecommendations([1, 2, 3, 4, 5, 6, 7])).map(row => row.recRemain), [0, 3, 3, 6, 6, 9, 9]);
    assert.equal((await Database.giveRecommendation(1, 8)).code, 'level');
    assert.equal((await Database.giveRecommendation(2, 2)).code, 'self');
    assert.equal((await Database.giveRecommendation(2, 999)).code, 'invalid_target');
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => Database.giveRecommendation(2, 8)));
    assert.equal(concurrent.filter(result => result.ok).length, 1, 'one atomic success for concurrent same-pair packets');
    assert.equal((await get(8)).evalScore, 1, 'a level-one character can receive recommendations');
    assert.equal((await get(2)).recRemain, 2);
    await Database.close(); Database.init();
    assert.equal((await Database.giveRecommendation(2, 8)).code, 'duplicate', 'restart and relog preserve the pair restriction');
    assert.equal((await Database.giveRecommendation(8, 2)).code, 'level');
    assert.equal((await Database.giveRecommendation(2, 9)).ok, true);
    assert.equal((await Database.giveRecommendation(2, 10)).ok, true);
    assert.equal((await Database.giveRecommendation(2, 6)).code, 'exhausted');
    await sql('UPDATE characters SET evalScore=255 WHERE id=7');
    assert.equal((await Database.giveRecommendation(6, 7)).code, 'full');
    assert.equal((await get(6)).recRemain, 9, 'failed grants spend nothing');
    // The final recipient slot is also serialized across different givers.
    await sql('UPDATE characters SET evalScore=254 WHERE id=7');
    assert.equal((await Promise.all([Database.giveRecommendation(4, 7), Database.giveRecommendation(5, 7)]))
        .filter(result => result.ok).length, 1);
    assert.equal((await get(7)).evalScore, 255);
    await sql('UPDATE characters SET evalScore=10 WHERE id IN (3,4,6)');
    at = (Rules.day(at) + 1) * Rules.DAY_MS;
    const reset = await Database.refreshRecommendations([2, 3, 4, 6]);
    assert.deepEqual(reset.map(row => row.recRemain), [3, 3, 6, 9]);
    assert.deepEqual(reset.slice(1).map(row => row.evalScore), [9, 8, 7]);
    assert.equal((await Database.giveRecommendation(2, 8)).ok, true, 'same pair is eligible on the next real day');
    assert.equal((await Database.refreshRecommendations([6]))[0].evalScore, 7, 'repeated reads never repeat decay');
    at += 3 * Rules.DAY_MS;
    assert.equal((await Database.refreshRecommendations([6]))[0].evalScore, 0, 'offline real days decay to zero');
    const later = at;
    await Database.refreshRecommendations([2]);
    at -= Rules.DAY_MS;
    assert.equal((await Database.refreshRecommendations([2]))[0].recDay, Rules.day(later), 'backwards clock cannot reopen a day');
    at = later;
    await sql('UPDATE characters SET level=10 WHERE id=1');
    assert.equal((await Database.refreshRecommendations([1]))[0].recRemain, 3, 'reaching level ten grants the day allowance');
    const levelActor = new (invoke('GameServer/Model/Actor'))({ ...(await get(1)), level: 19, recSpent: 1 });
    assert.equal(levelActor.fetchRecRemain(), 2);
    levelActor.setLevel(20);
    assert.equal(levelActor.fetchRecRemain(), 5, 'native level-up packets immediately reflect the new allowance');
    // Native transaction rollback must roll back both counters and the durable pair.
    await sql(`CREATE TRIGGER reject_recommendation BEFORE UPDATE OF evalScore ON characters
        WHEN NEW.id=10 AND NEW.evalScore>OLD.evalScore BEGIN SELECT RAISE(ABORT,'fixture refusal'); END`);
    const before = await get(9);
    await assert.rejects(Database.giveRecommendation(9, 10), /fixture refusal/);
    assert.equal((await get(9)).recSpent, before.recSpent);
    assert.equal((await sql('SELECT * FROM character_recommendations WHERE sourceId=9 AND targetId=10')).length, 0);
    await sql('DROP TRIGGER reject_recommendation');

    for (let id = 20; id <= 27; id++) await seed(id, 40, true);
    // Three actual, cooldown-admitted hunt episodes span one hour. A relog
    // between episodes cannot lose or accelerate that durable progress.
    await event('hunt:first', 20, 21, 'hunted_together', { huntMs: 0 });
    assert.equal((await get(21)).evalScore, 0);
    at += 30 * 60000;
    await event('hunt:second', 20, 21, 'hunted_together', { huntMs: 30 * 60000 });
    await Database.close(); Database.init();
    at += 30 * 60000;
    await event('hunt:third', 20, 21, 'hunted_together', { huntMs: 30 * 60000 });
    assert.equal((await get(21)).evalScore, 1);
    assert.equal((await event('hunt:third', 20, 21, 'hunted_together', { huntMs: 30 * 60000 })).statuses[0], 'duplicate');
    assert.equal((await get(21)).evalScore, 1);
    await event('hunt:interrupted1', 22, 23);
    at += 2 * 3600000;
    await event('hunt:interrupted2', 22, 23);
    assert.equal((await get(23)).evalScore, 0, 'a long interruption does not count as time spent hunting');
    // Good relationships alone can motivate a recommendation; hostile history cannot.
    for (let n = 0; n < 5; n++) await event(`friend:${n}`, 24, 25, 'gave_useful_loot');
    assert.equal((await get(25)).evalScore, 1);
    for (let n = 0; n < 4; n++) await event(`hostile:${n}`, 26, 27, 'attacked');
    for (let n = 0; n < 5; n++) await event(`hostile:gift:${n}`, 26, 27, 'gift');
    assert.equal((await get(27)).evalScore, 0);
    // A rejected cold proposal produces neither social evidence nor a recommendation.
    const cold = await Database.commitAndReleaseColdSimulationLeases([{ characterId: 20, expectedRevision: 999,
        timestamp: at, patch: { phase: 'cold', activity: 'hunting' },
        memoryEvents: [{ key: 'cold:stale', sourceId: 20, targetId: 23, type: 'gift', at }] }]);
    assert.equal(cold[0].ok, false);
    assert.equal((await get(23)).evalScore, 0);

    await seed(40, 40, true); await seed(41, 40, true);
    const coldGift = revision => Database.commitAndReleaseColdSimulationLeases([{ characterId: 40, expectedRevision: revision,
        timestamp: at, patch: { phase: 'cold', activity: 'hunting' },
        memoryEvents: [{ key: `cold:friend:${revision}`, sourceId: 40, targetId: 41, type: 'gave_useful_loot', at }] }]);
    for (let n = 0; n < 3; n++) assert.equal((await coldGift(n))[0].ok, true);
    await sql(`CREATE TRIGGER reject_cold_recommendation BEFORE UPDATE OF evalScore ON characters
        WHEN NEW.id=41 AND NEW.evalScore>OLD.evalScore BEGIN SELECT RAISE(ABORT,'cold fixture refusal'); END`);
    await assert.rejects(coldGift(3), /cold fixture refusal/);
    assert.equal((await sql('SELECT simulationRevision FROM bot_life_state WHERE characterId=40'))[0].simulationRevision, 3,
        'recommendation failure also rolls back the enclosing cold outcome');
    await sql('DROP TRIGGER reject_cold_recommendation');
    assert.equal((await coldGift(3))[0].ok, true);
    assert.equal((await get(41)).evalScore, 1, 'accepted cold evidence awards through the same transaction');
    assert.equal((await coldGift(3))[0].ok, false);
    assert.equal((await get(41)).evalScore, 1);

    // A completed physical purchase fulfils the bot's active equipment need.
    await sql(`UPDATE bot_life_state SET statsJson=? WHERE characterId=22`, [JSON.stringify({ equipmentPlan: { status: 'active', target: { selfId: 1 } } })]);
    await sql("INSERT INTO items(characterId,selfId,name,amount,enchant,equipped,slot) VALUES (22,57,'Adena',1000,0,0,0)");
    const stock = await sql("INSERT INTO items(characterId,selfId,name,amount,enchant,equipped,slot) VALUES (23,1,'Short Sword',2,0,0,0)");
    const objectId = Number(stock.insertId);
    await Database.buyFromLivePrivateStore(22, { sellerId: 23, selfId: 1, objectId, amount: 1, price: 100, validate() {} });
    assert.equal((await get(23)).evalScore, 1, 'needed completed trade earns a recommendation');
    await Database.buyFromLivePrivateStore(22, { sellerId: 23, selfId: 1, objectId, amount: 1, price: 100, validate() {} });
    assert.equal((await get(23)).evalScore, 1, 'repeated useful trades obey the same daily pair cap');
    await assert.rejects(Database.buyFromLivePrivateStore(22, { sellerId: 23, selfId: 1, objectId, amount: 1, price: 100, validate() {} }), /stock_changed/);

    await seed(30, 40, true); await seed(31, 40, true); await seed(32, 40, true);
    await sql("INSERT INTO clans(id,name,leaderId) VALUES (1,'RecommendationClan',32)");
    await sql('UPDATE characters SET clanId=1 WHERE id IN (30,31,32)');
    for (let n = 0; n < 5; n++) await event(`clan:friend:${n}`, 30, 31, 'gave_useful_loot');
    assert.equal((await get(31)).evalScore, 1);
    assert.equal((await get(32)).evalScore, 1, 'clan leader receives a separate recommendation');
    assert.equal((await get(30)).recRemain, 7, 'leader support spends the same daily allowance');

    // Route the real 0xb9 packet, invalid selection, stale session and 0x28
    // through one service, and verify native typed system messages.
    const originalLookup = World.registeredActorById, originalUser = Response.userInfo, originalChar = Response.charInfo;
    const sessions = new Map();
    function nativeActor(row) {
        const actor = { model: row, fetchId: () => row.id, fetchDestId: () => row.destId,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchIsOnline: () => true, isDead: () => false };
        const packets = [], others = [];
        const session = { actor, dataSendToMe: packet => packets.push(packet), dataSendToOthers: packet => others.push(packet), packets, others };
        actor.session = session; session.registration = { id: row.id, actor, session, retired: false };
        sessions.set(row.id, session); return actor;
    }
    try {
        const a = nativeActor(await get(9)), b = nativeActor(await get(10));
        a.model.destId = 10;
        World.registeredActorById = id => sessions.get(id)?.registration || null;
        Response.userInfo = actor => Buffer.from([4, actor.model.recRemain, actor.model.evalScore]);
        Response.charInfo = actor => Buffer.from([3, actor.model.recRemain, actor.model.evalScore]);
        await Runtime.refresh(a); await Runtime.refresh(b);
        const packet = Buffer.alloc(5); packet[0] = 0xb9; packet.writeInt32LE(10, 1);
        assert.equal((await invoke('GameServer/Network/Opcodes').table[0xb9](a.session, packet)).ok, true);
        assert(a.session.packets.some(packet => packet[0] === 4));
        assert(b.session.others.some(packet => packet[0] === 3), 'received score is broadcast to observers');
        const confirmation = a.session.packets.find(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 830);
        const numberOffset = 13 + Buffer.byteLength(`${b.model.name}\0`, 'ucs2');
        assert.equal(confirmation.readInt32LE(numberOffset), 1, 'remaining allowance uses TYPE_NUMBER');
        assert.equal(confirmation.readInt32LE(numberOffset + 4), a.model.recRemain);
        assert.equal((await invoke('GameServer/Network/Request/Recommend')(a.session, packet)).code, 'duplicate');
        const receivedMessages = b.session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 831).length;
        await Runtime.flush();
        assert.equal(b.session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 831).length, receivedMessages,
            'journal publication does not repeat an immediate player notification');
        const c = nativeActor(await get(8));
        a.model.destId = 8;
        a.basicAction = data => invoke('GameServer/Actor/Generics/BasicAction')(a.session, a, data);
        const action = Buffer.alloc(10); action[0] = 0x45; action.writeInt32LE(0x28, 1);
        assert.equal((await invoke('GameServer/Network/Request/ActionUse')(a.session, action)).ok, true,
            'native action 0x28 uses the same recommendation service');
        assert.equal(c.model.evalScore, (await get(8)).evalScore);
        a.model.destId = 7;
        assert.equal((await invoke('GameServer/Network/Request/Recommend')(a.session, packet)).code, 'invalid_target');
        const spent = (await get(9)).recSpent;
        assert.equal((await Database.giveRecommendation(9, 8, () => false)).code, 'invalid_target');
        assert.equal((await get(9)).recSpent, spent, 'retired session cannot write after queue admission');
        invoke('GameServer/Network/Request/Recommend')(a.session, Buffer.from([0xb9]));
        assert.equal(a.session.packets.at(-1)[0], 0x25);
        const botReceiver = nativeActor(await get(41));
        botReceiver.model.evalScore = 0;
        // A day rollover updates remaining-online actors and broadcasts their new counters.
        const priorUser = World.user;
        try {
            World.user = { sessions: [a.session, b.session, botReceiver.session] };
            at = (Rules.day(at) + 1) * Rules.DAY_MS;
            await event('cold:visible:friend', 40, 41, 'chat');
            await Runtime.flush();
            assert.equal(a.model.recRemain, 9);
            assert.equal(b.model.evalScore, 0);
            assert.equal(b.session.others.at(-1)[2], 0);
            assert.equal(botReceiver.model.evalScore, 1, 'committed bot recommendation publishes through the journal');
            assert.equal(botReceiver.session.others.at(-1)[2], 1);
        } finally { World.user = priorUser; }
    } finally {
        World.registeredActorById = originalLookup; Response.userInfo = originalUser; Response.charInfo = originalChar;
    }
    await Database.pruneRecommendations();
    await Runtime.start(); await Runtime.stop();
    await Database.close(); Database.init();
    assert.equal((await sql('SELECT version FROM schema_migrations WHERE version=77')).length, 1);
    console.log('Recommendations: real days, limits, replay, concurrency, rollback, hunt/friend/trade/clan and native packet publication passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Date.now = realNow;
    await Runtime.stop();
    if (Database.isReady()) await Database.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
