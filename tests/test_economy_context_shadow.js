'use strict';
// The economy hold and its counters (hold:economy, context:gate). Never a decision input.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'economy-context-shadow-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const InventoryLimits = invoke('GameServer/Inventory/InventoryLimits');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const state = () => ({ characterId: 901, updatedAt: 1, level: 20, phase: 'cold', activity: 'resting', adena: 100,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } }, currentRegion: 'Giran',
    simulation: { revision: 2 }, loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
const hold = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('hold:economy:')));
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
// The state after the bot accepted a view's decision (its packet in stats):
// the held build's echo (decision sequence, leaf, focus) is its output.
const accept = (view, current = state()) => ({ ...current, stats: { ...current.stats, ...view.statsPacket } });
function delta(before, after) {
    const out = {};
    for (const [key, value] of Object.entries(after)) if (value !== (before[key] || 0)) out[key] = value - (before[key] || 0);
    return out;
}

// Off: no diagnostic call is reached, the decision path is unchanged.
const original = { count: Diagnostics.count, duration: Diagnostics.duration, enabled: Diagnostics.enabled, push: Diagnostics.push,
    laps: Diagnostics.laps };
let restoreScope = proofScope();
Config.developerDiagnostics = false; Economy.reset();
for (const key of Object.keys(original)) Diagnostics[key] = () => { throw Error(`off reached ${key}`); };
// laps is called unconditionally by the provider and must hand back null (no clock, no allocation) while off.
Diagnostics.laps = prefix => { assert.strictEqual(original.laps(prefix), null, 'laps is null while diagnostics are off'); return null; };
const offFirst = Economy.forState(state(), deps);
assert.strictEqual(Economy.forState(accept(offFirst), deps).plan, offFirst.plan);
Economy.forState(state(), deps); Economy.forgetContext(901, 'state_publication');
Economy.forState(state(), { ...deps, rememberContext: false });
Object.assign(Diagnostics, original);

// On, with a fake clock for deterministic native deadlines. The economy
// place counts every held build's verdict: hold:economy:<held|reason>.
const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
Config.developerDiagnostics = true; Economy.reset();
let before = hold();
const first = Economy.forState(state(), deps);
assert.deepEqual(delta(before, hold()), { 'hold:economy:unproved': 1 }, 'a first build has no held build');
{
    const durations = Diagnostics.metrics().durations || {};
    assert.strictEqual(durations['context:not_retained']?.count, durations.context?.count, 'build time is split by reason');
}

// Publication replaces the facts object while retaining the checked decision.
before = hold();
Economy.forgetContext(901, 'state_publication');
const publicationState = accept(first);
const publication = Economy.forState(publicationState, deps);
assert.strictEqual(publication.plan, first.plan, 'publication retains the same decision');
assert.strictEqual(publication.state, publicationState, 'the view reads the newly published facts');
assert.notStrictEqual(publication.state, first.state, 'publication supplies a new facts object');
assert.deepEqual(delta(before, hold()), { 'hold:economy:held': 1 }, 'publication without changed inputs is not a rebuild');

before = hold(); clock += 7000;
Economy.forgetContext(901, 'explicit_invalidation');
const republished = state();
const second = Economy.forState(republished, deps);
assert.deepEqual(delta(before, hold()), { 'hold:economy:unproved': 1 }, 'a released context has no held build');
assert.deepEqual(second.statsPacket, first.statsPacket, 'counting never changes the decision');

before = hold(); clock += 40000;
assert.strictEqual(Economy.forState(accept(second, republished), deps).plan, second.plan, 'a hit is not a rebuild');
assert.deepEqual(delta(before, hold()), { 'hold:economy:held': 1 });

// The LRU capacity names its own release.
for (let id = 1000; id < 1000 + Economy.RETAIN_LIMIT; id++) Economy.forState({ ...state(), characterId: id }, deps);
before = Diagnostics.metrics().counts || {};
Economy.forState(state(), deps);
assert.deepEqual(Object.keys(delta(before, Diagnostics.metrics().counts || {})).filter(key => /^(hold:economy|context:(eviction|miss)):/.test(key)).sort(),
    ['context:eviction:capacity', 'context:miss:not_retained', 'hold:economy:unproved']);
