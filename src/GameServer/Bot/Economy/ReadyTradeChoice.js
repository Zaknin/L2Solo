'use strict';
// A compact execution of an already selected shared decision, not another
// search/valuation/roll. Full need certificates stay in TradeIntent.project.
const { personalOfferAllowed } = require('../Population/PartyAdmission');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const BotImprovementService = invoke('GameServer/Bot/Economy/BotImprovementService');
const MAX_INSPECTED = 20;
const positive = value => Number.isSafeInteger(value) && value > 0;
function executable(side, line, state) {
    if (line.custodyPolicy === 1) return true;
    // Backed purchase shops settle immediately. The seller must have reached
    // that town; field answers continue through the physical meeting owner.
    return side === BUY && line.kind === 'shop' && line.custodyPolicy === 0
        && state?.activity === 'shopping' && state.currentRegion === line.town
        && BotImprovementService.inTown(state);
}
function encode(side, line, count, state) {
    const tuple = [side, Number(line.selfId), count, Number(line.recordId), Number(line.lineId),
        Number(line.revision), Number(line.price)];
    return [SELL, BUY].includes(side) && tuple.every(positive) && executable(side, line, state) ? tuple : null;
}
function purchase(state, economy, board) {
    const leaf = economy?.network?.activity;
    if (economy?.intentPending || leaf?.activity !== 'shopping'
        || leaf.kind !== 'buy' || leaf.sourceType !== 'afk' || leaf.quoted !== true
        || leaf.executable !== true || !positive(leaf.itemId) || !positive(leaf.amount)
        || !positive(leaf.unitPrice) || !leaf.town || !board?.heads) return null;
    const count = require('../Population/ColdEconomyDecision').remainingToOrder(leaf, state, economy.state || state);
    if (!positive(count)) return null;
    const line = board.heads(leaf.itemId, SELL, { towns: [leaf.town], excludeOwner: state.characterId,
        maxInspected: MAX_INSPECTED, accept: row => personalOfferAllowed(row, state) && !row.enchant && row.custodyPolicy === 1
            && row.price === leaf.unitPrice && row.count >= count })[0];
    return line ? encode(SELL, line, count, state) : null;
}
function sale(answers, state) {
    for (const answer of answers || []) {
        if (!personalOfferAllowed(answer.line, state)) continue;
        const tuple = encode(BUY, answer.line, answer.count, state);
        if (tuple) return tuple;
    }
    return null;
}
// Resolve only the exact indexed quote. A changed quote waits for the next
// native event; it never authorizes a different counterparty or price.
function tradeStateForOwner(id) {
    return typeof invoke === 'function' ? invoke('GameServer/Bot/Population/BotLifeState')?.cachedState?.(Number(id)) : null;
}
function resolve(tuple, board, ownerId) {
    if (!Array.isArray(tuple) || tuple.length !== 7 || !tuple.every(positive)
        || ![SELL, BUY].includes(tuple[0])) return null;
    const [side, selfId, count, recordId, lineId, revision, price] = tuple;
    const line = board?.records?.get(recordId)?.find(row => row.lineId === lineId);
    const state = tradeStateForOwner(ownerId);
    return line && personalOfferAllowed(line, state) && line.storeType === side && executable(side, line, state) && line.selfId === selfId
        && line.ownerId !== Number(ownerId) && line.revision === revision && line.price === price
        && line.count >= count && (side === BUY || !line.enchant) ? line : null;
}
module.exports = { purchase, sale, resolve, MAX_INSPECTED };
