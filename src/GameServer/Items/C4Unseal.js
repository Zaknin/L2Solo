const { recipes } = require('../../../data/Items/c4_unseal.json');
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
module.exports = {
    recipes,
    forProduct: id => byProduct.get(Number(id)) || null,
    options: id => bySource.get(Number(id)) || [],
    resolve
};
