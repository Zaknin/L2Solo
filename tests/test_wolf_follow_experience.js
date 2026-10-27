const assert = require('node:assert/strict');
require('../src/Global');
const NpcDied = require('../src/GameServer/Actor/Generics/NpcDied');
const PetRules = invoke('GameServer/Pets/PetRules');

function fixture() {
    const pet = {
        fetchSelfId: () => 12077,
        fetchId: () => 70001,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        petData: { version: 1, expired: false },
        state: { fetchDead: () => false },
        controlMode: 'follow'
    };
    const owner = { mounted: false, experience: 42000 };
    const npc = { fetchLocX: () => 0, fetchLocY: () => 0, petDamage: new Map() };
    return { pet, owner, npc };
}

const { pet, owner, npc } = fixture();
assert.equal(NpcDied.shouldAwardPassiveWolfExperience(pet, owner, npc), true);
assert.equal(owner.experience, 42000, 'the additive check does not change owner EXP');
assert.equal(PetRules.typeForNpc(12077)?.ownerShare || 0, 0, 'the wolf has no owner EXP share to subtract');

for (const rate of [0.5, 1, 2, 3.25]) {
    const scaled = NpcDied.passiveWolfExperienceAward(1000, rate) * rate;
    assert.equal(Math.round(scaled), 150, `15% reward should be rate-adjusted once at rate ${rate}`);
}
assert.equal(NpcDied.passiveWolfExperienceAward(1000, 0), 150, 'zero rate follows the runtime fallback');

const rejects = [
    ['unrelated pet', pet => { pet.fetchSelfId = () => 12345; }],
    ['dead pet', pet => { pet.state.fetchDead = () => true; }],
    ['expired pet', pet => { pet.petData.expired = true; }],
    ['not a version-one pet', pet => { pet.petData.version = 2; }],
    ['not follow mode', pet => { pet.controlMode = 'stay'; }],
    ['mounted owner', (pet, owner) => { owner.mounted = true; }],
    ['pet already damaged target', (pet, owner, npc) => { npc.petDamage.set(pet.fetchId(), { pet, damage: 1 }); }],
    ['outside radius', (pet, owner, npc) => { npc.fetchLocX = () => 2500.01; }]
];
for (const [name, change] of rejects) {
    const f = fixture();
    change(f.pet, f.owner, f.npc);
    assert.equal(NpcDied.shouldAwardPassiveWolfExperience(f.pet, f.owner, f.npc), false, name);
}
const edge = fixture();
edge.npc.fetchLocX = () => 2500;
assert.equal(NpcDied.shouldAwardPassiveWolfExperience(edge.pet, edge.owner, edge.npc), true, 'the 2500-unit edge is inclusive');
