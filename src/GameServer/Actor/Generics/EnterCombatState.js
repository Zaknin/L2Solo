const ServerResponse = invoke('GameServer/Network/Response');
const AbortCombatState = require('./AbortCombatState');

// C4 (L2J AttackStanceTaskManager): the stance ends 15 s after the last exchange.
const STANCE_MS = 15000;

function armStanceEnd(actor) {
    AbortCombatState.cancelStanceEnd(actor);
    actor.combatStanceTimer = setTimeout(stanceTimeout, STANCE_MS, actor);
    actor.combatStanceTimer.unref?.();
}

function stanceTimeout(actor) {
    actor.combatStanceTimer = undefined;
    if (!actor.state.fetchCombats()) return; // already ended without the timer
    if (actor.state.fetchHits() || actor.state.fetchCasts()) return armStanceEnd(actor); // own swing/cast is an exchange
    const session = actor.session;
    if (session?.actor !== actor) return; // logged out or gone cold
    AbortCombatState.endStance(session, actor);
}

function enterCombatState(session, actor) {
    armStanceEnd(actor);
    if (actor.state.fetchCombats()) {
        return;
    }

    actor.state.setCombats(true);
    session.dataSendToMeAndOthers(ServerResponse.autoAttackStart(actor.fetchId()), actor);
}

module.exports = enterCombatState;
