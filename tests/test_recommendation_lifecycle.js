const assert = require('node:assert/strict');
const fs = require('node:fs');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-recommendation-lifecycle');
require('../src/Global');
fixture.assertConfigured(options.default);
invoke('GameServer/DataCache').init();
const Database = invoke('Database'), World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor'), Npc = invoke('GameServer/Npc/Npc');
const Runtime = invoke('GameServer/Recommendations/Runtime'), Response = invoke('GameServer/Network/Response');
const Hunt = invoke('GameServer/Social/SharedHuntMemory'), Activity = require('../src/GameServer/Social/SharedHuntActivity');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Rules = require('../src/GameServer/Recommendations/Rules');
const realNow = Date.now, originalUser = World.user;
const originalResponse = { userInfo: Response.userInfo, charInfo: Response.charInfo };
let at = Rules.day(realNow()) * Rules.DAY_MS + 3600000;
Date.now = () => at;
const sql = (q, args = []) => Database.execute([q, args]);
const get = async id => (await sql('SELECT * FROM characters WHERE id=?', [id]))[0];
async function seed(id, bot = false) {
    const username = `${bot ? 'bot_' : 'user_'}lifecycle_${id}`;
    await sql('INSERT INTO accounts(username,password) VALUES (?,?)', [username, 'fixture']);
    await sql(`INSERT INTO characters(id,username,name,level,classId,race,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?,?,?,40,0,0,100,100,100,100,0,0,0,0,0,0,0)`, [id, username, username]);
    if (bot) await sql(`INSERT INTO bot_life_state(characterId,accountName,characterName,level,phase,activity,updatedAt,statsJson)
        VALUES (?,?,?,40,'hot','hunting',?,'{}')`, [id, username, username, at]);
    return get(id);
}
function register(row, leader = null) {
    const session = { accountId: row.username, fetchAccountId() { return this.accountId; }, packets: [], others: [],
        socket: { destroy() {} }, dataSendToMe(p) { this.packets.push(p); }, dataSendToOthers(p) { this.others.push(p); } };
    if (leader) Object.assign(session, { partyCompanion: true, followPlayerSession: leader });
    session.actor = new Actor({ ...row, isOnline: true }); session.actor.session = session;
    if (row.username.startsWith('bot_')) session.coldLifeState = { characterId: row.id, phase: 'hot', stats: { playedHours: 0 } };
    World.insertUser(session);
    return session;
}
function monster() {
    return { fetchKind: () => 'Monster', fetchIsRaidBoss: () => false, fetchLocX: () => 0, fetchLocY: () => 0,
        ensureAggroEntry: () => ({ damage: 0, hate: 0 }), state: { fetchCombats: () => true },
        switchCombatTarget() {}, fetchMostHated() { return this.attacker; } };
}
function hit(npc, session, damage = 1) {
    npc.attacker = session.actor;
    assert.equal(Npc.prototype.addDamageHate.call(npc, session, session.actor, damage, damage), true);
}
async function kill(npc, sessions) {
    Hunt.recordHot(sessions.map(session => ({ session, exp: 1, sp: 0 })), npc, at);
    await Memory.events.flush();
}
async function main() {
    Database.init(); World.user = { sessions: [], revision: 0 };
    Response.userInfo = actor => Buffer.from([4, actor.model.evalScore]);
    Response.charInfo = actor => Buffer.from([3, actor.model.evalScore]);
    const a = register(await seed(1)), b = register(await seed(2)), c = register(await seed(3));
    await Runtime.refresh(a.actor); await Runtime.refresh(b.actor); await Runtime.refresh(c.actor);
    a.actor.setDestId(2);
    World.retireUserActor(b, b.actor);
    assert.equal(b.actor.fetchIsOnline(), true, 'retirement deliberately retains the raw online flag');
    assert.equal(World.registeredActorById(2).retired, true);
    assert.equal((await Runtime.recommend(a, 2)).code, 'invalid_target');
    assert.equal((await get(1)).recSpent, 0);
    assert.equal((await get(2)).evalScore, 0);
    assert.equal(b.packets.length + b.others.length, 0, 'retired target receives and publishes no recommendation packets');
    World.retireUserActor(a, a.actor); a.actor.setDestId(3);
    assert.equal((await Runtime.recommend(a, 3)).code, 'invalid_target', 'a retired giver is rejected too');

    const giver = register(await seed(4)); giver.actor.setDestId(3);
    const give = Database.giveRecommendation;
    try {
        Database.giveRecommendation = (...args) => {
            const pending = give(...args);
            World.retireUserActor(c, c.actor);
            // Even restoring the same actor must not revive an in-flight proof.
            World.insertUser(c);
            return pending;
        };
        assert.equal((await Runtime.recommend(giver, 3)).code, 'invalid_target');
        assert.equal((await get(4)).recSpent, 0);
    } finally { Database.giveRecommendation = give; }

    await sql('UPDATE characters SET evalScore=10 WHERE id=2'); b.actor.model.evalScore = 10;
    await Runtime.flush(); b.packets.length = b.others.length = 0;
    at += Rules.DAY_MS;
    await Runtime.flush();
    assert.equal(b.others.length + b.packets.length, 0, 'midnight never republishes a retired actor');
    assert.equal(b.actor.model.evalScore, 10, 'publication does not mutate the retired actor');
    await Database.giveRecommendation(4, 2); // A durable offline receipt must not publish an old world object.
    await Runtime.flush();
    assert.equal(b.others.length + b.packets.length, 0, 'journal and notification paths also exclude retirement');

    const sparse = [await seed(20, true), await seed(21, true)];
    await Memory.ensureMany([20, 21]);
    for (let i = 0; i < 3; i++) {
        const leader = register(sparse[0]), companion = register(sparse[1], leader);
        const npc = monster(); hit(npc, leader);
        await kill(npc, [leader, companion]);
        for (const session of [leader, companion]) { session.actor.setIsOnline(false); World.removeUser(session); }
        if (i < 2) at += 30 * 60000;
    }
    assert.equal((await get(21)).evalScore, 0, 'three isolated kills with offline gaps do not earn an hour');
    assert.equal((await sql('SELECT duration FROM recommendation_hunts WHERE sourceId=20 AND targetId=21'))[0].duration, 0);

    const leader = register(await seed(30, true)), companion = register(await seed(31, true), leader);
    await Memory.ensureMany([30, 31]);
    for (const duration of [60000, 30 * 60000, 30 * 60000]) {
        const npc = monster(); hit(npc, leader);
        for (let elapsed = 0; elapsed < duration; elapsed += 5000) { at += 5000; hit(npc, leader); }
        await kill(npc, [leader, companion]);
    }
    assert.equal((await get(31)).evalScore, 1, 'an hour of confirmed native party combat earns a recommendation');
    assert.equal((await sql('SELECT duration FROM recommendation_hunts WHERE sourceId=30 AND targetId=31'))[0].duration, Rules.HUNT_MS);

    // Solo combat clears the shared interval. A later reunion cannot credit it.
    const solo = monster(); hit(solo, leader); at += 10000; hit(solo, leader);
    companion.partyCompanion = false; World.updateUserPresence(companion);
    at += 10000; hit(solo, leader); at += 10 * 60000; hit(solo, leader);
    companion.partyCompanion = true; World.updateUserPresence(companion);
    hit(solo, leader); at += 10000; hit(solo, leader);
    const measured = Activity.takeCombat(solo).get('30:31');
    assert.equal(measured.duration, 10000, 'solo time is excluded from later shared activity');
    const idle = monster(); hit(idle, leader); at += 30 * 60000; hit(idle, leader);
    assert.equal(Activity.takeCombat(idle).get('30:31').duration, 0, 'long gaps between hits earn no time');

    const members = [{ characterId: 50 }, { characterId: 51 }];
    let progress = Activity.coldProgress(null, members, 12000, at);
    progress = Activity.coldProgress(progress, members, 0, at + 1000);
    assert.equal(progress.pending['50:51'], 12000, 'cold elapsed wall time without combat contributes nothing');
    progress = Activity.coldProgress(progress, members, 18000, at + 2000);
    const receipts = Hunt.eventsForGroup([50, 51], 'cold-proof', at, () => ({ ready: true }), () => null,
        (source, target) => progress.pending[Activity.pairKey(source, target)]);
    assert.equal(receipts[0].huntMs, 30000);
    const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
    assert.equal(Policy.event(receipts[0]).huntMs, 30000, 'IPC and durable event normalization retain evidence');
    assert.throws(() => Policy.event({ ...receipts[0], huntMs: Rules.HUNT_MS + 1 }), /invalid hunt duration/);
    assert.throws(() => Policy.event({ ...receipts[0], type: 'chat' }), /invalid hunt duration/);
    Activity.consumeCold(progress, receipts.slice(0, 1));
    assert.equal(progress.pending['50:51'], undefined);
    assert.equal(progress.pending['51:50'], 30000, 'pairs outside a committed batch retain their credit');
    assert.equal(Activity.coldProgress(progress, [{ characterId: 50, timing: { lastHotAt: at } }, members[1]], 0, at + 3000).pending['51:50'], 0,
        'a hot/cold ownership change cannot import an old pending interval');
    assert.equal(Activity.coldProgress(progress, members, 0, at + Rules.DAY_MS).pending['51:50'], 0,
        'a server/offline gap cannot release old pending activity as a new hunt');

    await sql('DELETE FROM schema_migrations WHERE version=78');
    await Database.close(); Database.init();
    assert.equal((await sql('SELECT * FROM recommendation_hunts')).length, 0, 'migration discards old unverified progress');
    assert.equal((await get(31)).evalScore, 1, 'migration preserves received recommendations');
    console.log('Recommendation lifecycle: retirement, queue races, midnight, offline/solo gaps, native combat evidence and cold receipts passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Date.now = realNow;
    await Memory.events.drain(); await Runtime.stop();
    if (Database.isReady()) await Database.close();
    World.user = originalUser; Object.assign(Response, originalResponse);
    fs.rmSync(fixture.directory, { recursive: true, force: true });
});
