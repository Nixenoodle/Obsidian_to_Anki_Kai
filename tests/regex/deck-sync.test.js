// Exercise the real sync/request code with only Obsidian and AnkiConnect mocked.
require('ts-node').register({ compilerOptions: { module: 'commonjs', esModuleInterop: true } });
const assert = require('node:assert/strict');
const Module = require('module');
const originalLoad = Module._load;
let FileManager;
try {
    Module._load = function (name, ...args) {
        if (name === 'obsidian') return { Notice: class {} };
        if (name === 'multimatch') return () => [];
        return originalLoad.call(this, name, ...args);
    };
    FileManager = require('../../src/files-manager').FileManager;
} finally {
    Module._load = originalLoad;
}
const { AllFile } = require('../../src/file');
const AnkiConnect = require('../../src/anki');

function makeFile(deckName, noteId, cards) {
    return Object.assign(Object.create(AllFile.prototype), {
        notes_to_edit: [{
            identifier: noteId, current_cards: cards, current_tags: ['edit'],
            note: { deckName, fields: { Front: 'Updated question', Back: 'Updated answer' }, tags: ['edit'] }
        }],
        data: { add_file_link: false }, all_notes_to_add: [], note_ids: []
    });
}

function fixture(files, cards, deckIds = { Home: 10, 'Home::Child': 11, Other: 20, Editing: 30 }) {
    const calls = [];
    const storedCards = new Map(cards.map(card => [card.id, structuredClone(card)]));
    const storedNotes = new Map(files.flatMap(file => file.notes_to_edit.map(note => [note.identifier, {}])));
    const noteCards = new Map(files.flatMap(file => file.notes_to_edit.map(note => [note.identifier, note.current_cards])));
    const manager = Object.assign(Object.create(FileManager.prototype), { ownFiles: files });
    function action(request) {
        calls.push(structuredClone(request));
        const { action: name, params } = request;
        switch (name) {
            case 'multi': return params.actions.map(req => ({ error: null, result: action(req) }));
            case 'deckNamesAndIds': return deckIds;
            case 'notesInfo': return params.notes.map(id => ({ noteId: id, cards: noteCards.get(id), tags: ['edit'] }));
            case 'getTags': return ['edit'];
            case 'deleteNotes': assert.deepEqual(params.notes, []); return null;
            case 'findCards': {
                const match = /^did:(\d+) cid:(\d+(?:,\d+)*)$/.exec(params.query);
                assert.ok(match, 'lookup must use exact numeric deck and card IDs');
                const did = Number(match[1]);
                return match[2].split(',').map(Number).filter(id => {
                    const card = storedCards.get(id);
                    // Anki's did: search includes the original deck of a filtered card.
                    return card && (card.did === did || card.odid === did);
                });
            }
            case 'changeDeck':
                for (const id of params.cards) {
                    const card = storedCards.get(id);
                    card.odid = 0; // AnkiConnect removes cards from filtered decks first.
                    card.did = deckIds[params.deck] ?? 40;
                }
                return null;
            case 'updateNoteFields': Object.assign(storedNotes.get(params.note.id), params.note.fields); return null;
            case 'addTags': case 'removeTags': return null;
            default: throw new Error(`Unexpected action: ${name}`);
        }
    }
    AnkiConnect.invoke = async (name, params = {}) => action({ action: name, params });
    return { manager, calls, storedCards, storedNotes };
}

let tests = 0;
async function test(label, fn) {
    await fn();
    tests++;
    console.log('  ✓', label);
}

