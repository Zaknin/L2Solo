'use strict';
const History = require('./ShotTradeDemand');
const Price = require('./PriceDecision');
const Belief = require('./PriceBelief');

// Production and native rechecks share the seller's ordinary price decision
// and finite public demand evidence. No accepted buyer is invented here.
function exit(state, id, { board, town, timestamp = Date.now(), trip, npcOffers = [], units, lot = 1, reserve = 0, current = 0 } = {}) {
    const demand = History.forecast(id, town, timestamp), persona = invoke('GameServer/Bot/AI/BotPersona').of(state);
    if (!demand || !persona || !trip?.details?.(town)?.known) return null;
    const belief = Belief.prior(id, { board, characterId: Number(state.characterId), timestamp,
        understanding: persona.understanding, marketTrades: state.marketTrades || {} });
    if (!belief) return null;
    const trader = Price.traderOf(persona);
    const market = Price.marketFor(id, { board, ownerId: state.characterId, town, tripCost: trip,
        npcOffers, timestamp, demand, units });
    const ask = Price.chooseAsk(belief, market, trader, ['shot-production', state.characterId, id, demand.authority.revision], current);
    if (!ask.known || ask.npc || !(ask.sold > 0)) return null;
    const landed = ask.price + market.ownTrip;
    const cheaperUnits = market.rivals.reduce((sum, rival) => sum + (rival.landed < landed ? rival.units : 0), 0);
    const willingUnits = Price.willingUnitsAt(belief, trader, { price: ask.price,
        applicableUnits: demand.applicableUnits, landed, npcLanded: market.npcLanded });
    const remaining = Math.max(0, Math.min(demand.applicableUnits, willingUnits) - cheaperUnits - Math.max(0, units - lot));
    if (!(remaining > 0) || !Number.isSafeInteger(lot) || lot < 1) return null;
    return { type: 'listing', town, price: ask.price, count: demand.applicableUnits,
        applicableUnits: demand.applicableUnits, willingUnits, cheaperUnits,
        maxBatches: Math.ceil((remaining + Math.max(0, Number(reserve) || 0)) / lot),
        residualUnitValue: market.buyback, delayHours: demand.delayHours,
        repeatable: false, forecast: demand, trip: trip(town), tripDetails: trip.details(town) };
}
function* exits(state, recipe, { board, timestamp, trip, prepareTrip, npcOffersFor, read = () => {}, existing = 0, reserve = 0 } = {}) {
    const id = Number(recipe.productId);
    if (!History.isShot(id)) return [];
    read(id);
    const result = [];
    for (const town of History.towns(id, timestamp)) {
        if (prepareTrip) yield* prepareTrip(town);
        yield 'trip';
        const value = exit(state, id, { board, town, timestamp, trip,
            npcOffers: npcOffersFor?.(id) || [], lot: Number(recipe.productCount), reserve,
            units: Number(recipe.productCount) + Math.max(0, Number(existing) || 0) });
        if (value) result.push(value);
        yield 'exit';
    }
    return result;
}
module.exports = { exit, exits };
