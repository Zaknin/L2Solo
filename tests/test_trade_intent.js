const assert = require('assert/strict');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const keys = ['power:101:7', 'stock:shots', 'stock:potions', 'stock:scrolls', 'book:123', 'enchant:123:4',
    'sa:123:555', 'henna:10', 'status:101', 'resale:101'];
for (const key of keys) {
    const row = { key, itemId: 202, amount: 6, price: 11, recipeId: 301, valueHours: 2, valueRate: .01 };
    assert.deepEqual(Intent.decode(Intent.encode(row)), row);
}
for (const key of ['unknown:1', 'stock:food', 'power:1', 'book:1:2', 'power:NaN:7']) assert.throws(() => Intent.rootTuple(key));
for (const bad of [NaN, Infinity, -1]) assert.throws(() => Intent.encode({ key: 'book:1', itemId: 1, amount: 1, price: 1, valueHours: bad, valueRate: 1 }));

const plannedPurchase = (sourceType, quoted, executable, count = 1) => ({ kind: 'buy', activity: 'shopping',
    sourceType, quoted, executable, missingAmount: count, availableUnits: executable ? count : 0, requirements: [] });
const preparedRoot = (key, itemId, child) => ({ key, object: { itemId }, valueHours: 1, ratio: .1,
    plan: { missingAmount: 1, requirements: [{ key: `item:${itemId}`, amount: child.missingAmount, plan: child }] } });
const nativeNpcPlan = plannedPurchase('npc', true, true);
const projectedQueue = [preparedRoot('power:101:7', 101, plannedPurchase(undefined, false, false)),
    preparedRoot('henna:501', 300, nativeNpcPlan), preparedRoot('henna:502', 301, nativeNpcPlan),
    { key: 'resale:501', object: { itemId: 501, kind: 'resale' }, valueHours: 1, ratio: .1,
        plan: { kind: 'craft', recipeId: 401, missingAmount: 1,
            requirements: [{ key: 'item:202', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] } },
    preparedRoot('stock:shots', 303, plannedPurchase('afk', true, true))];
const preparedNetwork = { quantityPrepared: true, queue: projectedQueue };
const beforeProjection = JSON.stringify(preparedNetwork);
assert.deepEqual(Intent.project({}, preparedNetwork, {}, () => 100).map(row => row.itemId), [101, 202, 303],
    'two native NPC jobs leave existing three public slots for future/player supply and producer inputs');
assert.equal(JSON.stringify(preparedNetwork), beforeProjection, 'public projection does not change queue, funding or native action');
assert.equal(Intent.project({}, { quantityPrepared: true,
    queue: [preparedRoot('henna:501', 300, plannedPurchase('npc', false, false))] }, {}, () => 100)[0].itemId, 300,
    'unknown/unexecutable NPC annotation cannot hide an intended future acquisition');
// Batch rounding and the single stock pool are WishNetwork's (test_wish_quantity_allocation);
// a network without that stock reader has no remaining amounts and defers.
assert.equal(Intent.project({ inventory: { 202: { amount: 4 } } }, { queue: projectedQueue }, {}, () => 100), null,
    'an unprepared network is never projected by a second stock subtraction');
const npcWithCraft = { ...nativeNpcPlan, intentionPath: { kind: 'craft', recipeId: 301,
    requirements: [{ key: 'item:202', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] } };
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [preparedRoot('power:101:7', 101, npcWithCraft)] }, {}, () => 100)
    .map(row => [row.itemId, row.amount, row.recipeId]), [[202, 10, 301]],
    'native NPC finished-good purchase is omitted while existing craft alternatives still project their inputs');
const sharedInput = (count) => plannedPurchase(undefined, false, false, count);
const repeated = Intent.project({}, { quantityPrepared: true, queue: [{ key: 'power:101:7', object: { itemId: 101 }, valueHours: 2, ratio: .01,
    plan: { missingAmount: 1, requirements: [{ key: 'item:101', amount: 1, plan: { kind: 'craft', recipeId: 301, missingAmount: 1,
        requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }, { key: 'item:203', amount: 1,
            plan: { kind: 'craft', recipeId: 302, missingAmount: 1, requirements: [{ key: 'item:202', amount: 6, plan: sharedInput(6) }] } }] } }] } }] },
    {}, () => 100).find(row => row.itemId === 202);
assert.equal(repeated.amount, 12, 'repeated input quantities are summed before publication');
assert(repeated.valueHours <= 2);
console.log('PASS public intention source ownership: selected NPC omitted, alternative inputs traversed, future and player quotes retained, unchanged native queue and three-slot bound');

