const assert = require('node:assert/strict');
require('../src/Global');

const Actor = invoke('GameServer/Actor/Actor');
const DataCache = invoke('GameServer/DataCache');
const Generics = invoke(path.actor);
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Item = invoke('GameServer/Item/Item');
const Request = invoke('GameServer/Network/Request');
const Database = invoke('Database');
const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const World = invoke('GameServer/World/World');

DataCache.init();
let nextItemId = 4000000;

function createSession() {
    const session = {
        packets: [], observers: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers(packet) { this.observers.push(packet); },
        dataSendToMeAndOthers(packet) { this.dataSendToMe(packet); this.dataSendToOthers(packet); }
    };
    session.actor = new Actor(session, {
        ...utils.crushOb(DataCache.classTemplates.find(row => row.classId === 1)),
        id: 9101, name: 'GearTester', username: 'gear_test', classId: 1,
        level: 20, exp: DataCache.experience[19], sp: 0, hp: 80, mp: 30,
        sex: 0, locX: 0, locY: 0, locZ: 0, head: 0, face: 0, hair: 0,
        hairColor: 0, title: '', karma: 0, pk: 0, pvp: 0, isGM: 0,
        items: [], paperdoll: Array.from({ length: 16 }, () => ({}))
    });
    return session;
}

function addItem(session, selfId, equipped = false, amount = 1) {
    const backpack = session.actor.backpack;
    const template = DataCache.items.find(row => row.selfId === selfId);
    assert(template, `item ${selfId} exists in the datapack`);
    const item = new Item(nextItemId++, {
        ...utils.crushOb(template), amount, equipped
    });
    backpack.items.push(item);
    Item.bindInventory(backpack);
    if (equipped) backpack.equipPaperdoll(item.fetchSlot(), item.fetchId(), selfId);
    return item;
}

function request(opcode, ...values) {
    const packet = Buffer.alloc(1 + values.length * 4);
    packet[0] = opcode;
    values.forEach((value, index) => packet.writeInt32LE(value, 1 + index * 4));
    return packet;
}

function equipmentOffset(packet) {
    let offset = 21;
    while (packet.readUInt16LE(offset)) offset += 2;
    return offset + 2 + 19 * 4;
}

function ownerEquipment(session, slot, display = true) {
    const packet = session.packets.findLast(packet => packet[0] === 0x04);
    assert(packet, 'the owner receives a refreshed UserInfo');
    return packet.readInt32LE(equipmentOffset(packet) + (slot + (display ? 16 : 0)) * 4);
}

