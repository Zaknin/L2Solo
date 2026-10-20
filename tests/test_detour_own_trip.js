'use strict';
// A held exp/income hunting decision names spot X. When X has no room, the
// bot's route sends it to another spot Y: that detour is the leaf's own trip
// and arrival, so the held decision stays. A material hunt and a flight
// (death pressure) are no stand-in: the move to Y is an event.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-own-trip-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
let Economy, generation = null;
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
async function run() {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
    const { beginHuntingTrip } = invoke('GameServer/Bot/Population/HuntingTravel');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    // Native fields: the decision's own spot (13_20, monster 711) and fields of
    // level 30-31 monsters a level-35 warrior may hunt alone.
    const spots = require('./helpers/wishSectionSpots')([711, 485, 79, 924, 344]);
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    // A warrior in the gear its level plans, so the route finds fields it may hunt.
    const inventory = {};
    for (const row of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 35 }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true, equippedCount: slots.length, equippedSlots: slots };
    }
    const base = { phase: 'cold', activity: 'hunting', level: 35, adena: 50, inventory,
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const T = Date.now();

    // One bot: its held decision, the route with X full from where it stands
    // (`standing`: the published state moved before the trip), the trip, its
    // arrival. verdict(state) = does the held decision hold over that state.
    function detour(native, standing = state => state) {
        const held = Economy.forState(native, { timestamp: T });
        const leaf = held.network.activity, X = leaf?.spotId;
        assert(leaf?.activity === 'hunting' && X, 'fixture: a hunting decision at a spot');
        const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
        const proof = held.eventProof();
        const verdict = state => Economy.eventProofHolds(state, proof, { timestamp: T },
            { baseline: packet.wishSections, leaf, timestamp: T });
        assert.equal(verdict(published), true, 'fixture: the published decision holds');
        const routed = standing(published);
        const route = BotRoute.trip({}, routed, leaf, { spots, timestamp: T, hasRoom: id => String(id) !== String(X) });
        assert(route?.needed && String(route.spotId) !== String(X), 'fixture: X full, the route leads elsewhere');
        const traveling = beginHuntingTrip(routed, route, T);
        assert(traveling, 'fixture: the trip starts');
        const arrival = Resolver.resolveSolo({ state: traveling, timestamp: traveling.stats.travel.arrivalAt });
        assert(arrival && arrival.patch.activity === 'hunting', 'fixture: the bot arrives to hunt');
        const arrived = { ...traveling, ...arrival.patch };
        Economy.forget(native.characterId);
        return { leaf, route, traveling, arrived, verdict };
    }

    {
        const { leaf, traveling, arrived, verdict } = detour({ ...base, characterId: 990101 });
        assert.equal(verdict(traveling), true, 'the detour trip keeps the decision');
        assert.equal(verdict(arrived), true, 'the arrival at the stand-in spot keeps the decision');
        // The same moves under a leaf that hunts a material at its monster:
        // not its own trip or arrival (the verdict's occupation reading).
        const material = { ...leaf, itemId: 1864, amount: 5 };
        assert.equal(Sections.occupationPlanned(traveling, material), false, 'a material hunt\'s detour trip is an event');
        assert.equal(Sections.occupationPlanned(arrived, material), false, 'a material hunt\'s stand-in arrival is an event');
    }
    console.log('PASS exp hunting detour keeps / a material hunt detour is an event');

    {
        // A bot that died on spot Z (its death mark, held with the decision)
        // and stands there: its search is a flight, which stays an event.
        const Z = spots.find(spot => spot.raidBoss !== true && spot.center
            && spot.npcEntries?.some(entry => entry.selfId === 485));
        assert(Z, 'fixture: a ground to flee from');
        const marked = { ...base, characterId: 990102, stats: { ...base.stats,
            spotBackoffs: [{ spotId: Z.id, untilStep: 1e9, startedAt: T, attempts: 1, reason: 'death_pressure' }] } };
        const { route, traveling, arrived, verdict } = detour(marked, state => ({ ...state, spotId: Z.id,
            currentRegion: Z.name, loc: { locX: Z.center.locX, locY: Z.center.locY, locZ: Z.center.locZ } }));
        assert.equal(route.reason, 'death_pressure_replan', 'fixture: a flight');
        assert.equal(verdict(traveling), false, 'a flight refuses the decision');
        assert.equal(verdict(arrived), false, 'the arrival of a flight refuses the decision');
    }
    console.log('PASS a death-pressure flight is an event');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Economy?.reset();
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(null);
    if (generation) Generation.configure(generation);
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
