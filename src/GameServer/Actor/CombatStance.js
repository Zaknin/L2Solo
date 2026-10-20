const ServerResponse = invoke('GameServer/Network/Response');

// Lisvus C4 fdc7e33: AttackStanceTaskManager expires the last combat event
// after 15 seconds; expiry only stops the stance, never actor automation.
const IDLE_TIMEOUT_MS = 15000;
const pending = new WeakMap();

function clear(actor) {
    const entry = pending.get(actor);
    if (entry) clearTimeout(entry.timer);
    pending.delete(actor);
}

function schedule(session, actor, delay) {
    clear(actor);
    const entry = {};
    pending.set(actor, entry);
    entry.timer = setTimeout(() => {
        if (pending.get(actor) !== entry) return;
        pending.delete(actor);
        if (!actor.state.fetchCombats() || actor.state.fetchDead?.()) return;
        actor.state.setCombats(false);
        // Ending a stance must not abort movement, pickup or other automation.
        const ownerSession = actor.session || session;
        ownerSession.dataSendToMeAndOthers(ServerResponse.autoAttackStop(actor.fetchId()), actor);
    }, delay);
    entry.timer.unref?.();
}

function refresh(session, actor) {
    // NPCs own a separate combat loop and its lifetime must stay with that loop.
    if (!actor.fetchKind && actor.state.fetchCombats?.()) schedule(session, actor, IDLE_TIMEOUT_MS);
}

module.exports = { refresh, clear };
