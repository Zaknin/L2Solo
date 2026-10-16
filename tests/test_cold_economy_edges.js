const assert = require('node:assert/strict');
require('../src/Global');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const before = { characterId: 1, activity: 'hunting', level: 30, adena: 1000,
    timing: { lastResolvedAt: 100 }, stats: { money: [100, .01, 100, 1000] },
    inventory: { 57: { selfId: 57, amount: 1000 }, 1870: { selfId: 1870, amount: 12 }, 1463: { selfId: 1463, amount: 1200 } } };
const options = { stockFor: (state, kind) => ({ itemId: kind === 'shots' ? 1463 : 1061, keep: 1000 }) };
const clone = () => structuredClone(before);
let after = clone(); after.adena += 1000; after.inventory[57].amount += 1000;
// No crossing: this packet says its next wish costs more than this wallet.
before.stats.money[3] = after.stats.money[3] = 10000;
after.exp = 100; after.inventory[1870].amount += 12;
assert.equal(Plan.edges(before, after, {}, 200, options), 0, 'ordinary loot does not build a plan');
after.inventory[1871] = { selfId: 1871, amount: 1 };
assert.equal(Plan.edges(before, after, {}, 200, options), 1, 'first new item type fires exactly one edge');
after = clone(); after.inventory[1463].amount = 900;
assert.equal(Plan.edges(before, after, {}, 200, options), 2);
assert.equal(Plan.edges(after, before, {}, 200, options), 2, 'stock recovery crosses in the other direction too');
after = clone(); after.stats.money[3] = 1000; after.adena = 1200;
assert.equal(Plan.edges(before, after, {}, 200, options), 4, 'money uses the real E4 packet predicate');
const escrowBefore = { ...before, stats: { ...before.stats, money: [100, .01, 100, 1000] }, adena: 100 };
const escrowAfter = { ...escrowBefore, adena: 200 };
assert.equal(Plan.edges(escrowBefore, escrowAfter, { buyOrderEscrow: 900 }, 200, options), 4,
    'native mirrored escrow participates in the actual funding crossing');
assert.equal(Plan.edges(escrowBefore, escrowAfter, { buyOrderEscrow: 1000 }, 200, options), 0,
    'a threshold already covered by escrow does not fire again on ordinary cash loot');
after = clone(); assert.equal(Plan.edges(before, after, { goalReviewAt: 150 }, 200, options), 8);
assert.equal(Plan.edges({ ...before, activity: 'traveling' }, { ...after, activity: 'shopping' }, {}, 200, options), 8,
    'arrival runs the natural town review even when the bag and goal deadline did not change');
assert.equal(Plan.edges(before, after, { goalReviewAt: 100 }, 200, options), 0, 'already-due goal is not a new edge');
assert.equal(Plan.edges({ ...before, activity: 'resting' }, after, { goalReviewAt: 100 }, 200, options), 8,
    'recovery reviews a goal whose deadline passed while economic actions were blocked');
assert.equal(Plan.edges({ ...before, activity: 'resting' }, after, {}, 200, options), 8,
    'recovery reviews stock and new loot even without a saved goal deadline');
assert.equal(Plan.edges(after, clone(), { goalReviewAt: 100 }, 200, options), 0,
    'the next ordinary hunting resolve does not repeat the recovery review');
after.level++; assert.equal(Plan.edges(before, after, {}, 200, options), 16);
after = clone(); after.activity = 'dead'; assert.equal(Plan.edges(before, after, {}, 200, options), 32);
for (const blocked of [{ activity: 'resting' }, { activity: 'traveling' }, { party: { partyId: 'p' } }, { partyId: 'p' }]) {
    after = { ...clone(), level: 31, ...blocked }; after.inventory[1871] = { selfId: 1871, amount: 1 };
    assert.equal(Plan.edges(before, after, { goalReviewAt: 150 }, 200, options), 0);
}
// Place 'edges': a goal review drops a kept card only when the goal revision
// moved (or is unknown); an arrival, loot or money edge never does.
after = clone();
assert.deepEqual(Plan.heldEdges(8, before, after, { goalReviewAt: 150 }, 200), ['review_goal'], 'no revision: the old rule');
assert.deepEqual(Plan.heldEdges(8, before, after, { goalReviewAt: 150, goalRevision: 7 }, 200, 7), [], 'same goal revision holds');
assert.deepEqual(Plan.heldEdges(8, before, after, { goalReviewAt: 150, goalRevision: 8 }, 200, 7), ['review_goal']);
assert.deepEqual(Plan.heldEdges(8, { ...before, activity: 'traveling' }, { ...after, activity: 'shopping' }, {}, 200), []);
assert.deepEqual(Plan.heldEdges(1 | 2 | 4 | 16, before, after, {}, 200), []);
// After a rest: only a moved decision fact (DecisionSections.events), not hp/mp.
const Sections = require('../src/GameServer/Bot/Economy/DecisionSections');
const resting = { ...clone(), activity: 'resting', vitals: { hp: 50, mp: 10 } };
resting.stats.wishSections = { at: 150, funding: Sections.fundingMark(resting),
    ...Sections.semanticFacts({ ...resting, activity: 'hunting' }, 150) };
const recovered = { ...structuredClone(resting), activity: 'hunting', vitals: { hp: 100, mp: 40 } };
assert.deepEqual(Plan.heldEdges(8, resting, recovered, {}, 200), [], 'a rest that only refilled hp/mp holds');
recovered.stats.clanId = 5;
assert.deepEqual(Plan.heldEdges(8, resting, recovered, {}, 200), ['review_after_rest'], 'a moved relation drops the card');
assert.deepEqual(Plan.edgeNames(8 | 16, { ...before, activity: 'resting' }, after, {}, 200), ['review_after_rest', 'level']);
console.log('Cold economy edges passed');
