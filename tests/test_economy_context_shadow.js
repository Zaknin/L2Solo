'use strict';
// Shadow counters compare rebuild keys and plans. Never a decision input.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-context-shadow-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const state = () => ({ characterId: 901, updatedAt: 1, level: 20, phase: 'cold', activity: 'resting', adena: 100,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } }, currentRegion: 'Giran',
    simulation: { revision: 2 }, loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
const shadow = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('context:shadow')));
const keyCounts = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('context:key_')));
// A held build carries its event proof only under a native generation and a
// ready warehouse source. A branch checkout has no generation, CI's detached
// one has it: each proof block fixes both and restores them in its finally.
function proofScope() {
    const generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    Warehouse.useRowSource(() => null, () => true);
    return () => { Generation.configure(generation); Warehouse.useRowSource(null); };
}
// A stubbed projection publishes the liquidation proof as WishProviders.build does.
function stubLiquidation(state, context, values) {
    context.liquidationInputs = Providers.liquidationInputs(state, { shots: context.stock('shots'), potions: context.stock('potions'),
        excluded: [...values.keys()].filter(id => Object.hasOwn(state.inventory || {}, id)) }).proof;
}
function delta(before, after) {
    const out = {};
    for (const [key, value] of Object.entries(after)) if (value !== (before[key] || 0)) out[key] = value - (before[key] || 0);
    return out;
}

// Every input key part is named, in order; the key is the parts joined.
{
    const probe = { ...state(), sp: 77, stats: { classId: 1, karma: null } }, probeDeps = { ...deps, workshop: { recipeId: 5 } };
    const parts = Economy.inputKeyParts(probe, probeDeps), names = Economy.INPUT_KEY_PARTS;
    assert.strictEqual(names.length, parts.length, 'a new input key part needs its name in INPUT_KEY_PARTS');
    assert.strictEqual(new Set(names).size, names.length);
    assert.strictEqual(Economy.inputKey(probe, probeDeps), parts.join('|'));
    const at = name => parts[names.indexOf(name)];
    assert.deepEqual([at('level'), at('class_id'), at('adena'), at('workshop_recipe'), at('sp')], [20, 1, 100, 5, 77]);
}

// Off: no diagnostic call is reached, the decision path is unchanged.
const original = { count: Diagnostics.count, duration: Diagnostics.duration, enabled: Diagnostics.enabled, push: Diagnostics.push,
    laps: Diagnostics.laps };
Config.developerDiagnostics = false; Economy.reset();
for (const key of Object.keys(original)) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
// laps is called unconditionally by the provider and must hand back null (no clock, no allocation) while off.
Diagnostics.laps = prefix => { assert.strictEqual(original.laps(prefix), null, 'laps is null while diagnostics are off'); return null; };
const offFirst = Economy.forState(state(), deps);
assert.strictEqual(Economy.forState(state(), deps).plan, offFirst.plan);
Economy.forState(state(), deps); Economy.forgetContext(901, 'state_publication');
Economy.forState(state(), { ...deps, rememberContext: false });
Object.assign(Diagnostics, original);

// On, with a fake clock for deterministic native deadlines.
const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
Config.developerDiagnostics = true; Economy.reset();
let before = shadow();
const first = Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:new_key': 1 }, 'first build has no previous key');
{
    const durations = Diagnostics.metrics().durations || {};
    assert.strictEqual(durations['context:not_retained']?.count, durations.context?.count, 'build time is split by reason');
}

// Publication replaces the facts object while retaining the checked decision.
before = shadow();
Economy.forgetContext(901, 'state_publication');
const publicationState = state();
const publication = Economy.forState(publicationState, deps);
assert.strictEqual(publication.plan, first.plan, 'publication retains the same decision');
assert.strictEqual(publication.state, publicationState, 'the view reads the newly published facts');
assert.notStrictEqual(publication.state, first.state, 'publication supplies a new facts object');
assert.deepEqual(delta(before, shadow()), {}, 'publication without changed inputs is not a rebuild');

before = shadow(); clock += 7000;
Economy.forgetContext(901, 'explicit_invalidation');
const republished = state();
const second = Economy.forState(republished, deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:same_key': 1, 'context:shadow_plan:same_key:same_plan': 1 },
'a released context with an equal key counts the repeated plan');
assert.deepEqual(second.statsPacket, first.statsPacket, 'counting never changes the decision');

before = shadow(); clock += 40000;
assert.strictEqual(Economy.forState(republished, deps).plan, second.plan, 'a hit is not a rebuild');
assert.deepEqual(delta(before, shadow()), {});
before = shadow(); clock += 2000;
Economy.forgetContext(901, 'owner_release');
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:same_key': 1, 'context:shadow_plan:same_key:same_plan': 1 }, 'a later released context keeps the aggregate key and plan counts');

before = shadow(); const keyBefore = keyCounts();
Economy.forState({ ...republished, adena: 5000 }, deps);
let changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:new_key': 1, 'context:shadow_plan:new_key:same_plan': 1 },
    'a richer wallet invalidates inputs while the mandatory kit remains the focus');
assert.deepEqual(delta(keyBefore, keyCounts()), { 'context:key_part:adena': 1, 'context:key_parts:1': 1 }, 'the one moved input part is named');

