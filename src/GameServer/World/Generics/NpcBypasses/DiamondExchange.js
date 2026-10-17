const Catalog = require('../../../Items/DimensionalDiamondCatalog');
const data = Catalog.data;
const Service = invoke('GameServer/Quest/QuestService');
const Profession = invoke('GameServer/SecondProfession');
const Database = invoke('Database');
const Response = invoke('GameServer/Network/Response');
const H = require('../../../Quest/SecondProfessionQuest');

function render(session, message = '') {
    const links = data.recipes.map(row => `${H.itemName(row.itemId)} - ${row.cost} Dimensional Diamonds `
        + `<a action="bypass -h diamond-exchange ${row.itemId}">Exchange</a><br>`).join('');
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk.objectId,
        `<html><body>Dimensional Diamond exchange:<br>${message}<br>${links}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
}

module.exports = function diamondExchange(session, parts) {
    const actor = session.actor, talk = session.activeNpcTalk;
    const current = () => session.actor === actor && session.activeNpcTalk === talk;
    return Service.mutate(session, async () => {
        if (!current()) return;
        if (!Catalog.hasNpc(session.activeNpcTalk?.selfId) || !Profession.nearbyNpc(session)) {
            return session.dataSendToMe(Response.actionFailed());
        }
        if (!parts[1]) return render(session);
        const itemId = Number(parts[1]);
        if (!Catalog.hasRecipe(itemId)) return;
        let rows;
        try { rows = await Database.exchangeDimensionalDiamond(actor.fetchId(), itemId); }
        catch (error) {
            if (current()) return render(session, 'The exchange could not be completed. Check your Dimensional Diamonds.');
            return;
        }
        // A new selection loads its own inventory. Keep an accepted exchange
        // on the original character without refreshing its detached actor.
        if (session.actor !== actor) return;
        for (const row of rows) {
            if (!row.amount) actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== row.id);
            else if (actor.backpack.fetchItemRaw(row.id)) actor.backpack.fetchItemRaw(row.id).setAmount(row.amount);
            else actor.backpack.insertItem(row.id, row.selfId, row);
        }
        session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
        Service.transmitItemReceived(session, itemId, 1);
        if (current()) return render(session, `Received ${H.itemName(itemId)}.`);
    }).catch(error => {
        utils.infoWarn('Quest', 'diamond exchange failed: %s', error.message);
        if (current()) session.dataSendToMe(Response.actionFailed());
    });
};
