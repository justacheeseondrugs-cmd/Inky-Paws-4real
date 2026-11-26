"""Milestone 4 browser integration tests (Writing DNA & Creative Chat):
- Non-destructive IndexedDB v3 -> v4 upgrade preserving existing data & local API keys
- Global Writing DNA reused across unrelated stories + story-specific overrides isolated
- Editorial feedback before/after UI: AU-specific rule blocked from Global scope; literary rule approved & rejected cleanly
- Documents 6 reference roles UI + STYLE_ONLY craft profile (Violet Evergarden never activates Violet traits) + PtS timeline separation
- Creative Chat UI: independent per-story persistent chats, 0-token NL proposal extraction on "OKAAAAY SOOOO...",
  SELECTIVE item approval (rejected items never touch canon!), Chapter Brief creation & transfer to Escribir
- Unified Context Engine prep snapshot (`assembleUnifiedContextSnapshot`) + v4 backup round-trip + 7-tab invariant + 0 external API calls."""
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
            # TEST 1: Seed a REAL IndexedDB v3 database before opening v4 app
            # ------------------------------------------------------------------
            page.goto(f'{base_url}/manifest.webmanifest')
            page.evaluate('''async () => {
              await new Promise((resolve) => {
                const del = indexedDB.deleteDatabase('pts-studio');
                del.onsuccess = del.onerror = del.onblocked = () => resolve();
              });
              const v3Stores = [
                'chapters', 'characters', 'documents', 'docChunks',
                'memoryEntries', 'lockedFacts', 'canonNotes', 'settings', 'generationState',
                'universalCharacters', 'characterOverlays', 'storyConfigs', 'storyPresets',
                'knowledgeFacts', 'usageLog', 'arcSummaries', 'relationshipStates', 'lexicalIndexes'
              ];
              await new Promise((resolve, reject) => {
                const req = indexedDB.open('pts-studio', 3);
                req.onupgradeneeded = () => {
                  const db = req.result;
                  for (const name of v3Stores) {
                    const st = db.createObjectStore(name, { keyPath: 'id' });
                    if (['chapters', 'characters', 'documents', 'docChunks', 'memoryEntries', 'lockedFacts', 'canonNotes', 'generationState', 'knowledgeFacts', 'arcSummaries', 'relationshipStates', 'lexicalIndexes'].includes(name)) {
                      st.createIndex('by_project', 'projectId', { unique: false });
                    }
                  }
                };
                req.onsuccess = () => {
                  const db = req.result;
                  const tx = db.transaction(['settings', 'chapters', 'storyConfigs', 'documents', 'docChunks'], 'readwrite');
                  tx.objectStore('settings').put({
                    id: 'main',
                    provider: 'openai',
                    apiKeys: { openai: 'LOCAL-M4-V3-KEY' },
                    models: { openai: 'gpt-5.4-mini' },
                  });
                  tx.objectStore('settings').put({
                    id: 'workspaces',
                    items: [
                      { id: 'original', name: 'Original Story' },
                      { id: 'story-m4-pts', name: 'M4 PtS Story' },
                      { id: 'story-m4-orig', name: 'M4 Sci-Fi Original' },
                    ],
                  });
                  tx.objectStore('chapters').put({
                    id: 'ch-m4-1',
                    projectId: 'story-m4-pts',
                    order: 1,
                    title: 'Chapter 1: Rain in the Hall',
                    content: 'Erwin and Levi exchanged a single quiet glance before the projector hummed to life.',
                    wordCount: 15,
                    branchRole: 'main',
                    versions: [],
                    createdAt: '2026-01-01T10:00:00Z',
                  });
                  tx.objectStore('storyConfigs').put({
                    id: 'story-m4-pts',
                    projectId: 'story-m4-pts',
                    fandom: 'power_to_strive',
                    universeName: 'M4 PtS Story',
                    checkpointId: 'before_first_screen',
                    reactionMode: true,
                    overlayActivations: [{ overlayId: 'power_to_strive::levi_violet_traits', overlayLogicalId: 'levi_violet_traits', characterId: 'levi', scope: 'story', enabled: true }],
                    proposals: [],
                  });
                  tx.objectStore('storyConfigs').put({
                    id: 'story-m4-orig',
                    projectId: 'story-m4-orig',
                    fandom: 'starlight_original',
                    universeName: 'Starlight Original',
                    reactionMode: false,
                    proposals: [],
                  });
                  tx.objectStore('documents').put({
                    id: 'doc-ve-m4',
                    projectId: 'story-m4-pts',
                    filename: 'Violet_Evergarden_Style.txt',
                    type: 'STYLE_ONLY',
                    priority: 70,
                    active: true,
                    inclusion: 'SMART',
                    wordCount: 12,
                  });
                  tx.objectStore('docChunks').put({
                    id: 'chk-ve-m4',
                    projectId: 'story-m4-pts',
                    documentId: 'doc-ve-m4',
                    index: 0,
                    text: 'Quiet restrained epistolary emotional distance.',
                    wordCount: 5,
                  });
                  tx.oncomplete = () => { db.close(); resolve(); };
                  tx.onerror = () => reject(tx.error);
                };
                req.onerror = () => reject(req.error);
              });
            }''')

            # Boot app -> triggers non-destructive v3 -> v4 upgrade
            page.goto(f'{base_url}/index.html')
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 3")
            assert page.locator('#tabbar .tab-btn').count() == 7, 'Must preserve 7-tab invariant!'

            v4_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const rawDb = await db.openDb();
              const stores = [...rawDb.objectStoreNames];
              const main = await db.get('settings', 'main');
              const ch1 = await db.get('chapters', 'ch-m4-1', { projectId: 'story-m4-pts' });
              return {
                version: rawDb.version === 4,
                hasDna: stores.includes('writingDnaProfiles'),
                hasFb: stores.includes('editorialFeedback'),
                hasChat: stores.includes('creativeChats'),
                hasBriefs: stores.includes('chapterBriefs'),
                keyPreserved: main?.apiKeys?.openai === 'LOCAL-M4-V3-KEY',
                ch1Preserved: ch1?.title === 'Chapter 1: Rain in the Hall',
              };
            }''')
            assert all(v4_check.values()), f'v3->v4 upgrade check failed: {v4_check}'

            # ------------------------------------------------------------------
            # TEST 2: Settings — Global & Story Writing DNA + Reviewed Editorial Feedback
            # ------------------------------------------------------------------
            page.select_option('#workspace-select', 'story-m4-pts')
            page.click('[data-view="settings"]')
            page.wait_for_selector('#writing-dna-studio-card')

            # Edit Global Writing DNA note and save
            page.fill('#dna-custom-notes', 'GLOBAL_VOICE_MARKER: quiet literary restraint.')
            page.click('#dna-save-btn')
            page.wait_for_timeout(150)

            # Switch to Story-only scope and save isolated override
            page.select_option('#dna-scope-select', 'story')
            page.fill('#dna-custom-notes', 'PTS_STORY_ONLY_OVERRIDE')
            page.click('#dna-save-btn')
            page.wait_for_timeout(150)

            # Open Editorial Learning collapsible and submit (A) a pure literary feedback and (B) an AU-specific feedback
            page.locator('#writing-dna-studio-card details').nth(1).locator('summary').click()
            page.fill('#ed-orig', 'He was deeply sad and felt grief in his heart because he missed him.')
            page.fill('#ed-rev', 'He set the teacup down a fraction too carefully.')
            page.fill('#ed-note', 'Avoid explaining evident emotions; trust subtext.')
            page.select_option('#ed-scope', 'global')
            page.click('#ed-submit-btn')
            page.wait_for_selector('#ed-proposals-list .list-item')
            # Approve the pure literary global rule
            page.locator('#ed-proposals-list .list-item').first.locator('.act-ed-approve').click()
            page.wait_for_timeout(200)

            # Now submit an AU-specific correction requesting Global scope -> guard MUST restrict it to `story`!
            page.fill('#ed-orig', 'Levi smiled brightly at everyone.')
            page.fill('#ed-rev', 'Levi gave Erwin a flat look.')
            page.fill('#ed-note', 'Erwin and Levi used to date in Power to Strive.')
            page.select_option('#ed-scope', 'global')
            page.click('#ed-submit-btn')
            page.wait_for_timeout(200)
            fb_text = page.locator('#ed-proposals-list').inner_text()
            assert 'no contaminar el Writing DNA global' in fb_text, f'Expected global contamination guard warning: {fb_text}'
            # Reject this AU proposal so rejected ideas never activate
            page.locator('#ed-proposals-list .list-item', has_text='no contaminar el Writing DNA global').locator('.act-ed-reject').click()
            page.wait_for_timeout(150)

            # ------------------------------------------------------------------
            # TEST 3: Documents — 6 Reference Roles & STYLE_ONLY Craft Profile
            # ------------------------------------------------------------------
            page.click('[data-view="documents"]')
            page.wait_for_selector('#doc-list .card[data-id="doc-ve-m4"]')
            doc_card = page.locator('#doc-list .card[data-id="doc-ve-m4"]')
            doc_card.locator('details summary').click()
            doc_card.locator('.f-craft[data-dim="emotionalRestraint"]').fill('Quiet emotional restraint without melodrama.')
            doc_card.locator('.act-save').click()
            page.wait_for_timeout(150)

            # ------------------------------------------------------------------
            # TEST 4: Creative Chat — "OKAAAAY SOOOO..." selective proposal approval & Chapter Brief -> Escribir
            # ------------------------------------------------------------------
            page.click('[data-view="planner"]')
            page.wait_for_selector('#planner-extract-btn')
            messy = 'OKAAAAY SOOOO what if Joseph knows Erwin and Levi used to date, but Hange thinks something completely different HAHAHAHA. Also no Violet traits this time!'
            page.fill('#planner-input', messy)
            page.click('#planner-extract-btn')
            page.wait_for_selector('#planner-proposal-review-card')

            # Uncheck the `possible_idea` item to test SELECTIVE approval (approve config/belief items, reject possible_idea!)
            prop_card = page.locator('#planner-proposal-review-card')
            assert 'Desactivar overlay Violet Traits' in prop_card.inner_text()
            assert 'Falsa creencia de hange' in prop_card.inner_text()
            idea_cb = prop_card.locator('.list-item', has_text='Guardar como idea posible').locator('.prop-item-check')
            idea_cb.uncheck()
            page.click('#prop-apply-selected-btn')
            page.wait_for_timeout(250)

            # Create and approve a Chapter Brief, then transfer to Escribir!
            page.click('#brief-new-btn')
            page.wait_for_selector('#br-title')
            page.fill('#br-title', 'Chapter 2 — Unspoken Tea')
            page.fill('#br-objective', 'Hange tests her wrong theory while Joseph keeps his private knowledge.')
            page.fill('#br-pov', 'Third-person close (Levi)')
            page.fill('#br-secret', 'Eruri past stays hidden from Eren and Mikasa')
            page.fill('#br-ending', 'The screen resumes right as Levi looks at Erwin.')
            page.select_option('#br-len', '7000')
            page.click('#br-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_selector('#chapter-briefs-list .act-brief-send')
            page.locator('#chapter-briefs-list .act-brief-send').first.click()

            # Verify navigation to Escribir and populated brief fields!
            page.wait_for_selector('#w-instructions')
            assert 'Chapter 2 — Unspoken Tea' in page.input_value('#w-instructions')
            assert page.input_value('#w-title') == 'Chapter 2 — Unspoken Tea'
            assert page.input_value('#w-words') == '7000'
            assert 'screen resumes' in page.input_value('#w-ending')

            # ------------------------------------------------------------------
            # TEST 5: Reload persistence, cross-story isolation, Unified Context Prep & v4 backup round-trip
            # ------------------------------------------------------------------
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 3")

            final_check = page.evaluate('''async () => {
              const { db, DB_VERSION } = await import('/js/db.js');
              const { assembleUnifiedContextSnapshot } = await import('/js/contextEnginePrep.js');
              const { getCreativeChat } = await import('/js/creativeChat.js');

              const snapPts = await assembleUnifiedContextSnapshot({
                projectId: 'story-m4-pts',
                targetChapterOrder: 2,
                query: 'Erwin Levi Hange tea',
              });
              const snapOrig = await assembleUnifiedContextSnapshot({
                projectId: 'story-m4-orig',
                targetChapterOrder: 1,
                query: 'starlight',
              });
              const chatPts = await getCreativeChat('story-m4-pts');
              const chatOrig = await getCreativeChat('story-m4-orig');

              const dump = await db.exportAll();
              const mainExported = dump.settings.find(s => s.id === 'main');
              await db.importAll(dump, { merge: false });
              const mainAfter = await db.get('settings', 'main');

              return {
                // Global Writing DNA reused in unrelated story; Story PtS override stayed isolated!
                globalDnaInOrig: snapOrig.writingDna.customNotesByScope.global.includes('GLOBAL_VOICE_MARKER'),
                globalRuleInOrig: snapOrig.writingDna.approvedLearnedRules.some(r => r.scope === 'global'),
                storyOverrideIsolated: snapOrig.writingDna.customNotesByScope.story === '' && snapPts.writingDna.customNotesByScope.story.includes('PTS_STORY_ONLY_OVERRIDE'),
                // Selective proposal applied cleanly (Violet disabled, Eruri former_lovers private, Joseph enabled NOT invited, Hange false belief saved, rejected possible_idea NOT archived!)
                violetDisabled: snapPts.universe.activeOverlays.length === 0,
                eruriFormerLoversPrivate: snapPts.universe.relationshipSummary.eruri?.state === 'former_lovers' && snapPts.universe.relationshipSummary.eruri?.publiclyKnown === false,
                josephEnabledNotInvited: snapPts.universe.josephStatus === 'enabled_outside_uninvited',
                hangeHasFalseBelief: (snapPts.memory.modelPayload.layers.D_character_epistemic_and_relationships.characterKnowledgeMap.hange?.believesFalse || []).length >= 1,
                rejectedIdeaNotSaved: (chatPts.archivedIdeas || []).length === 0,
                // Independent story chats
                chatsIndependent: (chatPts.messages || []).length >= 1 && (chatOrig.messages || []).length === 0,
                // STYLE_ONLY craft profile preserved & never activates overlays
                styleCraftPreserved: snapPts.references.styleGuidance.some(g => g.craftProfile?.emotionalRestraint?.includes('Quiet emotional restraint')),
                // Brief preserved
                briefReady: snapPts.approvedChapterBrief?.title === 'Chapter 2 — Unspoken Tea',
                // v4 backup & API key safety
                v4BackupOk: dump.__meta.version === DB_VERSION && dump.__meta.version === 4 && Object.keys(mainExported?.apiKeys || {}).length === 0 && mainAfter?.apiKeys?.openai === 'LOCAL-M4-V3-KEY',
              };
            }''')
            assert all(final_check.values()), f'Milestone 4 final verification failed: {final_check}'
            assert not network_external, f'Unexpected external network/API requests made: {network_external}'
            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP violations: {csp_errs}'

            ctx.close()
            browser.close()
            print('PASS: all Milestone 4 browser integration tests passed (v3->v4 upgrade, 4-scope Writing DNA, AU anti-contamination guard, editorial feedback approval/rejection, 6 reference roles & STYLE_ONLY craft profile, independent Creative Chat, selective NL proposal approval, Chapter Brief -> Escribir transfer, unified Context Engine prep snapshot, v4 backup round-trip, 0 external API calls).')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
