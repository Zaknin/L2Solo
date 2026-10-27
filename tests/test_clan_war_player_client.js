'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const DB = invoke('Database'), Clans = invoke('GameServer/Clan/ClanService');
const War = invoke('GameServer/Clan/ClanWarRuntime'), World = invoke('GameServer/World/World');
const Opcodes = invoke('GameServer/Network/Opcodes'), Request = require('../src/GameServer/Network/Request/ClanWar');
const Receive = invoke('Packet/Receive');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-player-war-client-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
const changes = [];
function patch(object, key, value) { const old = object[key]; changes.push(() => { object[key] = old; }); object[key] = value; }
// The standard C4 clan window sends an opcode and a zero-terminated UTF-16 name.
const packet = (opcode, name) => Buffer.concat([Buffer.from([opcode]), Buffer.from(`${name}\0`, 'utf16le')]);
function player(id, clanId) {
    const session = { packets: [], online: true, fighting: false };
    session.actor = { fetchId: () => id, fetchName: () => `Player${id}`, fetchClanId: () => clanId,
        fetchClanPrivileges: () => 0, fetchIsOnline: () => session.online,
        state: { fetchCombats: () => session.fighting, fetchHits: () => false, fetchCasts: () => false } };
    session.dataSendToMe = value => session.packets.push(value);
    return session;
}
const messages = session => session.packets.filter(p => p[0] === 0x4a)
    .map(p => new Receive(p).readD().readD().readS().readS().data[3]);
