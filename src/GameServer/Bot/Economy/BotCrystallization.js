'use strict';
const Station = require('../../World/GiranCrystallizationStation');
const Rules = require('../../Items/C4EnchantRules');
const Index = require('../../Item/ItemTemplateIndex');
const CANDIDATE_LIMIT = 16;
const BATCH_LIMIT = 16;
let templates, candidates;
function reward(template, enchant = 0) {
    if (template?.etc?.rank !== 'd') return null;
    const kind = template.template.kind;
    const gross = Rules.crystalCount({ rank: 'd', cristals: template.etc.cristals, enchant,
        isWeapon: () => kind.startsWith('Weapon.'), isArmor: () => kind.startsWith('Armor.'),
        fetchKind: () => kind });
    const net = gross - Math.ceil(gross * 15 / 100);
    return net > 0 ? { gross, net, crystalId: 1458 } : null;
}
function catalog() {
    const Data = invoke('GameServer/DataCache');
    if (templates === Data.items) return candidates;
    templates = Data.items;
    candidates = templates.filter(row => reward(row) && Number(row.template.price) > 0)
        .sort((a, b) => a.template.price / reward(a).net - b.template.price / reward(b).net || a.selfId - b.selfId)
        .slice(0, CANDIDATE_LIMIT).map(row => Number(row.selfId));
    return candidates;
}
function spareState(state) {
    // The selected exchange reserves its inputs for this operation. Other
    // equipment, component and future-gear owners still protect their bag.
    return state.stats?.equipmentPlan?.strategy === 'luxury_exchange'
        ? { ...state, stats: { ...state.stats, equipmentPlan: null } } : state;
}
function free(state, id) {
    const source = spareState(state), Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    return invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(source,
        source.inventory?.[id] || {}, Disposition.reservedEquipmentAmounts(source));
}
function choices(state, purchase, trip, incomePerHour = 0) {
    if (!trip?.known) return [];
    const Data = invoke('GameServer/DataCache');
    const rows = [], seen = new Set(catalog()), source = spareState(state), bundle = [];
    const reserved = invoke('GameServer/Bot/Economy/ItemDisposition').reservedEquipmentAmounts(source);
    const freeAmount = invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount;
    const capacity = Math.max(0, Math.min(BATCH_LIMIT, 80
        - invoke('GameServer/Bot/Economy/ItemDisposition').inventorySlotCount(state)));
    let bundleAmount = 0, bundleNet = 0;
    for (const row of Object.values(state.inventory || {})) if (reward(Index.find(Data.items, row.selfId))) seen.add(Number(row.selfId));
    for (const id of seen) {
        const held = state.inventory?.[id], own = freeAmount(source, held || {}, reserved);
        // A bought copy of worn/useful gear could be reconciled into the kit.
        // Prefer a different type or an already free physical spare.
        if (Number(held?.amount) > 0 && !own) continue;
        const template = Index.find(Data.items, id), result = reward(template);
        if (own && bundle.length < 4 && bundleAmount < BATCH_LIMIT) {
            const amount = Math.min(own, BATCH_LIMIT - bundleAmount);
            bundle.push({ selfId: id, amount }); bundleAmount += amount; bundleNet += amount * result.net;
        }
        if (!held) {
            const inventory = { ...state.inventory, [id]: { selfId: id, amount: 1, slot: template.etc.slot, equipped: false } };
            const equipped = invoke('GameServer/Bot/AI/GearAcquisitionPlanner').equipInventoryUpgrades(state, inventory);
            if (equipped[id]?.equipped || equipped[id]?.equippedCount > 0) continue;
        }
        const offer = purchase(id);
        if (!own && !offer) continue;
        const batchLimit = Math.min(BATCH_LIMIT, own + Math.min(capacity, Number(offer?.availableUnits || 0)));
        if (!batchLimit) continue;
        const total = own ? 0 : offer.price + offer.tripFees;
        rows.push({ selfId: id, ...result, score: (total + (own ? 0 : offer.tripHours) * incomePerHour) / result.net,
            batchLimit, hours: (own ? 0 : offer.tripHours) + trip.hours });
    }
    const selected = rows.sort((a, b) => a.score - b.score || a.hours - b.hours || a.selfId - b.selfId);
    return bundle.length > 1
        ? [{ inputs: bundle, net: bundleNet, batchLimit: 1 }, ...selected.slice(0, 1)] : selected.slice(0, 2);
}
function inputAmount(state, id) {
    const plan = state.stats?.equipmentPlan;
    if (plan?.strategy !== 'luxury_exchange' || plan.status !== 'active'
        || !reward(Index.find(invoke('GameServer/DataCache').items, id))) return 0;
    return Math.min(BATCH_LIMIT, Number(plan.materials?.find(row => Number(row.selfId) === Number(id))?.amount || 0));
}
// Scheduler admission reads only the selected bounded inputs. The worker
// still chooses the operation and the native transaction validates ownership.
function ready(state) {
    const plan = state.stats?.equipmentPlan;
    if (plan?.strategy !== 'luxury_exchange' || plan.status !== 'active'
        || !invoke('GameServer/Bot/AI/PersonalGearProgression').personal(state)) return false;
    const amount = id => invoke('GameServer/Bot/Economy/WealthCraftDecision').freeAmount(state, state.inventory?.[id] || {});
    const cost = plan.exchange?.materials?.find(row => Number(row.selfId) === 1458)?.amount;
    if (Number(cost) > 0 && amount(1458) >= Number(cost)) return true;
    const inputs = (plan.materials || []).filter(row => Number(row.selfId) !== 1458);
    return inputs.length > 0 && inputs.length <= BATCH_LIMIT && inputs.every(row => Number(row.amount) > 0
        && amount(row.selfId) >= Number(row.amount));
}
module.exports = { reward, catalog, choices, free, inputAmount, ready, npcId: Station.npcId, CANDIDATE_LIMIT, BATCH_LIMIT };