// A build that waits on incoming stock (early return) still classifies its plan.
before = shadow();
Economy.forState({ ...republished, adena: 5000, incomingPending: true }, deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:new_key': 1, 'context:shadow_plan:new_key:new_plan': 1 });
Economy.forState({ ...republished, adena: 5000 }, deps);

// An unkept build stays unkept even when an older kept context of the actor is released later.
Economy.forState({ ...state(), adena: 5001 }, { ...deps, rememberContext: false });
Economy.forgetContext(901, 'explicit_invalidation');
before = shadow(); clock += 200000;
Economy.forState(state(), deps);
changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:new_key': 1, ...Object.fromEntries(Object.entries(changed).filter(([key]) => key.startsWith('context:shadow_plan:new_key:'))) });
assert.strictEqual(Object.keys(changed).filter(key => key.startsWith('context:shadow_plan:new_key:')).length, 1, 'a new key compares its plan with the previous build');

// The LRU capacity names its own release.
Economy.forState(state(), deps);
for (let id = 1000; id < 1000 + Economy.RETAIN_LIMIT; id++) Economy.forState({ ...state(), characterId: id }, deps);
before = shadow();
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:same_key': 1, 'context:shadow_plan:same_key:same_plan': 1 });

// A temporary caller's predecessor is not the held decision's baseline.
{
    const counts = () => Diagnostics.metrics().counts || {};
    const ownWorkshop = { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 };
    const changedWorkshop = { ...ownWorkshop, recipeId: 7 };
    for (const [id, currentWorkshop, expected] of [[910, undefined, 0], [911, changedWorkshop, 1]]) {
        const native = { ...state(), characterId: id };
        Economy.forState(native, { ...deps, workshop: ownWorkshop });
        Economy.forState(native, { ...deps, workshop: changedWorkshop, rememberContext: false });
        const before = counts()['context:silent:workshop_recipe'] || 0;
        Economy.forState({ ...native, adena: native.adena + 1 }, { ...deps, workshop: currentWorkshop || ownWorkshop });
        assert.equal((counts()['context:silent:workshop_recipe'] || 0) - before, expected,
            'silent event parts compare against the actual held build, not the temporary predecessor');
    }
}

// Shopping shadow checks use the retained decision's total bag + incoming baseline.
// The live leaf and decisions stay identical with diagnostics disabled/enabled.
{
    const Evidence = invoke('GameServer/Bot/Economy/WishPurchaseEvidence');
    const build = Providers.build, reader = Evidence.reader, restoreProof = proofScope();
    const itemId = 1864, itemKey = `item:${itemId}`, rootKey = `resale:${itemId}`;
    let quoteReads = 0;
    Providers.build = (current, context) => {
        context.board.first(itemId, 1);
        const values = new Map([[itemId, 10]]);
        stubLiquidation(current, context, values);
        return { nodes: [
            { key: rootKey, need: 'power', object: { itemId, kind: 'resale' }, valueHours: 1000, price: 50,
                paths: [{ requirements: [{ key: itemKey, amount: 5 }] }] },
            { key: itemKey, price: 10, paths: [{ kind: 'buy', activity: 'shopping', itemId, price: 10,
                unitPrice: 10, sourceType: 'afk', town: 'Giran', availableUnits: 100, quoted: true, executable: true }] }
        ], roots: [rootKey], values, moneyPaths: [], horizon: 1, sourceSections: null };
    };
    Evidence.reader = (...args) => {
        const read = reader(...args);
        return id => { quoteReads++; return read(id); };
    };
    const scenario = diagnostic => {
        Config.developerDiagnostics = diagnostic; Economy.reset();
        const board = new BoardIndex();
        // Equivalent scenario boards share content tokens, independent of construction serial.
        board.itemRevision = id => board.itemFingerprint(id);
        const offer = count => board.put({ id: 91201, ownerId: 7, storeType: 1, town: 'Giran',
            lines: [{ lineId: 1, selfId: itemId, count, price: 10 }] });
        offer(100);
        const tripCost = Object.assign(() => 0, { details: () => ({ known: true, hours: .1, fees: 0 }) });
        const options = { ...deps, board, tripCost };
        const native = { ...state(), characterId: 912, adena: 1e6,
            inventory: { ...state().inventory, [itemId]: { selfId: itemId, amount: 3, stackable: true } } };
        const results = [], verdicts = [];
        const request = (current, extra = {}) => {
            const before = Diagnostics.metrics().counts || {};
            const quotes = quoteReads;
            const result = Economy.forState(current, { ...options, ...extra });
            if (diagnostic) verdicts.push(Object.keys(delta(before, Diagnostics.metrics().counts || {}))
                .filter(key => key.startsWith('context:gate:')));
            results.push({ network: result.network, packet: result.statsPacket });
            assert.equal(Object.hasOwn(result.plan.network.activity || {}, 'heldAtDecision'), false,
                'shadow metadata never stamps the live network leaf');
            return { result, quotes: quoteReads - quotes };
        };
        const first = request(native).result;
        assert.equal(first.network.activity?.activity, 'shopping');
        assert.equal(first.network.activity?.amount, 2, 'the real quantity solver subtracts the three owned units');
        assert.equal(request(native).result.plan, first.plan, 'a cache hit preserves the original diagnostic baseline');
        const accepted = { ...native, stats: { ...native.stats, ...first.statsPacket } };
        const partial = { ...accepted, acceptedIncoming: { [itemId]: 1 } };
        const part = request(partial, { rememberContext: false });
        if (diagnostic) assert.equal(part.quotes, 1, 'one current offer check on an otherwise quiet partial fill');
        assert.equal(part.result.network.activity.amount, 1, 'the fresh decision orders only the missing unit');
        offer(99); // Token moved, quote stayed usable: the same buy proof covers soft deferral.
        const transferred = { ...accepted, inventory: { ...accepted.inventory,
            [itemId]: { ...accepted.inventory[itemId], amount: 4 } } };
        const transfer = request(transferred, { rememberContext: false });
        if (diagnostic) assert.equal(transfer.quotes, 1, 'market deferral reuses the baseline-aware offer proof');
        request({ ...partial, incomingPending: true });
        request({ ...accepted, acceptedIncoming: { [itemId]: 2 } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts, [
            ['context:gate:no_held'], [], ['context:gate:would_hold'], ['context:gate:would_hold'],
            ['context:gate:event_key'], ['context:gate:check_failed']
        ], 'partial fills and incoming-to-bag transfer hold; full arrival refuses despite intervening unkept/pending builds');
        return results;
    };
    try {
        const off = scenario(false), on = scenario(true);
        assert.deepEqual(on, off, 'shopping diagnostics never change live funding, activities, rolls or packets');
    } finally { Providers.build = build; Evidence.reader = reader; restoreProof(); Config.developerDiagnostics = true; }
}

// Selected hunting progress is measured from the held decision and is shadow-only.
// Raw bag+incoming progress is not a proof of allocatable stock or craft readiness.
{
    const build = Providers.build, enabled = Diagnostics.enabled, push = Diagnostics.push, restoreProof = proofScope();
    const itemId = 1864, targetId = 885, rootKey = `power:${targetId}:4`, secondId = 886, secondKey = `power:${secondId}:5`;
    let summaries = [], targetClaimed = false, funding = false, targetAmount = 1, second = false;
    Providers.build = (current, context) => {
        const values = new Map([[itemId, 10], [targetId, 50]]);
        stubLiquidation(current, context, values);
        if (targetClaimed) {
            const stock = context.stockFor;
            // A physically present target can be unavailable to this root.
            context.stockFor = (id, root) => id === targetId ? { owned: 0, incoming: 0 } : stock(id, root);
        }
        return { nodes: [
            { key: rootKey, need: 'power', object: { itemId: targetId, slot: 4 }, valueHours: 1000, price: 50,
                paths: [{ requirements: [{ key: `item:${targetId}`, amount: targetAmount }] }] },
            { key: `item:${targetId}`, price: 50, paths: [{ kind: 'craft', productCount: 1, costHours: .1,
                requirements: [{ key: `item:${itemId}`, amount: 5 }] }] },
            { key: `item:${itemId}`, price: 10, paths: [{ kind: 'drop', activity: 'hunting', itemId,
                funding, costHours: 1, executable: true }] },
            ...(second ? [{ key: secondKey, need: 'power', object: { itemId: secondId, slot: 5 }, valueHours: 10, price: 50,
                paths: [{ requirements: [{ key: `item:${itemId}`, amount: 4 }] }] }] : [])
        ], roots: second ? [rootKey, secondKey] : [rootKey], values, moneyPaths: [], horizon: 1, sourceSections: null };
    };
    Diagnostics.enabled = () => true;
    Diagnostics.push = row => {
        if (row.phase !== 'wish_context' || !row.gate) return;
        summaries.push(row);
        const buffer = Diagnostics.create({ config: { developerDiagnostics: true, economyDiagnostics: true,
            economyDiagnosticsBotIds: '913' }, thread: 'worker', now: () => clock });
        let encoded;
        buffer.connect(message => { encoded = message.records[0]; });
        assert.equal(buffer.push(row), true, 'quantity and input/output evidence fits the unchanged serialized record budget');
        assert.ok(Buffer.byteLength(encoded) + 1 <= Diagnostics.LIMITS.recordBytes);
        assert.equal(JSON.parse(encoded).inputActivityLeaf, row.inputActivityLeaf, 'input leaf survives the public diagnostic schema');
    };
    const scenario = diagnostic => {
        Config.developerDiagnostics = diagnostic; Economy.reset(); summaries = [];
        const native = { ...state(), characterId: 913, adena: 1e6,
            inventory: { ...state().inventory, [itemId]: { selfId: itemId, amount: 3, stackable: true } } };
        const results = [], verdicts = [];
        const request = (current, extra = {}) => {
            const before = Diagnostics.metrics().counts || {};
            const result = Economy.forState(current, { ...deps, ...extra });
            if (diagnostic) verdicts.push(Object.keys(delta(before, Diagnostics.metrics().counts || {}))
                .filter(key => key.startsWith('context:gate:')));
            results.push({ network: result.network, packet: result.statsPacket });
            assert.equal(Object.hasOwn(result.plan.network.activity || {}, 'heldAtDecision'), false);
            return result;
        };
        const first = request(native);
        assert.equal(first.network.activity?.itemId, itemId);
        assert.equal(first.network.activity?.amount, 2);
        assert.equal(request(native).plan, first.plan);
        const accepted = { ...native, stats: { ...native.stats, ...first.statsPacket } };
        const partial = { ...accepted, acceptedIncoming: { [itemId]: 1 } };
        request(partial, { rememberContext: false });
        if (diagnostic) assert.equal(summaries.at(-1).inputActivityLeaf, accepted.stats.activityLeaf);
        request({ ...accepted, inventory: { ...accepted.inventory, [itemId]: { ...native.inventory[itemId], amount: 4 } } },
            { rememberContext: false });
        request({ ...partial, incomingPending: true });
        request({ ...accepted, acceptedIncoming: { [itemId]: 2 } }, { rememberContext: false });
        request({ ...accepted, inventory: { ...accepted.inventory, [itemId]: { ...native.inventory[itemId], amount: 2 } } },
            { rememberContext: false });
        request({ ...accepted, inventory: { ...accepted.inventory, [targetId]: { selfId: targetId, amount: 1 } } },
            { rememberContext: false });
        if (diagnostic) {
            assert.deepEqual(verdicts, [['context:gate:no_held'], [], ['context:gate:would_hold'], ['context:gate:would_hold'],
                ['context:gate:event_key'], ['context:gate:check_failed'], ['context:gate:quantity'], ['context:gate:event_key']],
                'a bag loss below the decision count is a quantity event; a new target stack moves the event key');
            const complete = summaries.find(row => row.gate === 'check_failed' && row.actual === 2);
            assert.deepEqual([complete.item, complete.requested, complete.before, complete.owned, complete.actual, complete.remaining],
                [itemId, 2, 3, 3, 2, 0]);
            assert.equal(complete.sequence, accepted.stats.decisionSeq, 'sequence is the request input; decisionSeq is the network output');
        }
        // An explicitly claimed target is physically present but not free stock.
        Economy.reset(); targetClaimed = true;
        const present = { ...native, inventory: { ...native.inventory, [targetId]: { selfId: targetId, amount: 1 } } };
        const held = request(present);
        request({ ...native, stats: { ...native.stats, ...held.statsPacket } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:event_key'], 'a claimed target stack that leaves the bag moves the event key');
        targetClaimed = false;
        // A funding hunt's drops are not its own progress: they are a wished
        // material reaching its count. A new target stack moves the event key.
        Economy.reset(); funding = true; targetAmount = 2;
        const fundingHeld = request(native);
        request({ ...native, stats: { ...native.stats, ...fundingHeld.statsPacket }, acceptedIncoming: { [itemId]: 10 } },
            { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:quantity'], 'a funding hunt has no own item: its material rows hold exactly');
        request({ ...native, stats: { ...native.stats, ...fundingHeld.statsPacket }, acceptedIncoming: { [itemId]: 10 },
            inventory: { ...native.inventory, [targetId]: { selfId: targetId, amount: 1 } } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:event_key'], 'a new target stack moves the event key');
        funding = false; targetAmount = 1;
        // A material hunt from none: its first drop is a new bag row of its
        // own item, its progress, not an input event.
        Economy.reset();
        const none = { ...native, inventory: state().inventory };
        const fromNone = request(none);
        assert.equal(fromNone.network.activity?.amount, 5);
        request({ ...none, stats: { ...none.stats, ...fromNone.statsPacket },
            inventory: { ...none.inventory, [itemId]: { selfId: itemId, amount: 1, stackable: true } } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:would_hold'], 'a material hunt from none holds after its first drop');
        // Another root's stock row on the hunted item stays its input: its
        // material reaching that root's count is an event, not the hunt's progress.
        Economy.reset(); second = true;
        const shared = request(native);
        assert.equal(shared.network.activity?.rootKey, rootKey);
        assert.equal(shared.network.activity?.itemId, itemId);
        request({ ...native, stats: { ...native.stats, ...shared.statsPacket },
            inventory: { ...native.inventory, [itemId]: { ...native.inventory[itemId], amount: 4 } } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:quantity'], 'a second root on the hunted item reaching its count refuses');
        second = false;
        Economy.reset();
        const original = request(native);
        const renewed = request({ ...native, stats: { ...native.stats, ...original.statsPacket }, acceptedIncoming: { [itemId]: 1 } });
        request({ ...native, stats: { ...native.stats, ...renewed.statsPacket } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['context:gate:quantity'],
            'an actual completed retention advances the baseline; losing its new incoming unit is a quantity event');
        return results;
    };
    try { assert.deepEqual(scenario(true), scenario(false), 'hunting and target diagnostics preserve complete live networks and packets'); }
    finally { Providers.build = build; Diagnostics.enabled = enabled; Diagnostics.push = push; restoreProof(); Config.developerDiagnostics = true; }
}

// A ready craft loses its physical prerequisites even when its target is
// still absent and the material keeps the same bag slot and weight tier.
{
    const build = Providers.build, restoreProof = proofScope();
    const productId = 1865, materialId = 1864, rootKey = `power:${productId}:7`;
    Providers.build = (current, context) => {
        const values = new Map([[productId, 1000]]);
        stubLiquidation(current, context, values);
        return { nodes: [
            { key: rootKey, need: 'power', object: { itemId: productId }, valueHours: 1000,
                paths: [{ requirements: [{ key: `item:${productId}`, amount: 5 }] }] },
            { key: `item:${productId}`, price: 500, paths: [{ kind: 'craft', activity: 'crafting',
                itemId: productId, recipeId: 7, productCount: 2, costHours: .1,
                grossRequirements: [{ key: `item:${materialId}`, amount: 10 }],
                requirements: [{ key: `item:${materialId}`, amount: 10 }] }] },
            { key: `item:${materialId}`, price: 2, paths: [{ kind: 'buy', activity: 'shopping',
                itemId: materialId, price: 2, unitPrice: 2, sourceType: 'afk', town: 'Giran',
                executable: true, quoted: true, availableUnits: 100 }] }
        ], roots: [rootKey], values, moneyPaths: [], horizon: 1, sourceSections: null };
    };
    const counters = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {})
        .filter(([key]) => key.startsWith('context:gate:')));
    const scenario = (diagnostic, mode) => {
        Config.developerDiagnostics = diagnostic; Economy.reset();
        const board = new BoardIndex(); board.itemRevision = id => board.itemFingerprint(id);
        const options = { ...deps, board };
        const native = { ...state(), characterId: 915, adena: 100000,
            inventory: { ...state().inventory, [materialId]: { selfId: materialId, amount: 30, stackable: true } },
            ...(mode === 'delivery' ? { acceptedIncoming: { [materialId]: 5 } } : {}) };
        const first = Economy.forState(native, options);
        assert.equal(first.network.activity?.activity, 'crafting', 'the native solver chooses the ready craft');
        const accepted = { ...native, stats: { ...native.stats, ...first.statsPacket } };
        if (mode === 'unkept') Economy.forState({ ...accepted,
            inventory: { ...accepted.inventory, [materialId]: { ...accepted.inventory[materialId], amount: 29 } } },
        { ...options, rememberContext: false });
        if (mode === 'pending') Economy.forState({ ...accepted, incomingPending: true }, options);
        const amount = mode === 'delivery' ? 35 : mode === 'same' || mode === 'unkept' || mode === 'pending' ? 31 : 29;
        const changed = { ...accepted,
            inventory: { ...accepted.inventory, [materialId]: { ...accepted.inventory[materialId], amount } },
            acceptedIncoming: mode === 'incoming' ? { [materialId]: 1 } : {} };
        const before = counters(), next = Economy.forState(changed, options);
        return { first, next, counts: delta(before, counters()) };
    };
    try {
        for (const mode of ['same', 'loss', 'incoming', 'delivery', 'unkept', 'pending']) {
            const off = scenario(false, mode), on = scenario(true, mode);
            assert.deepEqual(on.first.network, off.first.network, `${mode}: the first network is unchanged`);
            assert.deepEqual(on.next.network, off.next.network, `${mode}: material evidence never changes the new network`);
            assert.deepEqual(on.next.statsPacket, off.next.statsPacket, `${mode}: the new packet is unchanged`);
            // A reserved input holds while its owned+incoming does not fall: one unit
            // out of the bag with one accepted incoming, or the network's own
            // delivery (incoming into the bag), is no loss.
            const lost = mode === 'loss';
            assert.equal(on.counts[`context:gate:${lost ? 'quantity' : 'would_hold'}`], 1,
                `${mode}: material loss is an event; its own delivery, unkept and pending builds preserve the original proof`);
        }
    } finally { Providers.build = build; restoreProof(); Config.developerDiagnostics = true; Economy.reset(); }
}

// The first refused held clause covers every rebuild; diagnostic observations keep decisions identical.
{
    const probeKeys = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {})
        .filter(([key]) => /^context:(hold_refused:)/.test(key)));
    const rows = hours => Trip.towns.map((town, at) => Object.freeze([true, hours + at, 100]));
    const actor = (loc, stats = {}) => ({ ...state(), characterId: 902, loc: { locX: 80000 + loc, locY: 148000, locZ: -3500 },
        stats: { ...state().stats, ...stats } });
    const scenario = () => {
        let revision = 1;
        // The board stays still; a moved workshop revision moves every read item's market token.
        const at = { ...deps, workshops: Workshops.publicForRecipe, workshopRevision: () => revision, routeRows: rows(1) };
        const moveMarket = () => { revision++; at.timestamp += 3600e3; };
        const views = {}, deltas = {};
        const step = (name, build) => { const before = probeKeys(); views[name] = build(); deltas[name] = delta(before, probeKeys()); };
        step('first', () => Economy.forState(actor(0), at));
        // Trip only: the location moves; the rows' content repeats, then moves.
        step('trip_same', () => Economy.forState(actor(100), { ...at, routeRows: rows(1) }));
        at.routeRows = rows(2);
        step('trip_moved', () => Economy.forState(actor(200), at));
        // The bot accepts the decision; then only its leaf moves, to the held build's own output.
        const accepted = views.trip_moved.statsPacket;
        const decided = { decisionSeq: accepted.decisionSeq, wishFocus: accepted.wishFocus, dormantWishes: accepted.dormantWishes };
        step('decided', () => Economy.forState(actor(200, decided), at));
        const leaf = views.decided.statsPacket.activityLeaf;
        moveMarket();
        step('echo', () => Economy.forState(actor(200, { ...decided, activityLeaf: leaf }), at));
        Economy.forgetContext(902, 'explicit_invalidation');
        step('leaf_no_held', () => Economy.forState(actor(200, { ...decided, activityLeaf: 7 }), at));
        // The same key with a held entry of that key: the moved market refuses it.
        moveMarket();
        step('market', () => Economy.forState(actor(200, { ...decided, activityLeaf: 7 }), at));
        // The same key as an unkept build: the held older entry refuses on its decision.
        const later = { ...decided, decisionSeq: decided.decisionSeq + 5, activityLeaf: 7 };
        step('unkept', () => Economy.forState(actor(200, later), { ...at, rememberContext: false }));
        step('decision', () => Economy.forState(actor(200, later), at));
        return { views, deltas, leaf };
    };
    // Off: no counter is reached and the plans are the reference.
    Config.developerDiagnostics = false; Economy.reset();
    const offCalls = [], saved = { count: Diagnostics.count, duration: Diagnostics.duration };
    Diagnostics.count = (...args) => offCalls.push(args); Diagnostics.duration = (...args) => offCalls.push(args);
    const off = scenario();
    Object.assign(Diagnostics, saved);
    assert.deepEqual(offCalls, [], 'diagnostics off: no counter is touched');
    Config.developerDiagnostics = true; Economy.reset();
    const on = scenario();
    for (const name of Object.keys(off.views)) {
        assert.deepEqual(on.views[name].statsPacket, off.views[name].statsPacket, `${name}: counting never changes the decision`);
        assert.deepEqual(on.views[name].network, off.views[name].network, `${name}: the same wishes, funding and activity`);
    }
    assert.notStrictEqual(on.leaf, 0, 'the fixture chooses an activity leaf');
    const one = (name, pattern) => {
        const keys = Object.keys(on.deltas[name]).filter(key => pattern.test(key));
        assert.deepEqual(keys.map(key => on.deltas[name][key]), [1], `${name}: one ${pattern} in ${JSON.stringify(on.deltas[name])}`);
        return keys[0];
    };
    assert.deepEqual(on.deltas.first, { 'context:hold_refused:no_held': 1 }, 'a first build has no held decision');
    assert.strictEqual(one('market', /^context:hold_refused:/), 'context:hold_refused:market_due');
    assert.strictEqual(one('decision', /^context:hold_refused:/), 'context:hold_refused:decision_seq');
}

// RTOKENS: the read set of a build (item ids, their market tokens, spots,
// node bag rows, deadline sides) against the actor's previous build, split
// by key outcome and plan outcome; a moved read set names its first moved kind.
{
    const readsetKeys = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {})
        .filter(([key]) => key.startsWith('context:readset')));
    const rows = hours => Trip.towns.map((town, at) => Object.freeze([true, hours + at, 100]));
    const start = 1e12;
    // A shot investment whose 30-minute deadline the time step crosses; its item has no recipe.
    const actor = () => ({ ...state(), characterId: 903, stats: { ...state().stats, shotRecipeDemand: { at: start, itemId: 999999 } } });
    const scenario = () => {
        let revision = 1;
        const at = { ...deps, timestamp: start + 29 * 60e3, workshops: Workshops.publicForRecipe,
            workshopRevision: () => revision, routeRows: rows(1) };
        const views = {}, deltas = {};
        const step = (name, build) => { const before = readsetKeys(); views[name] = build(); deltas[name] = delta(before, readsetKeys()); };
        step('first', () => Economy.forState(actor(), at));
        Economy.forgetContext(903, 'explicit_invalidation');
        step('repeat', () => Economy.forState(actor(), at));
        // The read items stay; their market tokens move (a workshop revision).
        revision++; Economy.forgetContext(903, 'explicit_invalidation');
        step('market', () => Economy.forState(actor(), at));
        // Only the clock moves, across the investment's deadline.
        at.timestamp = start + 31 * 60e3;
        step('time', () => Economy.forState(actor(), at));
        return { views, deltas };
    };
    Config.developerDiagnostics = false; Economy.reset();
    const offCalls = [], saved = { count: Diagnostics.count, duration: Diagnostics.duration };
    Diagnostics.count = (...args) => offCalls.push(args); Diagnostics.duration = (...args) => offCalls.push(args);
    const off = scenario();
    Object.assign(Diagnostics, saved);
    assert.deepEqual(offCalls, [], 'diagnostics off: no read set is counted');
    Config.developerDiagnostics = true; Economy.reset();
    const on = scenario();
    for (const name of Object.keys(off.views)) {
        assert.strictEqual(on.views[name].inputKey, off.views[name].inputKey, `${name}: the same key`);
        assert.deepEqual(on.views[name].statsPacket, off.views[name].statsPacket, `${name}: counting never changes the decision`);
        assert.deepEqual(on.views[name].network, off.views[name].network, `${name}: the same wishes, funding and activity`);
    }
    assert.deepEqual(on.deltas.first, {}, 'a first build has no previous read set');
    assert.deepEqual(on.deltas.repeat, { 'context:readset:same_key_same:same_plan': 1 }, 'equal reads, equal read set');
    const moved = name => Object.keys(on.deltas[name]).filter(key => key.startsWith('context:readset_moved:'));
    assert.deepEqual(moved('market'), ['context:readset_moved:market'], JSON.stringify(on.deltas.market));
    assert.strictEqual(Object.keys(on.deltas.market).filter(key => /^context:readset:same_key_moved:/.test(key)).length, 1);
    assert.deepEqual(moved('time'), ['context:readset_moved:time'], JSON.stringify(on.deltas.time));
    assert.strictEqual(Object.keys(on.deltas.time).filter(key => /^context:readset:new_key_moved:/.test(key)).length, 1,
        'the deadline is a key part too');
}

// Physical target identity belongs to native improvement admission even when
// no amount, worn stat, bag slot or semantic event changes.
{
    const Policy = invoke('GameServer/Bot/Economy/BotImprovementPolicy');
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const Data = invoke('GameServer/DataCache');
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const weapon = Data.items.find(row => String(row.etc?.rank).toLowerCase() === 'c'
        && Number(row.etc?.cristals) > 0 && row.template?.kind?.startsWith('Weapon.') && Sources.hasSource(row.selfId));
    assert(weapon, 'a source-admitted native C4 weapon exists');
    const originalBuild = Providers.build, targetId = weapon.selfId, restoreProof = proofScope();
    const board = new BoardIndex();
    board.itemRevision = id => board.itemFingerprint(id);
    board.put({ id: 9801, kind: 'shop', storeType: 1, ownerId: 7, town: 'Giran',
        lines: [{ lineId: 1, selfId: targetId, count: 1, price: 5e6 }] });
    const input = { ...state(), characterId: 9801, level: 35, adena: 1e8,
        stats: { classId: 1, exp: Data.experience[34] },
        inventory: Life.inventorySummaryFromItems([
            { id: 1, selfId: 1, amount: 1, equipped: true, slot: 7 },
            { id: 98010, selfId: targetId, amount: 1, equipped: false, enchant: 0, slot: 0 },
            { id: 98011, selfId: 951, amount: 10, equipped: false },
            { id: 98012, selfId: 953, amount: 10, equipped: false },
            { id: 98013, selfId: 1835, amount: 100000, equipped: false }]) };
    const options = { ...deps, timestamp: clock, board };
    const context = { ...Economy.basics(input, options), board };
    assert(context.hunt.perHour > 0, `native hunting income is positive: ${context.hunt.perHour}`);
    assert(context.price(951) > 0, 'the native C4 enchant scroll has a positive observed price');
    const item = input.inventory[targetId].instances[0];
    let opportunity;
    // The native tendency may choose stop. Find a real admitted attempt;
    // do not replace its roll, benefit, cost, recipe or eligibility rules.
    for (let offset = 0; offset < 32 && !opportunity; offset++) {
        item.id = 98010 + offset * 100;
        opportunity = Policy.opportunities(input, context).find(row => row.kind === 'enchant' && row.objectId === item.id);
    }
    assert(opportunity, `a native C4 unequipped ${weapon.template.name} enchant opportunity exists`);
    const oldId = item.id, rootKey = opportunity.key;
    assert(rootKey.startsWith(`enchant:${oldId}:`));
    const changed = { ...input, inventory: { ...input.inventory,
        [targetId]: { ...input.inventory[targetId], instances: [{ ...item, id: oldId + 100000 }] } } };
    assert.deepEqual(Sections.semanticFacts(changed, clock), Sections.semanticFacts(input, clock),
        'old semantic facts cannot see the unequipped physical target ID');
    assert.deepEqual(Floor.stateInventory(changed, Data.items), Floor.stateInventory(input, Data.items));
    assert.equal(changed.inventory[targetId].amount, input.inventory[targetId].amount);
    assert.notDeepEqual(Policy.targetInputs(input), Policy.targetInputs(changed), 'native target inputs include physical identity');
    assert.deepEqual(Policy.targetInputs(input).find(row => row[1] === oldId), [targetId, oldId, 0, false, 0, 1]);
    const ordered = { ...input, inventory: { [targetId]: { ...input.inventory[targetId], amount: 2,
        instances: [{ ...item, id: String(oldId + 1) }, item] } } };
    assert.deepEqual(Policy.targetInputs(ordered).map(row => row[1]), [String(oldId + 1), oldId],
        'target identity types and native enumeration order are preserved');
    assert.equal(Policy.opportunities(changed, { ...Economy.basics(changed, options), board })
        .some(row => row.key === rootKey), false, 'the old physical enchant root disappears at its native owner');
    Providers.build = (...args) => {
        const projection = originalBuild(...args);
        // Keep native generated enchant roots and their complete item graph;
        // unrelated equipment/resale competitors do not choose this fixture.
        const roots = projection.nodes.filter(row => row.key.startsWith('enchant:'));
        return { ...projection, roots: roots.map(row => row.key), moneyPaths: [] };
    };
    const targetInputs = Policy.targetInputs;
    let markReads = 0;
    Policy.targetInputs = (...args) => { markReads++; return targetInputs(...args); };
    const scenario = (enabled, mode) => {
        Config.developerDiagnostics = enabled; Economy.reset();
        const initialReads = markReads;
        const first = Economy.forState(input, options);
        assert.equal(markReads - initialReads, 1, 'the event key scans the native targets once per build, on and off');
        const hitReads = markReads;
        assert.strictEqual(Economy.forState(input, options).plan, first.plan);
        assert.equal(markReads, hitReads, 'a live cache hit scans no improvement targets');
        assert(first.network.focus?.[0]?.startsWith(`enchant:${oldId}:`), 'a real native enchant root is the held focus');
        const next = { ...changed, stats: { ...changed.stats, ...first.statsPacket } };
        if (mode === 'unkept') Economy.forState(next, { ...options, rememberContext: false });
        if (mode === 'pending') Economy.forState({ ...next, incomingPending: true }, options);
        const prior = Diagnostics.metrics().counts?.['context:gate:event_key'] || 0;
        const fresh = Economy.forState(next, options);
        if (enabled) assert.equal((Diagnostics.metrics().counts?.['context:gate:event_key'] || 0) - prior, 1,
            `${mode}: a replaced target moves the retained build's event key across temporary/pending builds`);
        assert.notEqual(fresh.network.focus?.[0], first.network.focus[0], 'the old native focus cannot survive a replaced target ID');
        assert.notEqual(fresh.network.activityLeaf, first.network.activityLeaf, 'the selected native leaf changes too');
        return { first, fresh };
    };
    try {
        for (const mode of ['plain', 'unkept', 'pending']) {
            const off = scenario(false, mode), on = scenario(true, mode);
            for (const key of ['first', 'fresh']) {
                assert.deepEqual(on[key].network, off[key].network, `${mode}: full native network is identical off/on`);
                assert.deepEqual(on[key].statsPacket, off[key].statsPacket, `${mode}: full packet is identical off/on`);
            }
        }
        console.log(`PASS native enchant identity proof: ${rootKey} disappears after objectId-only replacement`);
    } finally { Providers.build = originalBuild; Policy.targetInputs = targetInputs; restoreProof(); Config.developerDiagnostics = true; Economy.reset(); }
}

// The per-build record (tools/timeline) names the cause: the miss reason, the moved key parts, the plan outcome,
// the read-set verdict and the build time; a served request leaves a hit record with what was deferred.
{
    const records = [], saved = { push: Diagnostics.push, enabled: Diagnostics.enabled };
    Diagnostics.push = row => { records.push(row); return true; }; Diagnostics.enabled = () => true;
    Economy.reset();
    const base = { ...state(), characterId: 903 };
    Economy.forState(base, deps);
    Economy.forState({ ...base, adena: 9000 }, deps);
    Economy.forState({ ...base, adena: 9000 }, deps);
    Object.assign(Diagnostics, saved);
    const builds = records.filter(row => row.phase === 'wish_context');
    assert.deepEqual(builds.map(row => [row.reason, row.outcome, row.moved]), [
        ['not_retained', 'first_build', ''],
        ['input_dependency_changed', 'same_plan', 'adena'],
        ['hit_same_inputs', 'held', '']], JSON.stringify(builds));
    assert.strictEqual(builds[0].readset, 'none', 'a first build has no read set to compare');
    assert.ok(['same', ...Economy.READSET_KINDS || ['item', 'market', 'spot', 'node', 'time']].includes(builds[1].readset), builds[1].readset);
    assert.strictEqual(builds[2].readset, undefined);
    assert.ok(builds[0].durationMs >= 0 && builds[1].durationMs >= 0, 'a build records its time');
    assert.strictEqual(builds[2].durationMs, undefined, 'a hit has no build time');
}

// A late read through a stored build's view (a price, a spot value) joins the
// read set its held entry keeps: the next served view's fence names it.
{
    Economy.reset();
    const actor = { ...state(), characterId: 904 };
    const fenceOf = view => { const fields = Economy.decodeCalculationFence(view.calculationFence);
        assert.ok(fields, 'the view has a calculation fence');
        return { items: fields[1][1].filter((_, at) => at % 2 === 0), spots: fields[2].map(([id]) => id) }; };
    const built = Economy.forState(actor, deps);
    const before = fenceOf(built);
    const item = 990003, spot = deps.spots.find(row => row?.id && !before.spots.includes(row.id));
    assert.ok(!before.items.includes(item) && spot, 'fixture: an item and a spot the build did not read');
    built.price(item); built.spotValue(spot);
    const served = Economy.forState(actor, deps);
    assert.strictEqual(served.plan, built.plan, 'the held entry serves the second request');
    const after = fenceOf(served);
    assert.ok(after.items.includes(item), 'a late price read joins the held item reads');
    assert.ok(after.spots.includes(spot.id), 'a late spot read joins the held spot reads');
}

// Sampled owner: the projection hash, its size and the provider block layers are recorded; the same
// state rebuilt after an explicit release repeats the projection (`same` is a lower bound in general).
{
    const saved = { economyDiagnostics: Config.economyDiagnostics, economyDiagnosticsBotIds: Config.economyDiagnosticsBotIds };
    Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '901';
    try {
        Economy.reset();
        const counts = () => Diagnostics.metrics().counts || {};
        Economy.forState(state(), deps);
        const sameBefore = counts()['context:projection:same'] || 0;
        Economy.forgetContext(901, 'explicit_invalidation');
        Economy.forState(state(), deps);
        assert.strictEqual((counts()['context:projection:same'] || 0) - sameBefore, 1,
            'an unchanged state rebuilds the same projection');
        assert.ok(Object.keys(counts()).some(key => key.startsWith('context:projection_size:')), 'a sampled owner records the size');
        const durations = Diagnostics.metrics().durations || {};
        for (const layer of ['build', 'sources', 'benefits', 'admission', 'tail'])
            assert.ok(durations[`provider:${layer}`]?.count > 0, `provider:${layer} is timed`);
        // An unsampled owner pays for neither the hash nor the size.
        Config.economyDiagnosticsBotIds = '777';
        const projectionKeys = () => Object.keys(counts()).filter(key => key.startsWith('context:projection')).map(key => key + counts()[key]);
        const sampled = projectionKeys();
        Economy.forState(state(), deps); Economy.forgetContext(901, 'explicit_invalidation'); Economy.forState(state(), deps);
        assert.deepEqual(projectionKeys(), sampled, 'an unsampled owner adds no projection counts');
    } finally {
        Object.assign(Config, saved); Economy.reset();
    }
}

Date.now = realNow; Config.developerDiagnostics = false; Economy.reset();
console.log('test_economy_context_shadow: ok');
