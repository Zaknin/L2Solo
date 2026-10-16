'use strict';
// L70: one verdict "the held economy plan is still valid". Hard events cut
// through at once; soft changes wait for their kind's wall-clock delay since
// the last actual decision (docs/principles.md section 3 point 5).
const assert = require('node:assert/strict');
const { isDeepStrictEqual, inspect } = require('node:util');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l70-held-plan-'));
process.env.L2NODE_CONFIG_FILE = path.join(dir, 'config.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, fs.readFileSync(path.join(__dirname, '../config/default.ini'), 'utf8')
    + `\n[Database]\npath=${dir}/world.sqlite\nhistoryPath=${dir}/history.sqlite\n`);
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const Events = invoke('GameServer/Bot/AI/DecisionEvents');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const RestartDecision = require('../src/GameServer/Bot/Population/EconomyRestartDecision');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
const { BoardIndex, SELL } = invoke('GameServer/AfkTrade/BoardIndex');

const T = 1e12, MINUTE = 60 * 1000;
const board = new BoardIndex();
const deps = { timestamp: T, knowledgeEnabled: true, board, spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure() };
const at = timestamp => ({ ...deps, timestamp });
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const originalBuild = Providers.build;
let builds = 0;
Providers.build = (...args) => { builds++; return originalBuild(...args); };
const bag = extra => Life.inventorySummaryFromItems([
    { id: 1, selfId: 1, amount: 1, equipped: 1, slot: 7 },
    { id: 2, selfId: 1835, amount: 100000, equipped: 0, slot: 0 },
    { id: 3, selfId: 1869, amount: 100000 + extra, equipped: 0, slot: 0 }]);
function subject(characterId, adena = 50) {
    return { characterId, level: 35, phase: 'cold', activity: 'hunting', adena, sp: 0,
        currentRegion: 'Giran', loc: { locX: 80000, locY: 148000, locZ: -3500 }, inventory: bag(0),
        stats: { classId: 1, exp: Data.experience[34], coldCombat: { classId: 1, skillSource: 'database', skills: [] } },
        timing: { lastResolvedAt: T }, updatedAt: T, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
}
// A decided bot: one actual build, its packet adopted as the native step does.
function decided(characterId, adena) {
    let state = subject(characterId, adena);
    const economy = Economy.forState(state, deps);
    state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
    return { state, economy, accepted: Decisions.advisory(economy, state) };
}
// The bot's own result inside one decision: hunting -> resting, free loot
// inside its quantity band, one adena more.
const ownResult = (state, activity = 'resting') => ({ ...state, activity, adena: state.adena + 1, inventory: bag(1),
    updatedAt: state.updatedAt + 1, vitals: { ...state.vitals, mp: state.vitals.mp - 1 }, stats: { ...state.stats } });

function stateDifferences(actual, expected, field = 'state', result = []) {
    if (Object.is(actual, expected) || result.length >= 8) return result;
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
        const show = value => inspect(value, { depth: 0, maxStringLength: 64, breakLength: Infinity });
        result.push(`${field}: ${show(actual)} != ${show(expected)}`);
    } else {
        if (Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) result.push(`${field}: prototype identity differs`);
        for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
            if (result.length >= 8) break;
            if (Object.hasOwn(actual, key) !== Object.hasOwn(expected, key)) result.push(`${field}.${key}: own-property presence differs`);
            else stateDifferences(actual[key], expected[key], `${field}.${key}`, result);
        }
    }
    return result;
}

async function nullLifecycleParity() {
    const nativeTime = 1791741600000, id = 990771;
    const Gear = invoke('GameServer/Bot/AI/BotGear'), Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
    const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex'), Supplies = invoke('GameServer/Clan/ClanSupplyPolicy');
    const Memory = invoke('GameServer/Social/InteractionMemory'), Policy = invoke('GameServer/Social/InteractionMemoryPolicy');
    const nativeBoard = new BoardIndex(), memory = new Memory(), inventory = {};
    memory.accept(Policy.empty(id));
    for (const row of Gear.planFor({ classId: 46, level: 20 }).items) {
        if ([7, 14].includes(row.slot)) continue;
        const held = inventory[row.selfId];
        inventory[row.selfId] = { ...row, amount: Number(held?.amount || 0) + 1, equipped: true,
            equippedCount: Number(held?.equippedCount || 0) + 1, equippedSlots: [...held?.equippedSlots || [], row.slot] };
    }
    inventory[86] = { selfId: 86, amount: 1, slot: 7, equipped: true, equippedCount: 1, equippedSlots: [7] };
    inventory[1463] = { selfId: 1463, amount: 100000 }; inventory[1458] = { selfId: 1458, amount: 141 };
    const crystal = { ...subject(id, 3632378), level: 49, clanId: 7, inventory, updatedAt: nativeTime,
        stats: { classId: 46, exp: Data.experience[48] }, timing: { lastResolvedAt: nativeTime } };
    crystal.stats.coldCombat = Profile.legacySnapshot(crystal, Profile.skillRecordsFromTree(46, 49), nativeTime);
    for (const [item, price] of [[90, 1909712], [166, 206926]]) nativeBoard.put({ id: item, ownerId: 991000 + item,
        storeType: 1, kind: 'shop', town: 'Giran', lines: [{ lineId: item, selfId: item, count: 1, enchant: 0, price }] });
    const workshop = { known: true, recipeId: 0, productId: 0, incomePerHour: 0, cycleHours: 0 };
    Warehouse.useRowSource(() => null, () => true);
    const clanRow = Supplies.prepareRow([7, 1, [], 1]);
    Supplies.useRowSource(clan => clan === 7 ? clanRow : undefined, () => true);
    Economy.configure({ board: nativeBoard, memory: owner => memory.snapshot(owner), memoryIdentity: owner => memory.contentIdentity(owner),
        sourceReady: true, workshop, spots: deps.spots });
    const source = fs.readFileSync(path.join(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), 'utf8');
    const helpers = source.slice(source.indexOf('function withIncomeRoute('), source.indexOf('function reviewMarket('));
    const preparation = source.slice(source.indexOf('async function refreshCraftPacket('), source.indexOf('function cancelRoute('));
    const callback = source.slice(source.indexOf('planLifecycle: async') + 'planLifecycle: '.length, source.indexOf(',\n        emit: send'));
    const enabledOwner = Economy.eventReuseEnabled, diagnostic = Config.developerDiagnostics;
    let enabled = true, fullCalls = 0;
    const nativeOptions = { timestamp: nativeTime, board: nativeBoard, spots: deps.spots, workshop, buyOrderEscrow: 0 };
    try {
        Config.developerDiagnostics = false;
        Economy.eventReuseEnabled = () => enabled;
        const built = Economy.forState(crystal, nativeOptions);
        assert.equal(built.network.activity, null, 'the real class46 crystal cohort completes with no native activity');
        const published = { ...crystal, stats: { ...crystal.stats, ...built.statsPacket } };
        const advice = Decisions.advisory(built, published, published.activity, nativeOptions);
        assert(advice?.eventProof && advice.activityLeaf === 0 && advice.eventProof.activity === null);
        advice.builtAt = nativeTime - 1000;
        const originalBaseline = Sections.baselineIdentity(advice.baseline);
        const states = new Map(), kernel = { states };
        const adapter = { ...Economy, forState(...args) { fullCalls++; return Economy.forState(...args); } };
        const run = require('node:vm').runInNewContext(`${helpers}\n${preparation}\n(${callback})`, {
            invoke: name => name === 'GameServer/Bot/Economy/EconomyContext' ? adapter : invoke(name),
            kernel, boardReady: () => nativeBoard, planningSpots: deps.spots,
            currentPlanningOccupancy: () => invoke('GameServer/Bot/Population/SpotProfiles').occupancySnapshot(deps.spots, []),
            planningNpcCatalog: { plannerOptions: {} },
            occupationFor: async (_state, _at, _context, mode) => mode === 'wish' ? undefined : workshop,
            EconomicTrip: require('../src/GameServer/Bot/Economy/EconomicTrip'), EconomyContext: Economy,
            CraftEligibility: require('../src/GameServer/Bot/Economy/CraftEligibility'), ColdEconomyDecision: Decisions,
            GearAcquisitionPlanner: Planner, GearPlanSelection: Selection, DecisionSections: Sections,
            SpotRiskPolicy: invoke('GameServer/Bot/Population/SpotRiskPolicy'),
            SpotProfiles: invoke('GameServer/Bot/Population/SpotProfiles'), SpotIndex: invoke('GameServer/Bot/AI/SpotIndex'),
            PartyRequestPlanner: invoke('GameServer/Bot/Population/PartyRequestPlanner'),
            PartyWaitFallback: invoke('GameServer/Bot/Population/PartyWaitFallback'), economyDiagnostics: Diagnostics,
            beginHuntingTrip: require('../src/GameServer/Bot/Population/HuntingTravel').beginHuntingTrip
        });
        const active = { status: 'active', strategy: 'luxury_exchange', source: 'wish_network', target: { selfId: 90, slot: 7 },
            next: null, materials: [], recoveryTargets: [], economyInputKey: 'legacy-saved-input' };
        const recovery = { ...Selection.deferredWishPlan(active, {}), recoveryTargets: [{ targetId: 166,
            reason: 'market_unavailable', until: nativeTime + MINUTE, failedAt: nativeTime - 1000 }] };
        const failures = [];
        for (const [name, previousPlan, route, fallback] of [
            ['no plan', null, null, false], ['active wish', active, null, false], ['recovery', recovery, null, false],
            ['native route', active, { needed: true, to: { locX: 81000, locY: 149000, locZ: -3500 }, spotId: 'null-parity', travelMs: 3000 }, false],
            ['clan fallback', { ...active, clanGoal: { clanId: 7, goalKey: 'native-equipment' } }, null, true]
        ]) {
            try {
                const state = { ...published, stats: { ...published.stats, equipmentPlan: previousPlan } };
                const outcomes = [];
                for (const useProof of [false, true]) {
                    enabled = useProof; Economy.forgetContext(id); fullCalls = 0;
                    const owner = { state, context: { route, wishAdvisory: advice } }; states.set(id, owner);
                    const result = await run({ state, context: owner.context, timestamp: nativeTime });
                    assert.equal(fullCalls, useProof && !fallback ? 0 : 1, `${name}: only the ordinary/clan path requests the full native graph`);
                    assert.equal(result.activityPick, null, `${name}: completed null does not invent a native action`);
                    if (useProof && !fallback) {
                        if (route) {
                            assert.equal(owner.context.wishAdvisory, null, `${name}: a new travel target drops the old proof after native finalization`);
                            const why = [];
                            assert.equal(Economy.eventProofHolds(result.plannedState, advice.eventProof, nativeOptions,
                                { baseline: advice.baseline, activity: advice.activity, leaf: null, mp: advice.mp, timestamp: nativeTime, why }), false);
                            assert.deepEqual(why, ['event_key'], `${name}: the actual travel target is a hard event`);
                        } else {
                            assert.equal(owner.context.wishAdvisory.builtAt, advice.builtAt, `${name}: checked null reuse keeps its original build stamp`);
                            assert.strictEqual(owner.context.wishAdvisory.baseline, advice.baseline);
                        }
                        assert.strictEqual(result.plannedState.stats.wishSections, advice.baseline,
                            `${name}: the published baseline remains the accepted original object`);
                        assert.equal(Sections.baselineIdentity(advice.baseline), originalBaseline,
                            `${name}: native finalization does not rewrite the accepted baseline`);
                        assert.equal(result.economyDecision.key, Decisions.stateKey(result.plannedState), `${name}: card binds final native publication`);
                    }
                    outcomes.push(result);
                }
                for (const key of ['activityPick', 'acquisitionPlan', 'partyRequest', 'reusablePartyRequest', 'replanFailure', 'targetNpcId'])
                    assert.deepEqual(outcomes[1][key], outcomes[0][key], `${name}: null reuse matches ordinary native ${key}`);
                // The ordinary build hashes the current previousPlan into choices;
                // reuse retains the accepted input signature from before that own
                // publication. Every other baseline and native state field agrees.
                // Both callbacks return VM DTO containers. Recreate those same
                // three containers on both sides, preserving nested types.
                const comparable = value => ({ ...value, stats: { ...value.stats, wishSections: { ...value.stats.wishSections,
                    ...(!fallback ? { choices: advice.baseline.choices } : {}) } } });
                const actualState = comparable(outcomes[1].plannedState), expectedState = comparable(outcomes[0].plannedState);
                assert(isDeepStrictEqual(actualState, expectedState),
                    `${name}: null reuse matches ordinary native plannedState\n${stateDifferences(actualState, expectedState).join('\n')}`);
                assert.equal(outcomes[1].acquisitionPlan?.economyInputKey, undefined, `${name}: the shared native owner removes the legacy key`);
                if (!fallback) assert.equal(Decisions.sameEconomicOutput(outcomes[0].economyDecision, outcomes[1].economyDecision), true,
                    `${name}: null reuse preserves all packed non-action economics`);
            } catch (error) { failures.push(error); }
        }
        assert.equal(failures.length, 0, failures.map(error => error.stack).join('\n\n'));
    } finally {
        Economy.eventReuseEnabled = enabledOwner; Config.developerDiagnostics = diagnostic;
        Economy.configure(); Warehouse.useRowSource(null); Supplies.useRowSource(null);
    }
}

