"""Milestone 3 browser integration tests (Inky Brain):
- Non-destructive IndexedDB v2 -> v3 upgrade preserving all existing data & local API keys
- v3 & v2 backup compatibility round-trip (API keys excluded from export, preserved locally)
- Spanish Memory UI (preserving 7-tab invariant):
  * Epistemic fact CRUD + independent false belief modal (objective truth preserved)
  * Qualitative relationship continuity CRUD (no numeric scores)
  * Deterministic 0-token arc compression
  * 0-token explainable BM25 search ("¿Por qué Inky recuperó esto?") excluding alternative chapters
  * Editing Chapter 1 in Capítulos triggers cross-store stale review banner (memories + knowledgeFacts, 0 API calls)
  * Confirming reviewed clears stale status, full reload persistence, cross-workspace isolation, zero CSP/page errors."""
import functools
import http.server
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
            ctx = browser.new_context(service_workers='block')
            page = ctx.new_page()
            errors = []
            csp_errs = []
            network_external = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: csp_errs.append(msg.text) if 'Content Security Policy' in msg.text else None)
            page.on('dialog', lambda d: d.accept())
            page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))
            page.on('request', lambda req: network_external.append(req.url) if not req.url.startswith(base_url) and 'fonts.g' not in req.url else None)

            # ------------------------------------------------------------------
            # TEST 1: Seed a REAL IndexedDB v2 database before opening v3 app
            # ------------------------------------------------------------------
            page.goto(f'{base_url}/manifest.webmanifest')
            page.evaluate('''async () => {
              await new Promise((resolve) => {
                const del = indexedDB.deleteDatabase('pts-studio');
                del.onsuccess = del.onerror = del.onblocked = () => resolve();
              });
              const v2Stores = [
                'chapters', 'characters', 'documents', 'docChunks',
                'memoryEntries', 'lockedFacts', 'canonNotes', 'settings', 'generationState',
                'universalCharacters', 'characterOverlays', 'storyConfigs', 'storyPresets',
                'knowledgeFacts', 'usageLog'
              ];
              await new Promise((resolve, reject) => {
                const req = indexedDB.open('pts-studio', 2);
                req.onupgradeneeded = () => {
                  const db = req.result;
                  for (const name of v2Stores) {
                    const st = db.createObjectStore(name, { keyPath: 'id' });
                    if (['chapters', 'characters', 'documents', 'docChunks', 'memoryEntries', 'lockedFacts', 'canonNotes', 'generationState', 'knowledgeFacts'].includes(name)) {
                      st.createIndex('by_project', 'projectId', { unique: false });
                    }
                    if (name === 'memoryEntries') st.createIndex('by_chapter', 'chapterId', { unique: false });
                  }
                };
                req.onsuccess = () => {
                  const db = req.result;
                  const tx = db.transaction(['chapters', 'memoryEntries', 'settings', 'storyConfigs'], 'readwrite');
                  tx.objectStore('settings').put({
                    id: 'main',
                    provider: 'openai',
                    apiKeys: { openai: 'LOCAL-M3-V2-KEY' },
                    models: { openai: 'gpt-5.4-mini' },
                  });
                  tx.objectStore('settings').put({
                    id: 'workspaces',
                    items: [
                      { id: 'original', name: 'Original Story' },
                      { id: 'story-m3-a', name: 'M3 Brain Story A' },
                      { id: 'story-m3-b', name: 'M3 Brain Story B' },
                    ],
                  });
                  tx.objectStore('chapters').put({
                    id: 'ch-m3-1',
                    projectId: 'story-m3-a',
                    order: 1,
                    title: 'Chapter 1: Cedar Oath',
                    content: 'Beneath the cedar rafters, Levi gave Erwin the brass pocket watch and swore the ironbound lantern oath.',
                    wordCount: 18,
                    branchRole: 'main',
                    versions: [],
                    createdAt: '2026-01-01T10:00:00Z',
                  });
                  tx.objectStore('chapters').put({
                    id: 'ch-m3-1-alt',
                    projectId: 'story-m3-a',
                    order: 1,
                    title: 'Chapter 1: Alternative Divergent',
                    content: 'ALT_BRANCH_FORBIDDEN_MARKER_991 Levi threw the watch into the river.',
                    wordCount: 10,
                    branchRole: 'alternative',
                    branchGroupId: 'g1',
                    versions: [],
                    createdAt: '2026-01-01T10:05:00Z',
                  });
                  tx.objectStore('chapters').put({
                    id: 'ch-m3-2',
                    projectId: 'story-m3-a',
                    order: 2,
                    title: 'Chapter 2: Morning Tea',
                    content: 'Quiet morning tea after the first reel paused. Hange asked questions about the watch.',
                    wordCount: 15,
                    branchRole: 'main',
                    versions: [],
                    createdAt: '2026-01-02T10:00:00Z',
                  });
                  tx.objectStore('memoryEntries').put({
                    id: 'mem-m3-1',
                    projectId: 'story-m3-a',
                    chapterId: 'ch-m3-1',
                    chapterTitle: 'Chapter 1: Cedar Oath',
                    events: 'Levi handed Erwin the brass pocket watch and made the ironbound lantern oath.',
                    openThreads: 'Keep the lantern oath hidden from the rest of the room.',
                    stale: false,
                    createdAt: '2026-01-01T12:00:00Z',
                  });
                  tx.objectStore('storyConfigs').put({
                    id: 'story-m3-a',
                    projectId: 'story-m3-a',
                    fandom: 'power_to_strive',
                    universeName: 'M3 Brain Story A',
                    reactionMode: true,
                    proposals: [],
                  });
                  tx.oncomplete = () => { db.close(); resolve(); };
                  tx.onerror = () => reject(tx.error);
                };
                req.onerror = () => reject(req.error);
              });
            }''')

            # Boot app -> triggers non-destructive v2 -> v3 upgrade
            page.goto(f'{base_url}/index.html')
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 3")

            # Verify 7-tab invariant preserved!
            tab_count = page.locator('#tabbar .tab-btn').count()
            assert tab_count == 7, f'Expected 7 tabs, got {tab_count}'

            # Verify v2 -> v3 upgrade preserved all v2 data + created v3 stores & index!
            v3_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const rawDb = await db.openDb();
              const stores = [...rawDb.objectStoreNames];
              const kfTx = rawDb.transaction('knowledgeFacts', 'readonly');
              const kfIndexes = [...kfTx.objectStore('knowledgeFacts').indexNames];
              const mainSettings = await db.get('settings', 'main');
              const ch1 = await db.get('chapters', 'ch-m3-1', { projectId: 'story-m3-a' });
              const cfgA = await db.get('storyConfigs', 'story-m3-a');
              return {
                version: rawDb.version,
                hasArcs: stores.includes('arcSummaries'),
                hasRels: stores.includes('relationshipStates'),
                hasLex: stores.includes('lexicalIndexes'),
                hasKfSourceIdx: kfIndexes.includes('by_project_source_chapter'),
                keyPreserved: mainSettings?.apiKeys?.openai === 'LOCAL-M3-V2-KEY',
                ch1Preserved: ch1?.title === 'Chapter 1: Cedar Oath',
                cfgPreserved: cfgA?.fandom === 'power_to_strive',
              };
            }''')
            assert v3_check['version'] == 3 and all(v3_check.values()), f'v2->v3 upgrade check failed: {v3_check}'

            # ------------------------------------------------------------------
            # TEST 2: Spanish Memory UI — Epistemic fact, false belief, qualitative relationship,
            #         arc compression, and 0-token explainable BM25 search
            # ------------------------------------------------------------------
            page.select_option('#workspace-select', 'story-m3-a')
            page.click('[data-view="memory"]')
            page.wait_for_selector('#memory-search-card')
            assert 'Hito 5' in page.locator('#memory-integration-status').inner_text()

            # Create epistemic fact linked to Chapter 1
            page.click('#kf-add-btn')
            page.wait_for_selector('#kf-truth')
            page.fill('#kf-title', 'Juramento de la linterna')
            page.fill('#kf-truth', 'Erwin and Levi secretly swore the brass pocket watch oath.')
            page.select_option('#kf-scope', 'room_event')
            page.select_option('#kf-layer', 'room')
            page.select_option('#kf-source-chapter', 'ch-m3-1')
            page.fill('#kf-first-order', '1')
            page.check('#kf-secret')
            page.fill('#kf-constraints', 'Never casually revealed to the room')
            page.click('#kf-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_selector('#epistemic-facts-list .list-item')

            # Add a false belief for Eren (objective truth must stay intact!)
            page.click('#epistemic-facts-list .act-kf-belief')
            page.wait_for_selector('#cb-char')
            page.fill('#cb-char', 'eren')
            page.select_option('#cb-ver', 'room')
            page.select_option('#cb-state', 'believes_false')
            page.fill('#cb-order', '2')
            page.fill('#cb-text', 'Eren thinks the watch was just a broken military compass.')
            page.fill('#cb-evidence', 'Overheard half a sentence in Chapter 2.')
            page.click('#cb-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            facts_text = page.locator('#epistemic-facts-list').inner_text()
            assert 'Erwin and Levi secretly swore the brass pocket watch oath.' in facts_text
            assert 'Cree algo falso' in facts_text
            assert 'broken military compass' in facts_text

            # Add qualitative relationship state (open collapsible details first)
            page.locator('#relationship-continuity-card summary').click()
            page.click('#rel-add-btn')
            page.wait_for_selector('#rel-participants')
            page.fill('#rel-participants', 'erwin, levi')
            page.fill('#rel-label', 'Erwin Smith & Levi Ackerman')
            page.fill('#rel-stage', 'secret_relationship')
            page.fill('#rel-order', '1')
            page.fill('.rel-dim-input[data-dim="trust"]', 'Deep silent trust forged under fire.')
            page.fill('#rel-promises', 'Brass pocket watch lantern oath from Chapter 1.')
            page.click('#rel-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            assert 'Deep silent trust' in page.locator('#relationships-list').inner_text()

            # Compress Chapters 1-2 into an Arc Summary at 0 tokens
            page.locator('#arc-summaries-card summary').click()
            page.click('#arc-compress-btn')
            page.wait_for_selector('#ac-run-btn')
            page.fill('#ac-title', 'Arco I — Juramento inicial')
            page.fill('#ac-start', '1')
            page.fill('#ac-end', '2')
            page.click('#ac-run-btn')
            page.wait_for_selector('#active-modal', state='detached')
            arc_text = page.locator('#arc-summaries-list').inner_text()
            assert 'Arco I — Juramento inicial' in arc_text
            assert 'brass pocket watch' in arc_text.lower()

            # Run 0-token explainable BM25 search -> recalls Ch 1 oath, excludes alternative branch!
            page.fill('#mem-search-query', 'brass pocket watch lantern oath')
            page.fill('#mem-search-chapter', '3')
            page.click('#mem-search-btn')
            page.wait_for_selector('#mem-explain-panel')
            explain_text = page.locator('#mem-explain-panel').inner_text()
            assert 'Chapter 1: Cedar Oath' in explain_text, f'Expected Ch 1 recall in explain panel: {explain_text}'
            assert '¿Por qué Inky recuperó esto?' in explain_text
            assert 'ALT_BRANCH_FORBIDDEN_MARKER_991' not in explain_text
            assert '1 alternativos' in explain_text

            # ------------------------------------------------------------------
            # TEST 3: Edit Chapter 1 in Capítulos -> marks BOTH memoryEntry & knowledgeFact & arc stale!
            # ------------------------------------------------------------------
            page.click('[data-view="chapters"]')
            page.wait_for_selector('#chapters-list .list-item')
            page.locator('#chapters-list .list-item', has_text='Chapter 1: Cedar Oath').locator('.act-open').click()
            page.wait_for_selector('#editor-mode-toggle')
            page.click('#editor-mode-toggle')
            page.wait_for_selector('#editor-content', state='visible')
            page.fill('#editor-content', 'Beneath the cedar rafters, Levi hesitated before handing Erwin the watch and left the vow unspoken for now.')
            page.click('#editor-close-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_timeout(300)

            # Return to Memoria -> stale review card MUST list memory, knowledgeFact, and arcSummary!
            page.click('[data-view="memory"]')
            page.wait_for_selector('#memory-stale-review-card')
            stale_text = page.locator('#memory-stale-review-card').inner_text()
            assert 'Juramento de la linterna' in stale_text, f'Knowledge fact should be marked stale: {stale_text}'
            assert 'Chapter 1: Cedar Oath' in stale_text, f'Chapter memory should be marked stale: {stale_text}'
            assert 'Arco I — Juramento inicial' in stale_text, f'Arc summary should be marked stale: {stale_text}'

            # Confirm the epistemic fact as reviewed -> removes it from stale review list
            page.click('#memory-stale-review-card .act-stale-fact-ok')
            page.wait_for_timeout(200)
            stale_after = page.locator('#memory-stale-review-card').inner_text()
            assert 'Juramento de la linterna' not in stale_after

            # ------------------------------------------------------------------
            # TEST 4: Reload persistence, cross-workspace isolation & v3/v2 backup round-trip
            # ------------------------------------------------------------------
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 3")
            page.select_option('#workspace-select', 'story-m3-b')
            page.click('[data-view="memory"]')
            page.wait_for_selector('#epistemic-facts-list')
            assert 'Todavía no has registrado hechos epistémicos' in page.locator('#epistemic-facts-list').inner_text(), 'Story B must be isolated from Story A facts!'

            backup_check = page.evaluate('''async () => {
              const { db, DB_VERSION } = await import('/js/db.js');
              const { saveKnowledgeFact, updateCharacterBelief } = await import('/js/knowledgeLedger.js');
              const { markChapterMemoriesStale } = await import('/js/memoryEngine.js');
              const { syncPersistedChapterIndex } = await import('/js/lexicalIndex.js');

              // Verify atomic invalidation when Ch 2 changes: a fact originated in Ch 1 whose belief was learned in Ch 2 MUST be invalidated,
              // AND the persisted chapter lexical index MUST be deleted in the same atomic transaction!
              await syncPersistedChapterIndex({ projectId: 'story-m3-a' });
              const beforeIdx = await db.get('lexicalIndexes', 'story-m3-a::chapters', { projectId: 'story-m3-a' });
              const fCross = await saveKnowledgeFact({
                id: 'kf-cross-ch',
                title: 'Fact from Ch 1 learned by Hange in Ch 2',
                truth: 'Erwin hid a cipher key in Ch 1.',
                scope: 'room_event',
                sourceChapterId: 'ch-m3-1',
                firstEffectiveChapterOrder: 1,
              }, { projectId: 'story-m3-a' });
              await updateCharacterBelief(fCross.id, 'hange@room', {
                state: 'knows',
                evidence: 'Hange spotted it in Chapter 2',
                effectiveChapterOrder: 2,
                sourceChapterId: 'ch-m3-2',
              }, { projectId: 'story-m3-a' });
              const staleRes = await markChapterMemoriesStale('ch-m3-2', { projectId: 'story-m3-a', reason: 'edited_ch2' });
              const fAfter = await db.get('knowledgeFacts', 'kf-cross-ch', { projectId: 'story-m3-a' });
              const afterIdx = await db.get('lexicalIndexes', 'story-m3-a::chapters', { projectId: 'story-m3-a' });

              const dump = await db.exportAll();
              const mainExported = dump.settings.find(s => s.id === 'main');
              await db.importAll(dump, { merge: false });
              const mainAfter = await db.get('settings', 'main');
              const factsA = await db.getAll('knowledgeFacts', { projectId: 'story-m3-a' });
              const relsA = await db.getAll('relationshipStates', { projectId: 'story-m3-a' });
              const arcsA = await db.getAll('arcSummaries', { projectId: 'story-m3-a' });
              return {
                metaV3: dump.__meta.version === DB_VERSION && dump.__meta.schemaVersion === 3,
                derivedExcludedByDefault: dump.__meta.derivedIndexesExcluded === true && !('lexicalIndexes' in dump),
                crossChapterBeliefInvalidated: staleRes.knowledgeFacts >= 1 && fAfter?.stale === true && fAfter?.beliefHistoryByCharacter?.['hange@room']?.[0]?.stale === true,
                lexicalIndexInvalidatedAtomically: Boolean(beforeIdx) && afterIdx === null,
                keysExcluded: Object.keys(mainExported?.apiKeys || {}).length === 0,
                keysPreserved: mainAfter?.apiKeys?.openai === 'LOCAL-M3-V2-KEY',
                factsSurvived: factsA.length === 2,
                relsSurvived: relsA.length === 1,
                arcsSurvived: arcsA.length === 1,
              };
            }''')
            assert all(backup_check.values()), f'v3 backup / atomic invalidation check failed: {backup_check}'
            assert not network_external, f'Unexpected external network/API requests made: {network_external}'
            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP violations: {csp_errs}'

            ctx.close()
            browser.close()
            print('PASS: all Milestone 3 + Part A browser integration tests passed (v2->v3 upgrade, epistemic ledger & false beliefs UI, qualitative relationships, 0-token arc compression, explainable BM25 search, atomic cross-store & cross-chapter belief invalidation, derived index lifecycle, workspace isolation, v3 backup round-trip, 0 external API calls).')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
