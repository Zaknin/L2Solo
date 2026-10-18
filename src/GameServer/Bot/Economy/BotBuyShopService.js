'use strict';

const Rules = require('../../AfkTrade/BoardRules');
const Places = require('./ShopPlaces');
const Funding = require('./PurchaseFunding');
const { marketBuyStoreTitle } = require('./MarketStoreTitle');
const key = line => `${Number(line.selfId)}:${Number(line.enchant || 0)}`;

// The wish queue already ordered and priced these bids. Allocate custody;
// never choose another price, need, or town on the main thread.
async function publish(state, wanted, town, { priority = 0, expectedAuthority = null, appearance } = {}) {
    const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
    const ownerId = Number(state.characterId);
    const current = Afk.findOwnerProjection(ownerId)?.shop || null;
    const records = Afk.ownerRecords(ownerId);
    const ads = records.filter(record => record.kind === 'buy_ad');
    const escrow = current?.storeType === Rules.BUY ? Number(current.escrowAdena) : 0;
    const budgetState = { ...state, adena: Funding.budget(state, escrow) };
    const kit = wanted.reduce((sum, line) => sum + Math.max(0, Number(line.survivalCost) || 0), 0);
    let money = Funding.spendable(budgetState, 0, { upperBound: true, survivalCost: kit });
    const shopLines = [], meetings = [], roots = new Set();
    const mayUseShop = priority !== Rules.SELL && (!current || current.storeType === Rules.BUY || priority === Rules.BUY);
    const inTown = state.currentRegion === town && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state);
    const mayOpen = state.phase === 'cold' && Places.hasPlaza(town) && (current?.town === town || inTown);
    let loc = null;
    if (wanted.length && mayUseShop && mayOpen) {
        loc = current?.town === town && Places.isStallArea(town, current)
            ? { locX: current.locX, locY: current.locY, locZ: current.locZ }
            : Places.take(town, Places.afkOwner(ownerId));
    }
    for (const line of wanted) {
        const cost = Number(line.count) * Number(line.price);
        if (loc && shopLines.length < Rules.BOT_SHOP_LINES && cost <= money
            && (!line.intent?.key || !roots.has(line.intent.key))) {
            const previous = records.filter(record => record.storeType === Rules.BUY && record.town === town)
                .flatMap(record => record.lines).find(old => key(old) === key(line) && old.price === line.price);
            shopLines.push({ ...line, ...(previous ? { fills: previous.fills, pricing: previous.pricing } : {}) });
            if (line.intent?.key) roots.add(line.intent.key);
            money -= cost;
        } else if (meetings.length < Rules.BOT_RECORDS.buy_ad) meetings.push(line);
    }
    const center = invoke('GameServer/Bot/Economy/ColdMarketListingService').townCenter(town) || { locX: 0, locY: 0, locZ: 0 };
    try {
        const look = shopLines.length ? current?.appearance || await appearance() : null;
        const result = await Afk.replaceBotRecords(ownerId, 'buy_ad', meetings.map(line => ({
            storeType: Rules.BUY, title: marketBuyStoreTitle([line]), town, ...center, lines: [line]
        })), {
            expected: Object.fromEntries(ads.map(ad => [ad.id, ad.revision])), expectedAuthority,
            buyShop: { expected: current ? { id: current.id, revision: current.revision } : null,
                config: shopLines.length ? { storeType: Rules.BUY, title: marketBuyStoreTitle(shopLines),
                    town, ...loc, head: current?.head || 0, appearance: look, lines: shopLines } : null }
        });
        return { shop: result.shop || result.retained?.[0] || result.opened[0] || null,
            changed: !!(result.closed.length || result.changed?.length || result.opened.length) };
    } finally {
        Afk.restorePlace(ownerId);
    }
}

module.exports = { publish };
