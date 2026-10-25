// C4 village_master requirements, Lisvus fdc7e33a. Level-only transfer stays
// available through the existing temple-priest menus while trials are added.
const Catalog = require('./SecondProfessionCatalog');
const routes = Catalog.routes;
const ClassTransfer = require('./ClassTransfer');
const Response = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const World = invoke('GameServer/World/World');
const NpcIndex = invoke('GameServer/World/NpcObjectIndex');
const H = require('./Quest/SecondProfessionQuest');

const handles = Catalog.handles;

function nearbyNpc(session) {
    const actor = session?.actor, talk = session?.activeNpcTalk;
    const npc = NpcIndex.find(World, talk?.objectId);
    if (!actor || actor.isDead() || !npc || npc.fetchSelfId() !== talk.selfId || npc.isDead()) return null;
    const distance = Math.hypot(actor.fetchLocX() - npc.fetchLocX(), actor.fetchLocY() - npc.fetchLocY());
    return distance <= 250 && Math.abs(actor.fetchLocZ() - npc.fetchLocZ()) <= 250 ? npc : null;
}

function render(session, message = '') {
    const actor = session.actor, id = session.activeNpcTalk?.selfId;
    if (!handles(id)) return false;
    const questLink = invoke('GameServer/Quest/QuestService').handlesNpc({ fetchSelfId: () => id })
        ? `<a action="bypass -h html ${id}-quest"><font color="LEVEL">Quest - start or continue quests</font></a><br><br>` : '';
    const choices = Catalog.routesForNpc(id).filter(route => route.race === actor.fetchRace()
        && (ClassTransfer.eligibility(actor, route.classId).ok || actor.fetchClassId() === route.classId));
    const body = choices.map(route => {
        if (actor.fetchClassId() === route.classId) return `<a action="bypass -h second-profession ${route.classId}">Refresh my ${route.name} skills</a><br>`;
        const marks = route.marks.map(mark => {
            const amount = actor.backpack.fetchItems().filter(item => item.fetchSelfId() === mark && !item.fetchEquipped())
                .reduce((sum, item) => sum + item.fetchAmount(), 0);
            return `${H.itemName(mark)}: ${amount ? 'ready' : 'missing'}`;
        }).join('<br>');
        return `${route.name}<br>${marks}<br><a action="bypass -h second-profession ${route.classId}">Become a ${route.name}</a><br><br>`;
    }).join('');
    session.dataSendToMe(Response.npcHtml(session.activeNpcTalk.objectId,
        `<html><body>Second profession transfer:<br>Bring the three trial marks and reach level 40.<br><br>${questLink}${message}<br>${body || 'No second-profession transfer is available for your current class.'}</body></html>`));
    session.dataSendToMe(Response.actionFailed());
    return true;
}

async function transfer(session, targetClassId) {
    const actor = session?.actor;
    if (!nearbyNpc(session)) return { ok: false, reason: 'npc' };
    const route = Catalog.routeForClass(targetClassId);
    if (!route?.npcs.includes(session.activeNpcTalk.selfId) || route.race !== actor.fetchRace()) {
        return { ok: false, reason: 'wrong_profession' };
    }
    if (actor.fetchClassId() === targetClassId) {
        await ClassTransfer.refresh(session, { restoreVitals: false, celebrate: false });
        return { ok: true, targetClassId, ...(session.actor !== actor ? { refreshPending: true } : {}) };
    }
    const check = ClassTransfer.eligibility(actor, targetClassId);
    if (!check.ok || check.requiredLevel !== 40) return { ok: false, reason: 'wrong_profession' };
    if (actor.fetchLevel() < 40) return { ok: false, reason: 'level' };
    let changed;
    try { changed = await Database.completeSecondProfession(actor.fetchId(), check.currentClassId, targetClassId); }
    catch (error) { return { ok: false, reason: 'marks', error }; }
    // The committed class and marks belong to the original character. A new
    // selection will load that result when this character logs in again.
    if (session.actor !== actor) return { ok: true, targetClassId, refreshPending: true };
    for (const row of changed) {
        if (row.amount) actor.backpack.fetchItemRaw(row.id)?.setAmount(row.amount);
        else actor.backpack.items = actor.backpack.items.filter(item => item.fetchId() !== row.id);
    }
    actor.setClassId(targetClassId);
    session.dataSendToMe(Response.itemsList(actor.backpack.fetchItems()));
    try {
        await ClassTransfer.refresh(session);
        return { ok: true, targetClassId, ...(session.actor !== actor ? { refreshPending: true } : {}) };
    } catch (error) {
        // The durable class and consumed marks remain a single committed result.
        // The master can retry refresh, including after login, without charging
        // marks again: the persisted target class is proof of the transfer.
        utils.infoWarn('Character', 'second profession refresh failed for %s: %s', actor.fetchName(), error.message);
        return { ok: true, targetClassId, refreshPending: true };
    }
}

module.exports = { routes, handles, nearbyNpc, render, transfer };
