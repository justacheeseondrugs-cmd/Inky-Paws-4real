"""Milestone 1 browser integration tests: populated IndexedDB v1->v2 migration,
v1/v2 backup compatibility, synthetic Master Bible v1.1 UI import, idempotency,
author-edit protection, custom Violet overlay editing, conversational proposals,
and Service Worker v45 compatibility. Zero paid API calls."""
import functools
import http.server
import json
import os
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def launch_browser(playwright):
    chromium_path = '/usr/bin/chromium'
    if os.path.exists(chromium_path):
        return playwright.chromium.launch(executable_path=chromium_path, args=['--no-sandbox'])
    return playwright.chromium.launch(args=['--no-sandbox'])


def synthetic_bible(content_version='1.1', erwin_core='Strategic, composed, deeply human.'):
    return {
        'schema': 'inky.master_character_bible',
        'schema_version': 1,
        'content_version': content_version,
        'language': 'en',
        'title': 'Synthetic Master Character Bible Fixture',
        'rules': {
            'hard_constraints': {
                'anya_room_entry': 'never',
                'allowed_optional_room_guest': 'joseph',
                'joseph_invitation_required': True,
                'optional_characters_default_enabled': False,
                'levi_violet_traits_default_enabled': False,
            },
        },
        'core_characters': [
            {
                'id': 'erwin',
                'name': 'Erwin Smith',
                'role': 'Commander',
                'core': erwin_core,
                'attention': 'Political incentives, evidence.',
                'voice': 'Formal, precise.',
                'body_language': 'Measured pause.',
                'stress_response': 'Quieter sharper speech.',
                'relationships': {'levi': 'Central Eruri trust.'},
                'development': 'Respects checkpoints.',
                'avoid': ['Omniscient chessmaster'],
                'original_voice_example': 'Let us verify what we know.',
                'sources': ['SYNTH'],
            },
            {
                'id': 'levi',
                'name': 'Levi Ackerman',
                'role': 'Captain',
                'core': 'Blunt, observant, economical, profoundly loyal.',
                'attention': 'Danger, injuries, lies.',
                'voice': 'Short, dry, literal.',
                'body_language': 'Stillness when angry.',
                'stress_response': 'Concern as practical instructions.',
                'relationships': {'erwin': 'Chosen trust.'},
                'development': 'Standard Levi is permanent default.',
                'avoid': ['Profanity every line'],
                'original_voice_example': 'Eat first.',
                'variant_policy': 'Standard Levi is default; Violet opt-in only.',
                'sources': ['SYNTH'],
            },
        ],
        'optional_characters': [
            {
                'id': 'joseph',
                'name': 'Joseph Alcott',
                'role': 'Optional civilian informant',
                'core': 'Dry, observant, loyal.',
                'attention': 'Exits, omissions.',
                'voice': 'Natural, dry humor.',
                'body_language': 'Relaxed posture.',
                'stress_response': 'Drops humor when family threatened.',
                'relationships': {'levi': 'Optional AU only.'},
                'development': 'Explicit invitation only.',
                'avoid': ['Automatic room access'],
                'original_voice_example': 'I know who might know.',
                'sources': ['SYNTH'],
            },
            {
                'id': 'anya',
                'name': 'Anya',
                'role': 'Optional child character; strictly outside room',
                'core': 'Five-year-old, imaginative, non-telepathic.',
                'attention': 'Routines and small mysteries.',
                'voice': 'Concrete child phrasing.',
                'body_language': 'Expressive face.',
                'stress_response': 'Fears abandonment.',
                'relationships': {'joseph': 'Papa when enabled.'},
                'development': 'Never enters watching room.',
                'avoid': ['Entering watching room', 'telepathy'],
                'original_voice_example': 'Secret mission.',
                'sources': ['SYNTH'],
            },
        ],
        'story_presets': [
            {
                'id': 'pts_eruri_default',
                'name': 'PtS — Eruri',
                'enabled_optional': [],
                'room_guest_ids': [],
                'eruri_state': 'mutual_attachment_unspoken',
                'joseph_marriage': False,
                'anya_room_entry': False,
                'enabled_character_overlays': [],
            },
            {
                'id': 'violet_au',
                'name': 'Violet AU — Eruri',
                'enabled_optional': [],
                'room_guest_ids': [],
                'eruri_state': 'author-defined',
                'joseph_marriage': False,
                'anya_room_entry': False,
                'enabled_character_overlays': ['levi_violet_traits'],
            },
        ],
        'optional_character_overlays': [
            {
                'id': 'levi_violet_traits',
                'character_id': 'levi',
                'default_enabled': False,
                'activation': ['author_selects_violet_au', 'author_explicitly_requests_traits'],
                'allowed_scopes': ['story', 'character_version', 'scene'],
                'traits_source': 'Author-approved Violet AU configuration; not defined by bible.',
                'policy': 'Standard Levi default; opt-in only.',
            },
        ],
    }


