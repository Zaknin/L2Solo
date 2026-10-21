'use strict';

const Funding = require('../Economy/PurchaseFunding');

function held(state, now = Date.now()) {
    const value = state?.stats?.raidSupplyPreparation;
    return value?.id && Number(value.expiresAt) > now ? value : null;
}

function cash(state) { return Funding.spendable(state, 0, { upperBound: true }); }

function supplies(members, shotPlans) {
    const Shots = invoke('GameServer/Inventory/ShotStock');
    return shotPlans.map(plan => {
        const state = members.find(s => s.characterId === plan.id);
        const shot = Shots.planForState(state);
        const target = Math.max(0, plan.required - Shots.beginnerAmount(state, shot));
        const missing = Math.max(0, plan.required - plan.stock);
        const quote = missing ? Number(invoke('GameServer/Bot/Economy/StaticMerchantPricing').botPurchasePrice(plan.selfId)) : 0;
        const price = Number.isFinite(quote) && quote > 0 ? quote : 0;
        return { id: plan.id, selfId: plan.selfId, target, missing, price, cost: missing * price,
            cash: cash(state) };
    });
}

// This is an explicit, expiring purchase authority, not another wallet.
// Native writers re-read the current bag, reserve and wallet on every debit.
function purchaseBudget(state, terms, now = Date.now()) {
    if (!terms?.raidPreparationId) return null;
    const prep = held(state, now), supply = prep?.supply;
    if (prep?.id !== terms.raidPreparationId || Number(supply?.selfId) !== Number(terms.itemId)) return 0;
    const missing = Math.max(0, Number(supply.target) - Number(state.inventory?.[supply.selfId]?.amount || 0));
    return Math.min(Math.max(0, Funding.budget(state) - Funding.clanCredit(state) - Funding.operatingReserve(state)),
        missing * Math.max(0, Number(supply.priceCap) || 0));
}

module.exports = { held, cash, supplies, purchaseBudget };