// A supported scroll need must not defer unrelated gear intentions or bid review.
for (const [key, category] of [['stock:shots', 1], ['stock:potions', 2], ['stock:scrolls', 3]]) {
    assert.deepEqual(Intent.rootTuple(key), [2, category, 0]);
    assert.equal(Intent.rootKey(2, category, 0), key);
}
assert.throws(() => Intent.rootKey(2, 4, 0));
const scrollWish = preparedRoot('stock:scrolls', 736, plannedPurchase('afk', true, true));
const mixedPrepared = { quantityPrepared: true, queue: [
    preparedRoot('power:462:11', 462, plannedPurchase('afk', true, true)), scrollWish
] };
const mixedBefore = JSON.stringify(mixedPrepared);
const mixedRows = Intent.project({}, mixedPrepared, {}, () => 124, 40);
assert.deepEqual(mixedRows.map(row => row.itemId), [462, 736]);
for (const row of mixedRows) assert.equal(Intent.decode(Intent.encode({ ...row, price: 100 })).key, row.key);
assert.equal(JSON.stringify(mixedPrepared), mixedBefore);
assert.deepEqual(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], preparedRoot('stock:scrolls', 736, nativeNpcPlan)
] }, {}, () => 124, 40).map(row => row.itemId), [462], 'NPC scroll purchase does not block peer gear or duplicate the NPC job');
assert.equal(Intent.project({}, { quantityPrepared: true, queue: [
    mixedPrepared.queue[0], { ...scrollWish, key: 'stock:food' }
] }, {}, () => 124, 40), null, 'unknown identities still defer instead of granting unsupported spending');
console.log('PASS scroll identity preserves existing codes, mixed gear projection and NPC ownership');

// The selected funded quote is executable consent for its own finite units,
// even when a mandatory kit upgrade exceeds the general willingness estimate.
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const requiredWish = { ...preparedRoot('power:101:7', 202,
    { ...plannedPurchase('afk', true, true, 10), unitPrice: 1459, town: 'Dion' }),
    funded: true, progressionPriority: 3, price: 14590, valueHours: 1,
    ratio: 1 / 90155 };
const selectedNetwork = { quantityPrepared: true, queue: [requiredWish], activity: {
    kind: 'buy', activity: 'shopping', sourceType: 'afk', quoted: true, executable: true,
    itemId: 202, amount: 2, availableUnits: 2, unitPrice: 1459, town: 'Dion', rootKey: requiredWish.key
} };
const standing = Intent.project({}, selectedNetwork, {}, () => 378, 40);
const terms = { selfId: 202, count: 2, price: 1459, town: 'Dion', enchant: 0 };
assert.equal(standing[0].worth, 378, 'selected purchase does not inflate the standing bid for all missing units');
const agreed = Intent.meetingPurchase(selectedNetwork, standing, terms);
assert(agreed, 'a funded selected quote reaches meeting preparation at its decided price');
assert.equal(agreed.amount, 2, 'only the selected finite stock receives quote authority');
assert.equal(agreed.valueHours, standing[0].valueHours * 2 / 10);
const packet = Funding.packetFor({ ...selectedNetwork, moneyPrice: requiredWish.ratio }, 90155, 0);
assert.equal(Funding.spendable({ adena: 20000, stats: { money: packet } }, 0,
    { r: agreed.valueRate }), 20000, 'the certificate uses the native packet rounding at the funding floor');
for (const changed of [{ count: 3 }, { price: 1460 }, { town: 'Giran' }, { selfId: 203 }, { enchant: 1 }]) {
    assert.equal(Intent.meetingPurchase(selectedNetwork, standing, { ...terms, ...changed }), null,
        'selected consent cannot cover a changed item, price, town, enchant or excess amount');
}
for (const changed of [{ executable: false }, { quoted: false }, { sourceType: 'npc' }, { kind: 'farm' }, { rootKey: 'power:999:7' }]) {
    assert.equal(Intent.meetingPurchase({ ...selectedNetwork, activity: { ...selectedNetwork.activity, ...changed } }, standing, terms), null);
}
assert.equal(Intent.meetingPurchase({ ...selectedNetwork, queue: [{ ...requiredWish, funded: false }] }, standing, terms), null);
assert.equal(standing[0].amount, 10); assert.equal(standing[0].worth, 378);
const priorFunding = { stats: { wishFocus: [requiredWish.key], money: [100, .01, 0, 0, .01, 20000, 202] } };
assert.equal(Intent.meetingPurchase(selectedNetwork, standing, terms, priorFunding).valueRate, .01,
    'fresh valuation can spend the same goal at its already funded native priority');
