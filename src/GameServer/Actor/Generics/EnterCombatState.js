const ServerResponse = invoke('GameServer/Network/Response');
const CombatStance = require('../CombatStance');

function enterCombatState(session, actor) {
    if (actor.state.fetchCombats()) {
        CombatStance.refresh(session, actor);
        return;
    }

    actor.state.setCombats(true);
    (actor.session || session).dataSendToMeAndOthers(ServerResponse.autoAttackStart(actor.fetchId()), actor);
    CombatStance.refresh(session, actor);
}

module.exports = enterCombatState;
