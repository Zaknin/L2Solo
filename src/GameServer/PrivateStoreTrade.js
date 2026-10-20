'use strict';

const World = invoke('GameServer/World/World');
const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const Funding = require('./Bot/Economy/PurchaseFunding');
const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const PrivateStore = invoke('GameServer/PrivateStore');
const refreshPartyMemberships = require('./World/PartyMembershipPublication');

const INTERACTION_DISTANCE = 300;

function inRange(buyer, seller) {
    return Math.hypot(buyer.fetchLocX?.() - seller.fetchLocX?.(),
        buyer.fetchLocY?.() - seller.fetchLocY?.(), buyer.fetchLocZ?.() - seller.fetchLocZ?.()) <= INTERACTION_DISTANCE;
}

function syncInventory(session, actor, rows, spent = 0, funding = {}) {
    if (session?.actor !== actor) return;
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    for (const item of [...actor.backpack.fetchItems()]) {
        const row = byId.get(Number(item.fetchId()));
        if (!row) actor.backpack.items = actor.backpack.items.filter(other => other !== item);
        else { item.setAmount(row.amount); byId.delete(Number(row.id)); }
    }
    for (const row of byId.values()) actor.backpack.insertItem(row.id, row.selfId, row);
    actor.backpack.inventoryRevision = Number(actor.backpack.inventoryRevision || 0) + 1;
    if (session.coldLifeState) {
        session.coldLifeState = { ...session.coldLifeState,
            adena: rows.filter(row => Number(row.selfId) === 57).reduce((sum, row) => sum + Number(row.amount), 0),
            inventory: BotLifeState.inventorySummaryFromItems(rows), stats: { ...session.coldLifeState.stats,
                money: Funding.packetAfterPurchase(session.coldLifeState.stats?.money, spent, funding) } };
        refreshPartyMemberships([session], invoke);
        EconomyContext.forget(actor.fetchId());
    }
    session.dataSendToMe?.(ServerResponse.itemsList(actor.backpack.fetchItems()));
}

async function sell(seller, buyerSession, store, selfId, quantity, options = {}) {
    const buyer = buyerSession?.actor, sellerSession = seller.session;
    const line = store.items.find(item => Number(item.selfId) === Number(selfId));
    const source = seller.backpack.fetchItemRaw(Number(options.objectId));
    const amount = Number(quantity), price = Number(line?.price);
    if (!buyer || !line || !source || !Number.isSafeInteger(amount) || amount < 1
        || !Number.isSafeInteger(price) || price < 1) throw Error('private_store_unavailable');
    const validate = () => {
        // lazy: cycle TradeService loads PrivateStoreTrade at module top
        const available = invoke('GameServer/Bot/TradeService').sellableActorItems(seller, sellerSession?.coldLifeState)
            .find(item => item.fetchId() === source.fetchId());
        if (buyer === seller || buyerSession.actor !== buyer || sellerSession?.actor !== seller
            || !(World.user?.sessions || []).includes(buyerSession) || !(World.user?.sessions || []).includes(sellerSession)
            || buyer.fetchIsOnline?.() === false || seller.fetchIsOnline?.() === false || buyer.isDead?.() || seller.isDead?.()
            || !inRange(buyer, seller) || buyer.fetchPrivateStore?.() !== store || Number(buyer.fetchPrivateStoreType?.()) !== 3
            || Number(store.storeType) !== 3 || store.kind !== 'player' || !store.items.includes(line)
            || Number(line.price) !== price || options.expectedUnitPrice != null && Number(options.expectedUnitPrice) !== price
            || Number(line.count) < amount || !available || Number(available.fetchAmount()) < amount
            || Number(source.fetchSelfId()) !== Number(selfId) || source.fetchEquipped() || source.fetchPetLocked?.()
            || Number(source.fetchEnchantLevel?.() || 0) !== Number(line.enchant || 0)) throw Error('private_store_changed');
    };
    validate();
    const result = await Database.buyFromLivePrivateStore(buyer.fetchId(), {
        sellerId: seller.fetchId(), selfId, objectId: source.fetchId(), amount, price, validate, buyOrder: true,
        town: TownTransitPolicy.townAt(buyer)
    });
    line.count -= amount;
    if (line.count <= 0) store.items = store.items.filter(item => item !== line);
    for (const [session, actor, rows] of [[sellerSession, seller, result.sellerInventory], [buyerSession, buyer, result.buyerInventory]]) {
        try { syncInventory(session, actor, rows); }
        catch (error) { utils.infoWarn('PrivateStore', 'presentation after committed buy order: %s', error.message); }
    }
    try {
        buyerSession.dataSendToMe?.(ServerResponse.systemMessage.text(
            `Bought ${amount}x ${result.name} from ${seller.fetchName()} for ${result.totalAdena} Adena.`));
        if (!store.items.length && buyerSession.actor === buyer && buyer.fetchPrivateStore?.() === store)
            PrivateStore.quit(buyerSession, 3);
    } catch (error) { utils.infoWarn('PrivateStore', 'notification after committed buy order: %s', error.message); }
    return { qty: amount, totalAdena: result.totalAdena, name: result.name, budgetBacked: true };
}