assert.equal(Intent.meetingPurchase(selectedNetwork, [{ ...standing[0], worth: 2000 }], terms, priorFunding).valueRate, .01,
    'the selected ordinary quote uses that same native bucket after a changed hour estimate');
assert.equal(Intent.meetingPurchase(selectedNetwork, standing, terms,
    { stats: { ...priorFunding.stats, wishFocus: ['power:999:7'] } }).valueRate, standing[0].valueRate,
    'another goal cannot donate its native funding priority');
assert.equal(Intent.meetingPurchase(selectedNetwork, [{ ...standing[0], worth: 2000 }], terms).amount, 10,
    'ordinary public willingness remains valid without selected-quote fallback');
console.log('PASS finite selected purchase consent, standing bid limits and native funding rounding');

const nativeWish = { ...requiredWish, plan: { ...requiredWish.plan,
    requirements: [{ key: 'item:202', amount: 2, plan: { ...plannedPurchase('npc', true, true, 2),
        unitPrice: 1459, town: 'Dion', availableUnits: Infinity } }] } };
const nativeNetwork = { ...selectedNetwork, queue: [nativeWish], activity: {
    ...selectedNetwork.activity, sourceType: 'npc', valueHours: .5 } };
assert.equal(Intent.project({}, nativeNetwork, {}, () => 378, 40).length, 0,
    'a selected NPC purchase still publishes no duplicate player demand');
const peerInstead = Intent.meetingPurchase(nativeNetwork, [], { ...terms, price: 1200 });
assert(peerInstead, 'a cheaper peer quote may fulfill the exact funded NPC input');
assert.equal(peerInstead.amount, 2); assert.equal(peerInstead.valueHours, .5);
for (const changed of [{ count: 3 }, { price: 1460 }, { town: 'Giran' }, { enchant: 1 }, { selfId: 203 }])
    assert.equal(Intent.meetingPurchase(nativeNetwork, [], { ...terms, ...changed }), null);
assert.equal(Intent.meetingPurchase({ ...nativeNetwork, queue: [{ ...nativeWish, funded: false }] }, [], terms), null);

const materialIntent = { key: 'power:101:7', itemId: 202, amount: 10,
    worth: 100, valueHours: 1, valueRate: .01 };
const materialTerms = { selfId: 202, count: 2, price: 500, town: 'Dion' };
const materialNetwork = { quantityPrepared: true, moneyPrice: .0001, queue: [], activity: null };
assert.equal(Intent.purchaseWorth(materialIntent, materialNetwork.moneyPrice), 1000);
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], materialTerms), materialIntent,
    'an advertised craft input uses the same goal willingness at consent, even when another action is selected');
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], { ...materialTerms, price: 1001 }), null,
    'fresh goal value still bounds the purchase price');
assert.equal(Intent.meetingPurchase(materialNetwork, [materialIntent], { ...materialTerms, count: 11 }), null);
assert.equal(Intent.meetingPurchase(materialNetwork, [], materialTerms), null,
    'a retired goal does not gain consent from its old public bid');
assert.equal(Intent.meetingPurchase({ ...materialNetwork, quantityPrepared: false }, [materialIntent], materialTerms), null,
    'an unprepared network cannot authorize a purchase from a prior intention');
assert.equal(Intent.meetingPurchase({ ...materialNetwork, moneyPrice: .001 }, [materialIntent], materialTerms), null,
    'higher priority spending can lower the fresh willingness');
console.log('PASS public craft input and meeting consent share goal willingness');

const requiredInput = { ...materialIntent, quote: { price: 700, town: 'Dion', amount: 3 } };
const fundedKit = { ...materialNetwork, moneyPrice: .001, queue: [{ key: materialIntent.key, funded: true,
    valueHours: 1, ratio: .01, plan: { missingAmount: 1, requirements: [{ key: 'item:202', amount: 10,
        plan: { ...plannedPurchase('afk', true, true, 10), unitPrice: 700, availableUnits: 3, town: 'Dion' } }] } }] };
assert.equal(Intent.meetingPurchase(fundedKit, [requiredInput], materialTerms).worth, 700,
    'another prerequisite of the same funded kit retains its fresh executable quote authority');
for (const change of [{ price: 701 }, { count: 4 }, { town: 'Giran' }, { enchant: 1 }])
    assert.equal(Intent.meetingPurchase(fundedKit, [requiredInput], { ...materialTerms, ...change }), null);