async function run() {
    const originalInvoke = AnkiConnect.invoke;
    try {
        await test('field edits preserve a non-rescheduling filtered card and its scheduling/flag state', async () => {
            const file = makeFile('Home', 100, [1]);
            const card = { id: 1, did: 30, odid: 10, queue: 4, due: 123, odue: 456, interval: 64, flags: 3 };
            const f = fixture([file], [card]);
            // Run both sync phases, including notesInfo -> current_cards wiring.
            file.notes_to_edit[0].current_cards = undefined;
            Object.assign(file, {
                file: '', original_file: '', formatter: { detectedMedia: new Set() }, notes_to_delete: [],
                writeIDs() {}, removeEmpties() {}
            });
            Object.assign(f.manager, {
                files: [{}], added_media_set: new Set(),
                app: { vault: { modify: async () => assert.fail('existing IDs should not require writing the source') } }
            });
            await f.manager.requests_1();
            assert.deepEqual(file.notes_to_edit[0].current_cards, [1]);
            assert.deepEqual(f.storedNotes.get(100), { Front: 'Updated question', Back: 'Updated answer' });
            assert.deepEqual(f.storedCards.get(1), card);
            assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
        });
        await test('ordinary cards already in the target deck are not moved either', async () => {
            const f = fixture([makeFile('Home', 100, [1])], [{ id: 1, did: 10, odid: 0 }]);
            await f.manager.requests_2();
            assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
        });
        await test('only mismatched siblings move; filtered siblings with the correct home stay untouched', async () => {
            const f = fixture([makeFile('Home', 100, [1, 2, 3])], [
                { id: 1, did: 30, odid: 10 }, { id: 2, did: 10, odid: 0 }, { id: 3, did: 20, odid: 0 }
            ]);
            await f.manager.requests_2();
            assert.deepEqual(f.calls.filter(call => call.action === 'changeDeck').map(call => call.params), [
                { cards: [3], deck: 'Home' }
            ]);
            assert.deepEqual(f.storedCards.get(1), { id: 1, did: 30, odid: 10 });
        });
        await test('an intentional home-deck change still moves a filtered card', async () => {
            const f = fixture([makeFile('Other', 100, [1])], [{ id: 1, did: 30, odid: 10 }]);
            await f.manager.requests_2();
            assert.deepEqual(f.storedCards.get(1), { id: 1, did: 20, odid: 0 });
        });
        await test('a child deck does not count as the exact target home deck', async () => {
            const f = fixture([makeFile('Home', 100, [1])], [{ id: 1, did: 30, odid: 11 }]);
            await f.manager.requests_2();
            assert.deepEqual(f.storedCards.get(1), { id: 1, did: 10, odid: 0 });
        });
        await test('a new target deck is still created by changeDeck', async () => {
            const f = fixture([makeFile('New Deck', 100, [1])], [{ id: 1, did: 10, odid: 0 }]);
            await f.manager.requests_2();
            assert.deepEqual(f.calls.filter(call => call.action === 'changeDeck').map(call => call.params), [
                { cards: [1], deck: 'New Deck' }
            ]);
            assert.equal(f.calls.filter(call => call.action === 'findCards').length, 0);
        });
        await test('deck-name casing does not cause a redundant move', async () => {
            const f = fixture([makeFile('home', 100, [1])], [{ id: 1, did: 30, odid: 10 }]);
            await f.manager.requests_2();
            assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
        });
        await test('special deck names use numeric IDs, not search keywords or wildcards', async () => {
            for (const name of ['current', 'filtered', 'Home * "quoted" \\ 日本']) {
                const f = fixture([makeFile(name, 100, [1])], [{ id: 1, did: 30, odid: 10 }], { [name]: 10 });
                await f.manager.requests_2();
                assert.equal(f.calls.find(call => call.action === 'findCards').params.query, 'did:10 cid:1');
                assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
            }
        });
        await test('membership queries are batched per target deck across files', async () => {
            const f = fixture([makeFile('Home', 100, [1]), makeFile('Home', 200, [2]), makeFile('Other', 300, [3])], [
                { id: 1, did: 30, odid: 10 }, { id: 2, did: 10, odid: 0 }, { id: 3, did: 20, odid: 0 }
            ]);
            await f.manager.requests_2();
            assert.equal(f.calls.filter(call => call.action === 'deckNamesAndIds').length, 1);
            assert.deepEqual(f.calls.filter(call => call.action === 'findCards').map(call => call.params.query), [
                'did:10 cid:1,2', 'did:20 cid:3'
            ]);
            assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
        });
        await test('no existing cards means no deck lookups', async () => {
            for (const files of [[], [makeFile('Home', 100, [])]]) {
                const f = fixture(files, []);
                await f.manager.requests_2();
                assert.equal(f.calls.filter(call => ['deckNamesAndIds', 'findCards', 'changeDeck'].includes(call.action)).length, 0);
            }
        });
        await test('membership errors abort before any cards are moved', async () => {
            const f = fixture([makeFile('Home', 100, [1])], [{ id: 1, did: 30, odid: 10 }]);
            const invoke = AnkiConnect.invoke;
            AnkiConnect.invoke = async (name, params) => {
                if (name === 'multi') return [{ error: 'lookup failed', result: null }];
                return invoke(name, params);
            };
            await assert.rejects(f.manager.requests_2(), error => error === 'lookup failed');
            assert.equal(f.calls.filter(call => call.action === 'changeDeck').length, 0);
            assert.deepEqual(f.storedCards.get(1), { id: 1, did: 30, odid: 10 });
        });
    } finally {
        AnkiConnect.invoke = originalInvoke;
    }
    console.log(`\n${tests} deck-sync tests passed.`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
