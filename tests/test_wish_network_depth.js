'use strict';
const assert = require('node:assert/strict');
const { WishNetwork, createSolver, MAX_DEPTH } = require('../src/GameServer/Bot/Economy/WishNetwork');

// RockChewer's live graph: a shot refill shares the B equipment supplier's
// C -> Luxury -> D crystal chain. The D item has both an NPC purchase and a
// craft whose raw material would be at depth seven. Evaluating that unused
// alternative must not abort the refill or the other equipment wishes.
const nodes = [
    { key: 'stock:shots', need: 'power', valueHours: 100,
        paths: [{ requirements: [{ key: 'item:1464' }] }] },
    { key: 'item:1464', paths: [{ kind: 'buy', activity: 'shopping', itemId: 1464, price: 100 },
        { kind: 'craft', requirements: [{ key: 'item:1459' }] }] },
    { key: 'item:1459', paths: [{ kind: 'crystallize', requirements: [{ key: 'item:76' }] }] },
    { key: 'item:76', paths: [{ kind: 'luxury_exchange', requirements: [{ key: 'item:1458' }] }] },
    { key: 'item:1458', paths: [{ kind: 'crystallize', requirements: [{ key: 'item:40' }] }] },
    { key: 'item:40', paths: [{ kind: 'buy', activity: 'shopping', itemId: 40, sourceType: 'npc', price: 20 },
        { kind: 'craft', requirements: [{ key: 'item:1882' }] }] },
    { key: 'item:1882', paths: [{ kind: 'buy', price: 30 },
        { kind: 'craft', requirements: [{ key: 'item:1867' }] }] },
    { key: 'item:1867', paths: [{ kind: 'buy', price: 1 }] }
];
const input = { actorKey: 'character:1', inputKey: 'depth', remembered: false, nodes,
    roots: ['stock:shots'], wallet: 1000, hourAdena: 100 };
for (const stockFor of [null, () => ({ owned: 0, incoming: 0 })]) {
    const result = new WishNetwork().build({ ...input, stockFor });
    const plan = result.plans.get('stock:shots');
    assert.equal(plan.price, 20, 'the bounded NPC chain remains cheaper than buying shots');
    assert.equal(plan.height, 5);
    assert.equal(result.activity.itemId, 40);
    assert.equal(result.activity.sourceType, 'npc');
}

// The same descriptor is also a cheaper craft when reached near a root.
// Neither a shallow cached craft nor a deep cached purchase can be reused
// with a different remaining depth budget. Both root orders must agree.
for (const progressionPriority of [0, 1]) for (const deepFirst of [false, true]) {
    const shallow = { key: 'power:40', need: 'power', valueHours: 100, progressionPriority,
        paths: [{ requirements: [{ key: 'item:40' }] }] };
    const deep = { ...nodes[0], progressionPriority };
    const solver = createSolver({ nodes: [deep, ...nodes.slice(1), shallow], hourAdena: 100, wallet: 1000 });
    const wishes = new Map((deepFirst ? [deep, shallow] : [shallow, deep])
        .map(root => [root.key, solver.rootWish(root.key)]));
    assert.equal(wishes.get(deep.key).plan.price, 20);
    assert.equal(wishes.get(shallow.key).plan.price, 1);
    assert.equal(wishes.get(shallow.key).plan.requirements[0].plan.kind, 'craft');
}

const chain = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => ({ key: `chain:${i}`,
    paths: i === MAX_DEPTH ? [{ kind: 'buy', price: 1 }]
        : [{ requirements: [{ key: `chain:${i + 1}` }] }] }));
const tooDeep = { key: 'too-deep', need: 'power', valueHours: 100,
    paths: [{ requirements: [{ key: 'item:10' }, { key: 'chain:0' }] }] };
const viable = { key: 'viable', need: 'care', valueHours: 10,
    paths: [{ kind: 'buy', activity: 'shopping', price: 1 }] };
const stockFor = id => ({ owned: id === 10 ? 1 : 0, incoming: 0 });
const bounded = createSolver({ nodes: [tooDeep, viable, ...chain,
    { key: 'item:10', paths: [{ kind: 'buy', price: 1 }] }], hourAdena: 100, stockFor });
const wish = bounded.rootWish(tooDeep.key);
assert.equal(wish.plan, null, 'a root with no bounded source cannot be executed');
const claims = bounded.allocate(wish, new Map());
assert.equal(wish.plan, null);
assert.equal(claims.has(10), false, 'a refused branch cannot reserve its earlier physical inputs');
assert(bounded.rootWish(viable.key).plan, 'refusing a deep root leaves the solver usable');
const boundary = createSolver({ nodes: [{ key: 'boundary', need: 'power', valueHours: 100,
    paths: [{ requirements: [{ key: 'chain:1' }] }] }, ...chain], hourAdena: 100 });
assert.equal(boundary.rootWish('boundary').plan.height, MAX_DEPTH, 'the existing depth limit is inclusive');
console.log('PASS wish depth: live shot/crystal chain, depth-aware reuse, stock claims and inclusive bound');
