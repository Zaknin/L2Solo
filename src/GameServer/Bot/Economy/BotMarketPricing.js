const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
let snapshotPrices = null;

function indexOffers(offers) {
    const prices = new Map();
    for (const offer of offers) {
        const price = Number(offer.price || 0);
        if (price > 0) prices.set(Number(offer.selfId), Math.min(
            price, prices.get(Number(offer.selfId)) ?? Infinity
        ));
    }
    return prices;
}

function useNpcOfferSnapshot(offers) {
    // Workers receive immutable offers from the main process and must never
    // load town/world services to evaluate an item.
    snapshotPrices = indexOffers(offers || []);
}

function npcPrice(item) {
    // An enchanted item is not equivalent to the ordinary NPC stock.
    if (item?.npcComparable === false || Number(item?.enchant || 0) > 0) return Infinity;
    if (snapshotPrices) return snapshotPrices.get(Number(item?.selfId)) ?? Infinity;
    return require('../../Knowledge/GameDataCatalogue').native().npcPriceForItem(item?.selfId) ?? Infinity;
}

function referencePrice(item) {
    return Math.min(BotEconomyPricing.scalePrice(item?.basePrice), npcPrice(item));
}

function priceAt(item, ratio) {
    return Math.max(1, Math.floor(referencePrice(item) * ratio));
}

module.exports = { npcPrice, referencePrice, priceAt, useNpcOfferSnapshot };