assert.equal(Intent.meetingPurchase({ ...fundedKit, queue: [{ key: materialIntent.key, funded: false }] },
    [requiredInput], materialTerms), null, 'an unfunded kit cannot spend at a required input quote');
assert(Intent.meetingPurchase(fundedKit, [materialIntent], materialTerms),
    'a fresh funded input quote survives omission from the public projection');
const retiredKit = { ...fundedKit, queue: [{ ...fundedKit.queue[0], plan: { missingAmount: 0 } }] };
assert.equal(Intent.meetingPurchase(retiredKit, [requiredInput], materialTerms), null,
    'an old public quote cannot replace a retired actual input');

let deepInput = { missingAmount: 3, requirements: [] };
for (let depth = 0; depth < 6; depth++) deepInput = { missingAmount: 1,
    requirements: [{ key: depth === 0 ? 'item:202' : `craft:${depth}`, amount: 3, plan: deepInput }] };
assert(Intent.project({}, { quantityPrepared: true, queue: [{ key: 'power:101:7', object: { itemId: 101 },
    valueHours: 1, ratio: .01, plan: deepInput }] }, {}, () => 100, 40).some(row => row.itemId === 202 && row.amount === 3),
    'nested craft inputs inside the native graph depth remain publicly purchasable');

const crystalPlan = amount => ({ ...plannedPurchase('afk', true, true, amount),
    unitPrice: 318, availableUnits: 575, town: 'Giran' });
const crystalRoot = (key, amount) => ({ ...preparedRoot(key, 1458, crystalPlan(amount)), funded: true });
const exchange = crystalRoot('power:854:2', 370);
exchange.plan.intentionPath = { kind: 'craft', missingAmount: 1, recipeId: 59,
    requirements: [{ key: 'item:1914', amount: 10, plan: plannedPurchase(undefined, false, false, 10) }] };
const exchangeNetwork = { quantityPrepared: true, moneyPrice: 1, queue: [exchange] };
const exchangeRows = Intent.project({}, exchangeNetwork, {}, () => 0, 40);
assert.deepEqual(exchangeRows.map(row => [row.itemId, row.amount]), [[1458, 370], [1914, 10]],
    'the actual exchange and future craft inputs both survive publication');
exchange.plan.intentionPath.requirements = [{ key: 'item:1458', amount: 500, plan: crystalPlan(500) }];
assert.equal(Intent.project({}, exchangeNetwork, {}, () => 0, 40)[0].amount, 370,
    'alternative paths do not add a second quantity for the same goal');

const firstCrystal = crystalRoot('power:883:5', 117), nextCrystal = crystalRoot('power:915:3', 260);
const rootNetwork = { quantityPrepared: true, moneyPrice: 1, queue: [firstCrystal, nextCrystal],
    activity: { kind: 'buy', activity: 'shopping', sourceType: 'afk', quoted: true, executable: true,
        itemId: 1458, amount: 117, availableUnits: 575, unitPrice: 318, town: 'Giran', rootKey: firstCrystal.key } };
const rootRows = Intent.project({}, rootNetwork, {}, () => 0, 1);
assert.equal(rootRows.length, 1); assert.equal(rootRows[0].amount, 117);
const crystalTerms = { selfId: 1458, count: 260, price: 318, town: 'Giran', enchant: 0 };
assert.equal(Intent.meetingPurchase(rootNetwork, rootRows, crystalTerms).key, nextCrystal.key,
    'a funded input omitted by item deduplication receives its own fresh certificate');
for (const change of [{ count: 261 }, { count: 377 }, { price: 319 }, { town: 'Dion' }, { enchant: 1 }])
    assert.equal(Intent.meetingPurchase(rootNetwork, rootRows, { ...crystalTerms, ...change }), null,
        'root quantities cannot be added or transferred to a different quote');
assert.equal(Intent.meetingPurchase({ ...rootNetwork, queue: [firstCrystal, { ...nextCrystal, funded: false }] },
    rootRows, crystalTerms), null, 'another root cannot lend its funding');
const futureOnly = { ...nextCrystal, plan: { missingAmount: 1,
    intentionPath: { missingAmount: 1, requirements: [{ key: 'item:1458', amount: 260, plan: crystalPlan(260) }] } } };
assert.equal(Intent.meetingPurchase({ ...rootNetwork, queue: [firstCrystal, futureOnly] },
    Intent.project({}, { quantityPrepared: true, queue: [futureOnly] }, {}, () => 0, 40), crystalTerms), null,
    'a quoted future craft alternative cannot impersonate the funded actual acquisition');
console.log('PASS exchange inputs survive craft alternatives and meetings retain each funded root quantity');
