'use strict';
// Pins how the three clan request handlers find their target among online sessions.
const assert = require('assert');
require('../src/Global');

const World = invoke('GameServer/World/World');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanInviteService = invoke('GameServer/Clan/ClanInviteService');
const ServerResponse = invoke('GameServer/Network/Response');
const RequestJoinPledge = invoke('GameServer/Network/Request/RequestJoinPledge');
const RequestOustPledgeMember = invoke('GameServer/Network/Request/RequestOustPledgeMember');
const RequestPledgePower = invoke('GameServer/Network/Request/RequestPledgePower');

function makeSession(id, name) {
    const actor = { fetchId: () => id, fetchName: () => name, fetchClanPrivileges: () => id * 10 };
    const session = { actor, sent: [], dataSendToMe(packet) { this.sent.push(packet); }, dataSendToOthers() {} };
    return session;
}

const leader = makeSession(1, 'Leader');
const member = makeSession(2, 'Mina');
const noActor = { actor: null, sent: [], dataSendToMe() {} };
const original = { sessions: World.user?.sessions };
World.user = { sessions: [noActor, leader, member] };

const clan = { id: 7, name: 'Nocturne', members: [{ id: 1, name: 'Leader' }, { id: 2, name: 'Mina' }, { id: 3, name: 'Offline' }] };
const stubs = {};
function stub(object, key, fn) { stubs[key] = [object, object[key]]; object[key] = fn; }
stub(ClanService, 'clanForActor', () => clan);
stub(ClanService, 'isLeader', (actor) => actor === leader.actor);
stub(ClanService, 'canInvite', (requestor, target) => (target ? { ok: true, clan } : { ok: false }));
stub(ClanInviteService, 'isBotSession', () => false);
stub(ServerResponse, 'actionFailed', () => 'failed');
stub(ServerResponse, 'managePledgePower', (privileges) => `power:${privileges}`);
stub(ServerResponse, 'userInfo', (actor) => `user:${actor.fetchId()}`);
stub(ServerResponse, 'pledgeShowInfoUpdate', (target) => `info:${target.id}`);
stub(ServerResponse, 'askJoinPledge', (id, name) => `ask:${id}:${name}`);
stub(ServerResponse, 'pledgeShowMemberListDelete', (name) => `delete:${name}`);
stub(ServerResponse, 'charInfo', () => 'char');
stub(ServerResponse, 'relationChanged', () => 'relation');
const calls = [];
stub(ClanService, 'setPrivileges', async (actor, target, privileges) => { calls.push(['set', actor.fetchId(), target.fetchId(), privileges]); return { ok: true }; });
stub(ClanService, 'removeMemberById', async (target, id, options) => { calls.push(['remove', id, options.force, options.actor?.fetchId()]); return { ok: true, clan }; });
stub(ClanService, 'onlineSessions', () => [leader]);

function buffer(...words) {
    const out = Buffer.alloc(1 + words.length * 4);
    words.forEach((word, index) => out.writeInt32LE(word, 1 + index * 4));
    return out;
}

(async () => {
    // RequestJoinPledge: target resolved by object id (string ids compare as numbers).
    RequestJoinPledge.consume(leader, { targetId: '2' });
    assert.deepStrictEqual(member.sent, ['ask:1:Nocturne']);
    assert.strictEqual(member.pendingClanInvite.invitedActor, member.actor);
    assert.strictEqual(member.pendingClanInvite.clanId, 7);
    member.sent.length = 0;
    RequestJoinPledge.consume(leader, { targetId: 99 });
    assert.deepStrictEqual(leader.sent, ['failed']);
    leader.sent.length = 0;

    // RequestPledgePower: action 2 reads the target's privileges, 3 sets them, a missing target fails.
    RequestPledgePower(leader, buffer(2, 2));
    assert.deepStrictEqual(leader.sent, ['power:20']);
    leader.sent.length = 0;
    RequestPledgePower(leader, buffer(99, 2));
    assert.deepStrictEqual(leader.sent, ['failed']);
    leader.sent.length = 0;
    RequestPledgePower(leader, buffer(2, 3, 5));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls.splice(0), [['set', 1, 2, 5]]);
    assert.deepStrictEqual(member.sent, ['user:2', 'info:7']);
    assert.deepStrictEqual(leader.sent, []);
    member.sent.length = 0;
    RequestPledgePower(leader, buffer(99, 3, 5));
    assert.deepStrictEqual(leader.sent, ['failed']);
    leader.sent.length = 0;

    // RequestOustPledgeMember: online member gets the actor, offline member goes without it.
    let result = await RequestOustPledgeMember.consume(leader, { name: 'mina' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.splice(0), [['remove', 2, true, 2]]);
    assert.deepStrictEqual(member.sent, ['user:2', 'delete:Mina']);
    assert.deepStrictEqual(leader.sent, ['delete:Mina', 'info:7']);
    member.sent.length = 0; leader.sent.length = 0;
    result = await RequestOustPledgeMember.consume(leader, { name: 'Offline' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls.splice(0), [['remove', 3, true, undefined]]);
    assert.deepStrictEqual(member.sent, []);
    leader.sent.length = 0;
    result = await RequestOustPledgeMember.consume(leader, { name: 'Nobody' });
    assert.strictEqual(result.code, 'not_member');
    assert.deepStrictEqual(leader.sent, ['failed']);

    for (const [key, [object, fn]] of Object.entries(stubs)) object[key] = fn;
    World.user = { sessions: original.sessions || [] };
    console.log('test_clan_request_target_lookup: ok');
})().catch((error) => { console.error(error); process.exit(1); });
