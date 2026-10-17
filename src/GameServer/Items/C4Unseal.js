const { recipes } = require('../../../data/Items/c4_unseal.json');
const Diagnostics = require('../Bot/Economy/EconomyDiagnostics');
const bySource = new Map();
const byProduct = new Map();
const productIndex = require('../Knowledge/NativeServiceIndex').currentIndex(['productId'], rows => {
    const products = new Map();
    for (const row of rows) if (!products.has(row.productId)) products.set(row.productId, row);
    return products;
});
for (const recipe of recipes) {
    if (!bySource.has(recipe.sourceId)) bySource.set(recipe.sourceId, []);
    bySource.get(recipe.sourceId).push(recipe);
    byProduct.set(recipe.productId, recipe);
}
function resolve(source, product) {
    const rows = bySource.get(Number(source)) || [];
    if (!rows.length) return null;
    if (product && ['object', 'function'].includes(typeof product))
        return rows.find(r => r.productId === Number(product)) || null;
    const index = productIndex(rows);
    if (!index) return rows.find(r => r.productId === Number(product)) || null;
    const id = Number(product);
    return (!Number.isNaN(id) && index.get(id)) || null;
}
// The plain answer per bag object. Every writer of a bot's bag builds a new
// inventory object (a structured clone, a spread copy, a delta apply), so the
// same object is the same bag and a new one is read again. The stored bag
// revision is not the key: it moves only at the cold commit, while hot
// errands and the worker replace the bag before it. Entries go with the bag.
const heldByBag = new WeakMap();
// The first item of a bot's bag (its inventory summary) that Mammon unseals,
// or null. `accept` narrows the recipes (the bot's armor style); a narrowed
// answer is not kept, only the plain one the scheduler asks on every pass.
function sealedHeld(inventory, accept = null) {
    if (!inventory || typeof inventory !== 'object') return null;
    const held = accept ? undefined : heldByBag.get(inventory);
    if (held !== undefined) return held;
    Diagnostics.count('mammon', 'scan', accept ? 'accept' : 'plain');
    let found = null;
    for (const key in inventory) {
        const item = inventory[key];
        if (Number(item?.amount) > 0 && bySource.has(Number(item.selfId)) && (!accept || accept(item))) {
            found = item;
            break;
        }
    }
    if (!accept) heldByBag.set(inventory, found);
    return found;
}
module.exports = {
    recipes,
    forProduct: id => byProduct.get(Number(id)) || null,
    options: id => bySource.get(Number(id)) || [],
    resolve,
    sealedHeld
};
