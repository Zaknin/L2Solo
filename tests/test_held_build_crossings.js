'use strict';
// The held build after a round (the post-round ask, ColdSimulationWorker
// projectResolve): the bot's own output and fight drift keep it, a real
// crossing refuses it. One held build per case, probed without replacing it.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-build-crossings-'));
process.env.L2NODE_CONFIG_FILE = path.join(dir, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${dir}/world.sqlite\nhistoryPath=${dir}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');

const T = 1e12, MINUTE = 60 * 1000;
const deps = { timestamp: T, knowledgeEnabled: true, board: new BoardIndex(),
    spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure() };
// A probe never replaces the held build: each case reads the same one.
const probe = { ...deps, timestamp: T + 1000, rememberContext: false };
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
Config.developerDiagnostics = true;
// A held build carries its event proof only beside a ready warehouse source.
Warehouse.useRowSource(() => null, () => true);
const bag = (loot = 0, extra = []) => Life.inventorySummaryFromItems([
    { id: 1, selfId: 1, amount: 1, equipped: 1, slot: 7 },
    { id: 2, selfId: 1835, amount: 100000, equipped: 0, slot: 0 },
    { id: 3, selfId: 1869, amount: 100000 + loot, equipped: 0, slot: 0 }, ...extra]);
function decided(characterId) {
    let state = { characterId, level: 35, phase: 'cold', activity: 'hunting', adena: 50, sp: 0,
        currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 }, inventory: bag(),
        stats: { classId: 1, exp: Data.experience[34], coldCombat: { classId: 1, skillSource: 'database', skills: [] } },
        timing: { lastResolvedAt: T }, updatedAt: T, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const economy = Economy.forState(state, deps);
    state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    const leaf = economy.network.activity;
    assert(leaf?.activity === 'hunting' && leaf.spotId != null, 'fixture: a hunting leaf at a spot');
    return { state, economy, leaf };
}
// The held build's verdict on current: the hold:economy reasons it counted.
function verdict(current, held) {
    const before = { ...(Diagnostics.metrics().counts || {}) };
    const result = Economy.forState(current, probe);
    const after = Diagnostics.metrics().counts || {};
    const reasons = Object.keys(after).filter(key => key.startsWith('hold:economy:') && after[key] !== before[key])
        .map(key => key.slice('hold:economy:'.length));
    return { kept: result.plan === held.economy.plan, reasons };
}
const after = (state, patch = {}) => ({ ...state, updatedAt: state.updatedAt + 1, ...patch,
    stats: { ...state.stats, ...patch.stats } });

const held = decided(94001), { state, leaf } = held;
assert.deepEqual(verdict(after(state), held), { kept: true, reasons: ['held'] }, 'fixture: a quiet round keeps the build');

// 1. A buff is a read-time modifier of the profile, not an economy input.
{
    const buffed = after(state, { stats: { coldCombat: { ...state.stats.coldCombat,
        effects: [{ id: 1068, key: 'might', stats: { pAtkMul: 1.1 }, expiresAt: T + 10 * MINUTE }] } } });
    assert.deepEqual(verdict(buffed, held), { kept: true, reasons: ['held'] }, 'a buff-only change keeps the held build');
}
// 2. The leaf's own trip, started and arrived, is its own output.
{
    const travel = { from: { ...state.loc }, to: { locX: 81000, locY: 149000, locZ: -3500 }, spotId: leaf.spotId,
        regionName: 'Hunting Ground', arrivalActivity: 'hunting', townName: null, method: 'gatekeeper_spot',
        startedAt: T, arrivalAt: T + 10 * MINUTE };
    const started = after(state, { activity: 'traveling', currentRegion: 'Hunting Ground', stats: { travel } });
    assert.deepEqual(verdict(started, held), { kept: true, reasons: ['held'] }, 'the own trip start keeps the held build');
    const arrived = after(state, { activity: 'hunting', spotId: leaf.spotId, loc: travel.to,
        currentRegion: 'Hunting Ground', stats: { travel: null } });
    assert.deepEqual(verdict(arrived, held), { kept: true, reasons: ['held'] }, 'an arrived own trip keeps the held build');
    const other = after(state, { activity: 'traveling', stats: { travel: { ...travel, spotId: `${leaf.spotId}_other` } } });
    assert.equal(verdict(other, held).kept, false, 'a trip to another spot still refuses');
    assert.deepEqual(verdict({ ...arrived, spotId: `${leaf.spotId}_other` }, held), { kept: false, reasons: ['sections'] },
        'an arrival elsewhere is an occupation event');
    assert.deepEqual(verdict({ ...arrived, activity: 'resting', spotId: `${leaf.spotId}_other` }, held), { kept: false, reasons: ['sections'] },
        'resting elsewhere (a flight, a pull) is an occupation event');
}
// 3. A bag row below a crossing: loot inside its band keeps the build; a new
// row takes a bag slot (the bag safety is exact: a crossing, as before).
{
    assert.deepEqual(verdict(after(state, { inventory: bag(1) }), held), { kept: true, reasons: ['held'] },
        'a bag row below its crossing keeps the held build');
    assert.deepEqual(verdict(after(state, { inventory: bag(0, [{ id: 4, selfId: 1870, amount: 1, equipped: 0, slot: 0 }]) }), held),
        { kept: false, reasons: ['bag'] }, 'a new bag row refuses by its slot, not by an event key');
}
// 4. Real crossings still refuse: death, a kit change, a level.
{
    const dead = verdict(after(state, { activity: 'dead', vitals: { ...state.vitals, hp: 0 } }), held);
    assert.equal(dead.kept, false, 'a death refuses the held build');
    const unequipped = verdict(after(state, { inventory: Life.inventorySummaryFromItems([
        { id: 1, selfId: 1, amount: 1, equipped: 0, slot: 0 },
        { id: 2, selfId: 1835, amount: 100000, equipped: 0, slot: 0 },
        { id: 3, selfId: 1869, amount: 100000, equipped: 0, slot: 0 }]) }), held);
    assert.deepEqual(unequipped, { kept: false, reasons: ['sections'] }, 'a kit change refuses the held build');
    const levelled = verdict(after(state, { level: state.level + 1, stats: { exp: Data.experience[35] } }), held);
    assert.deepEqual(levelled, { kept: false, reasons: ['sections'] }, 'a level refuses the held build');
}
console.log('held build crossings: buff, own trip and bag rows below a crossing keep it; death, kit and level refuse');
