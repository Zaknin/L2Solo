'use strict';
// One native chain: owner publication -> economy -> card -> saved restart.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recompute-chain-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'config.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('./helpers/databaseIsolation');
require('../src/Global');
console.log('START native C4 catalogs');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Network = invoke('GameServer/Bot/Economy/WishNetwork');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Supplies = invoke('GameServer/Clan/ClanSupplyPolicy');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const { ColdTableChannel } = require('../src/GameServer/Bot/Population/ColdTableChannel');
const TableMirror = require('../src/GameServer/Bot/Population/TableMirror');
const InteractionMemory = require('../src/GameServer/Social/InteractionMemory');
const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Restart = require('../src/GameServer/Bot/Population/EconomyRestartDecision');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
Config.developerDiagnostics = false;
const T = 1791741600000;
let clock = T;
const realNow = Date.now; Date.now = () => clock;
const generationA = { code: 'd3f6d5f4f3686bc4dcbf57a7cbcf5b4f3e1cfc9e',
    config: createHash('sha256').update(JSON.stringify(globalThis.options.default)).digest('hex') };
const generationB = { ...generationA, code: 'b'.repeat(40) };
Generation.configure(generationA);

// The same native table protocol as workers. Empty is unknown until the
// owner publishes its completed initial copy; no DB or mutable fake digest.
const channel = new ColdTableChannel();
let mirror = new TableMirror();
let ownersReady = false;
const clanRows = new Map([[7, Supplies.prepareRow([7, 1, [], 1])]]);
channel.register('personal_warehouse', { key: row => row[0], allRows: () => [], ready: () => ownersReady });
channel.register('clan_supplies', { key: row => row[0], allRows: () => clanRows.values(), ready: () => ownersReady });
mirror.watch('personal_warehouse', { reset() {}, put: (_key, row) => Warehouse.prepareRow(row), remove() {} });
mirror.watch('clan_supplies', { reset() {}, put: (_key, row) => Supplies.prepareRow(row), remove() {} });
Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => mirror.ready('personal_warehouse'));
Supplies.useRowSource(id => mirror.rows('clan_supplies').get(id), () => mirror.ready('clan_supplies'));
channel.attach({}, 'native-chain', payload => { mirror.apply(structuredClone(payload.tables)); return true; });
assert.equal(Warehouse.contentIdentity({ characterId: 9801 }), null);
assert.equal(Supplies.contentIdentity({ clanId: 7 }), null);
ownersReady = true; channel.flush();
assert(Warehouse.contentIdentity({ characterId: 9801 }));
assert(Supplies.contentIdentity({ clanId: 7 }));
console.log('PASS native owner-ready table publication');

let memory = new InteractionMemory();
const board = new BoardIndex(); board.itemRevision = id => board.itemFingerprint(id);
const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
const options = extra => ({ board, spots, timestamp: clock, eventReuse: true, buyOrderEscrow: 0,
    sourceReady: () => mirror.ready('personal_warehouse') && mirror.ready('clan_supplies'),
    memory: id => memory.snapshot(id), memoryIdentity: id => memory.contentIdentity(id),
    workshop: { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 }, ...extra });
function actor(characterId = 9801, classId = 1, level = 35) {
    memory.accept(MemoryPolicy.empty(characterId));
    const inventory = {};
    for (const row of Gear.planFor({ classId, level }).items) {
        const held = inventory[row.selfId];
        inventory[row.selfId] = { ...row, amount: Number(held?.amount || 0) + 1,
            equipped: true, equippedCount: Number(held?.equippedCount || 0) + 1,
            equippedSlots: [...held?.equippedSlots || [], row.slot] };
    }
    const state = { characterId, level, adena: 100, sp: 0, clanId: 7, phase: 'cold', activity: 'hunting',
        inventory, currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 },
        stats: { classId, exp: Data.experience[level - 1] },
        updatedAt: T, timing: { lastResolvedAt: T },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const shot = ShotStock.planForState(state);
    assert(shot.perAction > 0, 'the fixture has a real armed native shot user');
    state.inventory[shot.selfId] = { selfId: shot.selfId, amount: 100000, equipped: false };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, level), T);
    return state;
}
const publish = (state, result) => ({ ...state, stats: { ...state.stats, ...result.statsPacket } });
function verdict(state, accepted, extra = {}, checks = {}) {
    return Economy.heldBuildVerdict(state, accepted.eventProof, options(extra), {
        activity: accepted.activity, leaf: accepted.card.activity, baseline: accepted.baseline,
        mp: accepted.mp, timestamp: clock, softPrefix: accepted.softPrefix === true, ...checks });
}

