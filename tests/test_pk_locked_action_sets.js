const assert = require('assert');
require('../src/Global');

// U59: the registry PK lock and the tool availability PK lock are two unequal
// action sets. Pin which actions each one refuses for a PK-hunting bot, so a
// shared check keeps both sets exactly as they are.
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotToolAudit = invoke('GameServer/Bot/AI/BotToolAudit');

function actor() {
    return {
        fetchId: () => 202,
        fetchName: () => 'PkPinBot',
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        state: { fetchSeated: () => false, setSeated() {} },
        unselect() {}
    };
}

const BOTH = [
    'follow_player', 'regroup_party', 'stay_party', 'stay_here', 'hunt', 'rest', 'shop', 'fetch_resources', 'move_to_spot',
    'set_pull_policy', 'assign_puller', 'unassign_puller',
    'set_skill_priority', 'clear_skill_priority', 'set_combat_stance',
    'list_safe_loadouts', 'equip_candidate', 'optimize_equipment', 'list_party_candidates',
    'propose_trade', 'give_resources', 'offer_resources', 'update_trade_offer', 'cancel_trade',
    'quote_item', 'counter_offer', 'accept_price', 'decline_price', 'open_negotiated_trade'
];
const AVAILABILITY_ONLY = ['stop_pulling_and_return', 'request_player_join_party'];
const REGISTRY_ONLY = ['set_buff_policy'];

BotToolAudit.resetMemory();
const pk = () => ({ accountId: 'bot_pk_sets', plan: 'pk_hunting', actor: actor() });
const reason = (action) => BotAgentTools.execute(pk(), {
    action, confidence: 0.99, reply: '', targetPlayerName: '', spotId: '', buffType: '',
    reason: 'test', turnId: `pk-${action}`
}, [], null).reason;

for (const action of [...BOTH, ...REGISTRY_ONLY]) {
    assert.strictEqual(reason(action), 'pk_hunting_autonomous', `${action} is refused by the registry PK lock`);
}
for (const action of AVAILABILITY_ONLY) {
    assert.strictEqual(reason(action), 'tool_unavailable', `${action} passes the registry PK lock and is refused as unavailable`);
}

const available = new Set(BotAgentTools.availableActions(pk()));
for (const action of [...BOTH, ...AVAILABILITY_ONLY]) {
    assert(!available.has(action), `${action} is hidden from a PK-hunting bot`);
}
// set_buff_policy is not in the availability PK set; other gates decide it.
const nonPk = { accountId: 'bot_pk_sets_other', plan: 'hunting', actor: actor() };
assert.strictEqual(available.has('set_buff_policy'),
    new Set(BotAgentTools.availableActions(nonPk)).has('set_buff_policy'),
    'set_buff_policy availability does not depend on the PK plan');
assert(available.has('say') && available.has('none'), 'talking stays available to a PK-hunting bot');

console.log('PK locked action set checks passed');
