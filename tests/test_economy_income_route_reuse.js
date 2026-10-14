'use strict';
// L120: a build takes the income route of a basics of the same step through
// deps.preparedIncomeRoute only on an equal key, and replays its price reads
// so the build's read fence equals a fresh build's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-route-reuse-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
let Economy, Route, select;
function run() {
    require(path.join(root, 'src/Global'));
    invoke('GameServer/DataCache').init();
    invoke('GameServer/Bot/Population/PopulationConfig').knowledgeErrorsEnabled = false;
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    Route = require(path.join(root, 'src/GameServer/Bot/Economy/EquipmentIncomeRoute'));
    select = Route.select;
    // A search that reads shots, potions and shots again, as select's two
    // consumablePrices do, and finds one earning spot.
    let calls = 0;
    Route.select = (state, { price }) => {
        calls++;
        price(1835); price(1060); price(1835);
        return { spot: { id: 'l120-spot' }, row: { income: 6000, kills: 12, exp: 900, useShots: true }, score: 1 };
    };
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board(), spots = [], occupancy = {}, timestamp = 1790000000000;
    const state = { characterId: 120001, phase: 'cold', activity: 'hunting', level: 35, adena: 50,
        inventory: { 1: { selfId: 1, amount: 1, equipped: true, equippedCount: 1, slot: 7 } },
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, persona: { traits: { commitment: .5, caution: .5, resilience: .5, ambition: .5,
            empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const deps = { board, spots, occupancy, timestamp, rememberContext: false, keepIncomeRoute: true };
    const basics = Economy.basics(state, deps);
    const record = basics.preparedIncomeRoute;
    assert.equal(calls, 1);
    assert(record && record.route.spot.id === 'l120-spot');
    assert.deepEqual(record.reads.filter((_, i) => i % 2 === 0), [1835, 1060, 1835], 'every price read, in order, repeats too');
    assert(!Object.keys(basics).includes('preparedIncomeRoute'), 'a spread of the basics does not carry the record');
    const built = (target, extra) => {
        const reads = [];
        const context = Economy.forState(target, { ...deps, onSourceRead: id => reads.push(Number(id)), ...extra });
        return { reads, fence: Buffer.from(context.calculationFence || []).toString('hex'), hunt: context.hunt,
            statsPacket: context.statsPacket, price: [...context.plan.prices] };
    };
    const fresh = built(structuredClone(state), {});
    assert.equal(calls, 2, 'a build without a record searches');
    const reused = built(state, { preparedIncomeRoute: record });
    assert.equal(calls, 2, 'an equal key takes the prepared route');
    assert.deepEqual(reused.reads, fresh.reads, 'the replay reads the items in a fresh build\'s order');
    assert.equal(reused.fence, fresh.fence, 'the read fence equals a fresh build\'s');
    assert.deepEqual(reused.hunt, fresh.hunt);
    assert.equal(reused.hunt.source, 'route');
    assert.deepEqual(reused.statsPacket, fresh.statsPacket);
    assert.deepEqual(reused.price, fresh.price);
    for (const [why, target, extra] of [
        ['timestamp', state, { timestamp: timestamp + 1 }],
        ['state', structuredClone(state), {}],
        ['occupancy', state, { occupancy: {} }],
        ['spots', state, { spots: [] }],
        ['mode', state, { mode: 'solo' }],
        ['maxChecks', state, { maxChecks: 8 }]]) {
        const before = calls;
        built(target, { ...extra, preparedIncomeRoute: record });
        assert.equal(calls, before + 1, `a different ${why} searches afresh`);
    }
    const Gear = invoke('GameServer/Bot/AI/PersonalGearProgression'), assess = Gear.assess;
    Gear.assess = target => ({ ...assess(target), required: !assess(target).required });
    try {
        const flipped = calls;
        built(state, { preparedIncomeRoute: record });
        assert.equal(calls, flipped + 1, 'a different required flag searches afresh');
    } finally { Gear.assess = assess; }
    const before = calls;
    const moved = { ...record, reads: record.reads.map((value, i) => i === 1 ? value + 1 : value) };
    const repriced = built(state, { preparedIncomeRoute: moved });
    assert.equal(calls, before + 1, 'a price that differs from the record searches afresh');
    assert.deepEqual(repriced.reads, fresh.reads);
    assert.equal(repriced.fence, fresh.fence);
    console.log('PASS L120 income route reuse: equal key fires, other inputs miss, fence order as fresh');
}
try { run(); } catch (error) { console.error(error); process.exitCode = 1; } finally {
    if (Route && select) Route.select = select;
    Economy?.reset();
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
}
