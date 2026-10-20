const ServerResponse = invoke('GameServer/Network/Response');
const AbortCombatState = require('./AbortCombatState');

// C4 (L2J AttackStanceTaskManager): the stance ends 15 s after the last exchange.
const STANCE_MS = 15000;

function armStanceEnd(actor) {
    // A pending timer is only set while it waits (stanceTimeout and
    // cancelStanceEnd drop it), so refresh restarts its 15 s in place.
    if (actor.combatStanceTimer) {
        actor.combatStanceTimer.refresh();
        return;
    }
    actor.combatStanceTimer = setTimeout(stanceTimeout, STANCE_MS, actor);
    actor.combatStanceTimer.unref?.();
}

function ownExchange(actor) {
    return actor.attack?.isAttacking?.() || actor.state.fetchHits() || actor.state.fetchCasts();
}

// No combat-flag guard: stun, sleep, petrify, fake death and clearTargetState
// drop inCombat on a player without a packet, so a timer that fires always
// owes the client its AutoAttackStop.
function stanceTimeout(actor) {
    actor.combatStanceTimer = undefined;
    if (ownExchange(actor)) return armStanceEnd(actor); // own attack loop or cast is an exchange
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
