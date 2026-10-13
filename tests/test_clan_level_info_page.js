'use strict';
// Pins the Clan Manager's level-info page: every level cost exactly as shown to the player.
const assert = require('assert');
require('../src/Global');

const Clan = invoke('GameServer/World/Generics/NpcBypasses/Clan');
const ServerResponse = invoke('GameServer/Network/Response');

const original = ServerResponse.npcHtml;
const pages = [];
ServerResponse.npcHtml = (id, body) => { pages.push(body); return Buffer.alloc(0); };
try {
    const session = { actor: { isDead: () => false, fetchId: () => 1 }, dataSendToMe() {} };
    Clan(session, ['clan', 'level-info']);
} finally {
    ServerResponse.npcHtml = original;
}
assert.deepStrictEqual(pages, [
    '<html><body>Clan Manager:<br>' +
    'You may raise the level of the clan. You will need the following:<br>' +
    '<font color="LEVEL">Clan Level 1:</font> 30,000 SP plus 650,000 adena<br>' +
    '<font color="LEVEL">Clan Level 2:</font> 150,000 SP plus 2,500,000 adena<br>' +
    '<font color="LEVEL">Clan Level 3:</font> 500,000 SP plus Proof of Blood<br>' +
    '<font color="LEVEL">Clan Level 4:</font> 1,400,000 SP plus Proof of Alliance<br>' +
    '<font color="LEVEL">Clan Level 5:</font> 3,500,000 SP plus Proof of Aspiration<br><br>' +
    '<button value="Level Up" action="bypass -h clan level-up" width=60 height=15 back="sek.cbui94" fore="sek.cbui92">' +
    '<br><a action="bypass -h clan menu">Back</a>' +
    '</body></html>'
]);
console.log('test_clan_level_info_page: ok');