def main():
    server = http.server.ThreadingHTTPServer(
        ('127.0.0.1', 0),
        functools.partial(QuietHandler, directory=str(root)),
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f'http://127.0.0.1:{server.server_port}'

    try:
        with sync_playwright() as playwright:
            browser = launch_browser(playwright)

            # ------------------------------------------------------------------
            # TEST 1: Populated legacy IndexedDB v1 -> v2 non-destructive migration
            # ------------------------------------------------------------------
            ctx = browser.new_context(service_workers='block')
            page = ctx.new_page()
            errors = []
            csp_errs = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: csp_errs.append(msg.text) if 'Content Security Policy' in msg.text else None)
            page.on('dialog', lambda d: d.accept())
            page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            # Seed a genuine raw v1 IndexedDB BEFORE loading index.html (so app opens v1 -> upgrades to v2!)
            page.goto(f'{base_url}/manifest.webmanifest')
            v1_seeded = page.evaluate('''async () => {
              await new Promise((resolve, reject) => {
                const delReq = indexedDB.deleteDatabase('pts-studio');
                delReq.onsuccess = resolve;
                delReq.onerror = () => reject(delReq.error);
              });
              const db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('pts-studio', 1);
                req.onupgradeneeded = (e) => {
                  const d = e.target.result;
                  for (const name of ['chapters','characters','documents','docChunks','memoryEntries','lockedFacts','canonNotes','settings','generationState']) {
                    const s = d.createObjectStore(name, { keyPath: 'id' });
                    if (name === 'docChunks') s.createIndex('by_document', 'documentId', { unique: false });
                    if (name === 'memoryEntries') s.createIndex('by_chapter', 'chapterId', { unique: false });
                  }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              await new Promise((resolve, reject) => {
                const tx = db.transaction(['chapters','characters','documents','docChunks','memoryEntries','lockedFacts','canonNotes','settings','generationState'], 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.objectStore('chapters').put({
                  id: 'v1-ch-1',
                  title: 'Legacy Chapter 1',
                  content: 'Original legacy prose preserved across v1->v2.',
                  wordCount: 7,
                  order: 0,
                  status: 'finished',
                  versions: [{ content: 'Earlier v0 draft', note: 'first edit', timestamp: '2026-01-01T00:00:00Z' }],
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-02T00:00:00Z',
                });
                tx.objectStore('chapters').put({
                  id: 'v1-ch-1-alt',
                  projectId: 'original',
                  title: 'Legacy Chapter 1',
                  content: 'Alternative branch prose.',
                  wordCount: 3,
                  order: 0,
                  branchGroupId: 'v1-ch-1',
                  branchRole: 'alternative',
                  variantLabel: 'A',
                  alternativeSourceId: 'v1-ch-1',
                  versions: [],
                });
                tx.objectStore('chapters').put({
                  id: 'v1-story-b-ch1',
                  projectId: 'story-b',
                  title: 'Story B Chapter 1',
                  content: 'Unrelated workspace prose.',
                  wordCount: 3,
                  order: 0,
                  versions: [],
                });
                tx.objectStore('characters').put({
                  id: 'v1-char-levi',
                  projectId: 'original',
                  name: 'Levi Ackerman',
                  pronouns: 'he/him',
                  personality: 'Author custom legacy Levi sheet.',
                  active: true,
                });
                tx.objectStore('documents').put({
                  id: 'v1-doc-1',
                  projectId: 'original',
                  filename: 'legacy-notes.txt',
                  type: 'REFERENCE',
                  priority: 50,
                  inclusion: 'SMART',
                  wordCount: 4,
                  active: true,
                });
                tx.objectStore('docChunks').put({
                  id: 'v1-chunk-1',
                  projectId: 'original',
                  documentId: 'v1-doc-1',
                  index: 0,
                  text: 'Legacy reference chunk text.',
                  wordCount: 4,
                });
                tx.objectStore('memoryEntries').put({
                  id: 'v1-mem-1',
                  projectId: 'original',
                  chapterId: 'v1-ch-1',
                  chapterTitle: 'Legacy Chapter 1',
                  events: 'Legacy memory survives.',
                  stale: true,
                  createdAt: '2026-01-02T00:00:00Z',
                });
                tx.objectStore('lockedFacts').put({
                  id: 'v1-fact-1',
                  projectId: 'original',
                  text: 'Legacy locked fact survives.',
                  isCore: true,
                });
                tx.objectStore('canonNotes').put({
                  id: 'v1-canon-1',
                  projectId: 'original',
                  text: 'Legacy private canon survives.',
                  visibility: 'private',
                });
                tx.objectStore('generationState').put({
                  id: 'v1-ch-gen',
                  projectId: 'original',
                  chapterId: 'v1-ch-gen',
                  chapterTitle: 'In-Progress Draft',
                  status: 'paused_review',
                  accumulatedText: 'Approved block text.',
                  wordsSoFar: 3,
                  targetWords: 3000,
                });
                tx.objectStore('settings').put({
                  id: 'main',
                  provider: 'openai',
                  apiKeys: { openai: 'LOCAL-V1-OPENAI-KEY', gemini: 'LOCAL-V1-GEMINI-KEY' },
                  models: { openai: 'gpt-5.4-mini', gemini: 'gemini-2.0-flash' },
                  blockWordSize: 1000,
                  defaultGenerationMode: 'full_chapter',
                });
                tx.objectStore('settings').put({
                  id: 'workspaces',
                  items: [{ id: 'story-b', name: 'Story B' }],
                });
                tx.objectStore('settings').put({
                  id: 'rewrite-draft:original:v1-ch-1',
                  projectId: 'original',
                  chapterId: 'v1-ch-1',
                  instructions: 'Tighten pacing',
                  text: 'Staged v1 rewrite draft must survive v2 migration.',
                  baseContentHash: 'v1:7:46:12345678',
                });
              });
              db.close();
              return true;
            }''')
            assert v1_seeded

            # Load app -> triggers v1 -> v2 upgrade automatically
            page.goto(f'{base_url}/index.html')
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 2")

            # Verify 100% of v1 data survived + all v2 stores & compound indexes exist
            migration_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const rawDb = await db.openDb();
              const stores = Array.from(rawDb.objectStoreNames);
              const chIndexes = Array.from(rawDb.transaction('chapters').objectStore('chapters').indexNames);
              const memIndexes = Array.from(rawDb.transaction('memoryEntries').objectStore('memoryEntries').indexNames);
              const ovIndexes = Array.from(rawDb.transaction('characterOverlays').objectStore('characterOverlays').indexNames);

              const ch1 = await db.get('chapters', 'v1-ch-1', { projectId: 'original' });
              const ch1ByProject = await db.getByProjectIndex('chapters', 'by_project', { projectId: 'original' });
              const ch1ByProjectOrder = await db.getByProjectIndex('chapters', 'by_project_order', { projectId: 'original' });
              const ch1ByProjectUpdated = await db.getByProjectIndex('chapters', 'by_project_updated', { projectId: 'original' });
              const chAlt = await db.get('chapters', 'v1-ch-1-alt', { projectId: 'original' });
              const chB = await db.get('chapters', 'v1-story-b-ch1', { projectId: 'story-b' });
              const charLevi = await db.get('characters', 'v1-char-levi', { projectId: 'original' });
              const doc1 = await db.get('documents', 'v1-doc-1', { projectId: 'original' });
              const chunks = await db.getByIndex('docChunks', 'by_document', 'v1-doc-1', { projectId: 'original' });
              const mem1 = await db.get('memoryEntries', 'v1-mem-1', { projectId: 'original' });
              const fact1 = await db.get('lockedFacts', 'v1-fact-1', { projectId: 'original' });
              const canon1 = await db.get('canonNotes', 'v1-canon-1', { projectId: 'original' });
              const gen1 = await db.get('generationState', 'v1-ch-gen', { projectId: 'original' });
              const mainSettings = await db.get('settings', 'main');
              const rewriteDraft = await db.get('settings', 'rewrite-draft:original:v1-ch-1');
              const origStoryConfig = await db.get('storyConfigs', 'original');

              return {
                name: rawDb.name,
                version: rawDb.version,
                stores,
                chIndexes,
                memIndexes,
                ovIndexes,
                ch1Ok: ch1?.content === 'Original legacy prose preserved across v1->v2.' && ch1?.versions?.length === 1 && ch1?.projectId === 'original',
                legacyIndexedOk: ch1ByProject.some(c => c.id === 'v1-ch-1') && ch1ByProjectOrder.some(c => c.id === 'v1-ch-1') && ch1ByProjectUpdated.some(c => c.id === 'v1-ch-1'),
                chAltOk: chAlt?.branchRole === 'alternative' && chAlt?.variantLabel === 'A',
                chBOk: chB?.content === 'Unrelated workspace prose.',
                charLeviOk: charLevi?.personality === 'Author custom legacy Levi sheet.',
                docOk: doc1?.filename === 'legacy-notes.txt' && chunks.length === 1,
                memOk: mem1?.events === 'Legacy memory survives.' && mem1?.stale === true,
                factOk: fact1?.text === 'Legacy locked fact survives.',
                canonOk: canon1?.text === 'Legacy private canon survives.',
                genOk: gen1?.accumulatedText === 'Approved block text.',
                keysOk: mainSettings?.apiKeys?.openai === 'LOCAL-V1-OPENAI-KEY' && mainSettings?.apiKeys?.gemini === 'LOCAL-V1-GEMINI-KEY',
                rewriteDraftOk: rewriteDraft?.text === 'Staged v1 rewrite draft must survive v2 migration.',
                noSilentAuConfig: !origStoryConfig,
              };
            }''')
            assert migration_check['name'] == 'pts-studio'
            assert migration_check['version'] >= 2
            for s in ['universalCharacters', 'characterOverlays', 'storyConfigs', 'storyPresets', 'knowledgeFacts', 'usageLog']:
                assert s in migration_check['stores'], f'Missing v2 store: {s}'
            assert 'by_project' in migration_check['chIndexes']
            assert 'by_project_order' in migration_check['chIndexes']
            assert 'by_project_chapter' in migration_check['memIndexes']
            assert 'by_base_character' in migration_check['ovIndexes']
            for k in ['ch1Ok', 'legacyIndexedOk', 'chAltOk', 'chBOk', 'charLeviOk', 'docOk', 'memOk', 'factOk', 'canonOk', 'genOk', 'keysOk', 'rewriteDraftOk', 'noSilentAuConfig']:
                assert migration_check[k], f'Migration preservation failed for {k}: {migration_check}'

            # Repeated reload (re-opening upgraded DB) is completely safe
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 2")

            # ------------------------------------------------------------------
            # TEST 2: export excludes API keys & includes new stores; legacy v1 backup still imports
            # ------------------------------------------------------------------
            backup_compat = page.evaluate('''async () => {
              const { db, DB_VERSION } = await import('/js/db.js');
              const dump = await db.exportAll();
              const mainExported = dump.settings.find(s => s.id === 'main');
              const keysExcluded = mainExported && Object.keys(mainExported.apiKeys || {}).length === 0 && dump.__meta.apiKeysExcluded === true;
              const hasV2Stores = ['universalCharacters','characterOverlays','storyConfigs','storyPresets','knowledgeFacts','usageLog'].every(s => Array.isArray(dump[s]));
              const metaOk = dump.__meta.version === DB_VERSION && dump.__meta.schemaVersion === DB_VERSION;

              // Import a legacy v1 full backup (only 9 stores, version 1, chapter WITHOUT projectId!) -> must succeed, backfill projectId, & keep local keys!
              const v1LegacyBackup = {
                __meta: { app: 'pts-studio', version: 1 },
                chapters: [
                  { id: 'v1-restored', title: 'Restored V1', content: 'Hello from v1 backup.', wordCount: 4, order: 0, versions: [] },
                ],
                characters: [
                  { id: 'v1-char-levi', projectId: 'original', name: 'Levi Ackerman', pronouns: 'he/him', personality: 'Restored story-specific Levi.', active: true },
                ],
                documents: [],
                docChunks: [],
                memoryEntries: [],
                lockedFacts: [],
                canonNotes: [],
                generationState: [],
                settings: [
                  { id: 'main', provider: 'openai', apiKeys: { openai: 'EVIL-KEY' }, models: { openai: 'gpt-5.4-mini' } },
                  { id: 'workspaces', items: [{ id: 'story-b', name: 'Story B' }] },
                ],
              };
              await db.importAll(v1LegacyBackup, { merge: false });
              const mainAfter = await db.get('settings', 'main');
              const restored = await db.get('chapters', 'v1-restored', { projectId: 'original' });
              const restoredByOrder = await db.getByProjectIndex('chapters', 'by_project_order', { projectId: 'original' });
              return {
                keysExcluded,
                hasV2Stores,
                metaOk,
                restoredOk: restored?.content === 'Hello from v1 backup.' && restoredByOrder.some(c => c.id === 'v1-restored'),
                localKeysPreserved: mainAfter?.apiKeys?.openai === 'LOCAL-V1-OPENAI-KEY' && mainAfter?.apiKeys?.gemini === 'LOCAL-V1-GEMINI-KEY',
              };
            }''')
            assert all(backup_compat.values()), f'Backup compatibility check failed: {backup_compat}'

            # ------------------------------------------------------------------
            # TEST 3: Master Bible v1.1 UI import, namespaced non-collision, transactional guard,
            #         idempotency, author-edit protection & custom Violet overlay
            # ------------------------------------------------------------------
            page.select_option('#workspace-select', 'original')
            page.click('[data-view="characters"]')
            page.wait_for_selector('#bible-import-input', state='attached')

            bible_v11 = json.dumps(synthetic_bible('1.1')).encode('utf-8')
            page.set_input_files('#bible-import-input', {
                'name': 'synthetic_bible_v1_1.json',
                'mimeType': 'application/json',
                'buffer': bible_v11,
            })
            page.wait_for_selector('#univ-char-list .list-item[data-logical-id="levi"]')
            page.wait_for_selector('#overlay-list .list-item[data-logical-id="levi_violet_traits"]')

            # Verify optional characters did NOT auto-join the active story roster & namespaced storage IDs are used
            after_import = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const storyChars = await db.getAll('characters', { projectId: 'original' });
              const univChars = await db.getAll('universalCharacters');
              const levi = await db.get('universalCharacters', 'power_to_strive::levi');
              const violet = await db.get('characterOverlays', 'power_to_strive::levi_violet_traits');
              return {
                storyCharNames: storyChars.map(c => c.name),
                univCount: univChars.length,
                leviNamespaced: levi?.id === 'power_to_strive::levi' && levi?.logicalId === 'levi',
                violetDisabled: violet?.defaultEnabled === false,
                violetEmpty: Array.isArray(violet?.characterizationChanges) && violet.characterizationChanges.length === 0,
                violetConfigured: violet?.configured === false,
              };
            }''')
            assert 'Joseph Alcott' not in after_import['storyCharNames']
            assert 'Anya' not in after_import['storyCharNames']
            assert after_import['univCount'] == 4 and after_import['leviNamespaced']
            assert after_import['violetDisabled'] and after_import['violetEmpty'] and after_import['violetConfigured']

            # Edit universal Levi and configure custom Violet traits directly in the UI (no code change!)
            page.click('#univ-char-list .list-item[data-logical-id="levi"] .act-univ-edit')
            page.wait_for_selector('#u-core')
            page.fill('#u-core', 'Author customized universal Levi core.')
            page.click('#u-save-btn')
            page.wait_for_selector('#active-modal', state='detached')

            page.click('#overlay-list .list-item[data-logical-id="levi_violet_traits"] .act-ov-edit')
            page.wait_for_selector('#ov-changes')
            page.fill('#ov-changes', 'Author custom Violet trait 1\nAuthor custom Violet trait 2')
            page.click('#ov-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_function("() => (document.querySelector('#overlay-list .list-item[data-logical-id=\"levi_violet_traits\"]')?.innerText || '').includes('2 rasgo(s)')")

            # Re-import synthetic Bible v1.2, import another fandom with colliding logicalId "levi", AND test atomic invalid import rollback
            other_bible = synthetic_bible('1.0', erwin_core='Other Fandom Commander.')
            other_bible['fandom'] = 'starlight_saga'
            other_bible['core_characters'][1]['core'] = 'Other Fandom Levi must never touch Power to Strive Levi.'
            bad_bible = synthetic_bible('1.3')
            bad_bible['optional_character_overlays'][0]['character_id'] = 'missing_character_id'

            reimport_res = page.evaluate('''async ({ bibleV12, otherBible, badBible }) => {
              const { importMasterCharacterBible } = await import('/js/characterLibrary.js');
              const { db } = await import('/js/db.js');
              const summary1 = await importMasterCharacterBible(bibleV12);
              const summary2 = await importMasterCharacterBible(bibleV12);
              // Import another fandom with same logical IDs -> zero overwrite of power_to_strive!
              await importMasterCharacterBible(otherBible, { fandom: 'starlight_saga' });
              // Invalid Bible import must reject atomically before mutating anything!
              let invalidRejected = false;
              try { await importMasterCharacterBible(badBible); } catch { invalidRejected = true; }

              const ptsLevi = await db.get('universalCharacters', 'power_to_strive::levi');
              const otherLevi = await db.get('universalCharacters', 'starlight_saga::levi');
              const erwin = await db.get('universalCharacters', 'power_to_strive::erwin');
              const violet = await db.get('characterOverlays', 'power_to_strive::levi_violet_traits');
              return {
                protectedLogicalIds: summary1.protectedAuthorEdited.map(x => x.logicalId).sort(),
                erwinUpdated: summary1.characters.updated === 3 && erwin.corePersonality === 'Updated Erwin core v1.2.',
                idempotentSecondRun: summary2.characters.created === 0 && summary2.characters.updated === 0,
                ptsLeviPreserved: ptsLevi.corePersonality === 'Author customized universal Levi core.',
                otherLeviIsolated: otherLevi?.corePersonality === 'Other Fandom Levi must never touch Power to Strive Levi.',
                violetPreserved: violet.characterizationChanges.length === 2 && violet.defaultEnabled === false,
                invalidRejected,
              };
            }''', {
                'bibleV12': synthetic_bible('1.2', erwin_core='Updated Erwin core v1.2.'),
                'otherBible': other_bible,
                'badBible': bad_bible,
            })
            assert reimport_res['protectedLogicalIds'] == ['levi', 'levi_violet_traits'], f'Author edits not protected: {reimport_res}'
            assert reimport_res['erwinUpdated'] and reimport_res['idempotentSecondRun']
            assert reimport_res['ptsLeviPreserved'] and reimport_res['otherLeviIsolated']
            assert reimport_res['violetPreserved'] and reimport_res['invalidRejected']

            # Zero-cost resolved profile preview modal opens and switches scopes cleanly
            page.click('#univ-char-list .list-item[data-logical-id="levi"] .act-univ-preview')
            page.wait_for_selector('#prev-version')
            page.select_option('#prev-version', 'screen')
            assert 'Perfil estándar' in page.locator('#prev-body').inner_text()
            page.click('#prev-close-btn')
            page.wait_for_selector('#active-modal', state='detached')

            # ------------------------------------------------------------------
            # TEST 4: Conversational config proposals (additions + explicit corrections/removals/clears)
            # ------------------------------------------------------------------
            proposal_res = page.evaluate('''async () => {
              const { stageConfigProposal, approveConfigProposal, getStoryConfig } = await import('/js/storyConfigSchema.js');
              // Proposal 1: enable Joseph, invite Joseph, add overlay, set room & screen casts, set eruri
              const p1 = await stageConfigProposal('story-b', {
                sourceMessage: 'OKAAAAY SOOOO what if Erwin and Levi were former lovers and Joseph joins?',
                fandom: 'power_to_strive',
                universe: 'Former Lovers AU',
                relationshipStates: { eruri: 'former_lovers_continuing_attachment', joseph_marriage: true },
                optionalCharacterOps: { enable: ['joseph'] },
                guestInvitationOps: { invite: ['joseph'] },
                casts: { room: ['erwin', 'levi', 'joseph'], screen: ['anya'] },
                overlayOps: { add: [{ overlayId: 'levi_violet_traits', scope: 'story', enabled: true }] },
              });
              const beforeApprove = await getStoryConfig('story-b');
              const inactiveWhileProposed = Object.keys(beforeApprove.relationshipStates || {}).length === 0 && (beforeApprove.enabledOptionalCharacters || []).length === 0;
              await approveConfigProposal('story-b', p1.proposal.id);

              // Proposal 2: disable Joseph (also revokes invitation), remove overlay, clear screen cast with [], omit room cast, update eruri & remove joseph_marriage
              const p2 = await stageConfigProposal('story-b', {
                sourceMessage: 'Wait actually disable Joseph, remove Violet overlay, clear screen cast, switch eruri to secret_relationship and drop joseph_marriage!',
                optionalCharacterOps: { disable: ['joseph'] },
                overlayOps: { remove: ['levi_violet_traits'] },
                casts: { screen: [] }, // omitted room must stay untouched!
                relationshipOps: { set: { eruri: 'secret_relationship' }, remove: ['joseph_marriage'] },
              });
              await approveConfigProposal('story-b', p2.proposal.id);
              const afterCorrection = await getStoryConfig('story-b');
              const origUnaffected = await getStoryConfig('original');
              return {
                inactiveWhileProposed,
                josephDisabled: !(afterCorrection.enabledOptionalCharacters || []).includes('joseph') && !(afterCorrection.roomGuestInvitations || []).includes('joseph'),
                overlayRemoved: (afterCorrection.overlayActivations || []).length === 0,
                screenCleared: (afterCorrection.casts?.screen || []).length === 0,
                roomKept: (afterCorrection.casts?.room || []).includes('erwin'),
                eruriUpdated: afterCorrection.relationshipStates?.eruri === 'secret_relationship' && !('joseph_marriage' in (afterCorrection.relationshipStates || {})),
                origUnaffected: !origUnaffected,
              };
            }''')
            assert all(proposal_res.values()), f'Conversational proposal flow failed: {proposal_res}'

            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP violations: {csp_errs}'
            ctx.close()

            # ------------------------------------------------------------------
            # TEST 5: Multi-tab blocked IndexedDB v1 -> v2 upgrade UX
            # ------------------------------------------------------------------
            ctx_tabs = browser.new_context(service_workers='block')
            page_old = ctx_tabs.new_page()
            page_new = ctx_tabs.new_page()
            for p in (page_old, page_new):
                p.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
                p.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            # Old tab creates and HOLDS an open raw v1 connection (without closing on versionchange)
            page_old.goto(f'{base_url}/manifest.webmanifest')
            page_old.evaluate('''async () => {
              await new Promise((resolve, reject) => {
                const delReq = indexedDB.deleteDatabase('pts-studio');
                delReq.onsuccess = resolve;
                delReq.onerror = () => reject(delReq.error);
              });
              window.__oldV1Db = await new Promise((resolve, reject) => {
                const req = indexedDB.open('pts-studio', 1);
                req.onupgradeneeded = (e) => {
                  const d = e.target.result;
                  for (const name of ['chapters','characters','documents','docChunks','memoryEntries','lockedFacts','canonNotes','settings','generationState']) {
                    d.createObjectStore(name, { keyPath: 'id' });
                  }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              await new Promise((resolve, reject) => {
                const tx = window.__oldV1Db.transaction('chapters', 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.objectStore('chapters').put({ id: 'hold-ch', title: 'Multi-tab Chapter', content: 'Must survive blocked upgrade.', wordCount: 4, order: 0 });
              });
            }''')

            # New tab loads app -> upgrade is blocked -> must display calm Spanish banner (no silent hang, no erase instruction)
            page_new.goto(f'{base_url}/index.html')
            page_new.wait_for_selector('#db-blocked-banner', state='visible')
            banner_text = page_new.locator('#db-blocked-banner').inner_text().lower()
            assert 'otra pestaña' in banner_text and 'sin perder' in banner_text, f'Unexpected blocked banner text: {banner_text}'
            assert 'borrar' not in banner_text, 'Blocked banner must NEVER tell author to erase browser data!'

            # Close old tab's DB connection -> new tab automatically unblocks, hides banner, and preserves chapter!
            page_old.evaluate('() => { window.__oldV1Db.close(); }')
            page_new.wait_for_selector('#db-blocked-banner', state='detached')
            page_new.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 2")
            survived_ch = page_new.evaluate("async () => { const {db} = await import('/js/db.js'); return await db.get('chapters', 'hold-ch', { projectId: 'original' }); }")
            assert survived_ch and survived_ch['content'] == 'Must survive blocked upgrade.', f'Chapter lost after blocked upgrade recovery: {survived_ch}'
            ctx_tabs.close()

            # ------------------------------------------------------------------
            # TEST 6: Service Worker v45 upgrade compatibility with IndexedDB v2
            # ------------------------------------------------------------------
            ctx_sw = browser.new_context(service_workers='allow')
            page_sw = ctx_sw.new_page()
            sw_errors = []
            page_sw.on('pageerror', lambda err: sw_errors.append(str(err)))
            page_sw.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page_sw.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))
            page_sw.goto(f'{base_url}/manifest.webmanifest')
            page_sw.evaluate('''async () => {
              const other = await caches.open('unrelated-origin-app');
              await other.put(new Request('/keep.txt'), new Response('ok'));
              const old = await caches.open('inky-paws-es-v44-phase0-v1');
              await old.put(new Request('/js/db.js'), new Response('// stale v1'));
            }''')
            page_sw.goto(f'{base_url}/index.html')
            page_sw.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")
            sw_info = page_sw.evaluate('''async () => {
              const reg = await navigator.serviceWorker.ready;
              if (reg.active && reg.active.state !== 'activated') {
                await new Promise((resolve) => {
                  const sw = reg.active;
                  if (sw.state === 'activated') return resolve();
                  sw.addEventListener('statechange', () => { if (sw.state === 'activated') resolve(); });
                });
              }
              return { keys: await caches.keys() };
            }''')
            assert any(k.startswith('inky-paws-es-') and k != 'inky-paws-es-v44-phase0-v1' for k in sw_info['keys'])
            assert 'inky-paws-es-v44-phase0-v1' not in sw_info['keys']
            assert 'unrelated-origin-app' in sw_info['keys']
            ctx_sw.set_offline(True)
            page_sw.reload()
            page_sw.wait_for_selector('#tabbar .tab-btn')
            assert page_sw.locator('#tabbar .tab-btn').count() == 7
            ctx_sw.set_offline(False)
            assert not sw_errors, f'SW upgrade errors: {sw_errors}'
            ctx_sw.close()

            browser.close()
            print('PASS: all Milestone 1 + follow-up browser integration tests passed (v1->v2 legacy index backfill, v1/v2 backup, namespaced atomic Bible import, author-edit protection, proposal corrections, multi-tab blocked upgrade UX, SW v45 offline).')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
