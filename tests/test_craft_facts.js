'use strict';
// Task 2: one finite craft facts reader for the wish network and the producer.
const assert = require('node:assert/strict');
require('../src/Global');
const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
const Basket = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');

const recipe = { recipeId: 7, productCount: 2, successRate: 60, mpCost: 30,
    materials: [{ selfId: 202, amount: 6 }, { selfId: 203, amount: 1 }, { selfId: 202, amount: 4 }] };

// Five outputs at two per batch need three batches; repeated ingredient ids are summed once.
const five = Profit.craftFacts(recipe, { output: 5, mpCapacity: 100, mpPerHour: 600 });
assert.equal(five.status, 'ready');
assert.equal(five.batches, 3);
assert.equal(five.output, 6);
assert.deepEqual([...five.gross], [[202, 30], [203, 3]]);
assert.equal(five.rows, 3, 'one visited row per recipe ingredient row');
assert.equal(five.successProbability, 0.6);
assert.equal(five.mp, 90);
assert.equal(five.labourHours, 90 / 600);

// Native draws: a cold command holds batches up to MP (100 / 30 -> 3) and 64;
// a hot bot crafts one batch per command; a workshop command is its capacity.
assert.equal(Profit.craftFacts(recipe, { batches: 7, mpCapacity: 100, mpPerHour: 600 }).draws, 3);
assert.equal(Profit.craftFacts(recipe, { batches: 7, executor: 'hot', mpPerHour: 600 }).draws, 7);
assert.equal(Profit.craftFacts(recipe, { batches: 7, executor: 'workshop', capacityBatches: 5 }).draws, 2);
assert.equal(Profit.craftFacts({ ...recipe, mpCost: 0 }, { batches: 65 }).draws, 2, 'one command holds at most 64 batches');
assert.deepEqual(Profit.craftFacts(recipe, { batches: 1, executor: 'workshop', capacityBatches: 0 }),
    { status: 'unknown', reason: 'capacity' });
assert.deepEqual(Profit.craftFacts(recipe, { batches: 1, mpCapacity: 20, mpPerHour: 600 }),
    { status: 'unknown', reason: 'mp_capacity' }, 'MP below one batch never crafts');

// A workshop crafter spends his MP for the fee: no own labour; the fee is paid per batch, failure included.
const workshop = Profit.craftFacts(recipe, { batches: 2, executor: 'workshop', capacityBatches: 4, fee: 1500 });
assert.equal(workshop.status, 'ready');
assert.equal(workshop.labourHours, 0);
assert.equal(workshop.fee, 3000);
assert.equal(workshop.feeOnFailure, true);

// Unknown labour is explicit, never free; quantities stay readable.
const noRegen = Profit.craftFacts(recipe, { batches: 2 });
assert.equal(noRegen.status, 'unknown');
assert.equal(noRegen.reason, 'mp_regen');
assert.deepEqual([...noRegen.gross], [[202, 20], [203, 2]]);

// A recipe scroll learned for this decision is consumed once, not per batch.
const learning = Profit.craftFacts(recipe, { batches: 4, recipeInput: 9001, mpCapacity: 1000, mpPerHour: 600 });
assert.deepEqual([...learning.gross], [[9001, 1], [202, 40], [203, 4]]);
assert.deepEqual([...learning.once], [9001]);

// Gross only: owned stock never lowers the reader's amounts.
assert.equal(Profit.craftFacts(recipe, { output: 0, mpPerHour: 600 }).batches, 0);
assert.deepEqual(Profit.craftFacts({ ...recipe, successRate: 'x' }, { batches: 1 }), { status: 'unknown', reason: 'recipe' });

// The producer basket asks for exactly the reader's gross amounts.
const asked = new Map();
const basket = Basket.basketFor(recipe, (id, amount) => {
    asked.set(id, amount);
    return { whole: true, units: amount, cost: amount, landed: amount, town: 'Giran' };
}, () => null, 3, { recipeInput: 9001, recipeStock: { count: 0 } });
assert.ok(basket);
assert.deepEqual([...asked], [...Profit.craftFacts(recipe, { batches: 3, recipeInput: 9001, mpPerHour: 600 }).gross]);

