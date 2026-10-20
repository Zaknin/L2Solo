const { canDeposit } = require('./WarehouseItemRules');
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const NpcObjectIndex = require('../World/NpcObjectIndex');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const ItemSlot = invoke('GameServer/Item/ItemSlot');
const World = invoke('GameServer/World/World');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const Limits = require('./PersonalWarehouseLimits');

const MAX_LINES = 100;
const INTERACTION_RADIUS = 300;

function isWarehouseNpc(session) {
    const active = session.activeNpcTalk;
    const actor = session.actor;
    const npc = NpcObjectIndex.find(World, Number(active?.objectId));
    if (!npc || !actor || !/^Warehouse (Keeper|Chief|Freightman)$/i.test(npc.fetchTitle?.() || '')) return false;
    if (Number(npc.fetchSelfId?.()) !== Number(active?.selfId)) return false;
    const dx = Number(actor.fetchLocX?.()) - Number(npc.fetchLocX?.());
    const dy = Number(actor.fetchLocY?.()) - Number(npc.fetchLocY?.());
    return Number.isFinite(dx) && Number.isFinite(dy) && ((dx * dx) + (dy * dy)) <= (INTERACTION_RADIUS * INTERACTION_RADIUS);
}

function templateFor(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId);
}

function warehouseItem(row) {
    const template = templateFor(row.selfId);
    if (!template) return null;
    const details = utils.crushOb(template);
    return new Item(Number(row.id), {
        ...details,
        amount: Number(row.amount),
        enchant: Number(row.enchant || 0),
        petData: row.petData,
        equipped: false,
        slot: ItemSlot.canonicalSlot(row.selfId, details.slot)
    });
}

function list(owner) {
    const rows = Limits.isPlayer(owner)
        ? Database.fetchPlayerWarehouseItems(owner.actor.fetchId(), owner.accountId)
        : Database.fetchWarehouseItems(typeof owner === 'object' ? owner.actor.fetchId() : owner);
    return rows
        .then((rows) => rows.map(warehouseItem).filter(Boolean));
}

async function playerTransfer(session, lines, mode) {
    const actor = session.actor;
    const backpack = actor.backpack;
    await CharacterWriteQueue.flushCharacter(actor.fetchId());
    const items = mode === 'deposit' ? backpack.fetchItems().filter(canDeposit) : await list(session);
    if (!validateLines(lines, items)) throw Error(`invalid warehouse ${mode === 'deposit' ? 'deposit' : 'withdrawal'}`);
    const transfers = lines.map(line => {
        const source = items.find(item => Number(item.fetchId()) === Number(line.objectId));
        return { id: Number(source.fetchId()), selfId: Number(source.fetchSelfId()), amount: Number(line.amount),
            stackable: source.fetchStackable?.() === true };
    });
    const results = await Database.transferPlayerWarehouseBatch(actor.fetchId(), session.accountId, transfers, mode);
    // Publish to the live backpack only after the entire selected batch commits.
    for (const result of results) {
        if (mode === 'deposit') {
            const source = backpack.fetchItems().find(item => Number(item.fetchId()) === result.sourceItemId);
            if (result.inventoryAmount === 0) backpack.items = backpack.items.filter(item => item !== source);
            else source.setAmount(result.inventoryAmount);
        } else {
            const target = backpack.fetchItems().find(item => Number(item.fetchId()) === result.inventoryId);
            if (target) target.setAmount(result.inventoryAmount);
            else {
                const added = warehouseItem({ ...result, id: result.inventoryId, amount: result.inventoryAmount });
                if (added) backpack.items.push(added);
            }
        }
    }
    return list(session);
}

function validateLines(lines, items) {
    const seen = new Set();
    return lines.length <= MAX_LINES && lines.every((line) => {
        const id = Number(line.objectId);
        const amount = Number(line.amount);
        return Number.isSafeInteger(id) && Number.isSafeInteger(amount) && amount > 0 &&
            !seen.has(id) && (seen.add(id) || true) &&
            items.some((item) => !item.fetchPetLocked?.() && Number(item.fetchId()) === id && amount <= Number(item.fetchAmount()));
    });
}

async function deposit(session, lines) {
    if (!isWarehouseNpc(session)) throw new Error('warehouse NPC is no longer active');
    if (Limits.isPlayer(session)) return playerTransfer(session, lines, 'deposit');
    const actor = session.actor;
    const backpack = actor.backpack;
    await CharacterWriteQueue.flushCharacter(actor.fetchId());
    const inventory = backpack.fetchItems().filter(canDeposit);
    if (!validateLines(lines, inventory)) throw new Error('invalid warehouse deposit');

    const stored = await list(actor.fetchId());
    for (const line of lines) {
        const source = inventory.find((item) => Number(item.fetchId()) === Number(line.objectId));
        const amount = Number(line.amount);
        const target = source.fetchStackable?.() && stored.find((item) => (
            item.fetchStackable?.() && Number(item.fetchSelfId()) === Number(source.fetchSelfId())
        ));

        const transferred = await Database.transferInventoryToWarehouse(actor.fetchId(), {
            id: source.fetchId(), selfId: source.fetchSelfId(), name: source.fetchName?.(), amount,
            stackable: source.fetchStackable?.(), petData: source.fetchPetData?.(), enchant: source.fetchEnchantLevel?.()
        });
        if (target) {
            target.setAmount(transferred.warehouseAmount);
        } else {
            const added = warehouseItem({
                id: transferred.warehouseId, selfId: source.fetchSelfId(), amount,
                petData: source.fetchPetData?.(), enchant: transferred.enchant
            });
            if (added) stored.push(added);
        }

        if (transferred.inventoryAmount === 0) {
            backpack.items = backpack.items.filter((item) => item !== source);
        } else {
            source.setAmount(transferred.inventoryAmount);
        }
    }
    return stored;
}

async function withdraw(session, lines) {
    if (!isWarehouseNpc(session)) throw new Error('warehouse NPC is no longer active');
    if (Limits.isPlayer(session)) return playerTransfer(session, lines, 'withdraw');
    const actor = session.actor;
    const backpack = actor.backpack;
    await CharacterWriteQueue.flushCharacter(actor.fetchId());
    const stored = await list(actor.fetchId());
    if (!validateLines(lines, stored)) throw new Error('invalid warehouse withdrawal');

    for (const line of lines) {
        const source = stored.find((item) => Number(item.fetchId()) === Number(line.objectId));
        const amount = Number(line.amount);
        const target = source.fetchStackable?.() && backpack.fetchItems().find((item) => (
            item.fetchStackable?.() && Number(item.fetchSelfId()) === Number(source.fetchSelfId())
        ));

        const transferred = await Database.transferWarehouseToInventory(actor.fetchId(), {
            id: source.fetchId(), selfId: source.fetchSelfId(), name: source.fetchName?.(), amount,
            stackable: source.fetchStackable?.()
        });
        if (target) {
            target.setAmount(transferred.inventoryAmount);
        } else {
            const added = warehouseItem({
                id: transferred.inventoryId, selfId: source.fetchSelfId(), amount,
                petData: transferred.petData, enchant: transferred.enchant
            });
            if (added) backpack.items.push(added);
        }

        if (transferred.warehouseAmount === 0) {
            stored.splice(stored.indexOf(source), 1);
        } else {
            source.setAmount(transferred.warehouseAmount);
        }
    }
    return stored;
}

module.exports = { isWarehouseNpc, list, deposit, withdraw };
