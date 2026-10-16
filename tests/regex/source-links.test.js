// Real parser/sync/navigation code with only the Obsidian host and HTTP boundary
// mocked. No running Obsidian, Anki, or Docker required.
require('ts-node').register({ compilerOptions: { module: 'commonjs', esModuleInterop: true } });
const assert = require('node:assert/strict');
const Module = require('module');
const notices = [];
class TFile {
    constructor(path) { this.path = path; this.extension = 'md'; }
}
class MarkdownView {}
const obsidian = {
    Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, FuzzySuggestModal: class {},
    TFile, MarkdownView, addIcon() {}, normalizePath: path => path,
    Notice: class { constructor(message) { notices.push(message); } }
};
const originalLoad = Module._load;
let MyPlugin, FileManager;
try {
    Module._load = function (name, ...args) {
        if (name === 'obsidian') return obsidian;
        // multimatch is ESM-only; no file discovery/filtering is exercised here.
        if (name === 'multimatch') return () => [];
        return originalLoad.call(this, name, ...args);
    };
    MyPlugin = require('../../main.ts').default;
    FileManager = require('../../src/files-manager').FileManager;
} finally {
    Module._load = originalLoad;
}
const { AllFile } = require('../../src/file');
const { settingToData } = require('../../src/setting-to-data');
const AnkiConnect = require('../../src/anki');
const { cardSourceUrl, cardSourceLinkFields, findCardSource } = require('../../src/source-links');
const settings = {
    CUSTOM_REGEXPS: { Basic: '^Q: (.+)\nA: (.+)\n?' },
    FILE_LINK_FIELDS: { Basic: 'Back' }, CONTEXT_FIELDS: {}, ALIAS_FIELDS: {},
    FOLDER_DECKS: {}, FOLDER_TAGS: {}, TAG_DECKS: {}, REGEXP_TAGS: {},
    Syntax: {
        'Begin Note': 'START', 'End Note': 'END', 'Begin Inline Note': 'STARTI', 'End Inline Note': 'ENDI',
        'Target Deck Line': 'TARGET DECK', 'File Tags Line': 'FILE TAGS', 'Delete Note Line': 'DELETE', 'Frozen Fields Line': 'FROZEN'
    },
    Defaults: {
        Deck: 'Default', 'Default Tags': '', 'Add File Link': true, 'ID Comments': true,
        'CurlyCloze - Keyword': 'Cloze', 'Add File Link - Link Label': 'Source: {{title}}',
        'Smart Scan': false
    }
};
const fileUrl = 'obsidian://open?vault=My%20%26%20Vault&file=Notes%2F%E6%97%A5%E6%9C%AC%20%231.md';
let tests = 0;
async function test(label, fn) {
    await fn();
    tests++;
    console.log('  ✓', label);
}
const block = (id = '') => `START\nBasic\nFront: Question\nBack: Answer\n${id ? `<!--ID: ${id}-->\n` : ''}END`;
const inline = (id = '') => `STARTI [Basic] Front: Question Back: Answer ${id ? `<!--ID: ${id}--> ` : ''}ENDI`;
const regex = (id = '') => `Q: Question\nA: Answer\n${id ? `<!--ID: ${id}-->` : ''}`;