async function run() {
    DB.init();
    await DB.execute(["INSERT INTO accounts(username,password) VALUES ('player_war_client','test')"]);
    for (const id of [1, 2, 3, 4, 16]) await DB.execute([`INSERT INTO characters
        (id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,'player_war_client',?,0,0,40,1000,500,0,0,0,0,1,1,1,?)`, [id, `Player${id}`, id <= 4 ? 10 : 20]]);
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'PlayerWarA',1,3),(20,'PlayerWarB',16,3)"]);
    await Clans.reload(); await War.refresh(true);
    assert.equal((await DB.execute(['SELECT COUNT(*) AS n FROM clan_simulation_clans']))[0].n, 0,
        'these are player clans, without autonomous authority');
    assert.equal(Clans.findById(10).members.length, 4, 'reproduce the live BornToKill roster size');
    assert.equal(Clans.findById(20).members.length, 1, 'a manual target may also have fewer than fifteen members');
    const leader = player(1, 10), opponent = player(16, 20), member = player(2, 10);
    const sessions = [leader, opponent, member];
    patch(Clans, 'onlineSessions', clan => sessions.filter(s => s.actor.fetchClanId() === clan.id && s.online));
    patch(World, 'user', { sessions }); patch(World, 'isBotSession', () => false);
    patch(World, 'fetchVisibleUsers', () => []);
    assert(Clans.isLeader(leader.actor)); assert(!Clans.isLeader(member.actor));
    assert.equal(Opcodes.table[0x4d], Request.declare);
    assert.equal(Opcodes.table[0x4f], Request.withdraw);
    const send = (session, opcode, name) => Opcodes.table[opcode](session, packet(opcode, name));
    assert.equal((await send(member, 0x4d, 'PlayerWarB')).code, 'not_authorized');
    assert(member.packets.some(p => p[0] === 0x25), 'the client receives ActionFailed on refusal');
    assert(messages(member).some(text => text.includes('not authorized')));

    const declared = await send(leader, 0x4d, 'PlayerWarB');
    assert(declared.ok && declared.changed); assert.equal(declared.state.status, 'outgoing');
    assert.equal(War.view.between(10, 20).status, 'outgoing');
    assert(messages(leader).some(text => text.includes('PlayerWarA has declared war on PlayerWarB')));
    assert(messages(opponent).some(text => text.includes('PlayerWarA has declared war on PlayerWarB')));
    assert.equal((await send(leader, 0x4d, 'playerwarb')).changed, false, 'a repeated client command is idempotent');
    assert((await send(opponent, 0x4d, 'PlayerWarA')).state.mutual);
    assert.equal(War.view.between(10, 20).mutual, true);
    assert.equal((await send(member, 0x4f, 'PlayerWarB')).code, 'not_authorized');
    member.fighting = true;
    assert.equal((await send(leader, 0x4f, 'PlayerWarB')).code, 'clan_in_combat');
    assert(War.view.between(10, 20).mutual, 'a refused stop cannot change the active war');
    member.fighting = false;
    const withdrawn = await send(leader, 0x4f, 'PlayerWarB');
    assert(withdrawn.ok && withdrawn.changed);
    assert.equal(withdrawn.state.status, 'incoming', 'withdrawing one declaration leaves the other clan declaration visible');
    assert(messages(leader).some(text => text.includes('PlayerWarA has withdrawn war against PlayerWarB')));
    assert((await send(opponent, 0x4f, 'PlayerWarA')).ok);
    assert.equal(War.view.between(10, 20).status, 'neutral');
    assert.equal((await send(leader, 0x4f, 'PlayerWarB')).changed, false);

    leader.online = false;
    assert.equal((await send(leader, 0x4d, 'PlayerWarB')).code, 'actor_changed');
    leader.online = true;
    for (const body of [Buffer.from([0x4d]), packet(0x4d, 'x'.repeat(17)),
        Buffer.concat([packet(0x4d, 'PlayerWarB'), Buffer.from([1])]),
        packet(0x4d, 'PlayerWarB').subarray(0, -1)]) {
        assert.equal((await Opcodes.table[0x4d](leader, body)).code, 'invalid_clan_name');
    }
    const events = await DB.execute(['SELECT actorId,action,reason FROM clan_war_events ORDER BY id']);
    assert.deepEqual(events.map(e => [e.actorId, e.action, e.reason]),
        [[1, 'declare', 'manual'], [16, 'declare', 'manual'], [1, 'withdraw', 'manual'], [16, 'withdraw', 'manual']],
        'only accepted native client commands enter persistent diplomacy');
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (30,'BotWarC',31,3)"]);
    await DB.execute(["INSERT INTO clan_simulation_clans(clanId,version,mode,createdAt,updatedAt,stateJson) VALUES (30,1,'autonomous',?,?,?)", [Date.now(), Date.now(), '{}']]);
    for (let id = 31; id <= 45; id++) await DB.execute([`INSERT INTO characters
        (id,username,name,classId,race,level,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ,clanId)
        VALUES (?,'player_war_client',?,0,0,40,1000,500,0,0,0,0,1,1,1,30)`, [id, `Bot${id}`]]);
    await Clans.reload();
    const botLeader = player(31, 30);
    const botCommand = action => War.transition(botLeader.actor, 10, action, { autonomous: true, reason: 'accept_war' });
    assert.equal((await botCommand('declare')).code, 'clan_members',
        'a new autonomous war still needs the target member minimum');
    assert((await send(leader, 0x4d, 'BotWarC')).ok, 'the small player clan may declare against an autonomous clan');
    assert((await botCommand('declare')).state.mutual,
        'an autonomous clan may accept the player declaration instead of failing on the small enemy roster');
    assert((await send(leader, 0x4f, 'BotWarC')).ok);
    assert((await botCommand('withdraw')).ok);
    await DB.execute(['UPDATE characters SET clanId=0 WHERE id=45']);
    await Clans.reload();
    assert((await send(leader, 0x4d, 'BotWarC')).ok);
    assert.equal((await botCommand('declare')).code, 'clan_members',
        'the responding bot clan must still have fifteen members of its own');
    assert((await send(leader, 0x4f, 'BotWarC')).ok);
    await DB.close(); DB.init(); await War.refresh(true);
    assert((await DB.fetchClanWars()).every(row => row.active === 0), 'stopping the war survives reopening SQLite');
    console.log('Player clan client: small player clans, C4 declare/stop opcodes, leader authority, client feedback, autonomous replies, combat refusal, malformed packets and persisted peace passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    changes.reverse().forEach(restore => restore()); War.view.replace([]);
    await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