const originals = [Database.updateItemEquipState, WriteQueue.itemAmount, World.spawnItem];
const writes = [];
const equipmentWrites = [];
Database.updateItemEquipState = (...args) => {
    equipmentWrites.push(args);
    return Promise.resolve();
};
WriteQueue.itemAmount = (...args) => writes.push(args);
try {
    const session = createSession();
    const armor = addItem(session, 6373, true);
    const boots = addItem(session, 6376, true);
    const starter = addItem(session, 2369, true);
    Generics.calculateStats(session, session.actor);
    assert.equal(session.actor.fetchExpertisePenalty(), 5, 'S-grade gear applies a novice penalty');
    const armoredDefence = session.actor.fetchCollectivePDef();
    session.packets.length = session.observers.length = 0;

    Request.trashItem(session, request(0x59, armor.fetchId(), 1));
    assert.equal(session.actor.backpack.fetchItemRaw(armor.fetchId()), undefined);
    assert.equal(armor.fetchEquipped(), false, 'destroyed gear is detached from equipment');
    assert.equal(session.actor.backpack.fetchPaperdollId(10), undefined, 'destroyed armor leaves no paperdoll entry');
    assert.equal(ownerEquipment(session, 10), 0, 'the owner immediately sees the armor removed');
    assert(session.actor.fetchCollectivePDef() < armoredDefence, 'armour removal recalculates defence');
    assert.equal(session.actor.fetchExpertisePenalty(), 5, 'the other S-grade item still imposes its penalty');
    assert.equal(session.actor.backpack.fetchPaperdollId(12), boots.fetchId(), 'other equipment stays equipped');
    assert(session.observers.some(packet => packet[0] === 0x03), 'nearby players receive CharInfo');
    assert(!session.observers.some(packet => packet[0] === 0x04), 'private UserInfo stays with the owner');

    Request.trashItem(session, request(0x59, boots.fetchId(), 1));
    assert.equal(session.actor.fetchExpertisePenalty(), 0, 'deleting the last high-grade item clears its penalty');
    assert(!EffectStore.list(session.actor).some(effect => effect.key === 'grade_penalty'));
    const status = session.packets.findLast(packet => packet[0] === 0xf3);
    assert.equal(status.readInt32LE(17), 0, 'the client immediately receives a cleared grade-penalty flag');
    assert.equal(session.actor.model.load, starter.fetchMass(), 'removed equipment no longer contributes to load');
    assert(writes.some(row => row[0] === 9101 && row[1] === boots.fetchId() && row[2] === 0),
        'equipment destruction still queues durable item deletion');

    Request.trashItem(session, request(0x59, starter.fetchId(), 1));
    assert.equal(ownerEquipment(session, 7), 0, 'the discarded starter sword leaves the visible right hand');
    assert.equal(ownerEquipment(session, 14), 0, 'the discarded starter sword leaves the repeated weapon field');
    const dual = addItem(session, 6580);
    session.packets.length = session.observers.length = 0;
    Request.useItem(session, request(0x14, dual.fetchId()));
    assert.equal(ownerEquipment(session, 7), dual.fetchSelfId(), 'duals render when equipped into empty hands');
    assert.equal(ownerEquipment(session, 14), dual.fetchSelfId());
    assert.equal(ownerEquipment(session, 7, false), dual.fetchId(), 'the right-hand object id matches the duals');
    assert(session.observers.some(packet => packet[0] === 0x03), 'equipping refreshes nearby character models');
    assert(!session.observers.some(packet => packet[0] === 0x04));

    session.packets.length = session.observers.length = 0;
    Request.unequipItem(session, request(0x11, 2 ** 14));
    assert.equal(ownerEquipment(session, 7), 0, 'unequipping duals clears the right hand');
    assert.equal(ownerEquipment(session, 14), 0);
    assert(session.observers.some(packet => packet[0] === 0x03));
    assert(!session.observers.some(packet => packet[0] === 0x04));

    const sword = addItem(session, 1);
    Request.useItem(session, request(0x14, sword.fetchId()));
    assert.equal(ownerEquipment(session, 7), 1, 'an ordinary one-handed sword still renders');
    Request.useItem(session, request(0x14, dual.fetchId()));
    assert.equal(sword.fetchEquipped(), false, 'duals replace the one-handed sword');
    assert.equal(ownerEquipment(session, 7), dual.fetchSelfId(), 'duals also render when replacing a sword');

    const fullBody = addItem(session, 356, true);
    let spawned;
    World.spawnItem = (...args) => { spawned = args; };
    session.actor.backpack.dropItem(session, fullBody.fetchId(), 1, 1, 2, 3);
    assert.equal(session.actor.backpack.fetchPaperdollId(15), undefined, 'dropping full-body armor clears its internal slot');
    assert.equal(ownerEquipment(session, 10), 0, 'dropping full-body armor clears its visible chest alias');
    assert.equal(spawned[1], 356, 'the removed gear still spawns on the ground');

    // Match explicit unequip: a conflicted slot is cleared completely, so a
    // hidden legacy duplicate cannot remain active or return after relogging.
    for (const [hiddenSelfId, visibleSelfId] of [[2369, 1], [6373, 1146], [356, 6674]]) {
        for (const deleteVisible of [false, true]) {
            const conflicted = createSession();
            const hidden = addItem(conflicted, hiddenSelfId, true);
            const visible = addItem(conflicted, visibleSelfId, true);
            const removed = deleteVisible ? visible : hidden;
            const survivor = deleteVisible ? hidden : visible;
            const slot = removed.fetchSlot();
            assert.equal(slot, survivor.fetchSlot(), 'the fixture duplicates one equipment slot');
            assert.equal(conflicted.actor.backpack.fetchPaperdollId(slot), visible.fetchId());

            Request.trashItem(conflicted, request(0x59, removed.fetchId(), 1));
            assert.equal(conflicted.actor.backpack.fetchItemRaw(removed.fetchId()), undefined);
            assert.equal(conflicted.actor.backpack.fetchItemRaw(survivor.fetchId()), survivor,
                'only the requested item is destroyed');
            assert.equal(survivor.fetchEquipped(), false,
                `removing the ${deleteVisible ? 'visible' : 'hidden'} duplicate also disarms its conflicting survivor`);
            assert.equal(conflicted.actor.backpack.fetchPaperdollId(slot), undefined);
            assert.equal(ownerEquipment(conflicted, slot === 15 ? 10 : slot), 0,
                'client equipment agrees with the normalized slot, including full-body armor');
            assert.equal(conflicted.actor.backpack.fetchEquippedWeapon(), undefined);
            assert.equal(conflicted.actor.backpack.fetchEquippedArmors().length, 0);
            assert.equal(conflicted.actor.fetchExpertisePenalty(), 0,
                'a surviving but disarmed high-grade duplicate imposes no penalty');
            assert(equipmentWrites.some(row => row[1] === survivor.fetchId() && row[2] === false && row[3] === 0),
                'the surviving duplicate is durably unequipped');
            assert(writes.some(row => row[1] === removed.fetchId() && row[2] === 0));
            assert(!writes.some(row => row[1] === survivor.fetchId()), 'the surviving item is not deleted');
        }
    }

    const arrows = addItem(session, 17, false, 10);
    const before = session.packets.length;
    session.actor.backpack.deleteItem(session, arrows.fetchId(), 3);
    assert.equal(arrows.fetchAmount(), 7, 'partial stack consumption keeps its existing behavior');
    assert(!session.packets.slice(before).some(packet => packet[0] === 0x04),
        'ordinary consumables do not broadcast equipment refreshes');

    console.log('Equipment removal sync: native trash, grade penalty, empty-hand duals, unequip and ground drop passed');
} finally {
    [Database.updateItemEquipState, WriteQueue.itemAmount, World.spawnItem] = originals;
}
