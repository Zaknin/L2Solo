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
    actor.combatStanceTimer = setTimeout(() => stanceTimeout(actor), STANCE_MS);
    actor.combatStanceTimer.unref?.();
}

// The actor's own swing or offensive cast start is an exchange too (L2J
// doAttack/doCast): a running stance restarts its 15 s, none is started.
function holdStance(actor) {
    actor.combatStanceTimer?.refresh();
}

// No combat-flag or own-action check: stun, sleep, petrify, fake death and
// clearTargetState drop inCombat on a player without a packet, and every own
// swing or cast start already refreshed the timer, so a timer that fires
// always owes the client its AutoAttackStop.
function stanceTimeout(actor) {
    actor.combatStanceTimer = undefined;
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
module.exports.holdStance = holdStance;
