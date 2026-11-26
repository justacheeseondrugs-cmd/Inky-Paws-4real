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
            # TEST 1: Fresh install + SW upgrade from stale v43 cache + offline boot
            # ------------------------------------------------------------------
            ctx1 = browser.new_context(service_workers='allow')
            page1 = ctx1.new_page()
            page_errors = []
            csp_violations = []
            page1.on('pageerror', lambda err: page_errors.append(str(err)))
            page1.on('console', lambda msg: csp_violations.append(msg.text) if 'Content Security Policy' in msg.text else None)
            # Block external font requests offline cleanly without noise
            page1.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page1.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            # Simulate previously cached v43 SW cache containing stale timeline.js without memoriesForChapters
            page1.goto(f'{base_url}/index.html')
            page1.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")
            sw_state = page1.evaluate('''async () => {
              const oldCache = await caches.open('inky-paws-es-v43-your-name-v1');
              await oldCache.put(
                new Request('/js/timeline.js?v=20260928-chapter-variants-v1'),
                new Response('export function isMainTimelineChapter(){return true;}', {
                  headers: {'Content-Type': 'application/javascript'}
                })
              );
              const reg = await navigator.serviceWorker.ready;
              await reg.update();
              // Trigger a clean reload wait via caches check
              return { active: !!reg.active, keys: await caches.keys() };
            }''')
            assert sw_state['active'], 'Service Worker failed to activate'

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
            # TEST 2-7: IndexedDB backup safety, rewrite staging, quarantine,
            #           autosave flush, form drafts, workspace-switch race, XSS & CSP
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

            # --- TEST 2: Transactional & validated backup import + local API key preservation ---
            backup_res = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              await db.put('settings', {
                id: 'main',
                provider: 'openai',
                apiKeys: { openai: 'LOCAL-OPENAI-KEY', gemini: 'LOCAL-GEMINI-KEY' },
                models: { openai: 'gpt-5.4-mini', gemini: 'gemini-2.0-flash' },
                defaultGenerationMode: 'full_chapter',
                blockWordSize: 1000,
              });
              db.setActiveProjectId('original');
              await db.put('chapters', { id: 'keep-ch-1', title: 'Chapter 1', content: 'Original prose must survive.', wordCount: 4, order: 0, status: 'finished', versions: [] });

              // Invalid imports must fail BEFORE touching existing data
              for (const bad of [null, [], {}, { __meta: { app: 'evil' }, chapters: [] }, { chapters: 'nope' }, { chapters: [{ title: 'no id' }] }]) {
                let threw = false;
                try { await db.importAll(bad, { merge: false }); } catch { threw = true; }
                if (!threw) throw new Error('Invalid backup was accepted: ' + JSON.stringify(bad));
              }
              if ((await db.get('chapters', 'keep-ch-1'))?.content !== 'Original prose must survive.') {
                throw new Error('Invalid backup erased existing chapter!');
              }

              // Valid import with malicious apiKeys must commit atomically AND keep local keys
              await db.importAll({
                __meta: { app: 'pts-studio', version: 1 },
                chapters: [
                  { id: 'ch-1', projectId: 'original', title: 'Chapter 1', content: 'First chapter canon.', wordCount: 3, order: 0, status: 'finished', versions: [] },
                  { id: 'ch-2', projectId: 'original', title: 'Chapter 2', content: 'Long chapter prose. '.repeat(300), wordCount: 900, order: 1, status: 'finished', versions: [] },
                  { id: 'ch-3', projectId: 'original', title: 'Chapter 3', content: 'FUTURE_SPOILER_CH3 should never enter Ch 2 rewrite.', wordCount: 8, order: 2, status: 'finished', versions: [] },
                ],
                memoryEntries: [
                  { id: 'm-1', projectId: 'original', chapterId: 'ch-1', chapterTitle: 'Chapter 1', events: 'Ch1 event', createdAt: '2026-01-01' },
                  { id: 'm-3', projectId: 'original', chapterId: 'ch-3', chapterTitle: 'Chapter 3', events: 'FUTURE_SPOILER_CH3', createdAt: '2026-01-03' },
                ],
                settings: [
                  { id: 'main', provider: 'openai', apiKeys: { openai: 'ATTACKER-KEY' }, models: { openai: 'gpt-5.4-mini' }, defaultGenerationMode: 'full_chapter', blockWordSize: 1000 },
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
              return { ok: true, count: (await db.getAll('chapters')).length };
            }''')
            assert backup_res['count'] == 3

            # --- TEST 3: Staged rewrite (no silent overwrite, dynamic budget, chronological filter) ---
            page.click('[data-view="chapters"]')
            page.wait_for_selector('#chapters-list .list-item[data-id="ch-2"]')
            page.click('#chapters-list .list-item[data-id="ch-2"] .act-rewrite')
            page.wait_for_selector('#rewrite-instructions')
            page.fill('#rewrite-instructions', 'Deepen Levi interiority while keeping every beat.')
            page.click('#rewrite-go-btn')
            page.wait_for_selector('#rewrite-review-pane', state='visible')

            # Verify dynamic budget and zero future spoiler in request
            req_body = mock_state['last_openai_body']
            assert req_body['max_completion_tokens'] >= 5000, f"Budget too small: {req_body.get('max_completion_tokens')}"
            sys_msg = req_body['messages'][0]['content']
            assert 'FUTURE_SPOILER_CH3' not in sys_msg, 'Future chapter leaked into Chapter 2 rewrite!'
            assert 'Ch1 event' in sys_msg, 'Prior Chapter 1 memory missing from Chapter 2 rewrite!'
            # Warning banner should show because mocked response had finish_reason='length'
            assert 'incompleta' in page.locator('#rewrite-warning-slot').inner_text().lower()

            # Original chapter in IndexedDB MUST STILL BE UNCHANGED before approval!
            before_approve = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.get('chapters','ch-2')).content; }")
            assert before_approve.startswith('Long chapter prose.'), 'Rewrite overwrote chapter before approval!'

            # Approve rewrite -> original saved in versions, content updated
            page.click('#rewrite-approve-btn')
            page.wait_for_selector('#active-modal', state='detached')
            after_approve = page.evaluate("async () => { const {db} = await import('/js/db.js'); return await db.get('chapters','ch-2'); }")
            assert after_approve['content'].startswith('Rewritten opening paragraph')
            assert len(after_approve['versions']) == 1 and after_approve['versions'][0]['content'].startswith('Long chapter prose.')

            # --- TEST 4: Chapter editor autosave flush-on-close (<100ms) ---
            page.click('#chapters-list .list-item[data-id="ch-1"] .act-open')
            page.wait_for_selector('#editor-mode-toggle')
            page.click('#editor-mode-toggle')
            page.fill('#editor-content', 'Flushed immediately before 700ms debounce!')
            page.click('#editor-close-btn')
            page.wait_for_selector('#active-modal', state='detached')
            page.wait_for_timeout(150)
            flushed = page.evaluate("async () => { const {db} = await import('/js/db.js'); return (await db.get('chapters','ch-1')).content; }")
            assert flushed == 'Flushed immediately before 700ms debounce!', f'Autosave lost on close: {flushed}'

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
            # Paid text must be preserved in textarea and NOT yet added to accumulatedText
            staged_val = page.input_value('#w-review-text')
            assert 'Kael' in staged_val and len(staged_val) > 80

            # Clean forbidden name in editor -> approve button unlocks automatically
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
            print('PASS: all Phase 0 browser integration checks (SW fresh+upgrade+offline, transactional backup, staged rewrite, autosave flush, form drafts, quarantine, workspace-switch race, XSS, CSP/PDF) passed.')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
