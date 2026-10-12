const SendPacket = invoke('Packet/Send');
const Data = invoke('GameServer/DataCache');
const Item = invoke('GameServer/Item/Item');
const ItemSlot = invoke('GameServer/Item/ItemSlot');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');

// Lisvus C4 MultiSellList: 0xd0, one final page of up to 40 entries.
module.exports = function multiSellList(listId, rows) {
    const packet = new SendPacket(0xd0)
        .writeD(listId).writeD(1).writeD(1).writeD(40).writeD(rows.length);
    const itemFor = entry => {
        const template = ItemTemplateIndex.find(Data.items, entry.selfId);
        if (!template) throw Error(`Missing multisell item ${entry.selfId}`);
        return new Item(0, utils.crushOb(template));
    };
    rows.forEach((row, index) => {
        packet.writeD((index + 1) * 100000).writeC(1).writeH(1).writeH(row.required.length);
        const product = itemFor(row.result);
        // A shop template fits either ear/finger; an equipped instance has one slot.
        const slot = product.fetchSlot();
        const bodyPart = [1, 4].includes(slot) ? 2 ** slot + 2 ** (slot + 1) : ItemSlot.bodyPart(product);
        packet.writeH(product.fetchSelfId()).writeD(bodyPart)
            .writeH(product.fetchClass2()).writeD(row.result.amount).writeH(0);
        for (const entry of row.required) {
            const ingredient = itemFor(entry);
            packet.writeH(ingredient.fetchSelfId()).writeH(ingredient.fetchClass2())
                .writeD(entry.amount).writeH(0);
        }
    });
    return packet.fetchBuffer();
};
