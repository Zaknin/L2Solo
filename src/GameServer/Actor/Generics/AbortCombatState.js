const ServerResponse = invoke('GameServer/Network/Response');

// The pending stance end (armed by EnterCombatState) is dropped with the stance
// and when the actor is torn down (Actor.destructor).
function cancelStanceEnd(actor) {
    clearTimeout(actor.combatStanceTimer);
    actor.combatStanceTimer = undefined;
}

// Ends only the stance; movement and queued actions stay (the stance timer
// must not stop a fleeing player).
function endStance(session, actor) {
    cancelStanceEnd(actor);
    actor.state.setCombats(false);
    session.dataSendToMeAndOthers(ServerResponse.autoAttackStop(actor.fetchId()), actor);
}

function abortCombatState(session, actor) {
    endStance(session, actor);
    actor.automation.abortAll(actor);
}

module.exports = abortCombatState;
module.exports.endStance = endStance;
module.exports.cancelStanceEnd = cancelStanceEnd;
