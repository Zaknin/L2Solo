'use strict';
// The transit hold (Economy/Hold.js, place 'transit'): the lifecycle step of a
// resting, travelling or dead solo bot is checked against the decision events
// of its last build. In shadow it counts hold:transit:<held|reason> and, on
// sampled owners, compares what the rebuild changed; only 'on' skips it.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transit-hold-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
require('../src/Global');
invoke('GameServer/DataCache').init();
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Diagnostics = invoke('GameServer/Bot/Economy/EconomyDiagnostics');
const Hold = invoke('GameServer/Bot/Economy/Hold');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const count = key => Diagnostics.metrics().counts?.[key] || 0;

assert.equal(Hold.MODE.transit, 'shadow', 'transit switches to on in its own commit, after the live shadow read');
assert(Object.isFrozen(Hold.MODE));
Config.developerDiagnostics = false;
assert.equal(Hold.asked('transit'), false, 'shadow costs nothing while the counters are off');
assert.equal(Hold.asked('transit', { hold: { transit: true } }), true);
Config.developerDiagnostics = true;
assert.equal(Hold.asked('transit'), true);
assert.equal(Hold.asked('nowhere'), false, 'a place without a mode is off');

const source = fs.readFileSync(path.join(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const helperSource = `${slice('function samePlanJson(', 'function nativePlanHolds(')}\n`
    + `${slice('// Diagnostics only: a lifecycle rebuild', 'function rememberWishAdvisory(')}\n`;
let economy = invoke('GameServer/Bot/Economy/EconomyContext'), reads = 0;
const persona = { archetype: 'test' };
const context = (extra = {}) => ({ invoke, performance, Hold, BotPersona: { of: () => persona },
    EconomyContext: { heldEventsQuiet: (...args) => economy.heldEventsQuiet(...args) },
    BackgroundResolver: { travelRecord: travel => { reads++; return Resolver.travelRecord(travel); } }, ...extra });
const { transitHold, compareTransit } = vm.runInNewContext(`${helperSource}({ transitHold, compareTransit })`, context());

const T = 1_800_000_000_000;
const plan = { status: 'deferred', strategy: 'none', next: null, reason: 'wish_focus' };
const baseline = { at: T - 60000, expHour: 1234 };
const quiet = { failure: null, invalidSource: false, levelingRecovery: null };
const bot = (activity, stats = {}, extra = {}) => ({ characterId: 4242, activity, level: 30, vitals: { mp: 100 },
    stats: { equipmentPlan: plan, wishSections: baseline, money: [1, 2], wishFocus: ['root:1', 5, 100],
        decisionSeq: 3, activityLeaf: 2, ...stats }, ...extra });
const resting = (stats, extra) => bot('resting', { restUntil: T + 60000, ...stats }, extra);
const verdict = (state, previousPlan = plan, native = quiet, ctx = {}) => transitHold(state, previousPlan, native, ctx, T);
const why = result => result.why.join(',');

// Off: no verdict, no read of the step.
Config.developerDiagnostics = false;
assert.equal(verdict(resting()), null);
assert.equal(reads, 0);
Config.developerDiagnostics = true;

// Outside the place: a field step, a rest without a deadline, a travel
// without its record, a party bot (its rebuild gives a waiter a spot).
const held = count('hold:transit:held');
for (const state of [bot('hunting'), bot('resting'), bot('traveling'), resting({}, { partyId: 7 }),
    resting({}, { party: { partyId: 7 } }), resting({ partyRequest: { spotId: 1 } })]) assert.equal(verdict(state), null);
assert.equal(count('hold:transit:held'), held);

// A quiet solo step: the verdict asks the shared event check with the
// build's baseline, its expected hour and the persona, then counts held.
const calls = [];
economy = { heldEventsQuiet: (state, input, at, deps, deferred, list) => { calls.push({ input, at, deps, deferred, list }); return true; } };
const travel = { to: { locX: 1, locY: 2 }, arrivalAt: T + 60000 };
for (const state of [resting(), bot('traveling', { travel }), bot('dead')]) {
    const result = verdict(state, plan, quiet, { buyOrderEscrow: 300 });
    assert.equal(why(result), '');
    assert.equal(result.held, false, 'shadow never skips the rebuild');
}
assert.equal(count('hold:transit:held'), held + 3);
assert.equal(calls.length, 3);
assert.equal(calls[0].input.baseline, baseline);
assert.equal(calls[0].input.expPerHour, 1234);
assert.equal(calls[0].input.persona, persona, 'the persona comes from its owner');
assert.equal(calls[0].input.mp, undefined, 'no held MP: a crafter refuses');
assert.equal(calls[0].at, T);
assert.equal(calls[0].deps.buyOrderEscrow, 300);
assert.equal(calls[0].deferred, null);
assert.equal(verdict(resting(), plan, quiet, { hold: { transit: true } }).held, true, 'on skips a quiet step');

// Refusals carry the shared reason names, are counted, and never skip.
economy = invoke('GameServer/Bot/Economy/EconomyContext');
for (const [reason, state, previousPlan, native] of [
    ['unproved', resting(), null, quiet],
    ['sections', resting({ wishSections: null }), plan, quiet],
    ['native', resting(), plan, { ...quiet, failure: { reason: 'combat_unviable' } }],
    ['native', resting(), plan, { ...quiet, levelingRecovery: { until: T } }],
    ['wish_dirty', resting({ wishDirty: 1 }), plan, quiet],
    ['crafter_mp', resting({}, { craftLevel: 1 }), plan, quiet]
]) {
    const before = count(`hold:transit:${reason}`);
    const result = verdict(state, previousPlan, native, { hold: { transit: true } });
    assert.equal(result.why[0], reason);
    assert.equal(result.held, false, `${reason} refuses`);
    assert.equal(count(`hold:transit:${reason}`), before + 1);
}

// Sampled owners only: one row naming the decision the rebuild changed;
// its drifting own outputs are named on a same row.
Config.economyDiagnostics = true;
Config.economyDiagnosticsBotIds = '4242';
const rows = [];
let batch = null;
Diagnostics.connect(message => { rows.push(...message.records.map(JSON.parse)); batch = message; return true; });
const row = (planned, packet, reasons = []) => {
    const length = rows.length;
    compareTransit({ why: reasons, startedAt: performance.now() }, resting(), planned, packet, plan);
    if (batch) { const sent = batch; batch = null; Diagnostics.ack(sent.id, sent.records.length); }
    return rows.length > length ? rows.at(-1) : null;
};
const state = resting();
const same = row({ ...state, stats: { ...state.stats, wishSections: { at: T } } },
    { wishSections: { at: T }, wishDirty: 0, money: [1, 2], wishFocus: ['root:1', 5, 100], decisionSeq: 3, activityLeaf: 2 });
assert.equal(same.phase, 'hold'); assert.equal(same.layer, 'transit');
assert.equal(same.reason, 'held'); assert.equal(same.outcome, 'same');
assert.equal(same.moved, undefined);
assert(Number.isFinite(same.durationMs));
for (const [moved, planned, packet] of [
    ['plan:reason', { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, reason: 'other' } } }, {}],
    ['plan:next', { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, next: { npcId: 7 } } } }, {}],
    ['plan', { ...state, stats: { ...state.stats, equipmentPlan: { reason: plan.reason, ...plan } } }, {}],
    ['plan:next', { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, next: undefined } } }, {}],
    ['plan:startedAt', { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, startedAt: T } } }, {}],
    ['plan:reason', { ...state, stats: { ...state.stats, equipmentPlan: { ...plan, reason: 'other', startedAt: T } } }, {}],
    ['party_request', { ...state, stats: { ...state.stats, partyRequest: { spotId: 1 } } }, {}],
    ['trip', { ...state, activity: 'traveling' }, {}],
    ['trip', { ...state, spotId: 9 }, {}],
    ['focus', state, { wishFocus: ['root:2', 5, 100] }],
    ['decision_seq', state, { decisionSeq: 4 }],
    ['activity_leaf', state, { activityLeaf: 7 }],
    ['plan', { ...state, stats: { ...state.stats, equipmentPlan: null } }, { money: [9] }]
]) {
    const result = row(planned, packet);
    assert.equal(result.outcome, 'new', moved);
    assert.equal(result.moved, moved);
}
for (const [moved, packet] of [['packet:money', { money: [9] }], ['packet:wishFocus', { wishFocus: ['root:1', 6, 90] }],
    ['packet:dormantWishes', { dormantWishes: [['root:3', 1]] }], ['packet:stockTargets', { stockTargets: [[57, 10]] }]]) {
    const result = row(state, packet);
    assert.equal(result.outcome, 'same', `${moved} is the build's own drift, not a changed decision`);
    assert.equal(result.moved, moved);
}
assert.equal(row(state, {}, ['money']).reason, 'money', 'a refused step is compared under its reason');
assert.equal(Hold.compare('transit', { characterId: 4343 }, [], () => { throw Error('moved read off sample'); }, 0), false);
assert.equal(compareTransit(null, state, state, {}, plan), undefined);

// The lifecycle step: a held transit step returns before any build; in
// shadow it goes on to the ordinary rebuild.
const callback = source.slice(source.indexOf('planLifecycle: async') + 'planLifecycle: '.length, source.indexOf(',\n        emit: send'));
const planLifecycle = vm.runInNewContext(`${helperSource}(${callback})`, context({
    invoke: name => name === 'GameServer/Bot/Population/ColdKarmaPolicy' ? { plan: () => null } : invoke(name),
    planningSpots: [], GearAcquisitionPlanner: { replanContextFor: () => quiet },
    currentPlanningOccupancy: () => { throw Error('rebuild started'); }
}));
(async () => {
    economy = { heldEventsQuiet: () => true };
    assert.equal(await planLifecycle({ state: resting(), context: { hold: { transit: true } }, timestamp: T }), null);
    await assert.rejects(planLifecycle({ state: resting(), context: {}, timestamp: T }), /rebuild started/);
    await assert.rejects(planLifecycle({ state: bot('hunting'), context: { hold: { transit: true } }, timestamp: T }), /rebuild started/);
    console.log('test_transit_hold: ok');
})().catch(error => { console.error(error); process.exit(1); });
