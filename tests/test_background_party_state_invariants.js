const assert = require('assert');

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'party-store-invariants-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');

const Database = invoke('Database');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');

const stored = async partyId => (await Database.execute(['SELECT * FROM bot_background_parties WHERE partyId = ?', [partyId]]))[0];

(async () => {
    Database.init();

    const saved = await BackgroundPartyState.createOrUpdate({
        partyId: 'bgp_stale_leader',
        leaderId: 999,
        memberIds: [101, 101, 102],
        status: 'active'
    });
    assert(saved, 'a valid party should still be persisted');
    assert.strictEqual(saved.leaderId, 101, 'the persisted leader must belong to the normalized member list');
    assert.deepStrictEqual(saved.memberIds, [101, 102], 'party membership must be deduplicated before persistence');
    const savedRow = await stored('bgp_stale_leader');
    assert.strictEqual(Number(savedRow.leaderId), 101, 'the persisted leader must be the normalized attached leader');
    assert.strictEqual(savedRow.memberIdsJson, '[101,102]', 'the persisted member list must use normalized ids');

    const dissolved = await BackgroundPartyState.createOrUpdate({
        partyId: 'bgp_empty_dissolved',
        status: 'dissolved',
        memberIds: []
    });
    assert(dissolved, 'an empty dissolved party must remain persistable for orphan cleanup');
    assert.strictEqual(dissolved.status, 'dissolved');
    assert.deepStrictEqual(dissolved.memberIds, []);
    assert.strictEqual((await stored('bgp_empty_dissolved')).status, 'dissolved', 'the cleanup write must preserve dissolved status');

    const baseline = (BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total);
    for (let index = 0; index < 1000; index++) {
        const partyId = `bgp_write_cycle_${index}`;
        await BackgroundPartyState.createOrUpdate({ partyId, memberIds: [101, 102], status: 'active' });
        await BackgroundPartyState.setStatus(partyId, 'dissolved');
    }
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), baseline);
    for (let index = 0; index < 1000; index++) {
        const partyId = `bgp_accept_cycle_${index}`;
        BackgroundPartyState.acceptRow({ partyId, memberIdsJson: '[101,102]', status: 'active' });
        BackgroundPartyState.acceptRow({ partyId, memberIdsJson: '[101,102]', status: 'dissolved' });
    }
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), baseline);
    assert.equal(BackgroundPartyState.counts().total, baseline);
    const publications = [];
    const unsubscribe = BackgroundPartyState.subscribeChanges((party, previous) => publications.push({ party, previous }));
    const row = { partyId: 'bgp_stamp_probe', memberIdsJson: '[101,102]', status: 'active', updatedAt: 10 };
    const crypto = require('node:crypto'), oldHash = crypto.createHash;
    crypto.createHash = () => { throw new Error('party accept must not compute sha256'); };
    try {
        BackgroundPartyState.acceptRow(row);
        BackgroundPartyState.acceptRow(row);
        assert.equal(publications.length, 1, 'an identical accepted snapshot publishes once');
        BackgroundPartyState.acceptRow({ ...row, status: 'dissolved' });
        assert.equal(publications.length, 2);
        assert.equal(publications[1].party.status, 'dissolved');
        assert.equal(publications[1].previous.status, 'active');
        assert.equal(BackgroundPartyState.find(row.partyId), null);
    } finally { crypto.createHash = oldHash; unsubscribe(); }
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const oldForget = Economy.forgetGroup;
    const forgotten = [];
    Economy.forgetGroup = id => { forgotten.push(id); oldForget(id); };
    try {
        BackgroundPartyState.acceptRow({ ...row, partyId: 'bgp_hot_probe' });
        invoke('GameServer/DataCache').init();
        const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
        const deps = { spots: [], board: new BoardIndex(), timestamp: 1e12 };
        const member = id => ({ characterId: id, phase: 'cold', activity: 'hunting', level: 30, adena: 100,
            inventory: {}, stats: { classId: 0 }, timing: {}, loc: { locX: 0, locY: 0 } });
        Economy.forGroup({ partyId: 'bgp_hot_probe', adena: 200 }, [member(101), member(102)], deps);
        assert.equal(Economy.size().groups, 1);
        await BackgroundPartyState.setStatus('bgp_hot_probe', 'hot');
        assert.deepEqual(forgotten, [], 'hot is live and retains its group context');
        assert.equal(Economy.size().groups, 1);
        BackgroundPartyState.acceptRow({ ...row, partyId: 'bgp_hot_probe', status: 'dissolved' });
        assert.deepEqual(forgotten, ['bgp_hot_probe'], 'the worker dissolve removes the group context once');
        assert.equal(Economy.size().groups, 0);
    } finally { Economy.forgetGroup = oldForget; }
    for (let index = 0; index < 71; index++) BackgroundPartyState.acceptRow({ ...row, partyId: `bgp_live_${index}` });
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), 72);
    const started = performance.now();
    for (let index = 0; index < 10000; index++) assert.equal(BackgroundPartyState.admitted().length, 72);
    const perCallMs = (performance.now() - started) / 10000;
    assert.ok(perCallMs <= .05, `72-party admission took ${perCallMs} ms/call`);
    // The active-party indexes answer as the active() scan they replace: same
    // parties, same order, across a re-accept, a leader/objective change and a dissolve.
    const indexed = (partyId, leaderId, clanId, goalKey, extra = {}) => BackgroundPartyState.acceptRow({ partyId,
        leaderId, memberIdsJson: JSON.stringify([leaderId, leaderId + 1]), status: 'active', updatedAt: 20,
        statsJson: JSON.stringify({ objective: { clanId, clanGoalKey: goalKey }, ...extra }) });
    const scan = test => BackgroundPartyState.active().filter(test).map(party => party.partyId);
    const same = (label) => {
        for (const clanId of [7, 8]) assert.deepEqual(BackgroundPartyState.activeByObjectiveClan(clanId).map(p => p.partyId),
            scan(p => Number(p.stats?.objective?.clanId) === clanId), `${label}: clan ${clanId}`);
        for (const key of ['g1', 'g2']) assert.deepEqual(BackgroundPartyState.activeByGoalKey(key).map(p => p.partyId),
            scan(p => p.stats?.objective?.clanGoalKey === key), `${label}: goal ${key}`);
        const leaders = new Set([501, 511, 521]);
        assert.deepEqual(BackgroundPartyState.activeByLeaders(leaders).map(p => p.partyId),
            scan(p => leaders.has(p.leaderId)), `${label}: leaders`);
        const ids = ['bgp_ix_c', 'bgp_ix_a', 'bgp_ix_missing'];
        assert.deepEqual(BackgroundPartyState.activeByIds(ids).map(p => p.partyId),
            scan(p => ids.includes(p.partyId)), `${label}: ids`);
    };
    indexed('bgp_ix_a', 501, 7, 'g1'); indexed('bgp_ix_b', 511, 7, 'g2'); indexed('bgp_ix_c', 521, 8, 'g1');
    same('first accept');
    indexed('bgp_ix_a', 501, 7, 'g1', { moved: 1 });
    same('re-accept moves to the end');
    indexed('bgp_ix_b', 531, 8, 'g1');
    same('leader and objective change');
    BackgroundPartyState.acceptRow({ partyId: 'bgp_ix_c', memberIdsJson: '[521,522]', status: 'dissolved' });
    same('dissolve');
    for (const id of ['bgp_ix_a', 'bgp_ix_b']) BackgroundPartyState.acceptRow({ partyId: id, memberIdsJson: '[1,2]', status: 'dissolved' });
    assert.deepEqual(BackgroundPartyState.activeByObjectiveClan(7), []);
    console.log(`Background party membership/store checks passed: admission ${perCallMs.toFixed(4)} ms/call`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
