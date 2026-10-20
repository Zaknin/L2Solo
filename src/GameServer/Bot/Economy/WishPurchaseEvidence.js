'use strict';
// An observed acquisition, including permitted authored unlimited supply.
// Existing quote order, static source authority and marginal route are reused.
const Query = require('./OfferQuery');
const Production = require('./ProductionPolicy');
const FixedShots = require('./FixedShotOffers');
const NPC_LIMIT = 17;
const unlimited = offer => offer.sourceType === 'npc' || offer.sourceType === 'configured_store';
// The half of the accept test that reads only the offer; the trip to its town
// is the buyer's half.
const offerAccepted = row => Number(row.price) > 0 && !Number(row.enchant || 0)
    && (unlimited(row) || Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0)
    && row.available !== false;
// The NPC offers a reader shape takes from one item's list. The shop owner
// (ColdOccupationSources.npcOffersFor, from NpcShopBuyLists.townOffers) hands
// out one frozen array per item and view, so the shape is derived once per
// array and released with it; an unfrozen list is derived per call.
const shapes = new Map();
function npcShape(npcOnly, town) {
    const key = `${npcOnly}:${town}`;
    if (!shapes.has(key)) shapes.set(key, { npcOnly, town, held: new WeakMap() });
    return shapes.get(key);
}
function npcCandidates(shape, offers) {
    const derive = () => {
        if (!shape.npcOnly && !shape.town) return offers.length <= NPC_LIMIT ? offers : offers.slice(0, NPC_LIMIT);
        const kept = offers.filter(offer => (!shape.npcOnly || offer.sourceType === 'npc')
            && (!shape.town || offer.town === shape.town)).slice(0, NPC_LIMIT);
        // Without the board and the fixed shots these are the only offers:
        // the offer's half of the accept test is settled here.
        return shape.npcOnly ? kept.filter(offerAccepted) : kept;
    };
    if (!Object.isFrozen(offers)) return derive();
    let candidates = shape.held.get(offers);
    if (!candidates) shape.held.set(offers, candidates = Object.freeze(derive()));
    return candidates;
}
function quote(offer, cost) {
    if (!offer) return null;
    const route = cost.details(offer.town);
    if (!route?.known || !Number.isFinite(route.hours) || !Number.isFinite(route.fees)) return null;
    return { price: Number(offer.price), unitPrice: Number(offer.price), availableUnits: unlimited(offer) ? Infinity : Number(offer.count),
        town: offer.town, sourceType: unlimited(offer) ? offer.sourceType : 'afk', quoted: true,
        tripHours: route.hours || 0, tripFees: route.fees || 0 };
}
function reader(state, ctx, deps, { npcOnly = false, town = null } = {}) {
    // Preparation belongs to the existing worker. A reader cannot synchronously
    // expand geometry or treat an unprepared trip as free.
    const cost = deps.tripCost || ctx.trip;
    if (typeof cost !== 'function' || typeof cost.details !== 'function') return () => null;
    const shape = npcShape(npcOnly, town);
    const accept = row => offerAccepted(row) && Number.isFinite(cost(row.town));
    const options = { ...(town ? { towns: [town] } : {}), excludeOwner: state.characterId, maxInspected: 20, cost, accept, others: null };
    return id => {
        const npc = Production.allowsNpcShot(id) ? npcCandidates(shape, deps.npcOffersFor?.(id) || []) : [];
        if (npcOnly && town) {
            // One town, no board, no fixed shots: the trip is the same for
            // every candidate, the one order picks among them.
            if (!npc.length || !Number.isFinite(cost(town))) return null;
            return quote(npc.length === 1 ? npc[0] : Query.bestSellOffer(null, id, { cost, others: npc }), cost);
        }
        // The context's watched board records an absent item as an input too.
        const board = npcOnly ? null : ctx.board || deps.board;
        // Never push onto the shared frozen list.
        options.others = !npcOnly && Production.allowsFixedShot(id) ? [...npc, ...FixedShots.offers(id)] : npc;
        return quote(Query.bestSellOffer(board?.heads ? board : null, id, options), cost);
    };
}
module.exports = { reader };
