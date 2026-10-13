const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const Shared   = invoke('GameServer/Network/Shared');

// On Node 22 an unhandled rejection ends the server; record it instead.
const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

const settle = () => new Promise((resolve) => setImmediate(resolve));
const original = {
    fetchCharacters: Database.fetchCharacters,
    fetchItems: Database.fetchItems,
    fetchCharacterRecipes: Database.fetchCharacterRecipes
};

function fixture(failure) {
    const fail = (kind) => Promise.reject(new Error(`injected ${kind} failure`));
    Database.fetchCharacters = () => failure === 'characters'
        ? fail('characters')
        : Promise.resolve([{ id: 1, name: 'First' }, { id: 2, name: 'Second' }]);
    Database.fetchItems = (id) => failure === 'items' && id === 2
        ? fail('items')
        : Promise.resolve([{ id: 10 + id, selfId: 57, slot: 7, equipped: 1 }]);
    Database.fetchCharacterRecipes = () => failure === 'recipes'
        ? fail('recipes')
        : Promise.resolve([{ type: 'dwarven' }, { type: 'common' }]);
}

async function outcome(failure) {
    fixture(failure);
    let settled = 'pending';
    let value;
    Shared.fetchCharacters('fixture').then(
        (characters) => { settled = 'resolved'; value = characters; },
        (error) => { settled = 'rejected'; value = error; }
    );
    for (let i = 0; i < 4; i++) await settle();
    return { settled, value };
}

(async () => {
    try {
        // Normal path: the list resolves with each character's paperdoll and
        // recipe books filled in.
        const ok = await outcome(null);
        assert.strictEqual(ok.settled, 'resolved', 'a healthy list read resolves');
        assert.deepStrictEqual(ok.value.map((character) => character.name), ['First', 'Second']);
        assert.deepStrictEqual(ok.value[1].paperdoll[7], { id: 12, selfId: 57 }, 'the paperdoll is built from equipped items');
        assert.strictEqual(ok.value[0].dwarvenRecipes.length, 1);
        assert.strictEqual(ok.value[0].commonRecipes.length, 1);

        // A failed read anywhere in the list rejects the returned Promise, so
        // the caller's catch runs instead of waiting forever.
        for (const failure of ['characters', 'items', 'recipes']) {
            const failed = await outcome(failure);
            assert.strictEqual(failed.settled, 'rejected', `a failed ${failure} read rejects the list`);
            assert.strictEqual(failed.value.message, `injected ${failure} failure`);
        }

        // A synchronous throw from the read rejects as well.
        Database.fetchCharacters = () => { throw new Error('injected synchronous failure'); };
        await assert.rejects(Shared.fetchCharacters('fixture'), /injected synchronous failure/);

        assert.deepStrictEqual(unhandled, [], 'no list read failure goes unobserved');
        console.log('character list failure handling ok');
    } finally {
        Object.assign(Database, original);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
