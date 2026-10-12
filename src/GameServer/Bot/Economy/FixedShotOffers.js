'use strict';
// Shared authored shot supply for main and cold workers. No live World or
// database dependency: selection and execution read the same configured rows.
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Production = require('./ProductionPolicy');
const SHOT_IDS = [...Production.NO_GRADE_SHOTS, ...Production.GRADED_SHOTS];
const EMPTY_OFFERS = Object.freeze([]);
let fixedRate = null, fixedConfig = null, fixedRows = null, fixedByItem = new Map();
function offers(selfId = null) {
    if (Production.shotsDisabled()) return EMPTY_OFFERS;
    const rate = invoke('GameServer/Bot/Economy/BotEconomyPricing').economyRate();
    const stores = invoke('GameServer/Bot/MerchantStoreConfigs');
    if (!fixedRows || fixedRate !== rate || fixedConfig !== stores) {
        fixedRate = rate; fixedConfig = stores;
        fixedByItem = new Map();
        const rows = [], Pricing = require('./StaticMerchantPricing');
        const items = invoke('GameServer/DataCache').items;
        for (const id of SHOT_IDS) {
            const itemName = ItemTemplateIndex.find(items, id)?.template?.name || `Item ${id}`;
            const sources = Pricing.sellersOf(id).filter(row => Number(row.price) > 0).map(row => {
                const store = stores[row.sourceName];
                return Object.freeze({ ...row, sourceType: 'configured_store', sourceId: row.sourceName,
                    sellerKind: 'fixed', selfId: id, itemName, count: Infinity, available: true,
                    locX: Number(store?.locX || 0), locY: Number(store?.locY || 0), locZ: Number(store?.locZ || 0) });
            });
            fixedByItem.set(id, Object.freeze(sources));
            rows.push(...sources);
        }
        fixedRows = Object.freeze(rows);
    }
    return selfId === null ? fixedRows : fixedByItem.get(Number(selfId)) || EMPTY_OFFERS;
}
module.exports = { offers };
