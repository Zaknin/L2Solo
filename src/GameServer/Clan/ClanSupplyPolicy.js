'use strict';
const { isMainThread } = require('node:worker_threads');
const records = new Map();
const stocks = new Map();
let source = id => records.get(id);
let revision = 0;
const positive = value => Math.max(0, Math.floor(Number(value) || 0));
const active = goal => goal && !['completed', 'cancelled', 'failed', 'abandoned'].includes(goal.status)
    && !(positive(goal.required) && Number(goal.progress) >= Number(goal.required));
function requirements(clan, warehouse = null) {
    const demand = new Map(), seen = new Set(), goals = [clan?.state?.goal, clan?.state?.productionGoal].filter(active);
    if (!(Number(clan?.level) >= 1)) return {};
    for (const goal of goals) {
        if (goal.goalKey && seen.has(goal.goalKey)) continue;
        if (goal.goalKey) seen.add(goal.goalKey);
        const beneficiary = (clan.members || []).find(member => Number(member.characterId ?? member.id) === Number(goal.target?.memberId));
        const plan = beneficiary?.stats?.equipmentPlan;
        let materials = [];
        if (goal.policy?.strategy === 'craft' && goal.plan?.craft?.materials?.length) materials = goal.plan.craft.materials
            .map(row => [Number(row.selfId), positive(row.required ?? row.amount)]);
        else if (plan?.strategy === 'craft' && plan.clanGoal?.goalKey === goal.goalKey) {
            const Crafting = require('./ClanCraftingPolicy');
            materials = [...Crafting.requirements(Crafting.resolveRecipe(plan.recipeId), beneficiary.inventory,
                null, 1, plan.craftProviders, plan.componentRecipes)].map(([id, amount]) =>
                [id, Math.max(0, amount - positive(beneficiary.inventory?.[id]?.amount))]);
        } else if (goal.policy?.strategy !== 'craft' && (goal.type === 'item' || goal.type === 'equipment')) {
            const id = Number(goal.target?.itemId ?? goal.target?.selfId);
            const item = invoke('GameServer/Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, id);
            const unit = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(item?.template?.price);
            let amount = Math.max(0, positive(goal.required || 1) - positive(goal.progress));
            if (warehouse) {
                const budget = require('../ClanHall/Policy').freeAdena(warehouse, clan,
                    clan.state?.mode || 'autonomous', goal === clan.state?.goal ? null : clan.state?.goal);
                amount = Math.min(amount, unit > 0 ? Math.floor(budget / unit) : 0);
            }
            if (id > 0 && unit > 0) materials = [[id, amount]];
        }
        for (const [id, amount] of materials) if (id > 0 && amount > 0)
            demand.set(id, positive(demand.get(id)) + amount);
    }
    for (const row of warehouse || []) demand.set(Number(row.selfId), Math.max(0,
        positive(demand.get(Number(row.selfId))) - positive(row.amount)));
    return Object.fromEntries([...demand].filter(([, amount]) => amount > 0).slice(0, 128));
}
function publish(clan, warehouse) {
    if (!isMainThread || !(Number(clan?.id) > 0)) return;
    if (warehouse) stocks.set(Number(clan.id), warehouse.map(row => ({ selfId: row.selfId,
        amount: row.amount, reservedAmount: row.reservedAmount })));
    warehouse = warehouse || stocks.get(Number(clan.id)) || [];
    const row = [Number(clan.id), Number(clan.level), Object.entries(requirements(clan, warehouse)).map(([id, amount]) => [Number(id), amount])];
    const previous = records.get(row[0]);
    if (JSON.stringify(previous?.slice(0, 3)) === JSON.stringify(row)) return;
    row.push(++revision);
    records.set(row[0], row);
    require('../Bot/Population/ColdTableChannel').shared.changed('clan_supplies', row);
}
function reservedAmounts(state = {}) {
    const id = Number(state.clanId ?? state.stats?.clanId);
    const row = source(id);
    if (!(id > 0) || !(Number(row?.[1]) >= 1)) return {};
    return Object.fromEntries(row[2] || []);
}
function hasWarehouse(state = {}) {
    if (Number.isFinite(state.clanLevel)) return state.clanLevel >= 1;
    return Number(source(Number(state.clanId ?? state.stats?.clanId))?.[1]) >= 1;
}
async function init() {
    if (!isMainThread) return;
    const rows = await invoke('Database').execute(['SELECT id, level FROM clans', []], 'clan-supplies:levels');
    for (const row of rows) publish({ ...row, state: {} });
}
if (isMainThread) require('../Bot/Population/ColdTableChannel').shared.register('clan_supplies', {
    key: row => row[0], allRows: () => records.values(), eventDriven: true
});
module.exports = { requirements, publish, reservedAmounts, hasWarehouse, init,
    version(state = {}) { return Number(source(Number(state.clanId ?? state.stats?.clanId))?.[3] || 0); },
    useRowSource(reader) { source = reader || (id => records.get(id)); } };