// Called under TradeService's seller/owner queues. The listing and both actors
// are checked again inside the SQLite transaction, after pending writes drain.
async function buy(buyer, sellerSession, store, selfId, quantity, options = {}) {
    const seller = sellerSession?.actor;
    const buyerSession = buyer?.session;
    const line = store.items.find(item => Number(item.selfId) === Number(selfId)
        && (options.objectId == null || Number(item.objectId) === Number(options.objectId)));
    const objectId = Number(line?.objectId), price = Number(line?.price);
    const amount = Number(quantity);
    if (!seller || !line || !Number.isSafeInteger(objectId) || objectId < 1 || !Number.isSafeInteger(amount) || amount < 1
        || !Number.isSafeInteger(price) || price < 1) throw Error('private_store_unavailable');
    const validate = () => {
        if (buyer === seller || buyerSession?.actor !== buyer || sellerSession.actor !== seller
            || !(World.user?.sessions || []).includes(sellerSession)
            || !(World.user?.sessions || []).includes(buyerSession)
            || seller.fetchIsOnline?.() === false || buyer.fetchIsOnline?.() === false
            || buyer.isDead?.() || seller.isDead?.() || !inRange(buyer, seller)
            || seller.fetchPrivateStore?.() !== store || Number(seller.fetchPrivateStoreType?.()) !== 1
            || store.kind !== 'player' || Number(store.storeType) !== 1 || store.packageSale
            || !store.items.includes(line) || Number(line.count) < amount || Number(line.price) !== price
            || options.expectedUnitPrice !== undefined && price !== Number(options.expectedUnitPrice)) {
            throw Error('private_store_changed');
        }
        const item = seller.backpack.fetchItemRaw(objectId);
        if (!item || Number(item.fetchSelfId()) !== Number(selfId) || item.fetchEquipped()
            || item.fetchPetLocked?.() || Number(item.fetchAmount()) < amount) throw Error('private_store_stock_changed');
    };
    validate();
    const botBuyer = buyerSession.botSession === true || String(buyerSession.accountId || '').startsWith('bot_');
    const funding = { ...options.funding, itemId: Number(selfId) };
    const result = await Database.buyFromLivePrivateStore(buyer.fetchId(), {
        sellerId: seller.fetchId(), objectId, selfId, amount, price, validate,
        funding, fundingPacket: botBuyer ? () => buyerSession.coldLifeState?.stats?.money : null,
        town: TownTransitPolicy.townAt(seller) || store.town || null
    });
    // Nothing below can turn a committed exchange into a failed/retryable buy.
    line.count -= amount;
    if (line.count <= 0) store.items = store.items.filter(item => item !== line);
    for (const [session, actor, rows] of [[sellerSession, seller, result.sellerInventory],
        [buyerSession, buyer, result.buyerInventory]]) {
        if (session.actor !== actor) continue;
        try {
            syncInventory(session, actor, rows, actor === buyer ? result.totalAdena : 0, funding);
            if (actor === seller) session.dataSendToMe?.(ServerResponse.systemMessage.text(
                `Sold ${amount}x ${result.name} to ${buyer.fetchName()} for ${result.totalAdena} Adena.`));
        } catch (error) {
            utils.infoWarn('PrivateStore', 'inventory presentation after committed sale: %s', error.message);
        }
    }
    if (!store.items.length && sellerSession.actor === seller && seller.fetchPrivateStore?.() === store) {
        try { PrivateStore.quit(sellerSession, 1); }
        catch (error) { utils.infoWarn('PrivateStore', 'closing filled shop: %s', error.message); }
    }
    return { qty: amount, totalAdena: result.totalAdena, name: result.name };
}

module.exports = { buy, sell, inRange, syncInventory };