async function main() {

try {
    {
        const { packQuantityInputs, unpackQuantityInputs } = require('../src/GameServer/Bot/Economy/WishNetwork');
        const proof = { version: 1, rows: [
            ['physical', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], ['present', 2, 1], ['freePresent', 3, 0],
            ['incoming', 4, .125], ['free', 5, -0], ['crystalFree', 6, 1e20],
            ['stock', 'power:🛡:7', 7, 2, .5], ['stockPhysical', 'power:🛡:7', 7, 3],
            ['stock', 'other:8', 8, 0, 0] ] };
        const packed = packQuantityInputs(proof), unpacked = unpackQuantityInputs(packed);
        assert.deepEqual(unpacked, proof, 'all native quantity kinds, row order, strings and Number values survive exactly');
        assert(Object.is(unpacked.rows[4][2], -0));
        assert(Object.isFrozen(unpacked) && Object.isFrozen(unpacked.rows) && unpacked.rows.every(Object.isFrozen));
        for (let size = 0; size < packed.length; size++) assert.equal(unpackQuantityInputs(packed.subarray(0, size)), null,
            'truncated native quantity bytes never become a partial proof');
        assert.deepEqual(unpackQuantityInputs(Uint8Array.from([3, 1, 128, 2])), { version: 1, rows: [['physical', 1, 0]] });
        // Each vector breaks one rule of that minimal valid list: [3, 1, 128, 2].
        for (const bytes of [[...packed, 0], [2, 1, 128, 2], [3, 1, 128, 2, 0], [3, 128, 0, 128, 2],
            [3, 2, 128, 2, 128, 0], [3, 1, 0, 0], [3, 1, 128, 0], [3, 1, 128, 1], [3, 1, 128 + 64, 2, 0],
            [3, 1, 128 + 32, 2], [3, 1, 128 + 16, 2, 1], [3, 1, 128 + 6, 2, 1], [3, 1, 128 + 6, 2, 0, 2, 0, 1, 97],
            [3, 1, 128 + 6, 2, 0, 0, 0, 1, 255], [3, 1, 128 + 6, 2, 0, 1, 0, 1, 97, 1, 1, 97], [3, 1, 128, 130, 0]])
            assert.equal(unpackQuantityInputs(Uint8Array.from(bytes)), null, 'old versions, malformed tags, indexes, ids, UTF-8 or trailing bytes refuse');
        for (const row of [['stock', '\ud800', 1, 0, 0], ['physical', 1, -1], ['physical', 1, Infinity],
            ['physical', 1, NaN], ['physical', 1.5, 0], ['stock', 'x'.repeat(4096), 1, 0, 0]])
            assert.equal(packQuantityInputs({ version: 1, rows: [row] }), null);
        assert.equal(packQuantityInputs({ version: 1, rows: Array(129).fill(['physical', 1, 0]) }), null);
        assert.equal(unpackQuantityInputs(new Uint8Array(4097)), null);
    }
    {
        const decision = Decisions.compact({ key: 'prepared-native-fixture', updatedAt: T, inputHash: 12345, riskWeight: 1.5,
            usefulness: new Float32Array([1869, .125, 1870, 2.5]), watch: [[1869, 4, 3.5, 3]], materials: [[1870, 29]],
            wish: [Decisions.kindCode('shots') | 128, 1200, 37],
            clan: { horizonHours: 2, huntPerHour: 150, plan: { itemId: 17, valueHours: 3 } },
            workshop: { known: true, recipeId: 22, productId: 1463, incomePerHour: 100, cycleHours: .5 },
            feasibility: [12345, 2, 3], shot: { craft: { recipeId: 22, batches: 1 } },
            activity: { activity: 'hunting', rootKey: 'stock:shots', itemId: 1870, amount: 29, npcId: 1001, spotId: 7 } });
        const baseline = { at: T }, proof = {}, saved = [3, 'original'];
        const accepted = { card: decision, baseline, eventProof: proof, saved, mp: 100, preparedMp: 100 };
        const thin = { network: { activity: decision.activity } }, originalBytes = Buffer.from(decision.data).slice();
        const refreshed = { decision, economy: thin, advisory: accepted };
        const shot = { craft: { recipeId: 22, batches: 2 } };
        const next = Decisions.refreshPreparedCraft(refreshed, shot, 70);
        assert(next, 'a completed native preparation can replace its physical packet');
        assert.deepEqual(next.decision.shot, shot);
        for (const name of ['usefulness', 'wish', 'urgency', 'materials', 'watch', 'activity', 'feasibility', 'clan', 'workshop',
            'inputHash', 'updatedAt', 'riskWeight', 'flags', 'key'])
            assert.deepEqual(next.decision[name], decision[name], `MP preparation preserves the original ${name}`);
        assert.deepEqual(Buffer.from(decision.data), originalBytes, 'the accepted original card is never mutated');
        assert.equal(next.advisory.preparedMp, 70);
        assert.equal(next.advisory.mp, 100, 'physical preparation does not restamp the decision MP baseline');
        assert.strictEqual(next.advisory.baseline, baseline);
        assert.strictEqual(next.advisory.eventProof, proof);
        assert.strictEqual(next.advisory.saved, saved);
        const returned = Decisions.refreshPreparedCraft(next, decision.shot, 100);
        assert.deepEqual(Buffer.from(returned.decision.data), originalBytes, 'replacing the shot back preserves every original byte');
        assert.equal(returned.advisory.preparedMp, 100, 'returning to the original MP still completes a new physical preparation');
        const absent = Decisions.refreshPreparedCraft(next, null, 80);
        assert.equal(absent.decision.shot, null);
        const restored = Decisions.refreshPreparedCraft(absent, decision.shot, 100);
        assert.deepEqual(Buffer.from(restored.decision.data), originalBytes, 'removing and adding a shot preserves all other sections');
        assert.deepEqual(Decisions.refreshPreparedCraft(next, { large: 'x'.repeat(1000) }, 60).decision.shot, { unknown: true },
            'the replacement uses the same native payload cap as a fresh card');
    }
    {
        const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
        const Wire = require('../src/GameServer/Bot/Population/ColdStateWire');
        const metadata = Generation.metadata(), identity = Generation.current();
        const message = Protocol.envelope('init', 'generation-fixture', { config: {}, recomputeGeneration: metadata });
        message.payload = Wire.packPayload(message.type, message.payload);
        const received = JSON.parse(JSON.stringify(message));
        assert.equal(Protocol.validateEnvelope(received, 'main', { workerEpoch: 'generation-fixture' }).ok, true);
        const payload = Wire.unpackPayload(received.type, received.payload);
        assert.deepEqual(payload.recomputeGeneration, metadata, 'the actual init wire preserves the native generation');
        Generation.configure(payload.recomputeGeneration);
        assert.equal(Generation.current(), identity, 'the worker init metadata derives the same native generation');
    }
    // Transport/lifetime proof uses a real native card; the opaque event
    // proof's gameplay validation remains the economy owner's responsibility.
    {
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        Warehouse.useRowSource(() => null, () => true);
        const { state, economy, accepted } = decided(93040);
        assert(accepted, 'the native fixture produces a complete compact card');
        const transportProof = { ...accepted.eventProof };
        delete transportProof.market; delete transportProof.spots;
        const original = { ...accepted, characterId: state.characterId, eventProof: { ...transportProof,
            restartable: true, quantities: { version: 1, rows: [] }, liquidation: { basis: { shots: { itemId: 1835, target: 0,
                beginnerCurrent: 0 }, potions: { target: 0 }, excluded: [] }, rows: [] },
            stockRoots: [], bands: [], safety: [0, 0, 0], hourAdena: 0 } };
        const encode = value => RestartDecision.encode({ ...value, eventProof: Economy.restartEventProof(value.eventProof, value) },
            Sections.baselineIdentity(value.baseline), Sections.clockBytes(value.baseline));
        const saved = encode(original);
        assert(saved, 'a compact card and bounded proof fit the saved field');
        assert(Buffer.byteLength(JSON.stringify({ wishAdvisory: saved })) <= 1024);
        const published = { ...state, stats: { ...state.stats, wishAdvisory: saved } };
        const payload = require('node:zlib').inflateRawSync(Buffer.from(saved[1], 'base64'));
        assert.equal(payload.subarray(4, 36).toString('hex'), Sections.baselineIdentity(original.baseline),
            'the prefix references the already persisted baseline');
        assert.equal(JSON.parse(payload.subarray(36, 36 + payload.readUInt16LE(0))).length, 7,
            'the prefix does not duplicate the baseline or encode the card as nested base64');
        const restartProof = Economy.restartEventProof;
        try {
            const prefixProof = restartProof(original.eventProof, original);
            Economy.restartEventProof = () => prefixProof;
            const adopted = { ...state, stats: { ...state.stats, wishAdvisory: 'old' } };
            const publishedAdvice = Decisions.advisory(economy, adopted);
            assert(publishedAdvice.saved);
            assert.strictEqual(adopted.stats.wishAdvisory, publishedAdvice.saved,
                'a result callback publishes the prefix after the actual packet was adopted');
            const foreign = { ...state, stats: { ...state.stats, wishSections: { ...state.stats.wishSections }, wishAdvisory: 'old' } };
            Decisions.advisory(economy, foreign);
            assert.equal(foreign.stats.wishAdvisory, 'old', 'an unadopted packet cannot publish a prefix into another baseline');
        } finally { Economy.restartEventProof = restartProof; }
        const restored = Decisions.restoreAdvisory(published, T + MINUTE);
        assert(restored, 'the existing actor publication can restore the decision');
        assert.deepEqual(Buffer.from(restored.card.data), Buffer.from(original.card.data), 'every economic card byte survives');
        assert.equal(restored.card.key, original.card.key);
        assert.deepEqual(restored.baseline, original.baseline);
        assert.deepEqual(restored.eventProof, original.eventProof);
        assert.equal(restored.softPrefix, true);
        const persisted = JSON.parse(JSON.stringify(published));
        assert(Decisions.restoreAdvisory(persisted, T + MINUTE), 'the actual saved stats survive JSON transport');
        const reorder = value => Array.isArray(value) ? value.map(reorder)
            : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
        persisted.stats.wishSections = reorder(persisted.stats.wishSections);
        assert(Decisions.restoreAdvisory(persisted, T + MINUTE), 'object field order does not change the native baseline identity');
        for (const baseline of [undefined, { ...original.baseline, at: T + 1 }, { ...original.baseline, ages: [0, 0, 0, 1] }])
            assert.equal(Decisions.restoreAdvisory({ ...published, stats: { ...published.stats, wishSections: baseline } }, T + MINUTE), null,
                'missing or foreign persisted baseline cannot adopt a saved prefix');
        assert.equal(Decisions.restoreAdvisory(published, T - 1), null, 'clock rollback refuses the saved prefix');
        assert.equal(Decisions.restoreAdvisory(published, T + Sections.SOFT_DELAY.market), null, 'the original deadline is exclusive');
        const partialBaseline = { ...original.baseline, at: T + 4 * MINUTE, ages: [0, 0, 0, 4 * MINUTE] };
        const partialSaved = encode({ ...original, baseline: partialBaseline, eventProof: { ...original.eventProof, at: partialBaseline.at } });
        assert(partialSaved);
        assert(Buffer.byteLength(JSON.stringify({ wishAdvisory: partialSaved })) + Sections.clockBytes(partialBaseline) <= 1024,
            'the saved field and incremental section clocks share the byte budget');
        const partial = { ...published, stats: { ...published.stats, wishSections: partialBaseline, wishAdvisory: partialSaved } };
        assert(Decisions.restoreAdvisory(partial, T + 5 * MINUTE));
        assert.equal(Decisions.restoreAdvisory(partial, T + Sections.SOFT_DELAY.market), null,
            'refreshing another section cannot extend the original market deadline');
        assert.equal(Decisions.restoreAdvisory({ ...published, characterId: state.characterId + 1 }, T + MINUTE), null,
            'a saved card cannot cross owners');
        for (const field of ['decisionSeq', 'activityLeaf']) assert.equal(Decisions.restoreAdvisory({ ...published,
            stats: { ...published.stats, [field]: Number(published.stats[field] || 0) + 1 } }, T + MINUTE), null,
        `a foreign ${field} cannot adopt the card`);
        assert.equal(Decisions.restoreAdvisory({ ...published, stats: { ...published.stats, wishFocus: ['foreign'] } }, T + MINUTE), null);
        for (const invalid of [[1, saved[1]], [2, saved[1]], [3, 'broken'], [3, 'x'.repeat(1024)], {}])
            assert.equal(Decisions.restoreAdvisory({ ...published, stats: { ...published.stats, wishAdvisory: invalid } }, T + MINUTE), null);
        const invalidBaseline = { ...original.baseline, ages: [0, 0, 0, Sections.SOFT_DELAY.market + 1] };
        const invalidClock = encode({ ...original, baseline: invalidBaseline });
        assert(invalidClock);
        assert.equal(Decisions.restoreAdvisory({ ...published, stats: { ...published.stats, wishSections: invalidBaseline, wishAdvisory: invalidClock } }, T + MINUTE), null,
            'a nonfinite native deadline refuses malformed section clocks');
        const oversized = { ...original, eventProof: Uint8Array.from(require('node:crypto').randomBytes(2048)) };
        assert.equal(RestartDecision.encode(oversized, Sections.baselineIdentity(original.baseline)), null,
            'oversize opaque proof abstains without truncating economic data');
        const verify = Economy.eventProofHolds;
        const enabled = Economy.eventReuseEnabled;
        try {
            let verdicts = 0;
            Economy.eventReuseEnabled = () => true;
            Economy.eventProofHolds = (_state, proof, _deps, options) => {
                verdicts++;
                assert.strictEqual(proof, restored.eventProof);
                assert.strictEqual(options.baseline, restored.baseline);
                assert.equal(options.softPrefix, true);
                return true;
            };
            const first = Decisions.refreshAdvisory(published, restored, at(T + MINUTE), { afterResult: true });
            assert(first, 'a shared owner verdict admits the restored prefix');
            const next = { ...published, stats: { ...published.stats, ...first.economy.statsPacket }, updatedAt: T + 2 * MINUTE };
            const second = Decisions.refreshAdvisory(next, first.advisory, at(T + 2 * MINUTE), { afterResult: true });
            assert(second);
            assert.equal(verdicts, 2, 'each use asks the same native verdict');
            assert.strictEqual(second.advisory.baseline, restored.baseline);
            assert.strictEqual(second.economy.statsPacket.wishAdvisory, saved, 'refresh never rewrites the persisted original payload');
            assert.equal(Decisions.restoreAdvisory({ ...next, stats: { ...next.stats, ...second.economy.statsPacket } },
                T + Sections.SOFT_DELAY.market), null, 'refresh cannot extend restart validity');
        } finally { Economy.eventProofHolds = verify; Economy.eventReuseEnabled = enabled; }
        const identity = Generation.current(), rate = options.default.General.adenaRate;
        try {
            options.default.General.adenaRate = Number(rate || 1) + .25;
            assert.notEqual(Generation.current(), identity, 'native runtime rate changes invalidate the generation');
        } finally {
            if (rate === undefined) delete options.default.General.adenaRate;
            else options.default.General.adenaRate = rate;
        }
        assert.equal(Generation.current(), identity, 'the same semantic rate profile has the same generation');
        Warehouse.useRowSource(null);
    }
    // A visibility handoff carries advice through the existing native owner;
    // retaining advice never revives permission to execute a stale card.
    {
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        Warehouse.useRowSource(() => null, () => true);
        const { state, accepted } = decided(93041);
        assert(accepted?.eventProof, 'the real completed build supplies its full event proof');
        const wire = Decisions.wireAdvisory(accepted);
        assert(wire, 'the native read set has a bounded public wire representation');
        const received = Decisions.receiveAdvisory(structuredClone(wire));
        assert(received);
        assert.deepEqual(Buffer.from(received.card.data), Buffer.from(accepted.card.data));
        assert.deepEqual(received.eventProof.market, [...accepted.eventProof.market]);
        assert.deepEqual(received.eventProof.spots, [...accepted.eventProof.spots]);
        const owner = new Decisions.ColdEconomyDecisions();
        owner.accept(state.characterId, accepted.card, null, state);
        assert(owner.retainAdvisory(state, received));
        owner.fence(state.characterId);
        assert.equal(owner.decided(state), null, 'a fence still removes compact-card execution permission');
        assert.strictEqual(owner.advisoryFor(state).baseline, received.baseline);
        const next = { ...state, updatedAt: T + 1000, stats: { ...state.stats } };
        const card = Decisions.compact({ data: accepted.card.data.slice(0), updatedAt: next.updatedAt,
            key: Decisions.stateKey(next), flags: 0 });
        owner.accept(state.characterId, card, null, next);
        assert.strictEqual(owner.advisoryFor(next).eventProof, received.eventProof,
            'an ordinary publication preserves the original proof without restamping');
        const carried = owner.advisoryFor(next);
        owner.releaseAdvisory(state.characterId, { ...carried });
        assert.strictEqual(owner.advisoryFor(next), carried, 'a mismatched transfer cannot release newer owner advice');
        owner.releaseAdvisory(state.characterId, carried);
        assert.equal(owner.advisoryFor(next), null, 'a completed transfer releases the old owner copy');
        assert(owner.decided(next), 'releasing advice does not alter compact-card execution admission');
        assert(owner.retainAdvisory(next, received));
        const newer = { ...next, stats: { ...next.stats, wishSections: { ...next.stats.wishSections, at: T + 1000 } } };
        assert.equal(owner.retainAdvisory(newer, received), false, 'a late old fence result cannot replace a newer published decision');
        const foreign = { ...next, stats: { ...next.stats, activityLeaf: Number(next.stats.activityLeaf || 0) + 1 } };
        owner.accept(state.characterId, card, null, foreign);
        assert.equal(owner.advisoryFor(foreign), null, 'a foreign accepted tuple drops advice');
        assert.equal(owner.retainAdvisory(foreign, received), false);
        const Module = require('node:module'), filename = require.resolve('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const scopedRequire = Module.createRequire(filename), loaded = { exports: {} };
        require('node:vm').runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename })(loaded.exports,
            name => name === 'worker_threads' ? { ...scopedRequire(name), isMainThread: false } : scopedRequire(name),
            loaded, filename, path.dirname(filename));
        const { ColdSimulationKernel } = loaded.exports;
        const kernel = new ColdSimulationKernel({ now: () => T + 1000, resolveSolo: () => null });
        const newerAdvice = { ...accepted, baseline: { ...accepted.baseline, at: T + 500 } };
        const currentState = { ...state, simulation: { revision: 2 }, stats: { ...state.stats, wishSections: newerAdvice.baseline } };
        kernel.upsert({ state: currentState, context: { wishAdvisory: Decisions.wireAdvisory(newerAdvice) } });
        const retained = kernel.states.get(state.characterId).context.wishAdvisory;
        assert(retained);
        kernel.upsert({ state: { ...state, simulation: { revision: 1 } }, context: { wishAdvisory: wire } });
        assert.strictEqual(kernel.states.get(state.characterId).state, currentState, 'a stale revision keeps authoritative state');
        assert.strictEqual(kernel.states.get(state.characterId).context.wishAdvisory, retained,
            'stale delivery cannot replace the newer retained proof with its older advice');
        kernel.upsert({ state: { ...state, simulation: { revision: 1 } }, context: {
            wishAdvisory: { ...wire, activityLeaf: Number(wire.activityLeaf || 0) + 1 } } });
        assert.strictEqual(kernel.states.get(state.characterId).context.wishAdvisory, retained,
            'foreign output advice cannot replace the proof of the actually published state');
        const fenced = kernel.fence(state.characterId);
        assert.equal(kernel.states.has(state.characterId), false, 'the worker releases the physical actor');
        assert.deepEqual(Decisions.receiveAdvisory(fenced.wishAdvisory).baseline, newerAdvice.baseline,
            'the original accepted baseline leaves with the native fence result');
        owner.forget(state.characterId);
        assert.equal(owner.size(), 0, 'actual retirement drops the retained advice');
        Warehouse.useRowSource(null);
    }
    // A legacy publication refusal removes execution permission, not the
    // original native evidence needed by the next ordinary shadow rebuild.
    {
        const diagnostic = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        Warehouse.useRowSource(() => null, () => true);
        try {
            const { state, accepted } = decided(93050);
            assert(accepted.eventProof, 'the native completed build has an original event proof');
            const owner = { state, context: {} }, states = new Map([[state.characterId, owner]]);
            const source = fs.readFileSync(path.join(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), 'utf8');
            const remember = require('node:vm').runInNewContext(source.slice(source.indexOf('function rememberWishAdvisory('),
                source.indexOf('function reviewMarket(')) + ';rememberWishAdvisory', {
                economyDiagnostics: Diagnostics, kernel: { states }, EconomyContext: Economy, ColdEconomyDecision: Decisions
            });
            const published = { ...state, stats: { ...state.stats,
                equipmentPlan: invoke('GameServer/Bot/AI/GearPlanSelection').deferredWishPlan({
                    target: { selfId: 626, name: 'Bronze Shield', slot: 8 } }, {}) } };
            const check = { baseline: accepted.baseline, activity: accepted.activity, leaf: accepted.card.activity,
                timestamp: T, mp: accepted.mp };
            assert.equal(Economy.calculationHolds(published, accepted.fence, deps, check), false,
                'native own plan publication changes the strict legacy fence');
            assert.equal(Economy.calculationHolds(state, accepted.fence, deps, check), true,
                'the original input still matches that same legacy fence');
            accepted.builtAt = T;
            remember(owner, accepted, published, deps);
            const retained = owner.context.wishAdvisory;
            assert(retained?.legacyRejected, 'the existing native owner retains a shadow-only rejected publication');
            for (const key of ['card', 'eventProof', 'baseline', 'mp', 'saved']) assert.strictEqual(retained[key], accepted[key]);
            assert.equal(Object.hasOwn(retained, 'builtAt'), false, 'a rejected publication has no accepted fresh-build stamp');
            const prepared = {}, before = builds;
            assert.equal(Decisions.refusal(state, retained, deps, null, { prepared }), 'no_card',
                'a later legacy fence match cannot revive the rejected execution permission');
            assert.strictEqual(prepared.eventCandidate, retained, 'the diagnostic receives the candidate before off-mode refusal');
            assert.equal(builds, before, 'retaining diagnostic evidence does not run a solver');
            const wire = Decisions.receiveAdvisory(structuredClone(Decisions.wireAdvisory(retained)));
            assert.equal(wire.legacyRejected, true, 'ownership transfer preserves the execution rejection');
            const active = Economy.eventProofHolds(state, retained.eventProof, { ...deps, eventReuse: true }, check);
            assert.equal(active, true, 'the native fixture still passes the complete shared event verdict');
            const resumed = Decisions.refreshAdvisory(state, retained, { ...deps, eventReuse: true });
            assert(resumed, 'only an enabled successful shared verdict can use the retained candidate');
            assert.equal(resumed.advisory.legacyRejected, true);
            assert.strictEqual(resumed.advisory.baseline, retained.baseline);
            assert.equal(Decisions.refusal(state, resumed.advisory, deps), 'no_card', 'returning to off mode remains conservative');
            Economy.forgetContext(state.characterId);
            const next = Economy.forState(state, { ...at(T + 1), eventCandidate: prepared.eventCandidate });
            assert.equal(builds, before + 1, 'cache eviction takes exactly the ordinary rebuild');
            assert.strictEqual(next.eventShadow?.accepted, retained, 'the original candidate survives cache eviction into the native shadow');
            const shadowCount = () => ['would_hold', 'refused'].reduce((sum, name) =>
                sum + Number(Diagnostics.metrics().counts?.[`card:event_gate:${name}`] || 0), 0);
            const compared = shadowCount();
            const fresh = Decisions.advisory(next, { ...state, stats: { ...state.stats, ...next.statsPacket } });
            assert.equal(shadowCount(), compared + 1, 'the ordinary completed build contributes one real card-shadow verdict');
            assert.equal(builds, before + 1, 'diagnostic comparison adds no second solver');
            const proofless = { ...accepted, eventProof: null };
            remember(owner, proofless, published, deps);
            assert.equal(owner.context.wishAdvisory, null, 'a proofless legacy rejection still drops the old advice');
            const reused = { ...accepted, builtAt: T - 1 };
            remember(owner, reused, state, { ...deps, timestamp: T + 1000 }, false);
            assert.strictEqual(owner.context.wishAdvisory, reused);
            assert.equal(reused.builtAt, T - 1, 'a checked reused publication keeps its actual build stamp');
            const newer = { ...retained, baseline: { ...retained.baseline, at: T + 1000 } };
            owner.context.wishAdvisory = newer;
            remember(owner, accepted, published, deps);
            assert.strictEqual(owner.context.wishAdvisory, newer, 'an older publication cannot replace newer owner advice');
            assert.equal(fresh.legacyRejected, undefined, 'an actual fresh advisory replaces the old rejection state');
        } finally { Config.developerDiagnostics = diagnostic; Warehouse.useRowSource(null); }
    }
    // Binary transport distinguishes a completed explicit null from a missing
    // or truncated activity. Native completed-build eligibility is tested by
    // the real recipe scenario in test_recompute_chain.js.
    {
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        Warehouse.useRowSource(() => null, () => true);
        try {
            const { state, accepted } = decided(93052);
            assert(accepted.eventProof);
            const card = Decisions.compact({ key: accepted.card.key, updatedAt: T, inputHash: accepted.card.inputHash, activity: null });
            const original = Decisions.wireAdvisory(accepted);
            const wire = { ...original, activityLeaf: 0, card: { key: card.key, data: Buffer.from(card.data).toString('base64') },
                eventProof: { ...original.eventProof, activity: null,
                    decision: [accepted.decisionSeq, 0, accepted.focus] } };
            const received = Decisions.receiveAdvisory(structuredClone(wire));
            assert(received);
            assert.equal(received.card.activity, null, 'an explicit completed null survives binary ownership transfer');
            assert.equal(Decisions.refusal({ ...state, stats: { ...state.stats, activityLeaf: 0 } }, received, deps), 'leaf_kind',
                'off mode keeps the ordinary unsupported-activity refusal');
            for (const value of [{ ...wire, activityLeaf: undefined }, { ...wire, activityLeaf: 1 },
                { ...wire, eventProof: { ...wire.eventProof, activity: accepted.eventProof.activity } },
                { ...wire, card: { ...wire.card, data: Buffer.from(card.data).subarray(0, 27).toString('base64') } }])
                assert.equal(Decisions.receiveAdvisory(value), null, 'missing tuple, foreign proof or truncated card is not a completed null');
        } finally { Warehouse.useRowSource(null); }
    }
    // Social leaves are calculated intentions, not native attack/help commands.
    // The shadow joins the exact accepted build to its ordinary rebuild only.
    {
        const diagnostic = Config.developerDiagnostics;
        const workerSource = fs.readFileSync(path.join(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), 'utf8');
        const helpers = workerSource.slice(workerSource.indexOf('function samePlanJson('),
            workerSource.indexOf('// Diagnostics only: a lifecycle rebuild'));
        const { nativePlanHolds, socialShadowDeps } = require('node:vm').runInNewContext(
            `${helpers}; ({ nativePlanHolds, socialShadowDeps })`, {
                DecisionSections: Sections, GearAcquisitionPlanner: invoke('GameServer/Bot/AI/GearAcquisitionPlanner'),
                SpotRiskPolicy: invoke('GameServer/Bot/Population/SpotRiskPolicy'), economyDiagnostics: Diagnostics
            });
        const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
        const Plan = invoke('GameServer/Bot/Population/ColdEconomyPlan');
        const count = key => Diagnostics.metrics().counts?.[key] || 0;
        let socialKind = 'pvp';
        Providers.build = (...args) => {
            builds++;
            // Keep the native social root and solver; isolate its nomination
            // from unrelated equipment choices in this controlled fixture.
            const projection = originalBuild(...args), prefix = socialKind === 'pvp' ? 'scores:' : 'care:';
            const root = projection.nodes.find(row => row.key === `${prefix}99999`);
            assert(root, 'native provider generated the remembered social wish');
            args[1].board.first(1864, SELL); // a soft market input, not an action on the social target
            return { ...projection, nodes: [root], roots: [root.key], moneyPaths: [], sourceSections: null };
        };
        try {
            for (const [kind, id] of [['pvp', 93901], ['helping', 93902]]) {
                socialKind = kind;
                const memory = { revision: 1, relations: [{ kind: 'character', targetId: 99999, trust: 50, hostility: 50 }] };
                const native = subject(id, 1e6);
                native.activity = 'resting'; native.vitals.hp = 1;
                native.stats.restUntil = T + MINUTE;
                const scenario = enabled => {
                    // Native content tokens match across board serials, as
                    // they do across main/worker indexes. Keep full key parity.
                    const board = new BoardIndex(), options = { ...deps, memory, board };
                    board.itemRevision = itemId => board.itemFingerprint(itemId);
                    Config.developerDiagnostics = enabled; Economy.reset();
                    const built = Economy.forState(native, options);
                    const state = { ...native, stats: { ...native.stats, ...built.statsPacket } };
                    assert.equal(built.network.activity.activity, kind);
                    const accepted = Decisions.advisory(built, state);
                    const rest = Resolver.resolveRest(state, 1000, T + 1000);
                    assert.deepEqual(rest.materialize, { exp: 0, sp: 0, adena: 0, items: [] });
                    assert.equal(rest.patch.activity, 'resting', 'quiet native recovery is still in progress');
                    const next = { ...state, ...rest.patch, updatedAt: T + 1000 };
                    const current = { ...options, timestamp: T + 1000 };
                    board.put({ id, kind: 'shop', storeType: SELL, ownerId: 7,
                        lines: [{ lineId: 1, selfId: 1864, count: 1, price: 10 }] });
                    const prepared = {}, why = [];
                    assert.equal(Decisions.refreshAdvisory(next, accepted, current,
                        { prepared, why, socialShadow: true }), null, 'live reuse remains refused');
                    assert.deepEqual(why, ['leaf_kind']);
                    if (enabled) assert.equal(prepared.socialShadow?.holds, true, 'all later card checks hold');
                    else assert.equal(prepared.socialShadow, undefined, 'off creates no candidate');
                    const before = builds, same = count(`card:social_plan:${kind}:same`);
                    const candidate = socialShadowDeps(next, current, prepared, T + 1000, () => true);
                    const fresh = Economy.forState(next, candidate);
                    assert.equal(builds, before + 1, 'only the ordinary soft-market rebuild runs');
                    if (enabled) assert.equal(count(`card:social_plan:${kind}:same`) - same, 1,
                        'the matching accepted baseline compares its existing fresh build');
                    return { built, accepted, next, current, fresh };
                };
                const off = scenario(false), on = scenario(true);
                for (const name of ['built', 'fresh']) {
                    assert.deepEqual(on[name].network, off[name].network, `${kind}: full network unchanged off/on`);
                    assert.deepEqual(on[name].statsPacket, off[name].statsPacket, `${kind}: complete packet unchanged off/on`);
                }
                const { accepted, next, current, fresh } = on;
                const candidateFor = (state = next, card = accepted, input = current) => {
                    const prepared = {};
                    assert.equal(Decisions.refreshAdvisory(state, card, input, { prepared, socialShadow: true }), null);
                    return prepared;
                };
                assert.equal(candidateFor(next, accepted, { ...current, memory: { ...memory, revision: 2 } }).socialShadow?.holds, false,
                    'changed native memory revision refuses the candidate');
                assert.equal(candidateFor({ ...next, stats: { ...next.stats, relations: [{ targetId: 4, trust: 1 }] } }).socialShadow?.holds, false,
                    'changed fallback relations refuse the candidate');
                for (const changed of [{ activityLeaf: next.stats.activityLeaf + 1 }, { wishFocus: ['foreign:focus', 0, 0] }])
                    assert.equal(candidateFor({ ...next, stats: { ...next.stats, ...changed } }).socialShadow, undefined,
                        'a foreign accepted tuple cannot become a candidate');
                for (const leaf of [{ ...accepted.card.activity, targetId: 0 }, { ...accepted.card.activity, rootKey: 'scores:other' }])
                    assert.equal(candidateFor(next, { ...accepted, card: { activity: leaf } }).socialShadow, undefined,
                        'only canonical concrete social targets are considered');
                for (const [state, nativeHolds, edges] of [
                    [{ ...next, partyId: 2 }, true, 0], [{ ...next, stats: { ...next.stats, partyRequest: {} } }, true, 0],
                    [next, false, 0], [next, true, Plan.edges(next, { ...next, activity: 'hunting' }, {}, T + 1000)]
                ]) {
                    if (nativeHolds && state === next) assert(edges, 'native recovery completion creates a result-site edge');
                    const prepared = candidateFor(), refused = count(`card:social_check:${kind}:refused`);
                    assert.strictEqual(socialShadowDeps(state, current, prepared, T + 1000, () => nativeHolds, edges), current);
                    assert.equal(count(`card:social_check:${kind}:refused`) - refused, 1);
                }
                const replan = { recoveryTargets: [], routeCurrent: false };
                assert(nativePlanHolds(next, null, replan, T + 1000));
                assert.equal(nativePlanHolds(next, { status: 'active' }, replan, T + 1000), false,
                    'a stale native route does not pass the shared plan proof');
                // Same tuple, another actual build: the old advisory must not
                // be compared with the newer cache entry as though it were its own.
                assert.notStrictEqual(accepted.baseline, fresh.statsPacket.wishSections);
                current.board.put({ id, kind: 'shop', storeType: SELL, ownerId: 7,
                    lines: [{ lineId: 1, selfId: 1864, count: 2, price: 10 }] });
                let prepared = candidateFor(), unavailable = count(`card:social_plan:${kind}:unavailable`);
                Economy.forState(next, socialShadowDeps(next, current, prepared, T + 1000, () => true));
                assert.equal(count(`card:social_plan:${kind}:unavailable`) - unavailable, 1,
                    'accepted/cache identity mismatch is unavailable, never same');
                const latest = Economy.forState(next, current);
                const published = { ...next, stats: { ...next.stats, ...latest.statsPacket } };
                const card = Decisions.advisory(latest, published);
                prepared = candidateFor(published, card);
                unavailable = count(`card:social_plan:${kind}:unavailable`);
                const before = builds;
                Economy.forState(published, socialShadowDeps(published, current, prepared, T + 1000, () => true));
                assert.equal(builds, before, 'a cache hit does not manufacture a second solver call');
                assert.equal(count(`card:social_plan:${kind}:unavailable`) - unavailable, 1, 'a hit is unavailable');
                Economy.forgetContext(id);
                prepared = candidateFor(published, card);
                unavailable = count(`card:social_plan:${kind}:unavailable`);
                Economy.forState(published, socialShadowDeps(published, current, prepared, T + 1000, () => true));
                assert.equal(count(`card:social_plan:${kind}:unavailable`) - unavailable, 1, 'a missing held build is unavailable');
                assert.equal(next.stats.pvpEncounter, undefined);
                assert.equal(next.partyId, undefined, 'the shadow neither attacks nor creates a party');
                current.board.remove(id);
            }
        } finally {
            Config.developerDiagnostics = diagnostic;
            Providers.build = (...args) => { builds++; return originalBuild(...args); };
        }
    }
    assert.equal(Sections.capability(subject(1), T), Sections.capability(subject(1), T + 11 * MINUTE),
        'fixture: the game day/night build mark does not move inside the test window');
    // A retained build accepts its exact unpublished input or its own output,
    // never another leaf/focus that merely shares the decision sequence.
    {
        const diagnostic = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        const Warehouse = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        Warehouse.useRowSource(() => null, () => true);
        const input = subject(93014), economy = Economy.forState(input, deps);
        assert(economy.eventProof(), 'the tuple shadow fixture has complete native owner input proof');
        const before = builds;
        assert.strictEqual(Economy.forState(input, deps).plan, economy.plan, 'exact prepublication input replay remains valid');
        assert.equal(builds, before);
        const published = { ...input, stats: { ...input.stats, ...economy.statsPacket } };
        const accepted = Decisions.advisory(economy, input);
        assert.equal(accepted.decisionSeq, economy.statsPacket.decisionSeq, 'acceptance uses build output before publication');
        assert.equal(accepted.activityLeaf, economy.statsPacket.activityLeaf);
        assert.equal(accepted.focus, economy.statsPacket.wishFocus?.[0] ?? null);
        assert.strictEqual(accepted.baseline, economy.statsPacket.wishSections);
        const foreignLeaf = { ...published, stats: { ...published.stats, activityLeaf: published.stats.activityLeaf + 1 } };
        const foreignFocus = { ...published, stats: { ...published.stats, wishFocus: ['foreign:focus', 0, 0] } };
        for (const [foreign, reason] of [[foreignLeaf, 'activity_leaf'], [foreignFocus, 'wish_focus']]) {
            assert.equal(Decisions.refusal(foreign, accepted, deps), reason);
            const refused = Diagnostics.metrics().counts?.[`context:gate:${reason}`] || 0;
            const held = Diagnostics.metrics().counts?.['context:gate:would_hold'] || 0;
            assert.notStrictEqual(Economy.forState(foreign, { ...deps, rememberContext: false }).plan, economy.plan,
                'a foreign output tuple cannot reuse the cache entry');
            assert.equal((Diagnostics.metrics().counts?.[`context:gate:${reason}`] || 0) - refused, 1,
                'shadow coverage refuses the same foreign output instead of counting would_hold');
            assert.equal(Diagnostics.metrics().counts?.['context:gate:would_hold'] || 0, held);
        }
        const foreignInput = { ...input, stats: { ...input.stats, wishFocus: ['foreign:input', 0, 0] } };
        assert.equal(Economy.inputKey(foreignInput, deps), Economy.inputKey(input, deps), 'the old raw key omits focus');
        assert.notStrictEqual(Economy.forState(foreignInput, { ...deps, rememberContext: false }).plan, economy.plan,
            'an equal raw key still requires the original input tuple');
        assert.equal(Decisions.refusal(published, { ...accepted, baseline: undefined }, deps), 'no_sections',
            'legacy accepted metadata takes one conservative rebuild');
        assert.equal(Decisions.refusal(published, { ...accepted, focus: undefined }, deps), 'wish_focus',
            'legacy missing focus cannot bless an otherwise equal tuple');
        Config.developerDiagnostics = diagnostic;
        Warehouse.useRowSource(null);
    }
    // (a) after-result own result only: no new build, the card is restamped.
    {
        const { state, economy, accepted } = decided(93001);
        assert(state.stats.wishSections.at === T, 'the saved baseline records the time of the actual decision');
        assert(accepted && accepted.activity === 'hunting');
        const band = Economy.decodeCalculationFence(accepted.fence)[3].find(row => row[0] === 1869);
        assert(band && band[2] >= 100001, 'fixture: the free material has a quantity band');
        const [low, high] = state.stats.wishSections.cashBounds;
        assert(state.adena + 1 > low && (high === null || state.adena + 1 < high), 'fixture: adena stays inside the cash bounds');
        const next = ownResult(state);
        assert.notEqual(Economy.inputKey(next, at(T + 1000)), Economy.inputKey(state, at(T + 1000)),
            'fixture: the own result changes the raw input key (activity in the route frame, loot)');
        const before = builds;
        const reused = Economy.forState(next, at(T + 1000));
        assert.equal(builds, before, 'an own result inside the bands rebuilds nothing');
        assert.strictEqual(reused.plan, economy.plan, 'the held plan of the step is reused');
        assert.equal(reused.statsPacket.wishSections.at, T, 'the reused packet keeps the last actual decision time');
        const card = Decisions.advisory(reused, next);
        assert(card, 'the reused plan publishes a card');
        assert.equal(card.card.key, Decisions.stateKey(next), 'the card is stamped with the new state key');
        assert.equal(card.activity, 'resting');
        // After eviction, the card path: restamped after the result only.
        Economy.forgetContext(next.characterId);
        const thinBuilds = builds;
        const thin = Decisions.refreshAdvisory(next, accepted, at(T + 1000), { afterResult: true });
        assert(thin, 'after a result the card accepts the own hunting -> resting step');
        assert.equal(builds, thinBuilds);
        assert.equal(thin.decision.key, Decisions.stateKey(next));
        // Before an action a resting bot's step is its own rest; the card is
        // executed only through a hunter's target, so a rester reuses it too.
        assert(Decisions.refreshAdvisory(next, accepted, at(T + 1000)), 'before an action a resting bot reuses the card');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'shopping' }, accepted, at(T + 1000)), null,
            'before an action a shopper still rebuilds');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'traveling' }, accepted, at(T + 1000)), null,
            'a traveller without a trip record (resolved as a fight) still rebuilds');
        const why = [];
        Decisions.refreshAdvisory({ ...next, activity: 'shopping' }, accepted, at(T + 1000), { why });
        assert.deepEqual(why, ['not_field:shopping'], 'a refused card names its check');
        assert.equal(Decisions.refusal({ ...next, activity: 'traveling' }, accepted, at(T + 1000)), 'travel_record');
        assert.equal(Decisions.refusal({ ...next, incomingPending: true }, accepted, at(T + 1000)), 'incoming');
        assert.equal(Decisions.refusal(next, accepted, at(T + 1000)), '', 'a reusable card has no refusal');
        assert.equal(Decisions.refreshAdvisory({ ...next, activity: 'shopping' }, accepted, at(T + 1000), { afterResult: true }), null,
            'only hunting, resting and travelling are equalised');
        assert.equal(Decisions.refreshAdvisory({ ...next, loc: { ...next.loc, locX: next.loc.locX + 500 } }, accepted,
            at(T + 1000), { afterResult: true }), null, 'a location change stays exact');
    }
    // (h) a trip to the held hunting leaf's own spot executes the plan: no
    // event; a trip to another spot or a town stays exact (lever 2).
    {
        const { state, economy, accepted } = decided(93011);
        const leaf = accepted.card.activity;
        assert(leaf && leaf.activity === 'hunting' && leaf.spotId != null, 'fixture: a hunting leaf at a spot');
        const trip = (spotId, extra = {}) => ({ ...state, activity: 'traveling', updatedAt: state.updatedAt + 1,
            stats: { ...state.stats, travel: { from: { ...state.loc }, to: { locX: 81000, locY: 149000, locZ: -3500 }, spotId,
                regionName: 'Hunting Ground', arrivalActivity: 'hunting', townName: null, method: 'gatekeeper_spot',
                startedAt: T, arrivalAt: T + 10 * MINUTE, ...extra } } });
        const own = trip(leaf.spotId);
        let before = builds;
        assert.strictEqual(Economy.forState(own, at(T + 1000)).plan, economy.plan, 'the cache keeps the plan on its own trip');
        assert.equal(builds, before);
        assert.equal(Economy.calculationHolds(own, accepted.fence, at(T + 1000)), false,
            'without the card options the proof stays exact');
        assert(Economy.calculationHolds(own, accepted.fence, at(T + 1000), { activity: 'hunting', leaf }),
            'the build activity and the own leaf accept the trip start');
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(own, accepted, at(T + 1000)), 'before an action the own trip keeps the card');
        assert(Decisions.refreshAdvisory(own, accepted, at(T + 1000), { afterResult: true }), 'after a result as well');
        assert.equal(Decisions.refreshAdvisory(trip(`${leaf.spotId}_other`), accepted, at(T + 1000)), null,
            'a trip to another spot rebuilds');
        assert.equal(Decisions.refreshAdvisory(trip(leaf.spotId, { townName: 'Giran', arrivalActivity: 'shopping' }), accepted,
            at(T + 1000)), null, 'a town trip rebuilds');
        assert(Decisions.refreshAdvisory(trip(leaf.spotId, { arrivalAt: T + 500 }), accepted, at(T + 1000)),
            'a due arrival keeps the card before an action: the step resolves the arrival, not a fight');
        assert.equal(Decisions.refreshAdvisory({ ...own, activity: 'hunting', spotId: leaf.spotId,
            loc: own.stats.travel.to, stats: { ...own.stats, travel: null } }, accepted, at(T + 1000), { afterResult: true }),
        null, 'the arrival (location and spot) stays exact');
    }
    // (i) shots used between the survival line and the target: noise below
    // the bot's own error; the survival line and any rise stay hard (lever 3).
    {
        const shotBag = shots => Life.inventorySummaryFromItems([
            { id: 1, selfId: 1, amount: 1, equipped: 1, slot: 7 },
            { id: 2, selfId: 1835, amount: shots, equipped: 0, slot: 0 },
            { id: 3, selfId: 1869, amount: 100000, equipped: 0, slot: 0 }]);
        const probe = Economy.basics({ ...subject(93012, 1e6), inventory: shotBag(1) }, deps).stock('shots');
        const floor = Math.max(1, Math.ceil(probe.survivalTarget - (probe.beginnerCurrent || 0)));
        const target = Math.ceil(probe.target - (probe.beginnerCurrent || 0));
        assert(probe.itemId === 1835 && floor + 2 < target, 'fixture: room between the survival line and the target '
            + JSON.stringify([floor, target]));
        const amount = target - 1;
        let state = { ...subject(93012, 1e6), inventory: shotBag(amount) };
        const economy = Economy.forState(state, deps);
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const accepted = Decisions.advisory(economy, state);
        const band = Economy.decodeCalculationFence(accepted.fence)[3].find(row => row[0] === 1835);
        assert(band && band[2] === amount && band[1] >= floor && band[1] < amount,
            'shots below the target have a consumption band ' + JSON.stringify(band));
        const used = shots => ({ ...state, inventory: shotBag(shots), updatedAt: state.updatedAt + 1, stats: { ...state.stats } });
        const before = builds;
        assert.strictEqual(Economy.forState(used(amount - 1), at(T + 1000)).plan, economy.plan, 'one shot used inside the band');
        assert.equal(builds, before);
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(used(amount - 1), accepted, at(T + 1000), { afterResult: true }), 'the card holds too');
        assert(Decisions.refreshAdvisory(used(band[1]), accepted, at(T + 1000), { afterResult: true }), 'the band edge holds');
        assert.equal(Decisions.refreshAdvisory(used(band[1] - 1), accepted, at(T + 1000), { afterResult: true }), null,
            'use beyond the error or the survival line rebuilds');
        assert.equal(Decisions.refreshAdvisory(used(floor - 1), accepted, at(T + 1000), { afterResult: true }), null,
            'below the survival line rebuilds at once');
        assert.equal(Decisions.refreshAdvisory(used(amount + 1), accepted, at(T + 1000), { afterResult: true }), null,
            'a rise below the target stays exact');
        // A held purchase of the shots themselves orders only the rise since
        // its decision, so its own item stays exact (else it would buy short).
        const options = { activity: accepted.activity, leaf: accepted.card.activity };
        assert(Economy.calculationHolds(used(amount - 1), accepted.fence, at(T + 1000), options), 'fixture: the held leaf holds the band');
        assert.equal(Economy.calculationHolds(used(amount - 1), accepted.fence, at(T + 1000),
            { ...options, leaf: { activity: 'shopping', kind: 'buy', itemId: 1835, amount: target - amount + 1 } }), false,
        'a held shots purchase keeps the shots exact');
    }
    // (j) the build publishes its potion and shot targets; the sale list keeps
    // by them without a second earning-spot search (L72).
    {
        const { state, economy } = decided(93013);
        const potions = economy.stock('potions'), shots = economy.stock('shots');
        assert.deepEqual(state.stats.stockTargets, [potions.itemId, potions.target, shots.itemId, shots.target, shots.current],
            'the packet carries the plan\'s own stock targets');
        const Route = require('../src/GameServer/Bot/Economy/EquipmentIncomeRoute'), select = Route.select;
        let searches = 0;
        Route.select = (...args) => { searches++; return select(...args); };
        try {
            const marked = { ...state, stats: { ...state.stats, stockTargets: [potions.itemId, 7, shots.itemId, 11, shots.current] } };
            const read = Economy.keptTargets(marked);
            assert.equal(read.potions, 7);
            assert.equal(read.shots.target, 11);
            assert.equal(read.shots.itemId, shots.itemId);
            assert.equal(searches, 0, 'a published target needs no earning-spot search');
            invoke('GameServer/Bot/Economy/ItemDisposition').saleCandidates(marked, { unlimited: true });
            assert.equal(searches, 0, 'the sale list reads the published targets');
            const other = Economy.keptTargets({ ...marked, stats: { ...marked.stats, stockTargets: [potions.itemId, 7, shots.itemId + 1, 11, shots.current] } });
            assert(searches > 0 && other.shots.target === shots.target, 'another shot item falls back to the foundation');
            searches = 0;
            const risen = Economy.keptTargets({ ...marked, stats: { ...marked.stats, stockTargets: [potions.itemId, 7, shots.itemId, 11, shots.current - 1] } });
            assert(searches > 0 && risen.shots.target === shots.target,
                'shots risen since the build (a capped target without restock) fall back to the foundation');
        } finally { Route.select = select; }
    }
    // (b) hard events rebuild at once.
    {
        const { state, economy } = decided(93002, 1e6);
        const [low] = state.stats.wishSections.budgetBounds;
        assert(low > 0, 'fixture: a protected spending bound below the budget');
        let before = builds;
        const newItem = { ...ownResult(state), inventory: { ...bag(1), ...Life.inventorySummaryFromItems([
            { id: 4, selfId: 1870, amount: 1, equipped: 0, slot: 0 }]) } };
        assert.notStrictEqual(Economy.forState(newItem, at(T + 1000)).plan, economy.plan, 'a new item is an event');
        assert(builds > before);
        const outside = decided(93008, 1e6);
        before = builds;
        Economy.forState({ ...ownResult(outside.state), inventory: bag(1e7) }, at(T + 1000));
        assert(builds > before, 'loot beyond the quantity band is an event');
        const held = decided(93003, 1e6);
        before = builds;
        const nativePenalty = Floor.weightPenalty;
        Floor.weightPenalty = (...args) => nativePenalty(...args) + 1;
        try { Economy.forState(ownResult(held.state), at(T + 1000)); } finally { Floor.weightPenalty = nativePenalty; }
        assert(builds > before, 'a weight tier change is an event');
        const poor = decided(93004, 1e6);
        before = builds;
        Economy.forState({ ...ownResult(poor.state), adena: low - 1 }, at(T + 1000));
        assert(builds > before, 'adena below the lower budget bound is an event');
        assert.equal(Decisions.refreshAdvisory({ ...ownResult(poor.state), adena: low - 1 }, poor.accepted, at(T + 1000),
            { afterResult: true }), null, 'the card refuses the same hard money event');
    }
    // (c) a read market item is soft: 10 min since the last actual decision.
    {
        const { state, economy, accepted } = decided(93005);
        const wished = economy.network.queue.map(wish => Number(wish.object?.itemId)).find(Boolean);
        assert(wished, 'fixture: a wished item the review read');
        board.put({ id: 9300501, kind: 'shop', storeType: SELL, ownerId: 7, lines: [{ lineId: 1, selfId: wished, count: 1, price: 10 }] });
        let before = builds;
        assert.strictEqual(Economy.forState(state, at(T + MINUTE)).plan, economy.plan, 'a moved market token waits');
        assert.equal(builds, before);
        assert(Decisions.refreshAdvisory(state, accepted, at(T + MINUTE)), 'the card waits on the same soft market');
        const newer = { ...state, stats: { ...state.stats,
            wishSections: { ...state.stats.wishSections, at: T + 9 * MINUTE } } };
        const sameOutput = Decisions.advisory(economy, newer);
        assert.strictEqual(sameOutput.baseline, accepted.baseline, 'publication cannot restamp an older build baseline');
        const refreshed = Decisions.refreshAdvisory(newer, accepted, at(T + MINUTE));
        assert(refreshed);
        assert.strictEqual(refreshed.advisory.baseline, accepted.baseline);
        assert.strictEqual(refreshed.economy.statsPacket.wishSections, accepted.baseline,
            'a refreshed packet republishes its accepted baseline, not a foreign newer snapshot');
        assert.equal(Decisions.refreshAdvisory(newer, refreshed.advisory, at(T + 11 * MINUTE)), null,
            'equal outputs with a foreign newer baseline cannot extend the original market delay');
        const changedCapability = { ...newer, level: newer.level + 1 };
        changedCapability.stats = { ...newer.stats, wishSections: { ...newer.stats.wishSections,
            build: Sections.capability(changedCapability, T + MINUTE) } };
        assert.equal(Decisions.refusal(changedCapability, accepted, at(T + MINUTE)), 'capability',
            'a foreign snapshot cannot bless a capability change against an older card');
        assert.equal(Economy.calculationHolds(state, accepted.fence, at(T + MINUTE)), false,
            'without the card options the proof stays exact');
        assert.equal(Decisions.refreshAdvisory(state, accepted, at(T + 11 * MINUTE)), null, 'after 10 min the card is re-examined');
        before = builds;
        assert.notStrictEqual(Economy.forState(state, at(T + 11 * MINUTE)).plan, economy.plan, 'after 10 min the plan is rebuilt');
        assert(builds > before);
    }
    // (f) soft market never excuses the held leaf's own offer (critic 1).
    {
        board.remove(9300501); // the line of (c): the own offer below is the only one
        const tripCost = Object.assign(() => 0, { details: () => ({ known: true, hours: .1, fees: 0 }) });
        const tdeps = timestamp => ({ ...deps, tripCost, timestamp });
        let state = subject(93009, 1e6);
        const economy = Economy.forState(state, tdeps(T));
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const wished = economy.network.queue.map(wish => Number(wish.object?.itemId)).find(Boolean);
        assert(wished, 'fixture: a wished item the review read');
        board.put({ id: 9300901, kind: 'shop', storeType: SELL, ownerId: 7, town: 'Giran',
            lines: [{ lineId: 1, selfId: wished, count: 5, price: 10 }] });
        // fixture: the held decision's own next step buys that line
        economy.plan.network.activity = { activity: 'shopping', kind: 'buy', itemId: wished, amount: 1, unitPrice: 10,
            sourceType: 'afk', town: 'Giran' };
        assert(Economy.acceptedActivityHolds(state, economy.plan.network.activity, tdeps(T + MINUTE)),
            'fixture: the own offer, funding and route hold');
        let before = builds;
        assert.strictEqual(Economy.forState(state, tdeps(T + MINUTE)).plan, economy.plan,
            'a moved read token waits while the own offer holds');
        assert.equal(builds, before);
        board.put({ id: 9300901, kind: 'shop', storeType: SELL, ownerId: 7, town: 'Giran',
            lines: [{ lineId: 1, selfId: wished, count: 5, price: 20 }] });
        before = builds;
        assert.notStrictEqual(Economy.forState(state, tdeps(T + 2 * MINUTE)).plan, economy.plan,
            'the own line moved: rebuild inside the market delay');
        assert(builds > before);
    }
    // (g) a resting crafter's MP is a resource: the card is refused (critic 2a).
    {
        let state = { ...subject(93010), craftLevel: 1 };
        const economy = Economy.forState(state, deps);
        state = { ...state, stats: { ...state.stats, ...economy.statsPacket } };
        const accepted = Decisions.advisory(economy, state);
        assert(accepted && accepted.mp === state.vitals.mp);
        const resting = { ...ownResult(state), vitals: { ...state.vitals } };
        Economy.forgetContext(state.characterId);
        assert(Decisions.refreshAdvisory(resting, accepted, at(T + 1000), { afterResult: true }),
            'fixture: the same MP keeps the crafter card');
        assert.equal(Decisions.refreshAdvisory({ ...resting, vitals: { ...state.vitals, mp: state.vitals.mp + 50 } }, accepted,
            at(T + 1000), { afterResult: true }), null, 'a crafter MP rise refuses the card');
    }
    // (d) a reconcile event of this step is never overwritten by a reused packet.
    {
        const { state, economy, accepted } = decided(93006);
        // BotLifeState.prepareResolve: reconcile first, then the economy, then
        // the packet is merged into the next state.
        const next = { ...ownResult(state, 'hunting'), level: state.level + 1, stats: { ...state.stats } };
        const changed = Events.reconcile(state, next, T + 1000);
        assert(changed.includes('build'));
        assert(next.stats.wishDirty > 0);
        assert.equal(Decisions.refreshAdvisory(next, accepted, at(T + 1000), { afterResult: true }), null,
            'a raised event refuses the card');
        const before = builds;
        const rebuilt = Economy.forState(next, at(T + 1000));
        assert(builds > before, 'a raised event rebuilds');
        assert.notStrictEqual(rebuilt.plan, economy.plan);
        Object.assign(next.stats, rebuilt.statsPacket);
        assert.equal(next.stats.decisionSeq, state.stats.decisionSeq + 1, 'the event of the step survives the packet merge');
        assert.equal(next.stats.wishSections.at, T + 1000, 'the new decision restarts every soft delay');
        // A soft-only drift does not raise an event at all within its delay.
        const drift = { ...ownResult(next, 'hunting'), stats: { ...next.stats } };
        assert.deepEqual(Events.reconcile(next, drift, T + 2000), []);
    }
    // (e) the shared money verdict (cold reconcile and the hot observer).
    {
        const state = subject(93007, 50);
        const packet = [100, .1, 10, 100, .2, 20, 1];
        const base = { ...state, stats: { ...state.stats, money: packet } };
        const wishSections = { at: T, wallet: 50, cashBounds: [30, 130], funding: Sections.fundingMark(base), moneyError: 10,
            ...Sections.semanticFacts(base, T) };
        const before = { ...base, stats: { ...base.stats, wishSections } };
        const after = adena => ({ ...before, adena, stats: { ...before.stats } });
        assert.equal(Sections.events(before, after(61), T + 30 * 1000).includes('funding'), false,
            'a drift above the money error inside the bounds waits for the next decision point');
        assert.equal(Sections.events(before, after(129), T + 59 * 1000).includes('funding'), false);
        assert(Sections.events(before, after(61), T + 61 * 1000).includes('funding'), 'after 60 s the drift is re-examined');
        assert(Sections.events(before, after(130), T + 61 * 1000).includes('funding'), 'a newly payable wish after 60 s');
        assert(Sections.events(before, after(29), T + 1000).includes('funding'), 'below the lower bound is immediate');
        assert.equal(Sections.moneyEvent(after(55), wishSections, T + 1000), false);
        assert(Sections.moneyEvent(after(61), { ...wishSections, at: undefined }, T + 1000),
            'a baseline saved before L70 behaves as an elapsed delay');
        assert(Sections.softDue(wishSections, 'observation', T + 5 * MINUTE));
        assert.equal(Sections.softDue(wishSections, 'market', T + 9 * MINUTE), false);
    }
    await nullLifecycleParity();
    console.log('PASS L70 held plan: own result reuse and restamp, own-spot trip, shot use below target, hard events, soft market delay, reconcile kept, shared money verdict');
} finally {
    Providers.build = originalBuild;
    fs.rmSync(dir, { recursive: true, force: true });
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
