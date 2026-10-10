const Crafting = require('./ClanCraftingPolicy');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function kindFor(item) {
    return String(item?.kind || templateFor(item?.selfId)?.template?.kind || '');
}

function nameFor(item) {
    return String(item?.name || templateFor(item?.selfId)?.template?.name || `Item ${item?.selfId || 0}`);
}

function isBloodMark(item, config = {}) {
    return Number(item?.selfId) === Number(config.bloodMarkItemId || 1419);
}

function isClanWarehouseCandidate(item, config = {}) {
    const selfId = Number(item?.selfId || 0);
    const amount = Number(item?.amount || 0);
    const kind = kindFor(item);
    if (!selfId || selfId === 57 || amount <= 0 || item?.equipped || item?.equippedCount > 0) return false;
    return Number(config.demand?.[selfId] || 0) > 0
        && (ItemDisposition.isRecipeItem(item) || Crafting.isResource(selfId)
            || kind.startsWith('Other.Material') || isBloodMark(item, config)
            || kind.startsWith('Weapon.') || kind.startsWith('Armor.'));
}

function itemRows(state = {}, items = [], config = {}) {
    // Clan demand is an earmark for this transfer, not a personal craft input.
    const reserved = ItemDisposition.reservedEquipmentAmounts(state, { clan: false });
    const source = (items || []).map(item => {
        const protectedAmount = Math.min(Number(item.amount || 0), Number(reserved[item.selfId] || 0));
        reserved[item.selfId] = Math.max(0, Number(reserved[item.selfId] || 0) - protectedAmount);
        return { ...item, amount: Number(item.amount || 0) - protectedAmount };
    });
    return source.filter((item) => isClanWarehouseCandidate(item, config))
        .map((item) => ({
            ...item,
            id: Number(item.id || 0),
            selfId: Number(item.selfId || 0),
            name: nameFor(item),
            kind: kindFor(item),
            amount: Math.max(0, Number(item.amount || 0)),
            enchant: Math.max(0, Number(item.enchant || 0)),
            stackable: templateFor(item.selfId)?.etc?.stackable === true && !ItemDisposition.isRecipeItem(item)
        }))
        .filter((item) => item.id > 0 && item.amount > 0)
        .sort((left, right) => left.id - right.id);
}

function depositCandidates(state = {}, items = [], warehouseItems = [], config = {}) {
    const selected = new Map();
    return itemRows(state, items, config).flatMap((item) => {
        const recipe = ItemDisposition.isRecipeItem(item);
        const recipeLimit = Math.max(0, Number(config.demand?.[item.selfId] || 0));
        const stored = (warehouseItems || []).filter(row => Number(row.selfId) === item.selfId)
            .reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const left = Math.max(0, recipeLimit - stored - Number(selected.get(item.selfId) || 0));
        if (!left) return [];
        const amount = Math.min(item.amount, left);
        selected.set(item.selfId, Number(selected.get(item.selfId) || 0) + amount);
        return [{
            ...item,
            recipeLimit,
            amount,
            reason: recipe ? 'recipe' : (isBloodMark(item, config) ? 'progression_item' : 'material')
        }];
    }).filter(item => item.amount > 0);
}

module.exports = {
    depositCandidates,
    isClanWarehouseCandidate,
    isBloodMark,
    kindFor,
    nameFor
};