async function run() {
    await test('URI preserves encoded vault/path characters and uses a note ID', () => {
        const url = new URL(cardSourceUrl(fileUrl, 123));
        assert.equal(url.hostname, 'anki-card');
        assert.equal(url.searchParams.get('vault'), 'My & Vault');
        assert.equal(url.searchParams.get('file'), 'Notes/日本 #1.md');
        assert.equal(url.searchParams.get('nid'), '123');
    });
    await test('link update preserves label, context, aliases, and unrelated links/fields', () => {
        const back = `Answer<br><a href="${fileUrl}" class="obsidian-link">Source: 日本</a><br>Context<br>Alias<a href="https://example.com">Other</a>`;
        const fields = { Front: 'Question', Back: back };
        const result = cardSourceLinkFields(fields, 'Back', fileUrl, 123);
        assert.deepEqual(Object.keys(result), ['Back']);
        assert.equal(result.Back, back.replace(fileUrl, cardSourceUrl(fileUrl, 123)));
        assert.equal(fields.Back, back);
        for (const id of [null, undefined, 0, -1, NaN]) assert.deepEqual(cardSourceLinkFields(fields, 'Back', fileUrl, id), {});
        assert.deepEqual(cardSourceLinkFields(fields, '', fileUrl, 123), {});
        assert.deepEqual(cardSourceLinkFields(fields, 'Missing', fileUrl, 123), {});
    });
    for (const [name, make] of [['block', block], ['inline', inline], ['regex', regex]]) {
        await test(`${name}: finds the correct card after text shifts, not a prefix ID`, () => {
            const prefix = `# Intro\nNew text\n\n${make(1234)}\n\n`;
            const text = prefix + make(123);
            assert.equal(findCardSource(text, 123, settings), prefix.length);
            assert.equal(findCardSource(text.replaceAll('\n', '\r\n'), 123, settings), prefix.replaceAll('\n', '\r\n').length);
            assert.equal(findCardSource(text, 999, settings), null);
        });
        await test(`${name}: frontmatter nid jumps to the card, not YAML`, () => {
            const prefix = '---\ntags: [anki]\nnid: "123"\n---\n\n# Heading\n\n';
            assert.equal(findCardSource(prefix + make(), 123, settings), prefix.length);
        });
    }
    await test('plain IDs, custom syntax, regex Tags: lines, and malformed regex fallback', () => {
        const custom = { ...settings, Syntax: { ...settings.Syntax, 'Begin Note': '[CARD]', 'End Note': '[/CARD]' } };
        const prefix = '# Heading\n\n';
        assert.equal(findCardSource(prefix + block(123).replace('START', '[CARD]').replace('END', '[/CARD]').replace('<!--ID: 123-->', 'ID: 123'), 123, custom), prefix.length);
        const tagged = prefix + 'Q: Question\nA: Answer\nTags: study\n<!--ID: 123-->';
        assert.equal(findCardSource(tagged, 123, settings), prefix.length);
        const changed = 'Unknown syntax\n<!--ID: 123-->';
        assert.equal(findCardSource(changed, 123, { ...settings, CUSTOM_REGEXPS: { Basic: '(' } }), changed.indexOf('<!--ID:'));
        assert.equal(findCardSource('nid: 123\nNot YAML', 123, settings), null);
    });
    await test('regex lookup ignores code examples and handles mixed newlines', () => {
        const prefix = '```md\n' + regex(123) + '\n```\n\n';
        assert.equal(findCardSource(prefix + regex(123), 123, settings), prefix.length);
        const yamlPrefix = '---\nnid: 123\n---\n\n```md\n' + regex() + '\n```\n\n';
        assert.equal(findCardSource(yamlPrefix + regex(), 123, settings), yamlPrefix.length);
        const mixedPrefix = '# Intro\r\n\nText\r\n\n';
        assert.equal(findCardSource(mixedPrefix + regex(123), 123, settings), mixedPrefix.length);
    });

    const originalInvoke = AnkiConnect.invoke;
    try {
        for (const [name, make] of [['block', block], ['inline', inline], ['regex', regex]]) {
            await test(`${name}: existing IDs update to precise links`, async () => {
                AnkiConnect.invoke = async () => [123];
                const data = await settingToData({ vault: { getName: () => 'Test' } }, settings, { Basic: ['Front', 'Back'] });
                const file = new AllFile(make(123), 'Cards.md', fileUrl, data, {});
                file.scanFile();
                assert.equal(file.all_notes_to_add.length, 0);
                const update = file.getUpdateFields().params.actions[0].params.note;
                assert.equal(update.id, 123);
                assert.ok(update.fields.Back.includes(cardSourceUrl(fileUrl, 123)));
            });
            for (const yaml of [false, true]) {
                await test(`${name}: complete first sync writes ID and patches link${yaml ? ' with frontmatter IDs' : ''}`, async () => {
                    const s = { ...settings, Defaults: { ...settings.Defaults, 'Save Note ID to Frontmatter': yaml } };
                    const storedNotes = new Map();
                    const added = [];
                    function action(request) {
                        switch (request.action) {
                            case 'multi': return request.params.actions.map(req => ({ error: null, result: action(req) }));
                            case 'addNote':
                                added.push(structuredClone(request.params.note));
                                storedNotes.set(123, structuredClone(request.params.note));
                                return 123;
                            case 'updateNoteFields': Object.assign(storedNotes.get(request.params.note.id).fields, request.params.note.fields); return null;
                            case 'getTags': case 'notesInfo': return [];
                            default: return null;
                        }
                    }
                    AnkiConnect.invoke = async (name, params) => name === 'findNotes' ? [] : action({ action: name, params });
                    const data = await settingToData({ vault: { getName: () => 'Test' } }, s, { Basic: ['Front', 'Back'] });
                    const file = new AllFile(make(), 'Cards.md', fileUrl, data, {});
                    file.scanFile();
                    assert.equal(file.all_notes_to_add.length, 1);
                    let written;
                    const manager = Object.assign(Object.create(FileManager.prototype), {
                        ownFiles: [file], files: [new TFile('Cards.md')], added_media_set: new Set(),
                        app: { vault: { modify: async (_, text) => { written = text; } } }
                    });
                    await manager.requests_1();
                    assert.ok(added[0].fields.Back.includes(fileUrl), 'initial add has the file link');
                    assert.ok(storedNotes.get(123).fields.Back.includes(cardSourceUrl(fileUrl, 123)), 'same sync patches the precise link');
                    assert.ok(written.includes(yaml ? 'nid: 123' : 'ID: 123'));
                    assert.equal(findCardSource(written, 123, s), written.indexOf(yaml ? make().split('\n')[0] : make(123).split('\n')[0]));
                });
            }
        }
        await test('mixed card formats preserve ID-to-card alignment when an addition fails', async () => {
            AnkiConnect.invoke = async () => [];
            const data = await settingToData({ vault: { getName: () => 'Test' } }, settings, { Basic: ['Front', 'Back'] });
            const file = new AllFile([block(), inline(), regex()].join('\n\n'), 'Cards.md', fileUrl, data, {});
            file.scanFile();
            assert.equal(file.all_notes_to_add.length, 3);
            file.note_ids = [101, null, 103];
            file.writeIDs();
            const updates = file.getNewNoteLinkUpdates().map(request => request.params.note);
            assert.deepEqual(updates.map(note => note.id), [101, 103]);
            for (const note of updates) assert.ok(note.fields.Back.includes(cardSourceUrl(fileUrl, note.id)));
            assert.equal(findCardSource(file.file, 101, settings), 0);
            assert.equal(findCardSource(file.file, 103, settings), file.file.indexOf('Q:'));
        });
        await test('existing frontmatter IDs get precise links; disabled fields and failed adds are skipped', async () => {
            AnkiConnect.invoke = async () => [123];
            const s = { ...settings, Defaults: { ...settings.Defaults, 'Save Note ID to Frontmatter': true } };
            const data = await settingToData({ vault: { getName: () => 'Test' } }, s, { Basic: ['Front', 'Back'] });
            const file = new AllFile('---\nnid: 123\n---\n' + block(), 'Cards.md', fileUrl, data, { frontmatter: { nid: 123 } });
            file.scanFile();
            assert.equal(file.all_notes_to_add.length, 0);
            assert.ok(file.getUpdateFields().params.actions[0].params.note.fields.Back.includes(cardSourceUrl(fileUrl, 123)));
            file.all_notes_to_add = [file.notes_to_edit[0].note, file.notes_to_edit[0].note];
            file.note_ids = [null, 456];
            const updates = file.getNewNoteLinkUpdates();
            assert.equal(updates.length, 1);
            assert.equal(updates[0].params.note.id, 456);
            assert.deepEqual(Object.keys(updates[0].params.note.fields), ['Back']);
            data.file_link_fields.Basic = '';
            assert.deepEqual(file.getNewNoteLinkUpdates(), []);
            data.file_link_fields.Basic = 'Back';
            data.add_file_link = false;
            assert.deepEqual(file.getNewNoteLinkUpdates(), []);
        });
        await test('source-link update errors propagate instead of silently caching a successful sync', async () => {
            AnkiConnect.invoke = async () => [{ error: null, result: [] }, { error: null, result: [] }, { error: null, result: [] }, { error: null, result: [{ error: 'update failed', result: null }] }];
            const manager = Object.assign(Object.create(FileManager.prototype), {
                ownFiles: [{
                    getChangeDecks: () => ({}), getClearTags: () => ({ params: {} }), getAddTags: () => ({ params: {} }),
                    getNewNoteLinkUpdates: () => [{ action: 'updateNoteFields' }]
                }]
            });
            await assert.rejects(manager.requests_2(), error => error === 'update failed');
        });
    } finally {
        AnkiConnect.invoke = originalInvoke;
    }

    await test('navigation opens editing view and centers the current card without using Anki', async () => {
        const plugin = new MyPlugin();
        plugin.settings = settings;
        const text = '# New content\n\n' + block(123);
        const calls = [];
        const view = new MarkdownView();
        view.editor = {
            getValue: () => text, offsetToPos: offset => ({ line: text.slice(0, offset).split('\n').length - 1, ch: 0 }),
            setCursor: pos => calls.push(['cursor', pos]), scrollIntoView: (range, center) => calls.push(['scroll', range, center]), focus: () => calls.push(['focus'])
        };
        const leaf = { view, openFile: async (file, options) => calls.push(['open', file.path, options]) };
        plugin.app = { vault: { getAbstractFileByPath: path => new TFile(path) }, workspace: { getLeaf: () => leaf } };
        await plugin.openAnkiCard({ action: 'anki-card', file: 'Cards.md', nid: '123' });
        assert.equal(calls[0][0], 'open');
        assert.equal(calls[0][2].state.mode, 'source');
        assert.deepEqual(calls[1], ['cursor', { line: 2, ch: 0 }]);
        assert.equal(calls[2][2], true);
        assert.equal(calls[3][0], 'focus');
        for (const nid of ['123abc', '0', '-1', '9007199254740993', undefined]) await plugin.openAnkiCard({ action: 'anki-card', file: 'Cards.md', nid });
        assert.equal(calls.length, 4);
        plugin.app.vault.getAbstractFileByPath = () => null;
        await plugin.openAnkiCard({ action: 'anki-card', file: 'Missing.md', nid: '123' });
        assert.match(notices.at(-1), /source file not found/);
        plugin.app.vault.getAbstractFileByPath = path => new TFile(path);
        await plugin.openAnkiCard({ action: 'anki-card', file: 'Cards.md', nid: '999' });
        assert.match(notices.at(-1), /Could not find flashcard ID 999/);
    });
    await test('protocol handler is registered even when Anki-dependent initialization fails', async () => {
        const plugin = new MyPlugin();
        const handlers = {};
        plugin.registerObsidianProtocolHandler = (action, handler) => { handlers[action] = handler; };
        plugin.loadSettings = async () => { throw new Error('Anki offline'); };
        plugin.app = { workspace: { onLayoutReady: callback => callback() } };
        let received;
        plugin.openAnkiCard = async params => { received = params; };
        await plugin.onload();
        const params = { action: 'anki-card', file: 'Cards.md', nid: '123' };
        handlers['anki-card'](params);
        assert.equal(received, params);
    });
    console.log(`\nAll ${tests} source-link tests passed.`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
