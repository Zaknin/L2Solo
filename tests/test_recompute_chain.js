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
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
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
const ProductionIndex = require('../src/GameServer/Bot/Economy/RecipeProductionIndex');
const RecipeCatalog = require('../src/GameServer/Knowledge/RecipeCatalog');
const Recipes = require('../src/GameServer/Items/C4RecipeItems');
const Sources = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const CraftEligibility = require('../src/GameServer/Bot/Economy/CraftEligibility');
const OccupationSources = require('../src/GameServer/Bot/Population/ColdOccupationSources');
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
        quantityRows: Network.unpackQuantityInputs(first.plan.quantityInputs)?.rows.length ?? null,
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
    assert.equal(verdict(published, accepted).reason, 'baseline_clock', 'runtime clock reversal refuses the same proof');
    clock = forwards;
    for (const invalid of [{ sample: null }, { sample: 's1:bad' }, { share: undefined }, { share: 2 }]) {
        assert.equal(verdict(published, { ...accepted, baseline: { ...accepted.baseline, ...invalid } }).reason, 'baseline',
            'a malformed accepted observation refuses before any soft deadline');
    }
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
    scenario('native ordered production scope', () => {
        const recipes = RecipeCatalog.recipeItemRows(Recipes).filter(recipe => recipe.type === 'dwarven'
            && recipe.level > 0 && recipe.level <= 9 && Sources.allowsRecipe(recipe));
        const variants = new Map();
        for (const recipe of recipes) variants.set(recipe.productId, (variants.get(recipe.productId) || 0) + 1);
        const [firstRecipe, secondRecipe] = recipes.filter(recipe => variants.get(recipe.productId) === 1);
        assert(firstRecipe && secondRecipe, 'the native catalog supplies two distinct production products');
        const nativeBoard = new BoardIndex(), index = ProductionIndex.forBoard(nativeBoard), scope = index.scopeFor(9);
        const empty = index.contentIdentity(scope);
        const put = (book, recipe, price = 100) => book.put({ id: recipe.productId, ownerId: 998001,
            storeType: 3, kind: 'shop', town: 'Giran', lines: [{ lineId: recipe.productId,
                selfId: recipe.productId, count: 100, enchant: 0, price }] });
        put(nativeBoard, firstRecipe); index.update(firstRecipe.productId);
        put(nativeBoard, secondRecipe); index.update(secondRecipe.productId);
        const ordered = index.contentIdentity(scope), revision = index.revision(scope);
        assert.notEqual(ordered, empty);
        put(nativeBoard, firstRecipe, 200); index.update(firstRecipe.productId);
        assert.equal(index.contentIdentity(scope), ordered, 'prices stay an item dependency, not membership');
        assert.equal(index.revision(scope), revision);
        const copiedBoard = new BoardIndex(); put(copiedBoard, firstRecipe); put(copiedBoard, secondRecipe);
        const copied = ProductionIndex.forBoard(copiedBoard);
        assert.equal(copied.contentIdentity(scope), ordered, 'fresh owner content identity survives different revision history');
        assert.notEqual(copied.revision(scope), revision);
        nativeBoard.remove(firstRecipe.productId); index.update(firstRecipe.productId);
        put(nativeBoard, firstRecipe); index.update(firstRecipe.productId);
        assert.notEqual(index.contentIdentity(scope), ordered, 'native insertion order is part of admission identity');
        index.reset();
        assert.equal(index.contentIdentity(scope), empty);
        assert.equal(index.contentIdentity('unknown'), null);
        console.log('PASS native production membership / ordered identity / reset / stable restart content');
    });
    scenario('native retained nomination basis', () => {
        // This is a public native selector fixture, not a claim that the
        // complete armed graph selected either of these power roots.
        const context = Economy.basics(input, options());
        const slot = [...Providers.gearCandidates(published, context)].find(([, rows]) => rows.length > 1);
        assert(slot, 'the native kit and prices supply two admitted finalists in one slot');
        const [previousId, selectedId] = slot[1].slice(0, 2).map(item => item.selfId);
        const before = { ...published, stats: { ...published.stats, equipmentPlan: null,
            wishFocus: [`power:${previousId}:${slot[0]}`, ...published.stats.wishFocus.slice(1)] } };
        const after = { ...before, stats: { ...before.stats,
            wishFocus: [`power:${selectedId}:${slot[0]}`, ...before.stats.wishFocus.slice(1)] } };
        const rows = (state, extra = {}) => [...Providers.gearCandidates(state, { ...context, ...extra })]
            .map(([key, items]) => [key, items.map(item => item.selfId)]);
        const original = rows(before), republished = rows(after), basis = Providers.nominationBasis(before);
        assert.notDeepEqual(republished, original, 'changing only the focus changes native retained nomination order');
        assert.deepEqual(rows(after, { nominationBasis: basis }), original,
            'the captured two native IDs retain exactly the old selector rows and order');
        assert.deepEqual(basis, [0, previousId]);
        assert(Object.isFrozen(basis));
        console.log(`PASS native selector focus ${previousId}->${selectedId} / original basis equality (not a whole-graph choice proof)`);
    });
    scenario('native production discovery soft dependency', () => {
        Economy.reset(); clock = T;
        // The existing producer preparation fixture reaches native Create
        // Item first at Dwarven Fighter level5, before the Artisan's wider
        // recipe domain. Keep its complete native proof, including zeroes.
        const beginner = actor(9803, 53, 5), level = CraftEligibility.craftLevelFor(beginner);
        assert(level > 0, 'the native beginner has learned Create Item');
        const nativeIndex = OccupationSources.recipeIndex(board), scope = nativeIndex.scopeFor(level);
        const build = Economy.forState(beginner, options()), card = Decisions.advisory(build, beginner, beginner.activity, options());
        assert(card?.eventProof, JSON.stringify({ blocked: 'native beginner has no complete proof',
            quantityRows: Network.unpackQuantityInputs(build.plan.quantityInputs)?.rows.length ?? null, leaf: build.network.activity }));
        const state = publish(beginner, build), members = new Set([...nativeIndex.rowsFor(level)].map(recipe => recipe.recipeId));
        const read = new Set([...card.eventProof.market].map(row => row[0]));
        const added = RecipeCatalog.recipeItemRows(Recipes).find(recipe => recipe.type === 'dwarven'
            && recipe.level > 0 && recipe.level <= level && Sources.allowsRecipe(recipe)
            && !members.has(recipe.recipeId) && !read.has(recipe.productId));
        assert(added, 'a native product outside the completed item read set can open production');
        const recordId = 998003;
        try {
            assert.deepEqual(card.eventProof.producerScope, [scope, nativeIndex.contentIdentity(scope)]);
            const hard = Economy.eventInputKey(state, options(), clock, card.activity, card.card.activity);
            board.put({ id: recordId, ownerId: 998004, storeType: 3, kind: 'shop', town: 'Giran',
                lines: [{ lineId: recordId, selfId: added.productId, count: 100, enchant: 0, price: 1000 }] });
            nativeIndex.update(added.productId);
            assert([...nativeIndex.rowsFor(level)].some(recipe => recipe.recipeId === added.recipeId));
            assert.notEqual(nativeIndex.contentIdentity(scope), card.eventProof.producerScope[1]);
            assert.equal(Economy.eventInputKey(state, options(), clock, card.activity, card.card.activity), hard,
                'public discovery is a soft source dependency, not a hard market fingerprint');
            const deadline = Sections.softDeadline(card.baseline, 'market');
            clock = deadline - 1;
            assert.equal(verdict(state, card).valid, true, JSON.stringify(verdict(state, card)));
            clock = deadline;
            const rejected = verdict(state, card);
            assert.equal(rejected.reason, 'market', JSON.stringify(rejected));
            assert.equal(rejected.touchedSections, Sections.sectionMask(['sources', 'benefits']));
            assert.equal(Sections.softDeadline(card.baseline, 'market'), deadline, 'checking never renews the original deadline');
        } finally { board.remove(recordId); nativeIndex.update(added.productId); }
        console.log('PASS native previously unread producer / original soft market deadline / touched sections');
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
        // Recreate the actual owner card, then erase process-local economy
        // state: the saved field and the native owners are all that remain.
        // The largest section clocks a live baseline can carry beside the field.
        const worstClocks = Sections.clockBytes({ ages: Object.values(Sections.SOFT_DELAY) });
        const PROOF_FIELDS = ['version', 'restartable', 'owner', 'at', 'generation', 'decision', 'activity', 'hard',
            'quantities', 'liquidation', 'stockRoots', 'bands', 'safety', 'hourAdena', 'producerScope'];
        const decide = (input, label) => {
            Economy.reset(); clock = T;
            const build = Economy.forState(input, options());
            const card = Decisions.advisory(build, input, input.activity, options());
            assert(card?.eventProof, JSON.stringify({ blocked: `native ${label} has no accepted executable proof`,
                focus: build.network.focus, leaf: build.network.activity,
                quantities: Network.unpackQuantityInputs(build.plan.quantityInputs)?.rows.length ?? null }));
            const prefix = Economy.restartEventProof(card.eventProof, card);
            assert(prefix, `the native ${label} proof has a restart prefix`);
            assert.equal(prefix[0], 4, 'binary prefix format');
            // Strict deep equality compares every Number with Object.is (-0 too).
            const decoded = Economy.restoreEventProof(prefix, card);
            for (const name of PROOF_FIELDS) assert.deepEqual(decoded[name], card.eventProof[name], `${label} restart keeps ${name} exactly`);
            const field = card.saved ? Buffer.byteLength(JSON.stringify({ wishAdvisory: card.saved })) : null;
            const clocks = Sections.clockBytes(card.baseline);
            console.log(`INFO native ${label} restart rows=${Network.unpackQuantityInputs(card.eventProof.quantities).rows.length} quantityBytes=${card.eventProof.quantities.byteLength} card=${card.card.data.byteLength} prefix=${prefix.byteLength} field=${field} clocks=${clocks} worstClocks=${worstClocks}`);
            assert(card.saved && field + Math.max(clocks, worstClocks) <= Restart.MAX_BYTES, JSON.stringify({ blocked: `native ${label} restart proof does not fit the unchanged 1KB budget`,
                cardBytes: card.card.data.byteLength, prefixBytes: prefix.byteLength, field, clocks, worstClocks }));
            return { input, build, card, prefix, field, clocks };
        };
        // A process restart: new economy, memory and native table owners.
        const restart = ({ input, build }) => {
            const saved = JSON.parse(JSON.stringify(publish(input, build)));
            Economy.reset(); clock = T + 1000;
            const oldIdentity = memory.contentIdentity(input.characterId), memorySnapshot = memory.snapshot(input.characterId);
            memory = new InteractionMemory(); memory.accept(memorySnapshot);
            assert.equal(memory.contentIdentity(input.characterId), oldIdentity, 'native accepted memory contents survive packing in a new process owner');
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
            return { saved, restored };
        };

        // The typical armed hunter keeps its held decision across a restart.
        const armed = decide(input, 'armed');
        const armedRestart = restart(armed);
        assert.deepEqual(Buffer.from(armedRestart.restored.card.data), Buffer.from(armed.card.card.data), 'every armed card byte survives');
        console.log(`PASS native armed restart field=${armed.field} + worst clocks ${worstClocks} = ${armed.field + worstClocks}/${Restart.MAX_BYTES}`);

        // Corrupt, old or oversize prefixes are refused whole: restore -> null -> rebuild.
        const { prefix: armedPrefix, card: armedCard } = armed;
        const refused = (bytes, why) => assert.equal(Economy.restoreEventProof(Uint8Array.from(bytes), armedCard), null, why);
        for (const version of [2, 3, 5]) refused([version, ...armedPrefix.subarray(1)], `format ${version} is not this prefix`);
        for (let size = 0; size < armedPrefix.length; size++) refused(armedPrefix.subarray(0, size), 'a truncated prefix never becomes a partial proof');
        refused([...armedPrefix, 0], 'a trailing byte refuses');
        refused([4, ...new Uint8Array(65536)], 'the owner\'s 64 KiB raw bound refuses');
        // Fixed offsets from the end: quantities, the one-byte empty producer
        // scope, then hourAdena as its tag and raw double.
        const quantityBytes = armedCard.eventProof.quantities.byteLength;
        const scopeAt = armedPrefix.length - quantityBytes - 1;
        const [scope, content] = armedCard.eventProof.producerScope;
        assert.equal(content, createHash('sha256').update('[]').digest('hex'), 'this armed fixture reads empty producer content');
        assert.equal(armedPrefix[scopeAt], Number(scope.split(':')[1]), 'the empty scope is its level byte alone');
        assert(!Number.isInteger(armedCard.eventProof.hourAdena) && armedPrefix[scopeAt - 9] === 1, 'hourAdena is a raw double');
        const corrupt = (at, value) => Object.assign(Uint8Array.from(armedPrefix), { [at]: value });
        refused(corrupt(scopeAt, 10), 'an unknown producer level refuses');
        refused(corrupt(scopeAt, 32), 'an unknown producer scope tag refuses');
        refused(corrupt(scopeAt + 1, 2), 'an old quantity codec version refuses');
        refused(corrupt(scopeAt - 9, 5), 'an unknown number tag refuses');
        refused(corrupt(scopeAt - 9, 0), 'an integer tag cannot reread a double');
        console.log(`PASS native restart prefix rejects old formats / ${armedPrefix.length} truncations / trailing / oversize / tags`);

        // This is a second genuine native actor, not a smaller projection or
        // truncated proof of the armed cohort.
        const starter = decide(actor(9802, 0, 1), 'starter');
        const { saved, restored } = restart(starter);
        console.log(`PASS native saved restart bytes field=${starter.field} + worst clocks ${worstClocks} = ${starter.field + worstClocks}/${Restart.MAX_BYTES}`);
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
        const quantities = Network.unpackQuantityInputs(build.plan.quantityInputs);
        assert(quantities, 'the completed native crystal build captures all quantity answers within its bound');
        console.log(`INFO native crystal quantity rows=${quantities.rows.length} packed=${build.plan.quantityInputs.byteLength}`);
        const competing = new Set(quantities.rows
            .filter(row => row[0] === 'stock' && row[2] === 1458).map(row => row[1]));
        const crystalReads = quantities.rows.filter(row => (row[0] === 'stock' || row[0] === 'stockPhysical' ? row[2] : row[1]) === 1458);
        console.log(`INFO native crystal1458 clauses=${JSON.stringify(crystalReads)} rootCount=${competing.size}`);
        assert(crystalReads.length, 'this native cohort must actually consume a physical crystal input');
        const readers = state => ({ ...Providers.quantityReaders(state), stockFor: build.stockFor });
        assert.equal(Network.quantityInputsHold(build.plan.quantityInputs, readers(crystal)), true);
        assert.equal(competing.size, 0, 'this cohort did not consume allocation stock1458; it cannot prove competing-root changes');
        assert.equal(build.network.activity, null);
        assert.equal(build.plan.pending, false);
        assert.equal(build.intentPending, false);
        assert.equal(build.network.activityLeaf, 0);
        const acceptedNull = Decisions.advisory(build, crystal, crystal.activity, options());
        assert(acceptedNull?.eventProof, 'a completed native graph without an economic action has a complete proof');
        assert.strictEqual(acceptedNull.eventProof.activity, null);
        assert.strictEqual(Economy.wireEventProof(acceptedNull.eventProof).activity, null);
        const nullPrefix = Economy.restartEventProof(acceptedNull.eventProof, acceptedNull);
        assert(nullPrefix, 'the complete native null proof has a lossless prefix');
        assert.strictEqual(Economy.restoreEventProof(nullPrefix, acceptedNull).activity, null);
        assert.equal(Economy.restoreEventProof(nullPrefix, { ...acceptedNull, activityLeaf: 1 }), null);
        const publishedNull = publish(crystal, build);
        assert.equal(verdict(publishedNull, acceptedNull).valid, true, JSON.stringify(verdict(publishedNull, acceptedNull)));
        assert.equal(Decisions.refusal(publishedNull, acceptedNull, options()), '');
        assert.strictEqual(Economy.forState(publishedNull, options()).plan, build.plan);
        const capture = plan => Economy.captureEventProof(crystal, {
            producerSource: null, producerScope: acceptedNull.eventProof.producerScope
        }, { plan, reads: acceptedNull.eventProof.market, spots: acceptedNull.eventProof.spots });
        assert.equal(capture({ ...build.plan, pending: true }), null, 'pending null is not a completed intention');
        assert.equal(capture({ ...build.plan, intentPending: true }), null, 'unknown native intent cannot become accepted empty');
        assert.equal(capture({ ...build.plan, quantityInputs: null }), null, 'missing quantity proof does not become accepted empty');
        assert.equal(capture({ ...build.plan, network: { ...build.plan.network, activity: undefined } }), null,
            'missing activity is distinct from explicit native null');
        const loss = { ...crystal, inventory: { ...inventory, 1458: { ...inventory[1458], amount: 140 } } };
        assert.equal(Network.quantityInputsHold(build.plan.quantityInputs, readers(loss)), true,
            'native presence questions tolerate a decrement that keeps the same positive answer');
        const exhausted = { ...crystal, inventory: { ...inventory, 1458: { ...inventory[1458], amount: 0 } } };
        assert.equal(Network.quantityInputsHold(build.plan.quantityInputs, readers(exhausted)), false,
            'the actual native presence predicate crosses when physical crystals are exhausted');
        const exhaustedPublished = { ...publishedNull, inventory: exhausted.inventory };
        assert.equal(verdict(exhaustedPublished, acceptedNull).valid, false,
            'completed null retains all native quantity and structural event checks');
        assert.equal(verdict(publishedNull, acceptedNull, {}, { leaf: undefined }).valid, false);
        assert.equal(verdict(publishedNull, { ...acceptedNull, eventProof: null }).valid, false);

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

    // Real bags ask p50 220 / p90 705 distinct quantity questions: a large
    // proof is held packed and the verdict reads every row of it.
    scenario('a 600-row quantity proof is held packed and read whole', () => {
        const real = Network.unpackQuantityInputs(accepted.eventProof.quantities), reads = Network.createQuantityInputs();
        for (const row of real.rows) {
            if (row[0] === 'stock') reads.stock(row[2], row[1], { owned: row[3], incoming: row[4] });
            else if (row[0] === 'stockPhysical') reads.stockPhysical(row[1], row[2], row[3]);
            else reads[row[0]](row[1], row[2]);
        }
        // Items the bot does not hold; the last one is an incoming question.
        const last = 3000000 + 600;
        for (let id = 3000000 + real.rows.length + 1; id < last; id++) reads.present(id, 0);
        reads.incoming(last, 0);
        const packed = reads.finish();
        assert(packed instanceof Uint8Array, 'a 600-row native read list fits the packed bound');
        const rows = Network.unpackQuantityInputs(packed).rows;
        assert.equal(rows.length, 600);
        assert.deepEqual(rows.slice(0, real.rows.length), real.rows, 'the packed form keeps every captured row exactly');
        console.log(`INFO 600-row proof packed=${packed.byteLength} B (${(packed.byteLength / 600).toFixed(1)} B/row); `
            + `armed fixture ${real.rows.length} rows packed=${accepted.eventProof.quantities.byteLength} B`);
        const large = { ...accepted, eventProof: { ...accepted.eventProof, quantities: packed } };
        assert.equal(verdict(published, large).valid, true, JSON.stringify(verdict(published, large)));
        const received = Decisions.receiveAdvisory(structuredClone(Decisions.wireAdvisory(large)));
        assert(received, 'the large packed proof crosses the thread wire');
        assert.deepEqual(Buffer.from(received.eventProof.quantities), Buffer.from(packed));
        assert.equal(verdict(published, received).valid, true, JSON.stringify(verdict(published, received)));
        const prefix = Economy.restartEventProof(large.eventProof, large);
        assert(prefix, 'the restart prefix writes the held bytes');
        assert.deepEqual(Buffer.from(Economy.restoreEventProof(prefix, large).quantities), Buffer.from(packed));
        const moved = { ...published, acceptedIncoming: { ...published.acceptedIncoming, [last]: 1 } };
        assert.equal(verdict(moved, large).reason, 'quantity', 'the 600th row is read: its answer moving is a quantity event');
        console.log('PASS 600-row packed quantity proof / wire / restart / last row read');
    });

    scenario('packed quantities the codec cannot read are unproved', () => {
        for (const quantities of [Uint8Array.of(9, 9, 9), Uint8Array.of(3, 1, 128), null])
            assert.equal(verdict(published, { ...accepted, eventProof: { ...accepted.eventProof, quantities } }).reason, 'unproved');
        console.log('PASS unreadable packed quantities refuse as unproved');
    });

    scenario('a void quantity proof names its first reason', () => {
        const active = Diagnostics.active, count = Diagnostics.count, named = [];
        Diagnostics.active = () => true;
        Diagnostics.count = (layer, key, label) => { if (key === 'quantity_invalid') named.push(`${layer}:${label}`); };
        try {
            const overflow = Network.createQuantityInputs();
            for (let id = 1; id <= Network.QUANTITY_INPUT_LIMIT + 1; id++) overflow.present(id, 0);
            assert.equal(overflow.finish(), null, 'one row beyond the cap voids the proof, never a prefix');
            const conflict = Network.createQuantityInputs();
            conflict.physical(57, 10); conflict.physical(57, 11); conflict.unsupported();
            assert.equal(conflict.finish(), null);
            const complete = Network.createQuantityInputs();
            complete.physical(57, 10); complete.physical(57, 10);
            assert.equal(Network.unpackQuantityInputs(complete.finish()).rows.length, 1);
            assert.deepEqual(named, ['context:rows', 'context:conflict'], 'the first reason only, once per proof');
        } finally { Diagnostics.active = active; Diagnostics.count = count; }
        console.log('PASS void quantity proof reasons');
    });

    assert.equal(failures.length, 0, failures.map(({ name, error }) => `${name}: ${error.stack}`).join('\n'));
    console.log('PASS recompute native chain');
} finally {
    Warehouse.useRowSource(null); Supplies.useRowSource(null); Date.now = realNow;
    Economy.reset();
}