const failures = [];
function scenario(name, run) {
    const previousMirror = mirror, previousMemory = memory, previousClock = clock;
    try { run(); }
    catch (error) { failures.push({ name, error }); console.error(`FAIL ${name}: ${error.message}`); }
    finally {
        mirror = previousMirror; memory = previousMemory; clock = previousClock; Generation.configure(generationA);
        Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => mirror.ready('personal_warehouse'));
        Supplies.useRowSource(id => mirror.rows('clan_supplies').get(id), () => mirror.ready('clan_supplies'));
    }
}
try {
    console.log('START native armed hunt build');
    const input = actor();
    Economy.reset();
    const first = Economy.forState(input, options());
    const proof = first.eventProof();
    assert(proof, JSON.stringify({ blocked: 'native cohort has no complete event proof',
        focus: first.network.focus, leaf: first.network.activity?.activity,
        quantityRows: first.plan.quantityInputs?.rows.length ?? null,
        liquidation: !!first.plan.liquidationInputs,
        warehouse: Warehouse.ready(), clan: Supplies.ready(), generation: Generation.current() }));
    assert.equal(first.network.activity.activity, 'hunting', 'the ordinary armed cohort actually hunts');
    const accepted = Decisions.advisory(first, input, input.activity, options());
    assert(accepted?.eventProof, 'the native compact card carries the completed build proof');
    const published = publish(input, first);
    assert.equal(Sections.decisionRefusal(published, accepted.decisionSeq, accepted.activityLeaf, accepted.focus), '');
    assert.equal(verdict(published, accepted).valid, true);
    assert.equal(Decisions.refusal(published, accepted, options()), '');
    assert.strictEqual(Economy.forState(published, options()).plan, first.plan, 'own output publication does not invalidate its build');
    console.log('PASS native accepted tuple publication / shared EC-CED verdict');

    const shotId = ShotStock.planForState(input).selfId;
    const band = proof.bands.find(row => row[0] === shotId);
    assert(band && input.inventory[shotId].amount > band[1], JSON.stringify({ blocked: 'no native quiet shot band', shotId, bands: proof.bands }));
    clock += 1000;
    const quiet = { ...published, adena: published.adena + 1, sp: 20,
        loc: { ...published.loc, locX: published.loc.locX + 2 },
        inventory: { ...published.inventory, [shotId]: { ...published.inventory[shotId], amount: published.inventory[shotId].amount - 1 } } };
    assert.equal(verdict(quiet, accepted).valid, true, JSON.stringify(verdict(quiet, accepted)));
    assert.equal(Decisions.refusal(quiet, accepted, options()), '');
    assert.strictEqual(Economy.forState(quiet, options()).plan, first.plan, 'shot use inside its native band and money/position/SP drift do not rebuild');
    assert.strictEqual(Economy.forState(quiet, options()).statsPacket.wishSections, first.statsPacket.wishSections,
        'a quiet hit preserves the accepted baseline and its original clocks');
    console.log('PASS armed shot consumption / money-position-SP quiet drift');

    const crossed = { ...published, inventory: { ...published.inventory,
        [shotId]: { ...published.inventory[shotId], amount: Math.max(0, band[1] - 1) } } };
    const rejected = verdict(crossed, accepted);
    assert.equal(rejected.valid, false, 'crossing the native stock boundary is an event');
    assert(rejected.touchedSections, JSON.stringify(rejected));
    const rebuilt = Economy.forState(crossed, options());
    assert.notStrictEqual(rebuilt.plan, first.plan);
    console.log(`PASS native stock crossing -> ${rejected.reason} / touched=${rejected.touchedSections}`);

    // A hard owner-data gap refuses even a runtime card with a valid tuple.
    Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => false);
    assert.equal(verdict(published, accepted).reason, 'unready');
    Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => mirror.ready('personal_warehouse'));
    const forwards = clock; clock = T - 1;
    assert.equal(verdict(published, accepted).reason, 'baseline', 'runtime clock reversal refuses the same proof');
    clock = forwards;
    console.log('PASS native unknown-owner / backward-clock refusal');

    scenario('native generation events', () => {
        Generation.configure(generationB);
        assert.equal(verdict(published, accepted).valid, false, 'a real code-generation change refuses the old native decision');
        Generation.configure(null);
        assert.equal(verdict(published, accepted).valid, false, 'unknown generation fails closed');
        Generation.configure(generationA);
        assert.equal(verdict(published, accepted).valid, true);
        console.log('PASS native generation A->B / unavailable / original A restored');
    });
    scenario('native money crossing and clocks', () => {
        // A real monetary crossing may rebuild money/sources, but never restarts
        // unrelated observation or horizon baselines merely because a build ran.
        Economy.reset(); clock = T;
        const moneyBuild = Economy.forState(input, options());
        const moneyCard = Decisions.advisory(moneyBuild, input, input.activity, options());
        const moneyState = publish(input, moneyBuild), oldSections = moneyBuild.statsPacket.wishSections;
        clock = T + 2000;
        const rich = { ...moneyState, adena: 1e8 };
        const moneyVerdict = verdict(rich, moneyCard);
        assert.equal(moneyVerdict.valid, false);
        const moneyBasis = verdict(rich, moneyCard, {}, { rebuildBasis: true });
        assert.equal(moneyBasis.basisValid, true, JSON.stringify({ blocked: 'native money-only basis is not proved', verdict: moneyBasis }));
        const richBuild = Economy.forState(rich, options());
        assert.notStrictEqual(richBuild.plan, moneyBuild.plan, 'native funding/nomination crossing rebuilds');
        for (const [kind, bits] of [['observation', Sections.sectionMask(['occupation', 'build'])],
            ['horizon', Sections.sectionMask(['benefits'])]]) {
            if (!(moneyVerdict.touchedSections & bits)) assert.equal(Sections.softDeadline(richBuild.statsPacket.wishSections, kind),
                Sections.softDeadline(oldSections, kind), `untouched ${kind} retains the original absolute deadline`);
        }
        console.log(`PASS native money crossing / untouched section clocks touched=${moneyVerdict.touchedSections}`);

    });
    scenario('native restart codec and owners', () => {
        // Recreate the actual owner card, then erase process-local economy state.
        Economy.reset(); clock = T;
        const armedBuild = Economy.forState(input, options());
        const armedCard = Decisions.advisory(armedBuild, input, input.activity, options());
        const armedPrefix = Economy.restartEventProof(armedCard.eventProof, armedCard);
        console.log(`INFO typical armed persistence=${!!armedCard.saved} card=${armedCard.card.data.byteLength} prefix=${armedPrefix?.byteLength ?? Buffer.byteLength(JSON.stringify(armedPrefix))} field=${armedCard.saved ? Buffer.byteLength(JSON.stringify({ wishAdvisory: armedCard.saved })) : 'unsupported'} clocks=${Sections.clockBytes(armedCard.baseline)}`);
        // This is a second genuine native actor, not a smaller projection or
        // truncated proof of the armed cohort. Typical armed restart coverage
        // remains unsupported until its unchanged full payload fits the cap.
        const restartInput = actor(9802, 0, 1);
        Economy.reset();
        const restartBuild = Economy.forState(restartInput, options());
        const restartCard = Decisions.advisory(restartBuild, restartInput, restartInput.activity, options());
        assert(restartCard?.eventProof, JSON.stringify({ blocked: 'native starter has no accepted executable proof',
            focus: restartBuild.network.focus, leaf: restartBuild.network.activity,
            quantities: restartBuild.plan.quantityInputs?.rows.length ?? null }));
        const restartPrefix = Economy.restartEventProof(restartCard.eventProof, restartCard);
        if (!restartCard.saved) {
            const artifact = path.join(os.tmpdir(), 'l2-recompute-chain-restart-blocker.json');
            fs.writeFileSync(artifact, JSON.stringify({ input: restartInput, state: publish(restartInput, restartBuild),
                card: { key: restartCard.card.key, data: Buffer.from(restartCard.card.data).toString('base64') },
                decisionSeq: restartCard.decisionSeq, activityLeaf: restartCard.activityLeaf, focus: restartCard.focus,
                baseline: restartCard.baseline, activity: restartCard.activity, mp: restartCard.mp,
                characterId: restartCard.characterId, eventProof: restartCard.eventProof,
                restartProof: restartPrefix instanceof Uint8Array ? Buffer.from(restartPrefix).toString('base64') : restartPrefix }));
            console.log(`BLOCKED native restart evidence: ${artifact}`);
        }
        assert(restartCard.saved, JSON.stringify({ blocked: 'native restart proof does not fit the unchanged 1KB budget',
            cardBytes: restartCard.card.data.byteLength,
            proofBytes: Buffer.byteLength(JSON.stringify(restartCard.eventProof)),
            prefixBytes: restartPrefix?.byteLength ?? Buffer.byteLength(JSON.stringify(restartPrefix)) }));
        const saved = JSON.parse(JSON.stringify(publish(restartInput, restartBuild)));
        const restartBytes = Buffer.byteLength(JSON.stringify({ wishAdvisory: restartCard.saved }));
        const restartClockBytes = Sections.clockBytes(restartCard.baseline);
        assert(restartBytes + restartClockBytes <= Restart.MAX_BYTES);
        console.log(`PASS native saved restart bytes field=${restartBytes} clocks=${restartClockBytes} total=${restartBytes + restartClockBytes}/${Restart.MAX_BYTES}`);
        Economy.reset(); clock = T + 1000;
        const oldIdentity = memory.contentIdentity(restartInput.characterId), memorySnapshot = memory.snapshot(restartInput.characterId);
        memory = new InteractionMemory(); memory.accept(memorySnapshot);
        assert.equal(memory.contentIdentity(restartInput.characterId), oldIdentity, 'native accepted memory contents survive packing in a new process owner');
        mirror = new TableMirror();
        mirror.watch('personal_warehouse', { reset() {}, put: (_key, row) => Warehouse.prepareRow(row), remove() {} });
        mirror.watch('clan_supplies', { reset() {}, put: (_key, row) => Supplies.prepareRow(row), remove() {} });
        const restartedChannel = new ColdTableChannel();
        let restartedReady = false;
        restartedChannel.register('personal_warehouse', { key: row => row[0], allRows: () => [], ready: () => restartedReady });
        restartedChannel.register('clan_supplies', { key: row => row[0],
            allRows: () => [[7, 1, [], 999]], ready: () => restartedReady });
        restartedChannel.attach({}, 'native-restart', payload => { mirror.apply(structuredClone(payload.tables)); return true; });
        const restored = Decisions.restoreAdvisory(saved, clock);
        assert(restored, 'the native saved card decodes after losing every local economy entry');
        assert.equal(verdict(saved, restored).reason, 'unready', 'decoded cards wait for real native owner copies');
        restartedReady = true; restartedChannel.flush();
        assert.equal(verdict(saved, restored).valid, true, JSON.stringify(verdict(saved, restored)));
        assert.equal(Decisions.refusal(saved, restored, options()), '');
        Generation.configure(generationB);
        const decodedB = Decisions.restoreAdvisory(saved, clock);
        if (decodedB) assert.equal(verdict(saved, decodedB).valid, false,
            'a wrapper decoded under B cannot make the original A native hard proof reusable');
        assert.equal(verdict(saved, restored).valid, false);
        Generation.configure(null);
        const decodedUnknown = Decisions.restoreAdvisory(saved, clock);
        if (decodedUnknown) assert.equal(verdict(saved, decodedUnknown).valid, false);
        assert.equal(verdict(saved, restored).valid, false, 'an unavailable native generation cannot validate a saved prefix');
        Generation.configure(generationA);
        assert.equal(verdict(saved, restored).valid, true);
        console.log(`PASS native persisted generation A->B decode=${!!decodedB} / unavailable decode=${!!decodedUnknown}`);
        assert.equal(Decisions.restoreAdvisory(saved, T - 1), null, 'clock reversal refuses persistence');
        assert.equal(Decisions.restoreAdvisory(saved, Sections.softDeadline(restored.baseline, 'market')), null, 'original market expiry is exclusive');
        Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => false);
        assert.equal(verdict(saved, restored).reason, 'unready', 'unknown native warehouse data cannot certify a saved empty state');
        Warehouse.useRowSource(id => mirror.rows('personal_warehouse').get(id), () => mirror.ready('personal_warehouse'));
        console.log('PASS native card capture / forget / restart / expiry / unknown owner');
    });
    // The existing C4 market-source cohort asks only native presence here.
    // A separate physical-spare choice below exercises an actual batch read.
    scenario('native crystal quantity dependencies', () => {
        clock = T;
        const crystal = actor(990771, 46, 49), inventory = {};
        for (const row of Gear.planFor({ classId: 46, level: 20 }).items) {
            if ([7, 14].includes(row.slot)) continue;
            const held = inventory[row.selfId];
            inventory[row.selfId] = { ...row, amount: Number(held?.amount || 0) + 1,
                equipped: true, equippedCount: Number(held?.equippedCount || 0) + 1,
                equippedSlots: [...held?.equippedSlots || [], row.slot] };
        }
        inventory[86] = { selfId: 86, amount: 1, slot: 7, equipped: true, equippedCount: 1, equippedSlots: [7] };
        inventory[1463] = { selfId: 1463, amount: 100000 };
        inventory[1458] = { selfId: 1458, amount: 141 };
        crystal.inventory = inventory; crystal.adena = 3632378;
        crystal.stats.coldCombat = Profile.legacySnapshot(crystal, Profile.skillRecordsFromTree(46, 49), T);
        for (const [id, price] of [[90, 1909712], [166, 206926]]) board.put({ id, ownerId: 991000 + id,
            storeType: 1, kind: 'shop', town: 'Giran', lines: [{ lineId: id, selfId: id, count: 1, enchant: 0, price }] });
        Economy.reset();
        const build = Economy.forState(crystal, options());
        const quantities = build.plan.quantityInputs;
        assert(quantities, 'the completed native crystal build captures all quantity answers within its bound');
        const competing = new Set(quantities.rows
            .filter(row => row[0] === 'stock' && row[2] === 1458).map(row => row[1]));
        const crystalReads = quantities.rows.filter(row => (row[0] === 'stock' || row[0] === 'stockPhysical' ? row[2] : row[1]) === 1458);
        console.log(`INFO native crystal1458 clauses=${JSON.stringify(crystalReads)} rootCount=${competing.size}`);
        assert(crystalReads.length, 'this native cohort must actually consume a physical crystal input');
        const readers = state => ({ ...Providers.quantityReaders(state), stockFor: build.stockFor });
        assert.equal(Network.quantityInputsHold(quantities, readers(crystal)), true);
        assert.equal(competing.size, 0, 'this cohort did not consume allocation stock1458; it cannot prove competing-root changes');
        assert.equal(build.network.activity, null);
        assert.equal(build.eventProof(), null, 'no executable leaf correctly abstains from accepted-decision proof');
        const loss = { ...crystal, inventory: { ...inventory, 1458: { ...inventory[1458], amount: 140 } } };
        assert.equal(Network.quantityInputsHold(quantities, readers(loss)), true,
            'native presence questions tolerate a decrement that keeps the same positive answer');
        const exhausted = { ...crystal, inventory: { ...inventory, 1458: { ...inventory[1458], amount: 0 } } };
        assert.equal(Network.quantityInputsHold(quantities, readers(exhausted)), false,
            'the actual native presence predicate crosses when physical crystals are exhausted');

        const held = { ...crystal, inventory: { ...inventory, 166: { selfId: 166, amount: 2, equipped: false } } };
        const station = { known: true, hours: 0, fees: 0 }, reads = Network.createQuantityInputs();
        const ordinaryChoices = Crystals.choices(held, () => null, station);
        const capturedChoices = Crystals.choices(held, () => null, station, 0, reads);
        assert.deepEqual(capturedChoices, ordinaryChoices, 'capturing actual native crystal reads preserves every ranked choice');
        assert.equal(capturedChoices[0].selfId, 166);
        assert.equal(capturedChoices[0].batchLimit, 2);
        const spareProof = reads.finish();
        assert(spareProof);
        assert.equal(Network.quantityInputsHold(spareProof, Providers.quantityReaders(held)), true);
        const consumed = { ...held, inventory: { ...held.inventory, 166: { ...held.inventory[166], amount: 1 } } };
        assert.equal(Crystals.choices(consumed, () => null, station)[0].batchLimit, 1,
            'a real native owned spare crossing changes the executable physical batch');
        assert.equal(Network.quantityInputsHold(spareProof, Providers.quantityReaders(consumed)), false);
        board.remove(90); board.remove(166);
        console.log('PASS native crystal presence crossing / physical spare batch2->1 / no competing-root claim');
    });

    assert.equal(failures.length, 0, failures.map(({ name, error }) => `${name}: ${error.stack}`).join('\n'));
    console.log('PASS recompute native chain');
} finally {
    Warehouse.useRowSource(null); Supplies.useRowSource(null); Date.now = realNow;
    Economy.reset();
}