restoreScope();

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
                .filter(key => key.startsWith('hold:economy:')));
            results.push({ network: result.network, packet: result.statsPacket });
            assert.equal(Object.hasOwn(result.plan.network.activity || {}, 'heldAtDecision'), false,
                'shadow metadata never stamps the live network leaf');
            return { result, quotes: quoteReads - quotes };
        };
        const first = request(native).result;
        assert.equal(first.network.activity?.activity, 'shopping');
        assert.equal(first.network.activity?.amount, 2, 'the real quantity solver subtracts the three owned units');
        const accepted = { ...native, stats: { ...native.stats, ...first.statsPacket } };
        assert.equal(request(accepted).result.plan, first.plan, 'a cache hit preserves the original diagnostic baseline');
        const partial = { ...accepted, acceptedIncoming: { [itemId]: 1 } };
        const part = request(partial, { rememberContext: false });
        if (diagnostic) assert.equal(part.quotes, 1, 'one current offer check on an otherwise quiet partial fill');
        assert.equal(part.result.plan, first.plan, 'a quiet partial fill keeps the held decision');
        offer(99); // Token moved, quote stayed usable: the same buy proof covers soft deferral.
        const transferred = { ...accepted, inventory: { ...accepted.inventory,
            [itemId]: { ...accepted.inventory[itemId], amount: 4 } } };
        const transfer = request(transferred, { rememberContext: false });
        if (diagnostic) assert.equal(transfer.quotes, 1, 'market deferral reuses the baseline-aware offer proof');
        request({ ...partial, incomingPending: true });
        request({ ...accepted, acceptedIncoming: { [itemId]: 2 } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts, [
            ['hold:economy:unproved'], ['hold:economy:held'], ['hold:economy:held'], ['hold:economy:held'],
            ['hold:economy:event_key'], ['hold:economy:check_failed']
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
                .filter(key => key.startsWith('hold:economy:')));
            results.push({ network: result.network, packet: result.statsPacket });
            assert.equal(Object.hasOwn(result.plan.network.activity || {}, 'heldAtDecision'), false);
            return result;
        };
        const first = request(native);
        assert.equal(first.network.activity?.itemId, itemId);
        assert.equal(first.network.activity?.amount, 2);
        const accepted = { ...native, stats: { ...native.stats, ...first.statsPacket } };
        assert.equal(request(accepted).plan, first.plan);
        const partial = { ...accepted, acceptedIncoming: { [itemId]: 1 } };
        request(partial, { rememberContext: false });
        request({ ...accepted, inventory: { ...accepted.inventory, [itemId]: { ...native.inventory[itemId], amount: 4 } } },
            { rememberContext: false });
        request({ ...partial, incomingPending: true });
        request({ ...accepted, acceptedIncoming: { [itemId]: 2 } }, { rememberContext: false });
        request({ ...accepted, inventory: { ...accepted.inventory, [itemId]: { ...native.inventory[itemId], amount: 2 } } },
            { rememberContext: false });
        request({ ...accepted, inventory: { ...accepted.inventory, [targetId]: { selfId: targetId, amount: 1 } } },
            { rememberContext: false });
        if (diagnostic) {
            assert.deepEqual(verdicts, [['hold:economy:unproved'], ['hold:economy:held'], ['hold:economy:held'], ['hold:economy:held'],
                ['hold:economy:event_key'], ['hold:economy:check_failed'], ['hold:economy:quantity'], ['hold:economy:held']],
                'a bag loss below the decision count is a quantity event; a new target stack below the slot limit holds '
                + '(gear progression reserves it: no free stock moved; its equip is the kit event)');
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
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:held'], 'a claimed target stack (never free stock) that leaves the bag holds');
        targetClaimed = false;
        // A funding hunt's drops are not its own progress: they are a wished
        // material reaching its count.
        Economy.reset(); funding = true; targetAmount = 2;
        const fundingHeld = request(native);
        request({ ...native, stats: { ...native.stats, ...fundingHeld.statsPacket }, acceptedIncoming: { [itemId]: 10 } },
            { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:quantity'], 'a funding hunt has no own item: its material rows hold exactly');
        request({ ...native, stats: { ...native.stats, ...fundingHeld.statsPacket }, acceptedIncoming: { [itemId]: 10 },
            inventory: { ...native.inventory, [targetId]: { selfId: targetId, amount: 1 } } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:quantity'], 'a funding hunt\'s moved material rows stay a quantity event beside a new target stack');
        funding = false; targetAmount = 1;
        // A material hunt from none: its first drop is a new bag row of its
        // own item, its progress, not an input event.
        Economy.reset();
        const none = { ...native, inventory: state().inventory };
        const fromNone = request(none);
        assert.equal(fromNone.network.activity?.amount, 5);
        const firstDrop = { ...none, stats: { ...none.stats, ...fromNone.statsPacket },
            inventory: { ...none.inventory, [itemId]: { selfId: itemId, amount: 1, stackable: true } } };
        request(firstDrop, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:held'], 'a material hunt from none holds after its first drop');
        if (diagnostic) {
            // The card path passes only the leaf: its heldAtDecision stands in
            // for the held entry's heldUnits. The options mirror the entry.
            const proof = fromNone.plan.eventProof, leaf = fromNone.network.activity;
            assert.ok(proof, 'a held material hunt carries its event proof');
            const card = cardLeaf => {
                const verdict = {};
                Economy.eventProofHolds(firstDrop, proof, { ...deps }, { baseline: fromNone.plan.statsPacket.wishSections,
                    activity: none.activity, leaf: cardLeaf, mp: Number(none.vitals.mp), timestamp: deps.timestamp, verdict });
                return verdict;
            };
            assert.deepEqual([card({ ...leaf, heldAtDecision: 0 }).valid, card({ ...leaf, heldAtDecision: 0 }).reason], [true, ''],
                'a card from none holds after its first drop with the heldAtDecision on its leaf');
            assert.equal(card(leaf).reason, 'quantity', 'a card leaf without heldAtDecision reads its own drop as a quantity event');
        }
        // The same first drop into the last free slot fills the bag: a full
        // bag is an event even when the new row is the hunt's own progress.
        // With two free slots the same filler and drop still hold.
        const limit = InventoryLimits.forState(none), fillerId = 1869;
        for (const [free, gate] of [[2, 'held'], [1, 'bag']]) {
            Economy.reset();
            const filled = { ...none, inventory: { ...none.inventory,
                [fillerId]: { selfId: fillerId, amount: limit - free - 1, stackable: false } } };
            assert.equal(Floor.stateInventory(filled, DataCache.items).slots, limit - free, 'free slots before the drop');
            const held = request(filled);
            assert.deepEqual([held.network.activity?.rootKey, held.network.activity?.itemId, held.network.activity?.amount],
                [rootKey, itemId, 5], 'a filled bag keeps the same material hunt');
            request({ ...filled, stats: { ...filled.stats, ...held.statsPacket },
                inventory: { ...filled.inventory, [itemId]: { selfId: itemId, amount: 1, stackable: true } } }, { rememberContext: false });
            if (diagnostic) assert.deepEqual(verdicts.at(-1), [`hold:economy:${gate}`],
                `a first drop with ${free} free slot(s) ${gate === 'bag' ? 'fills the bag and refuses' : 'holds'}`);
        }
        // Another root's stock row on the hunted item stays its input: its
        // material reaching that root's count is an event, not the hunt's progress.
        Economy.reset(); second = true;
        const shared = request(native);
        assert.equal(shared.network.activity?.rootKey, rootKey);
        assert.equal(shared.network.activity?.itemId, itemId);
        request({ ...native, stats: { ...native.stats, ...shared.statsPacket },
            inventory: { ...native.inventory, [itemId]: { ...native.inventory[itemId], amount: 4 } } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:quantity'], 'a second root on the hunted item reaching its count refuses');
        second = false;
        Economy.reset();
        const original = request(native);
        const progressed = { ...native, stats: { ...native.stats, ...original.statsPacket }, acceptedIncoming: { [itemId]: 1 } };
        assert.strictEqual(request(progressed).plan, original.plan, 'own progress keeps the held build');
        Economy.forgetContext(913, 'explicit_invalidation');
        const renewed = request(progressed);
        request({ ...native, stats: { ...native.stats, ...renewed.statsPacket } }, { rememberContext: false });
        if (diagnostic) assert.deepEqual(verdicts.at(-1), ['hold:economy:quantity'],
            'an actual completed rebuild advances the baseline; losing its new incoming unit is a quantity event');
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
        .filter(([key]) => key.startsWith('hold:economy:')));
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
            assert.equal(on.counts[`hold:economy:${lost ? 'quantity' : 'held'}`], 1,
                `${mode}: material loss is an event; its own delivery, unkept and pending builds preserve the original proof`);
        }
    } finally { Providers.build = build; restoreProof(); Config.developerDiagnostics = true; Economy.reset(); }
}

// The held build's verdict names every rebuild; diagnostic observations keep decisions identical.
{
    const probeKeys = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {})
        .filter(([key]) => key.startsWith('hold:economy:')));
    const restoreProof = proofScope();
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
        // The held entry's own decision accepted: the moved market refuses it.
        const echo = views.leaf_no_held.statsPacket;
        moveMarket();
        step('market', () => Economy.forState(actor(200, { ...decided, ...echo }), at));
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
    assert.deepEqual(on.deltas.first, { 'hold:economy:unproved': 1 }, 'a first build has no held decision');
    assert.strictEqual(one('market', /^hold:economy:/), 'hold:economy:market');
    assert.strictEqual(one('decision', /^hold:economy:/), 'hold:economy:decision_seq');
    restoreProof();
}

// Physical target identity belongs to native improvement admission even when
// no amount, worn stat, bag slot or semantic event changes.
{
    const Policy = invoke('GameServer/Bot/Economy/BotImprovementPolicy');
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const weapon = DataCache.items.find(row => String(row.etc?.rank).toLowerCase() === 'c'
        && Number(row.etc?.cristals) > 0 && row.template?.kind?.startsWith('Weapon.') && Sources.hasSource(row.selfId));
    assert(weapon, 'a source-admitted native C4 weapon exists');
    const originalBuild = Providers.build, targetId = weapon.selfId, restoreProof = proofScope();
    const board = new BoardIndex();
    board.itemRevision = id => board.itemFingerprint(id);
    board.put({ id: 9801, kind: 'shop', storeType: 1, ownerId: 7, town: 'Giran',
        lines: [{ lineId: 1, selfId: targetId, count: 1, price: 5e6 }] });
    const input = { ...state(), characterId: 9801, level: 35, adena: 1e8,
        stats: { classId: 1, exp: DataCache.experience[34] },
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
    assert.deepEqual(Floor.stateInventory(changed, DataCache.items), Floor.stateInventory(input, DataCache.items));
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
        assert.equal(markReads - initialReads, 2, 'the request key and the proof key each scan the native targets once, on and off');
        const hitReads = markReads;
        assert.strictEqual(Economy.forState({ ...input, stats: { ...input.stats, ...first.statsPacket } }, options).plan, first.plan);
        assert.equal(markReads - hitReads, 1, 'a live cache hit scans the targets once, for its request key');
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

// The per-build record (tools/timeline) names the cause: the miss reason and
// the build time; a served request leaves a hit record.
{
    const records = [], saved = { push: Diagnostics.push, enabled: Diagnostics.enabled }, restoreProof = proofScope();
    Diagnostics.push = row => { records.push(row); return true; }; Diagnostics.enabled = () => true;
    Economy.reset();
    const base = { ...state(), characterId: 903 };
    const built = Economy.forState(base, deps);
    const richer = Economy.forState({ ...accept(built, base), adena: 9000 }, deps);
    Economy.forState({ ...accept(richer, base), adena: 9000 }, deps);
    Object.assign(Diagnostics, saved); restoreProof();
    const builds = records.filter(row => row.phase === 'wish_context');
    assert.deepEqual(builds.map(row => [row.reason, row.outcome]), [
        ['not_retained', undefined],
        // A sampled owner's refused build names whether it changed the plan.
        ['held_refused', 'same_plan'],
        ['hit_same_inputs', 'held']], JSON.stringify(builds));
    assert.ok(builds[0].durationMs >= 0 && builds[1].durationMs >= 0, 'a build records its time');
    assert.strictEqual(builds[2].durationMs, undefined, 'a hit has no build time');
}

// A late read through a stored build's view (a price, a spot value) joins the
// read set its held entry keeps; the held entry still serves the next request.
{
    const restoreProof = proofScope();
    Economy.reset();
    const actor = { ...state(), characterId: 904 };
    const built = Economy.forState(actor, deps);
    built.price(990003); built.spotValue(deps.spots.find(row => row?.id));
    const served = Economy.forState(accept(built, actor), deps);
    assert.strictEqual(served.plan, built.plan, 'the held entry serves the second request');
    restoreProof();
}

// Sampled owner: the provider block layers are timed.
{
    const saved = { economyDiagnostics: Config.economyDiagnostics, economyDiagnosticsBotIds: Config.economyDiagnosticsBotIds };
    Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '901';
    try {
        Economy.reset();
        Economy.forState(state(), deps);
        const durations = Diagnostics.metrics().durations || {};
        for (const layer of ['build', 'sources', 'benefits', 'admission', 'tail'])
            assert.ok(durations[`provider:${layer}`]?.count > 0, `provider:${layer} is timed`);
    } finally {
        Object.assign(Config, saved); Economy.reset();
    }
}

Date.now = realNow; Config.developerDiagnostics = false; Economy.reset();
console.log('test_economy_context_shadow: ok');