// The shared native preparation and the original non-native path must return
// the same facts and generator steps, including large-batch overflow reasons.
const NativeRecipes = require('../src/GameServer/Items/C4RecipeItems');
const RecipeKnowledge = require('../src/GameServer/Knowledge/RecipeCatalog');
function drainedFacts(recipe, options) {
    const steps = [], iterator = Profit.prepareCraftFacts(recipe, options);
    let step;
    do { step = iterator.next(); if (!step.done) steps.push(step.value); } while (!step.done);
    return { steps, facts: step.value };
}
const nativeRows = NativeRecipes.nativeSource().rows.filter(row => row.materials.length > 1).slice(0, 4);
assert(nativeRows.length > 0);
assert.equal(RecipeKnowledge.preparedInputsFor(nativeRows[0]), null, 'an unprimed craft read does not build the whole catalog');
assert.equal(RecipeKnowledge.inputsFor(nativeRows[0]), null, 'the aggregate reader also falls back without hidden catalog construction');
assert.deepEqual(drainedFacts(nativeRows[0], { batches: 2, mpPerHour: 600 }),
    drainedFacts(structuredClone(nativeRows[0]), { batches: 2, mpPerHour: 600 }));
assert.equal(RecipeKnowledge.preparedInputsFor(nativeRows[0]), null, 'craft facts keep the unprimed fallback');
RecipeKnowledge.warmup();
assert(RecipeKnowledge.preparedInputsFor(nativeRows[0]), 'explicit startup preparation enables the native path');
for (const native of nativeRows) for (const batches of [0, 1, 64, Number.MAX_SAFE_INTEGER]) {
    for (const executor of ['cold', 'hot', 'workshop']) {
        const options = { batches, executor, mpPerHour: 600, mpCapacity: Infinity, capacityBatches: 5,
            recipeInput: native.materials[0].selfId, fee: 15 };
        assert.deepEqual(drainedFacts(native, options), drainedFacts(structuredClone(native), options));
    }
}
const native = nativeRows[0], originalAmount = native.materials[1].amount;
try {
    const options = { batches: 2, mpPerHour: 600 };
    native.materials[1].amount = .5;
    assert.deepEqual(drainedFacts(native, options), drainedFacts(structuredClone(native), options), 'changed native inputs use original validation');
    native.materials[1].amount = originalAmount;
    // A mutable author row changed between scheduled steps is also read fresh.
    const live = Profit.prepareCraftFacts(native, options), fallbackRecipe = structuredClone(native);
    const fallback = Profit.prepareCraftFacts(fallbackRecipe, options);
    assert.deepEqual(live.next(), fallback.next());
    native.materials[1].amount = fallbackRecipe.materials[1].amount = originalAmount + 2;
    let step, expected;
    do { step = live.next(); expected = fallback.next(); assert.deepEqual(step, expected); } while (!step.done);
} finally { native.materials[1].amount = originalAmount; }
const originalInputs = native.materials.slice();
try {
    for (const mutate of [inputs => inputs.push({ ...inputs[0] }), inputs => inputs.splice(1, 1), inputs => inputs.reverse()]) {
        native.materials.splice(0, native.materials.length, ...originalInputs);
        const options = { batches: 2, mpPerHour: 600 }, fallbackRecipe = structuredClone(native);
        const live = Profit.prepareCraftFacts(native, options), fallback = Profit.prepareCraftFacts(fallbackRecipe, options);
        assert.deepEqual(live.next(), fallback.next());
        mutate(native.materials); mutate(fallbackRecipe.materials);
        let step, expected;
        do { step = live.next(); expected = fallback.next(); assert.deepEqual(step, expected); } while (!step.done);
    }
} finally { native.materials.splice(0, native.materials.length, ...originalInputs); }
console.log('test_craft_facts: ok');
