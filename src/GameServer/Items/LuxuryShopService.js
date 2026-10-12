const Catalog = require('../World/Generics/NpcExchangeShopLists');
const NpcIndex = require('../World/NpcObjectIndex');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const InventoryLimits = require('../Inventory/InventoryLimits');
const Data = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const ConsoleText = invoke('GameServer/ConsoleText');
const World = invoke('GameServer/World/World');

function nearby(session) {
    const actor = session.actor, talk = session.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || !npc || npc.fetchSelfId() !== talk?.selfId || !Catalog.fetchForNpc(talk.selfId).length
        || npc.isDead?.() || actor.isDead?.() || actor.fetchIsOnline?.() === false
        || actor.state?.fetchCombats?.() || actor.state?.fetchHits?.() || actor.state?.fetchCasts?.()
        || session.activeTrade || session.botTrade || actor.fetchPrivateStoreType?.() || session.activeEnchantItem
        || session.persistenceMode === 'ephemeral'
        || !(Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY()) <= 200)
        || !(Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) <= 200)) throw Error('luxury_shop_unavailable');
    return npc;
}

function open(session, listId = session.activeNpcTalk?.selfId) {
    const rows = Catalog.fetchForNpc(listId), talk = session.activeNpcTalk;
    session.activeMultiSell = null;
    if (!rows.length || Number(listId) !== talk?.selfId || !session.actor) throw Error('invalid_multisell_list');
    session.activeMerchantTrade = null;
    session.activeAdminShop = null;
    session.activeNpcShop = null;
    session.activeNpcSellShop = null;
    session.activeMultiSell = { listId: Number(listId), npcObjectId: talk.objectId, actor: session.actor };
    session.dataSendToMe(Response.multiSellList(Number(listId), rows));
    session.dataSendToMe(Response.actionFailed());
}

async function exchange(session, listId, entryId, amount) {
    const npc = nearby(session), actor = session.actor, context = session.activeMultiSell;
    const recipe = Catalog.resolve(listId, entryId);
    if (session.multiSellPending || !context || context.actor !== actor || context.listId !== listId
        || listId !== npc.fetchSelfId() || context.npcObjectId !== npc.fetchId()
        || !recipe || !Number.isInteger(amount) || amount < 1 || amount > 5000) throw Error('invalid_multisell_selection');
    const product = ItemTemplateIndex.find(Data.items, recipe.result.selfId);
    const validate = (rows = []) => {
        if (session.actor !== actor || session.activeMultiSell !== context || nearby(session).fetchId() !== context.npcObjectId)
            throw Error('multisell_interrupted');
        for (const row of rows) {
            const item = actor.backpack.fetchItemRaw(row.id);
            if (!item || item.fetchSelfId() !== row.selfId || item.fetchAmount() !== row.amount
                || item.fetchEquipped() || item.fetchPetLocked?.()) throw Error('multisell_materials_changed');
        }
        if (actor.backpack.fetchItems().length + amount * recipe.result.amount > InventoryLimits.forActor(actor)) throw Error('multisell_inventory_full');
        if (actor.backpack.fetchTotalLoad() + product.template.mass * amount * recipe.result.amount > actor.fetchMaxLoad())
            throw Error('multisell_weight_limit');
    };
    session.multiSellPending = true;
    try {
        const result = await Database.exchangeLuxuryItems(actor.fetchId(), { listId, entryId, amount, validate });
        for (const row of result.consumed) {
            if (row.remaining) actor.backpack.updateAmount(row.id, row.remaining);
            else actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== row.id);
        }
        for (const row of result.products) actor.backpack.insertItem(row.id, row.selfId, row);
        if (session.actor === actor) {
            actor.statusUpdateVitals?.();
            session.dataSendToMe(Response.userInfo(actor));
            session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
            ConsoleText.transmitPickup(session, recipe.result.selfId, result.products.length);
        }
        return result;
    } finally { session.multiSellPending = false; }
}

module.exports = { open, exchange };
