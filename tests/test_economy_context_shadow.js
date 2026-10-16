'use strict';
// Shadow counters of context rebuilds (diagnostics only): same/new key, gap since
// the actor's previous build and what released its context. Never a decision input.
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
const deps = { board: new BoardIndex(), spots: invoke('GameServer/Bot/Population/SpotProfiles').ensure(), timestamp: 1e12 };
const state = () => ({ characterId: 901, updatedAt: 1, level: 20, phase: 'cold', activity: 'resting', adena: 100,
    stats: { classId: 1 }, inventory: { 1: { selfId: 1, amount: 1, equipped: true, slot: 7 } }, currentRegion: 'Giran',
    simulation: { revision: 2 }, loc: { locX: 80000, locY: 148000, locZ: -3500 }, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } });
const shadow = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('context:shadow')));
const keyCounts = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {}).filter(([key]) => key.startsWith('context:key_')));
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

// On, with a fake clock so the gap buckets are exact.
const realNow = Date.now; let clock = 1e12; Date.now = () => clock;
Config.developerDiagnostics = true; Economy.reset();
let before = shadow();
const first = Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:new_key': 1 }, 'first build has no previous key');
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
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:5_15s': 1,
    'context:shadow_released:explicit_invalidation': 1, 'context:shadow_plan:same_key:same_plan': 1 },
'a released context with an equal key is counted with its gap, release reason and the repeated plan');
assert.deepEqual(second.statsPacket, first.statsPacket, 'counting never changes the decision');

before = shadow(); clock += 40000;
assert.strictEqual(Economy.forState(republished, deps).plan, second.plan, 'a hit is not a rebuild');
assert.deepEqual(delta(before, shadow()), {});
before = shadow(); clock += 2000;
Economy.forgetContext(901, 'owner_release');
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:1_5s': 1,
    'context:shadow_released:owner_release': 1, 'context:shadow_plan:same_key:same_plan': 1 }, 'the gap runs from the last use, a hit included');

before = shadow(); const keyBefore = keyCounts();
Economy.forState({ ...republished, adena: 5000 }, deps);
let changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:input_dependency_changed:new_key': 1, 'context:shadow_plan:new_key:same_plan': 1 },
    'a richer wallet invalidates inputs while the mandatory kit remains the focus');
assert.deepEqual(delta(keyBefore, keyCounts()), { 'context:key_part:adena': 1, 'context:key_parts:1': 1,
    'context:key_single:adena:same_plan': 1 }, 'the one moved part is named with the plan outcome');

// A build that waits on incoming stock (early return) still classifies its plan.
before = shadow();
Economy.forState({ ...republished, adena: 5000, incomingPending: true }, deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:input_dependency_changed:new_key': 1, 'context:shadow_plan:new_key:new_plan': 1 });
Economy.forState({ ...republished, adena: 5000 }, deps);

// An unkept build stays unkept even when an older kept context of the actor is released later.
Economy.forState(state(), { ...deps, rememberContext: false });
Economy.forgetContext(901, 'explicit_invalidation');
before = shadow(); clock += 200000;
Economy.forState(state(), deps);
changed = delta(before, shadow());
assert.deepEqual(changed, { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:ge120s': 1,
    'context:shadow_released:unkept': 1, ...Object.fromEntries(Object.entries(changed).filter(([key]) => key.startsWith('context:shadow_plan:same_key:'))) });
assert.strictEqual(Object.keys(changed).filter(key => key.startsWith('context:shadow_plan:same_key:')).length, 1, 'a same key compares its plan with the previous build');

// The LRU capacity names its own release.
Economy.forState(state(), deps);
for (let id = 1000; id < 1000 + Economy.RETAIN_LIMIT; id++) Economy.forState({ ...state(), characterId: id }, deps);
before = shadow();
Economy.forState(state(), deps);
assert.deepEqual(delta(before, shadow()), { 'context:shadow:not_retained:same_key': 1, 'context:shadow_gap:lt1s': 1,
    'context:shadow_released:capacity': 1, 'context:shadow_plan:same_key:same_plan': 1 });

// L134 probes: the shadow plan per miss reason (context:same_key_<plan>:<reason>),
// the clause that refused a same-key request (context:same_key_refused), the
// activity_leaf echo (context:leaf_echo) and the trip rows (context:trip_rows).
{
    const probeKeys = () => Object.fromEntries(Object.entries(Diagnostics.metrics().counts || {})
        .filter(([key]) => /^context:(same_key_|leaf_echo:|trip_rows:)/.test(key)));
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
    assert.deepEqual(on.deltas.first, {}, 'a first build has no previous build to compare');
    one('trip_same', /^context:trip_rows:same:/);
    one('trip_moved', /^context:trip_rows:moved:/);
    one('echo', /^context:leaf_echo:echo:/);
    one('leaf_no_held', /^context:leaf_echo:no_held:/);
    assert.strictEqual(one('market', /^context:same_key_refused:/), 'context:same_key_refused:market_due');
    one('market', /^context:same_key_(same|new)_plan:used_market_changed$/);
    assert.strictEqual(one('decision', /^context:same_key_refused:/), 'context:same_key_refused:decision_seq');
    one('decision', /^context:same_key_(same|new)_plan:input_dependency_changed$/);
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
        const sameBefore = counts()['context:projection:not_retained:same'] || 0;
        Economy.forgetContext(901, 'explicit_invalidation');
        Economy.forState(state(), deps);
        assert.strictEqual((counts()['context:projection:not_retained:same'] || 0) - sameBefore, 1,
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
