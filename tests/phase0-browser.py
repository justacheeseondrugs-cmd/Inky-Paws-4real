"""Comprehensive Phase 0 browser integration tests (real IndexedDB, SW, DOM, CSP, mocked AI)."""
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
            # TEST 1: SW cache cleanup isolation + upgrade from stale v43 + offline boot
            # ------------------------------------------------------------------
            ctx1 = browser.new_context(service_workers='allow')
            page1 = ctx1.new_page()
            page_errors = []
            csp_violations = []
            page1.on('pageerror', lambda err: page_errors.append(str(err)))
            page1.on('console', lambda msg: csp_violations.append(msg.text) if 'Content Security Policy' in msg.text else None)
            page1.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page1.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            # Seed BOTH an unrelated same-origin app cache and an old Inky Paws v43 cache
            # BEFORE sw.js registers and activates!
            page1.goto(f'{base_url}/manifest.webmanifest')
            page1.evaluate('''async () => {
              const unrelated = await caches.open('unrelated-other-app-v1');
              await unrelated.put(new Request('/other-app.txt'), new Response('keep me'));
              const oldInky = await caches.open('inky-paws-es-v43-your-name-v1');
              await oldInky.put(
                new Request('/js/timeline.js?v=20260928-chapter-variants-v1'),
                new Response('export function isMainTimelineChapter(){return true;}', {
                  headers: {'Content-Type': 'application/javascript'}
                })
              );
            }''')

            page1.goto(f'{base_url}/index.html')
            page1.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")
            sw_state = page1.evaluate('''async () => {
              const reg = await navigator.serviceWorker.ready;
              if (reg.active && reg.active.state !== 'activated') {
                await new Promise((resolve) => {
                  const sw = reg.active;
                  if (sw.state === 'activated') return resolve();
                  sw.addEventListener('statechange', () => {
                    if (sw.state === 'activated') resolve();
                  });
                });
              }
              return { active: !!reg.active, state: reg.active?.state, keys: await caches.keys() };
            }''')
            assert sw_state['active'], 'Service Worker failed to activate'
            assert 'inky-paws-es-v43-your-name-v1' not in sw_state['keys'], f"Old Inky Paws cache was not cleaned up: {sw_state['keys']}"
            assert 'unrelated-other-app-v1' in sw_state['keys'], f"SW deleted unrelated same-origin cache! {sw_state['keys']}"

            # Reload and verify new SW cache is active and app boots offline cleanly
            page1.reload()
            page1.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")
            ctx1.set_offline(True)
            page1.reload()
            page1.wait_for_selector('#tabbar .tab-btn')
            assert page1.locator('#tabbar .tab-btn').count() == 7, 'Offline reload did not render full shell'
            ctx1.set_offline(False)
            assert not page_errors, f'Page errors during fresh/offline SW test: {page_errors}'
            assert not csp_violations, f'CSP violations during boot: {csp_violations}'
            ctx1.close()

            # ------------------------------------------------------------------
            # TEST 2-8: Backup validation & workspace collision guards, provider caps,
            #           reload-resilient staged rewrites, continuation, conflict
            #           resolution, stale memory & review, quarantine, races, XSS & CSP
            # ------------------------------------------------------------------
            ctx = browser.new_context(service_workers='block')
            page = ctx.new_page()
            errors = []
            csp_errs = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: csp_errs.append(msg.text) if 'Content Security Policy' in msg.text else None)
            page.on('dialog', lambda d: d.accept())

            # Stub external font/PDF/provider endpoints locally (zero paid API calls!)
            page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))
            page.route('https://cdnjs.cloudflare.com/**/pdf.min.js', lambda r: r.fulfill(
                status=200,
                content_type='application/javascript',
                body='window.pdfjsLib={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>({getTextContent:async()=>({items:[{str:"PDF OK"}]})})})})};',
            ))

            mock_state = {'mode': 'rewrite_truncated', 'last_openai_body': None, 'calls': 0}

            def handle_openai(route):
                mock_state['calls'] += 1
                body = json.loads(route.request.post_data or '{}')
                mock_state['last_openai_body'] = body
                mode = mock_state['mode']
                if mode == 'rewrite_truncated':
                    route.fulfill(
                        status=200,
                        content_type='application/json',
                        body=json.dumps({
                            'choices': [{
                                'finish_reason': 'length',
                                'message': {
                                    'content': 'Rewritten opening paragraph with deeper Levi interiority and dry tension across the room. ' * 25
                                }
                            }]
                        }),
                    )
                elif mode == 'rewrite_continue':
                    route.fulfill(
                        status=200,
                        content_type='application/json',
                        body=json.dumps({
                            'choices': [{
                                'finish_reason': 'stop',
                                'message': {
                                    'content': 'Continuation closing paragraphs bringing the chapter seamlessly to its final beat in the quiet hall. ' * 30
                                }
                            }]
                        }),
                    )
                elif mode == 'quarantine_leak':
                    route.fulfill(
                        status=200,
                        content_type='application/json',
                        body=json.dumps({
                            'choices': [{
                                'finish_reason': 'length',
                                'message': {
                                    'content': 'Levi frowned as Kael stepped near the door while Erwin studied the silent screen carefully. ' * 8
                                }
                            }]
                        }),
                    )
                elif mode == 'memory_json':
                    route.fulfill(
                        status=200,
                        content_type='application/json',
                        body=json.dumps({
                            'choices': [{
                                'finish_reason': 'stop',
                                'message': {
                                    'content': json.dumps({
                                        'EVENTS': 'Levi confronted Erwin after the footage paused.',
                                        'RELATIONSHIP_CHANGES': 'Quiet truce established.',
                                        'NEW_FACTS': 'The compass belonged to Levi.',
                                        'WHO_KNOWS_WHAT': 'Only Hange noticed the glance.',
                                        'PHYSICAL_STATE': 'Levi favors his left shoulder.',
                                        'CURRENT_LOCATION_TIME': 'Reaction room, late evening.',
                                        'OPEN_THREADS': 'Who brought the compass?'
                                    })
                                }
                            }]
                        }),
                    )
                else:
                    route.fulfill(
                        status=200,
                        content_type='application/json',
                        body=json.dumps({
                            'choices': [{
                                'finish_reason': 'stop',
                                'message': {'content': 'Clean novel prose paragraph continuing seamlessly from the prior beat. ' * 10}
                            }]
                        }),
                    )

            page.route('https://api.openai.com/**', handle_openai)

            page.goto(f'{base_url}/index.html')
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")

            # --- TEST 2: Strengthened backup validation, full vs partial, & cross-workspace ID collision guards ---
            backup_res = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              await db.put('settings', {
                id: 'main',
                provider: 'openai',
                apiKeys: { openai: 'LOCAL-OPENAI-KEY', gemini: 'LOCAL-GEMINI-KEY' },
                models: { openai: 'gpt-4o', gemini: 'gemini-2.0-flash' },
                defaultGenerationMode: 'full_chapter',
                blockWordSize: 1000,
              });
              db.setActiveProjectId('original');
              await db.put('chapters', { id: 'keep-ch-1', title: 'Chapter 1', content: 'Original prose must survive.', wordCount: 4, order: 0, status: 'finished', versions: [] });

              // Invalid imports (including duplicate IDs, unsupported version, malformed records, and partial under merge:false)
              const invalidDumps = [
                null,
                [],
                {},
                { __meta: { app: 'evil', version: 1 }, chapters: [] },
                { __meta: { app: 'pts-studio', version: 99 }, chapters: [] },
                { chapters: 'nope' },
                { chapters: [{ title: 'no id' }] },
                { __meta: { app: 'pts-studio', version: 1 }, chapters: [{ id: 'dup', title: 'A' }, { id: 'dup', title: 'B' }] },
                { __meta: { app: 'pts-studio', version: 1 }, chapters: [{ id: 'partial-only', title: 'Partial' }] },
              ];
              for (const bad of invalidDumps) {
                let threw = false;
                try { await db.importAll(bad, { merge: false }); } catch { threw = true; }
                if (!threw) throw new Error('Invalid or partial replace backup was accepted: ' + JSON.stringify(bad));
              }
              if ((await db.get('chapters', 'keep-ch-1'))?.content !== 'Original prose must survive.') {
                throw new Error('Invalid backup erased existing chapter!');
              }

              // Valid FULL 9-store backup with malicious apiKeys must commit atomically AND keep local keys
              const longCh2 = 'Long chapter prose sentence here. '.repeat(1000); // ~5000 words
              await db.importAll({
                __meta: { app: 'pts-studio', version: 1 },
                chapters: [
                  { id: 'ch-1', projectId: 'original', title: 'Chapter 1', content: 'First chapter canon.', wordCount: 3, order: 0, status: 'finished', versions: [] },
                  { id: 'ch-2', projectId: 'original', title: 'Chapter 2', content: longCh2, wordCount: 5000, order: 1, status: 'finished', versions: [] },
                  { id: 'ch-3', projectId: 'original', title: 'Chapter 3', content: 'FUTURE_SPOILER_CH3 should never enter Ch 2 rewrite.', wordCount: 8, order: 2, status: 'finished', versions: [] },
                ],
                characters: [],
                documents: [],
                docChunks: [],
                memoryEntries: [
                  { id: 'm-1', projectId: 'original', chapterId: 'ch-1', chapterTitle: 'Chapter 1', events: 'Ch1 event', createdAt: '2026-01-01' },
                  { id: 'm-3', projectId: 'original', chapterId: 'ch-3', chapterTitle: 'Chapter 3', events: 'FUTURE_SPOILER_CH3', createdAt: '2026-01-03' },
                ],
                lockedFacts: [],
                canonNotes: [],
                generationState: [],
                settings: [
                  { id: 'main', provider: 'openai', apiKeys: { openai: 'ATTACKER-KEY' }, models: { openai: 'gpt-4o', gemini: 'gemini-2.0-flash' }, defaultGenerationMode: 'full_chapter', blockWordSize: 1000 },
                  { id: 'workspaces', items: [{ id: 'story-b', name: 'Story B' }] },
                ],
              }, { merge: false });

              const main = await db.get('settings', 'main');
              if (main.apiKeys.openai !== 'LOCAL-OPENAI-KEY' || main.apiKeys.gemini !== 'LOCAL-GEMINI-KEY') {
                throw new Error('Local API keys were not preserved on import!');
              }
              if (await db.get('chapters', 'keep-ch-1')) {
                throw new Error('Old chapter not cleared on valid full replace import');
              }

              // Cross-workspace ID collision protection on db.put
              db.setActiveProjectId('story-b');
              let putCollisionRejected = false;
              try {
                await db.put('chapters', { id: 'ch-1', title: 'Hijack', content: 'Should fail!' });
              } catch (err) {
                putCollisionRejected = /Colisión de ID/i.test(String(err?.message || ''));
              }
              if (!putCollisionRejected) throw new Error('db.put allowed cross-workspace ID collision!');

              // Cross-workspace ID collision protection on partial merge importAll (must rollback atomically!)
              let mergeCollisionRejected = false;
              try {
                await db.importAll({
                  __meta: { app: 'pts-studio', version: 1 },
                  chapters: [
                    { id: 'story-b-rollback', projectId: 'story-b', title: 'Should Rollback', content: 'Must not persist', wordCount: 3, order: 0 },
                    { id: 'ch-1', projectId: 'story-b', title: 'Colliding Ch1', content: 'Overwrite attempt', wordCount: 2, order: 1 },
                  ],
                }, { merge: true });
              } catch (err) {
                mergeCollisionRejected = /Colisión entre historias/i.test(String(err?.message || ''));
              }
              if (!mergeCollisionRejected) throw new Error('merge importAll allowed cross-workspace ID collision!');
              if (await db.get('chapters', 'story-b-rollback', { projectId: 'story-b' })) {
                throw new Error('Failed merge importAll did not rollback earlier records!');
              }
              if ((await db.get('chapters', 'ch-1', { projectId: 'original' }))?.content !== 'First chapter canon.') {
                throw new Error('Cross-workspace collision corrupted original workspace chapter!');
              }

              // Non-colliding partial merge succeeds cleanly
              await db.importAll({
                __meta: { app: 'pts-studio', version: 1 },
                chapters: [
                  { id: 'story-b-safe', projectId: 'story-b', title: 'Story B Safe', content: 'Isolated chapter.', wordCount: 2, order: 0 },
                ],
              }, { merge: true });
              const safeMerged = await db.get('chapters', 'story-b-safe', { projectId: 'story-b' });
              if (!safeMerged) throw new Error('Valid non-colliding partial merge did not save!');

              db.setActiveProjectId('original');
              return { ok: true, count: (await db.getAll('chapters')).length };
            }''')
            assert backup_res['count'] == 3

            # --- TEST 3: Provider output limit, reload-resilient staged rewrite, continuation, & concurrent-edit conflict ---
            page.click('[data-view="chapters"]')
            page.wait_for_selector('#chapters-list .list-item[data-id="ch-2"]')
            page.click('#chapters-list .list-item[data-id="ch-2"] .act-rewrite')
            page.wait_for_selector('#rewrite-instructions')
            page.fill('#rewrite-instructions', 'Deepen Levi interiority while keeping every beat.')
            page.click('#rewrite-go-btn')
            page.wait_for_selector('#rewrite-review-pane', state='visible')

            # Verify provider ceiling respected (gpt-4o = 16384, never 120000) & zero future spoiler
            req_body = mock_state['last_openai_body']
            assert req_body.get('max_tokens') == 16384, f"Expected gpt-4o cap 16384, got: {req_body.get('max_tokens')}"
            sys_msg = req_body['messages'][0]['content']
            assert 'FUTURE_SPOILER_CH3' not in sys_msg, 'Future chapter leaked into Chapter 2 rewrite!'
            assert 'Ch1 event' in sys_msg, 'Prior Chapter 1 memory missing from Chapter 2 rewrite!'
            warn_text = page.locator('#rewrite-warning-slot').inner_text().lower()
            assert 'incompleta' in warn_text and '16384' in warn_text

            # Original chapter MUST STILL BE UNCHANGED before approval
            before_approve = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.get('chapters','ch-2')).content; }")
            assert before_approve.startswith('Long chapter prose sentence here.'), 'Rewrite overwrote chapter before approval!'

            # Close modal accidentally AND reload full page -> staged draft MUST survive!
            page.click('#rewrite-cancel-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")
            page.select_option('#workspace-select', 'original')
            page.click('[data-view="chapters"]')
            page.wait_for_selector('#chapters-list .list-item[data-id="ch-2"]')
            ch2_card_text = page.locator('#chapters-list .list-item[data-id="ch-2"]').inner_text()
            assert 'Borrador de reescritura guardado' in ch2_card_text, f'Missing persisted rewrite draft badge: {ch2_card_text}'

            # Reopen Rewrite modal -> restored draft appears automatically
            page.click('#chapters-list .list-item[data-id="ch-2"] .act-rewrite')
            page.wait_for_selector('#rewrite-review-pane', state='visible')
            restored_val = page.input_value('#rewrite-preview')
            assert restored_val.startswith('Rewritten opening paragraph'), 'Staged rewrite did not survive page reload!'
            assert 'restaurado' in page.locator('#rewrite-warning-slot').inner_text().lower()

            # Continue truncated rewrite -> appends continuation cleanly and shows Undo button
            mock_state['mode'] = 'rewrite_continue'
            page.click('#rewrite-continue-btn')
            page.wait_for_function("() => (document.querySelector('#rewrite-preview')?.value || '').includes('Continuation closing paragraphs')")
            assert page.locator('#rewrite-undo-cont-btn').is_visible(), 'Undo continuation button did not appear'

            # Simulate concurrent modification of ch-2 while rewrite is staged -> approval must trigger conflict workflow!
            page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const ch = await db.get('chapters', 'ch-2', { projectId: 'original' });
              ch.content = 'CONCURRENT_AUTHOR_EDIT saved while rewrite was staged.';
              ch.wordCount = 7;
              ch.updatedAt = new Date().toISOString();
              await db.put('chapters', ch, { projectId: 'original' });
            }''')
            page.click('#rewrite-approve-btn')
            page.wait_for_selector('#rewrite-conflict-panel', state='visible')
            after_conflict_attempt = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.get('chapters','ch-2')).content; }")
            assert after_conflict_attempt == 'CONCURRENT_AUTHOR_EDIT saved while rewrite was staged.', 'Conflict overwrite was NOT blocked!'

            # Resolve conflict by saving rewrite as alternative -> main edit stays intact, alternative has full rewrite, staged draft cleared
            page.click('#rewrite-conflict-alt-btn')
            page.wait_for_selector('#active-modal', state='detached')
            conflict_res = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const all = await db.getAll('chapters', { projectId: 'original' });
              const main = all.find(c => c.id === 'ch-2');
              const alts = all.filter(c => c.branchRole === 'alternative' && c.alternativeSourceId === 'ch-2');
              const draft = await db.get('settings', 'rewrite-draft:original:ch-2');
              return { mainContent: main?.content, altCount: alts.length, altContent: alts[0]?.content || '', draftExists: !!draft };
            }''')
            assert conflict_res['mainContent'] == 'CONCURRENT_AUTHOR_EDIT saved while rewrite was staged.'
            assert conflict_res['altCount'] == 1
            assert 'Rewritten opening paragraph' in conflict_res['altContent'] and 'Continuation closing paragraphs' in conflict_res['altContent']
            assert not conflict_res['draftExists'], 'Staged rewrite draft was not cleared after saving as alternative'

            # --- TEST 4: Chapter editor autosave flush + stale memory marking (0 API calls) + non-destructive memory review ---
            calls_before_edit = mock_state['calls']
            page.click('#chapters-list .list-item[data-id="ch-1"] .act-open')
            page.wait_for_selector('#editor-mode-toggle')
            page.click('#editor-mode-toggle')
            page.fill('#editor-content', 'Flushed immediately before 700ms debounce!')
            page.click('#editor-close-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_timeout(150)

            edit_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const ch = await db.get('chapters', 'ch-1', { projectId: 'original' });
              const mems = await db.getByIndex('memoryEntries', 'by_chapter', 'ch-1', { projectId: 'original' });
              return { content: ch?.content, mem: mems[0] || null };
            }''')
            assert edit_check['content'] == 'Flushed immediately before 700ms debounce!', f"Autosave lost on close: {edit_check}"
            assert mock_state['calls'] == calls_before_edit, 'Editing a chapter must NOT trigger automatic paid API requests!'
            assert edit_check['mem']['stale'] is True, f"Memory was not marked stale after editing source chapter: {edit_check['mem']}"
            assert edit_check['mem']['events'] == 'Ch1 event', 'Existing memory content was altered when marked stale!'
            page.wait_for_function("() => (document.querySelector('#chapters-list .list-item[data-id=\"ch-1\"]')?.innerText || '').includes('Memoria desactualizada')")

            # Regenerating an existing memory must open review modal and preserve old memory until approved!
            mock_state['mode'] = 'memory_json'
            page.click('#chapters-list .list-item[data-id="ch-1"] .act-memory')
            page.wait_for_selector('#mem-review-save-btn', state='visible')
            while_reviewing = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.getByIndex('memoryEntries','by_chapter','ch-1',{projectId:'original'}))[0]; }")
            assert while_reviewing['events'] == 'Ch1 event' and while_reviewing['stale'] is True, 'Existing memory was overwritten before author review!'
            # Keep previous memory -> must remain intact
            page.click('#mem-review-keep-btn')
            page.wait_for_selector('#active-modal', state='detached')
            after_keep = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.getByIndex('memoryEntries','by_chapter','ch-1',{projectId:'original'}))[0]; }")
            assert after_keep['events'] == 'Ch1 event' and after_keep['stale'] is True
            # Now approve replacement -> memory updates and stale clears
            page.click('#chapters-list .list-item[data-id="ch-1"] .act-memory')
            page.wait_for_selector('#mem-review-save-btn', state='visible')
            page.click('#mem-review-save-btn')
            page.wait_for_selector('#active-modal', state='detached')
            after_replace = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.getByIndex('memoryEntries','by_chapter','ch-1',{projectId:'original'}))[0]; }")
            assert after_replace['events'] == 'Levi confronted Erwin after the footage paused.' and after_replace['stale'] is False

            # --- TEST 5: Persistent writing-form draft across tab switches ---
            page.click('[data-view="write"]')
            page.wait_for_selector('#w-title')
            page.fill('#w-title', 'Chapter 4 — Persistent Draft')
            page.fill('#w-instructions', 'Keep this instruction safe across tabs.')
            page.fill('#w-forbidden', 'Kael')
            page.click('[data-view="characters"]')
            page.wait_for_selector('#char-new-btn')
            page.click('[data-view="write"]')
            page.wait_for_selector('#w-title')
            assert page.input_value('#w-title') == 'Chapter 4 — Persistent Draft'
            assert page.input_value('#w-instructions') == 'Keep this instruction safe across tabs.'
            assert page.input_value('#w-forbidden') == 'Kael'

            # --- TEST 6: Quarantine workflow (forbidden cast + truncation preserves paid text) ---
            mock_state['mode'] = 'quarantine_leak'
            # Disable author preflight so only 1 mocked prose call happens
            page.evaluate("async () => { const {saveAuthorBrain} = await import('/js/authorBrain.js'); await saveAuthorBrain({ prepEnabled: false }); }")
            page.fill('#w-onscreen-cast', 'Levi, Erwin')
            page.click('#w-generate-btn')
            page.wait_for_selector('#w-review-text')

            quarantine_text = page.locator('#w-quarantine-slot').inner_text()
            assert 'Kael' in quarantine_text, 'Quarantine warning did not list forbidden name Kael'
            assert 'truncada' in quarantine_text.lower(), 'Quarantine warning did not note truncation'
            assert page.locator('#w-approve-btn').is_disabled(), 'Approve button must be locked while forbidden name remains'
            staged_val = page.input_value('#w-review-text')
            assert 'Kael' in staged_val and len(staged_val) > 80

            cleaned_text = staged_val.replace('Kael', 'the scout')
            page.fill('#w-review-text', cleaned_text)
            assert not page.locator('#w-approve-btn').is_disabled(), 'Approve button did not unlock after cleaning forbidden name'
            page.click('#w-approve-btn')
            page.wait_for_selector('#w-finish-btn')

            # --- TEST 7: Workspace-switch race during async memory extraction ---
            mock_state['mode'] = 'memory_json'
            race_res = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const { generateContinuityMemory } = await import('/js/memoryEngine.js');
              db.setActiveProjectId('original');
              const ch = await db.get('chapters', 'ch-1');
              const promise = generateContinuityMemory(ch);
              // Immediately switch workspace mid-flight!
              db.setActiveProjectId('story-b');
              const result = await promise;
              const origMems = await db.getAll('memoryEntries', { projectId: 'original' });
              const bMems = await db.getAll('memoryEntries', { projectId: 'story-b' });
              db.setActiveProjectId('original');
              return {
                ok: result.ok,
                origHasCh1: origMems.some(m => m.chapterId === 'ch-1' && m.physicalState.includes('shoulder')),
                bCount: bMems.length,
              };
            }''')
            assert race_res['ok'] and race_res['origHasCh1'] and race_res['bCount'] == 0, f'Workspace race failed: {race_res}'

            # --- TEST 8: Stored-XSS protection & PDF.js CSP compatibility ---
            xss_res = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const payload = 'bad"><img src=x onerror="window.__xss=1">';
              db.setActiveProjectId('story-b');
              await db.put('chapters', { id: payload, title: payload, content: 'Safe text', wordCount: 2, order: 0 });
              await db.put('characters', { id: payload + 'c', name: payload, pronouns: payload, personality: payload, active: true });
              await db.put('documents', { id: payload + 'd', filename: payload, type: 'CANON', priority: 50, inclusion: 'SMART', wordCount: 5, active: true });
              await db.put('lockedFacts', { id: payload + 'f', text: payload, isCore: false });
              await db.put('canonNotes', { id: payload + 'n', text: payload, visibility: 'private' });
              await db.put('memoryEntries', { id: payload + 'm', chapterId: payload, chapterTitle: payload, events: payload, createdAt: new Date().toISOString() });
              return true;
            }''')
            assert xss_res
            for tab in ['chapters', 'characters', 'documents', 'memory', 'settings']:
                page.click(f'[data-view="{tab}"]')
                page.wait_for_timeout(120)
            xss_flag = page.evaluate('window.__xss === undefined')
            assert xss_flag, 'Stored XSS executed!'

            # Verify PDF.js CDN script loads cleanly under CSP
            page.click('[data-view="documents"]')
            page.set_input_files('#doc-upload-input', {
                'name': 'sample.pdf',
                'mimeType': 'application/pdf',
                'buffer': b'%PDF-1.4 mock',
            })
            page.wait_for_function("() => (document.querySelector('#doc-list')?.innerText || '').includes('sample.pdf')")

            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP violations detected: {csp_errs}'
            ctx.close()
            browser.close()
            print('PASS: all Phase 0 + follow-up browser integration checks passed.')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
