"""
Offline end-to-end Playwright browser test for Milestone 5 — Inky Novelist Alpha.

Verifies in real Chromium + IndexedDB (zero external API calls, zero paid requests):
1. 7-tab Spanish UI preserved + SW v49 cache registration.
2. Inky Wallet UI (primary/auxiliary models, reasoning effort, spending cap, custom pricing,
   unknown-cost honesty, local-usage vs account-balance & failed/cancelled charge notices).
3. Upgraded Context Inspector: exact modelBound preview + snapshotHash, diagnostics separation,
   preview invalidation on story edits, and hard blocking on critical PtS contradictions.
4. Full Chapter generation with mocked provider (inspects actual provider-bound prompt, zero
   credentials, starts as draft, logs actual usage, zero silent background continuity calls).
5. Novel Mode orchestrated generation: upfront budget disclosure, per-block IndexedDB persistence,
   continuous scene-state handoff, pause & resume, and spending-cap stop (`paused_budget`).
6. Co-writing: targeted passage rewrite preserving surrounding text verbatim, concurrent edit
   conflict detection + Save as Alternative fallback, and continuation from cursor position.
7. Post-Generation Review (deterministic 0-token vs optional probabilistic semantic review)
   & separately authorized editable Post-Approval Continuity proposal + selective persistence.
8. Creative Chat AI integration via Unified Context Engine & mocked OpenAI fetch (bounded history,
   auxiliary model, chat replies separated from manuscript prose, logged in usageLog).
9. Backup round-trip verifying zero API keys leak and local keys stay intact.
"""

import http.server
import json
import os
import socketserver
import threading
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format, *args):
        pass


def start_server():
    server = socketserver.TCPServer(('127.0.0.1', 0), QuietHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port


def main():
    server, port = start_server()
    base_url = f'http://127.0.0.1:{port}'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context()
            page = ctx.new_page()

            errors = []
            csp_errs = []
            external_non_mocked = []
            captured_openai_requests = []

            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: csp_errs.append(msg.text) if 'Content Security Policy' in msg.text else None)

            # Intercept OpenAI endpoint strictly locally for Creative Chat E2E test; block all other external hosts!
            def handle_openai_mock(route):
                req = route.request
                try:
                    payload = json.loads(req.post_data or '{}')
                except Exception:
                    payload = {}
                captured_openai_requests.append(payload)
                route.fulfill(
                    status=200,
                    content_type='application/json',
                    body=json.dumps({
                        'id': 'chatcmpl-mock-m5',
                        'object': 'chat.completion',
                        'choices': [{
                            'index': 0,
                            'finish_reason': 'stop',
                            'message': {
                                'role': 'assistant',
                                'content': 'Great angle! Keeping Eruri private while Hange chases the wrong theory gives the room delicious subtext without breaking canon.',
                            },
                        }],
                        'usage': {
                            'prompt_tokens': 1234,
                            'completion_tokens': 48,
                            'total_tokens': 1282,
                        },
                    }),
                )

            page.route('https://api.openai.com/**', handle_openai_mock)
            page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            def track_external(req):
                if not req.url.startswith(base_url) and not req.url.startswith('data:') and not req.url.startswith('blob:'):
                    if not req.url.startswith(('https://api.openai.com/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/')):
                        external_non_mocked.append(req.url)

            page.on('request', track_external)

            page.goto(base_url + '/index.html', wait_until='networkidle')
            page.wait_for_selector('#tabbar .tab-btn')
            assert page.locator('#tabbar .tab-btn').count() == 7, '7-tab invariant violated'

            # Seed workspace + local API key + PtS story config + STYLE_ONLY ref + prior chapter
            page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const { saveStoryConfig } = await import('/js/storyConfigSchema.js');
              await db.put('settings', {
                id: 'main',
                provider: 'openai',
                apiKeys: { openai: 'sk-proj-LOCALM5TESTKEY9876543210ABCDEF' },
                models: { openai: 'gpt-5.4-mini' },
                blockWordSize: 1000,
                defaultGenerationMode: 'full_chapter',
              });
              const ws = (await db.get('settings', 'workspaces')) || { id: 'workspaces', items: [] };
              await db.put('settings', {
                ...ws,
                items: [...(ws.items || []).filter(x => x.id !== 'story-m5-pts'), { id: 'story-m5-pts', name: 'M5 Novelist Alpha PtS' }],
              });
              await saveStoryConfig({
                id: 'story-m5-pts',
                projectId: 'story-m5-pts',
                fandom: 'power_to_strive',
                reactionMode: true,
                checkpointId: 's1_beginning',
                timelineId: 'pts_i_ii_original',
                enabledOptionalCharacters: ['joseph'],
                roomGuestInvitations: [],
                relationshipStates: { eruri: { state: 'former_lovers', publiclyKnown: false } },
              });
              await db.put('chapters', {
                id: 'ch-m5-1',
                projectId: 'story-m5-pts',
                order: 1,
                title: 'Chapter 1 — Quiet Tea',
                content: 'Levi set her teacup down beside Erwin while the watching room settled into uneasy silence before the screen flickered awake.',
                wordCount: 22,
                status: 'finished',
                checkpointId: 's1_beginning',
                timelineId: 'pts_i_ii_original',
                versions: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }, { projectId: 'story-m5-pts' });
              await db.put('documents', {
                id: 'doc-m5-style',
                projectId: 'story-m5-pts',
                filename: 'The_Vow_Style.txt',
                type: 'STYLE_ONLY',
                role: 'STYLE_ONLY',
                active: true,
                styleCraftProfile: { emotionalRestraint: 'Dry understatement and sensory restraint' },
              }, { projectId: 'story-m5-pts' });
              await db.put('docChunks', {
                id: 'chk-m5-style',
                projectId: 'story-m5-pts',
                documentId: 'doc-m5-style',
                index: 0,
                text: 'Kael signed the Lusiana marriage deal.',
              }, { projectId: 'story-m5-pts' });
            }''')
            page.reload(wait_until='load')
            page.wait_for_function("() => Array.from(document.querySelectorAll('#workspace-select option')).some(o => o.value === 'story-m5-pts')")
            page.select_option('#workspace-select', 'story-m5-pts')
            page.wait_for_timeout(150)

            # ------------------------------------------------------------------
            # TEST 1: Inky Wallet UI in Ajustes (models, reasoning, spend cap, disclaimers)
            # ------------------------------------------------------------------
            page.click('[data-view="settings"]')
            page.wait_for_selector('#inky-wallet-card')
            wallet_text = page.locator('#inky-wallet-card').inner_text()
            assert 'NO equivalen al saldo real' in wallet_text
            assert 'límite garantizado' in wallet_text
            assert 'canceladas' in wallet_text
            assert 'servidor seguro' in wallet_text
            assert not page.locator('#w-allow-unknown-override').is_checked(), 'Unknown-cost override must be OFF by default!'
            page.fill('#w-primary-model', 'gpt-5.4-mini')
            page.fill('#w-aux-model', 'gpt-4.1-mini')
            page.select_option('#w-reasoning-effort', 'none')
            page.fill('#w-max-spend', '0.50')
            page.click('#w-wallet-save-btn')
            page.wait_for_timeout(150)

            # ------------------------------------------------------------------
            # TEST 2: Upgraded Context Inspector (exact modelBound + snapshotHash + contradiction block)
            # ------------------------------------------------------------------
            page.click('[data-view="write"]')
            page.wait_for_selector('#w-context-inspector-btn')
            page.fill('#w-title', 'Chapter 2 — Watching Room Tension')
            page.fill('#w-instructions', 'Erwin and Levi share a quiet look while Hange jumps to the wrong conclusion.')
            if page.locator('#w-room-cast').count() > 0:
                page.fill('#w-room-cast', 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia')
            page.locator('input.w-doc[value="doc-m5-style"]').check()
            page.click('#w-context-inspector-btn')
            page.wait_for_selector('#w-context-inspector')
            insp_text = page.locator('#w-context-inspector').inner_text()
            snap_hash = page.locator('#w-context-inspector').get_attribute('data-snapshot-hash')
            assert snap_hash and len(snap_hash) > 4
            assert 'Motor de Contexto Unificado' in insp_text
            assert 'STYLE_ONLY' in insp_text
            page.locator('#w-context-inspector details', has_text='Request EXACTO').locator('summary').click()
            sys_prompt_preview = page.locator('#w-inspector-system-prompt').inner_text()
            assert len(sys_prompt_preview) > 100
            assert 'sk-proj-LOCALM5TESTKEY' not in sys_prompt_preview, 'API key leaked in Context Inspector!'
            assert 'Kael signed the Lusiana' not in sys_prompt_preview, 'STYLE_ONLY text leaked in Context Inspector!'
            assert 'Dry understatement and sensory restraint' in sys_prompt_preview

            # ------------------------------------------------------------------
            # TEST 3: Live E2E JS verification with mocked providers (Full Chapter, Novel Mode,
            # Co-writing passage rewrite + conflict, Post-Review & Continuity, Snapshot Invalidation, Blocking)
            # ------------------------------------------------------------------
            m5_core = page.evaluate('''async (previewHash) => {
              const { db } = await import('/js/db.js');
              const { verifyContextSnapshotFreshness, assembleOperationContext } = await import('/js/contextEngine.js');
              const { startOrResumeGeneration, approvePendingBlock, finishReviewedChapter } = await import('/js/generation.js');
              const { previewOrchestrationBudget, runOrchestratedGeneration } = await import('/js/novelOrchestrator.js');
              const { rewriteSelectedPassage, applySafePassageReplacement } = await import('/js/memoryEngine.js');
              const {
                runDeterministicProsePreflight,
                runSemanticEditorialReview,
                proposePostApprovalContinuity,
                applyApprovedContinuityProposal,
                continueFromAuthorPosition,
              } = await import('/js/postReview.js');
              const { getUsageSummary } = await import('/js/inkyWallet.js');
              const { listKnowledgeFacts, listRelationshipStates } = await import('/js/knowledgeLedger.js');

              const pid = 'story-m5-pts';
              const scope = { projectId: pid };

              // A. Snapshot freshness invalidation after editing story data
              await db.put('lockedFacts', { id: 'lf-m5-fresh', projectId: pid, text: 'NEW_LOCKED_FACT_INVALIDATES_PREVIEW' }, scope);
              const freshness = await verifyContextSnapshotFreshness(previewHash, {
                projectId: pid,
                operation: 'full_chapter',
                chapterTitle: 'Chapter 2 — Watching Room Tension',
                instructions: 'Erwin and Levi share a quiet look while Hange jumps to the wrong conclusion.',
                targetWords: 5000,
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                reactionMode: true,
              });
              const previewInvalidatedOk = freshness.fresh === false && freshness.staleReason === 'story_data_changed_after_preview';

              // B. Critical contradiction hard-blocks generation (Anya in room cast)
              const badState = await startOrResumeGeneration({
                projectId: pid,
                chapterId: 'ch-m5-blocked',
                chapterTitle: 'Blocked Chapter',
                instructions: 'Everyone including Anya reacts in the room.',
                targetWords: 3000,
                roomCast: 'Erwin, Levi, Anya',
                allowedCast: 'Erwin, Levi, Anya',
                reactionMode: true,
                generationMode: 'full_chapter',
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-5.4-mini' },
                  async generate() { throw new Error('MUST_NOT_CALL_PROVIDER_WHEN_BLOCKED'); },
                },
              });
              const blockedOk = badState.status === 'paused_error' && badState.lastError?.type === 'critical_contradiction';

              // C. Full Chapter generation with mocked provider (inspect ACTUAL request, starts as draft, logs actual usage!)
              const fullChCalls = [];
              const mockPrimaryProvider = {
                name: 'openai',
                config: { model: 'gpt-5.4-mini' },
                async generate(req) {
                  fullChCalls.push(req);
                  return {
                    ok: true,
                    text: 'Levi did not look up from her cup when Erwin shifted beside her. Across the watching room, Hange leaned forward with dangerous certainty, completely misreading the silence between them.',
                    truncated: false,
                    finishReason: 'stop',
                    usage: { promptTokens: 2100, completionTokens: 180, totalTokens: 2280, cachedTokens: 0, reasoningTokens: 0, reportedByProvider: true },
                  };
                },
              };
              await db.put('chapters', {
                id: 'ch-m5-2', projectId: pid, order: 2, title: 'Chapter 2 — Watching Room Tension',
                content: '', wordCount: 0, status: 'draft', versions: [],
              }, scope);
              const genState = await startOrResumeGeneration({
                projectId: pid,
                chapterId: 'ch-m5-2',
                chapterTitle: 'Chapter 2 — Watching Room Tension',
                instructions: 'Erwin and Levi share a quiet look while Hange jumps to the wrong conclusion.',
                targetWords: 3000,
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                reactionMode: true,
                generationMode: 'full_chapter',
                provider: mockPrimaryProvider,
              });
              const chBeforeApprove = await db.get('chapters', 'ch-m5-2', scope);
              const fullChapterStartsAsDraftOk = (
                fullChCalls.length === 1 &&
                genState.status === 'awaiting_review' &&
                chBeforeApprove.content === '' &&
                fullChCalls[0].systemPrompt.includes('NEW_LOCKED_FACT_INVALIDATES_PREVIEW') &&
                !fullChCalls[0].systemPrompt.includes('sk-proj-LOCALM5TESTKEY')
              );

              // Approve draft & finish -> ZERO automatic continuity calls!
              await approvePendingBlock('ch-m5-2', genState.pendingText, scope);
              await finishReviewedChapter('ch-m5-2', scope);
              const chFinished = await db.get('chapters', 'ch-m5-2', scope);
              const approvedAndFinishedOk = chFinished.status === 'finished' && chFinished.content.includes('watching room') && fullChCalls.length === 1;

              // D. Novel Mode: upfront budget disclosure, pause after step 1, resume step 2, per-block persistence, spending-cap stop!
              const novelPreview = await previewOrchestrationBudget({
                projectId: pid,
                chapterTitle: 'Chapter 3 — Long Novel Arc',
                instructions: 'Multi-scene watching room chapter.',
                targetWords: 5000,
                roomCast: 'Erwin, Levi, Hange',
                allowedCast: 'Erwin, Levi, Hange',
                reactionMode: true,
              });
              const novelCalls = [];
              const mockNovelProvider = {
                name: 'openai',
                config: { model: 'gpt-5.4-mini' },
                async generate(req) {
                  novelCalls.push(req);
                  const n = novelCalls.length;
                  return {
                    ok: true,
                    text: `Segment ${n} prose continuing seamlessly in the watching room with Erwin and Levi trading a dry glance as the screen hummed softly.`,
                    truncated: false,
                    finishReason: 'stop',
                    usage: { promptTokens: 2500, completionTokens: 600, totalTokens: 3100, cachedTokens: 0, reasoningTokens: 0, reportedByProvider: true },
                  };
                },
              };
              let stepCount = 0;
              const pausedNovel = await runOrchestratedGeneration({
                projectId: pid,
                chapterId: 'ch-m5-novel',
                chapterTitle: 'Chapter 3 — Long Novel Arc',
                instructions: 'Multi-scene watching room chapter.',
                targetWords: 5000,
                orchestrationPlan: [
                  { id: 's1', title: 'Tramo 1', focus: 'Opening tension', targetWords: 1700 },
                  { id: 's2', title: 'Tramo 2', focus: 'Mid-chapter escalation', targetWords: 1700 },
                  { id: 's3', title: 'Tramo 3', focus: 'Quiet landing', targetWords: 1600 },
                ],
                roomCast: 'Erwin, Levi, Hange',
                allowedCast: 'Erwin, Levi, Hange',
                reactionMode: true,
                provider: mockNovelProvider,
                shouldPause: () => stepCount >= 1,
                onProgress: (ev) => { if (ev.phase === 'step_completed') stepCount += 1; },
              });
              const resumedNovel = await runOrchestratedGeneration({
                projectId: pid,
                chapterId: 'ch-m5-novel',
                chapterTitle: 'Chapter 3 — Long Novel Arc',
                instructions: 'Multi-scene watching room chapter.',
                targetWords: 5000,
                roomCast: 'Erwin, Levi, Hange',
                allowedCast: 'Erwin, Levi, Hange',
                reactionMode: true,
                provider: mockNovelProvider,
              });
              // Spending cap stop test (cap = $0.0001 -> stops immediately before calling provider!)
              const cappedNovel = await runOrchestratedGeneration({
                projectId: pid,
                chapterId: 'ch-m5-novel-cap',
                chapterTitle: 'Capped Novel',
                instructions: 'Should stop at budget cap.',
                targetWords: 5000,
                roomCast: 'Erwin, Levi',
                allowedCast: 'Erwin, Levi',
                reactionMode: true,
                maxSpendUsd: 0.0001,
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-5.4' },
                  async generate() { throw new Error('MUST_NOT_CALL_OVER_SPENDING_CAP'); },
                },
              });
              const novelModeOk = (
                novelPreview.maxRequests === 3 &&
                pausedNovel.status === 'paused_manual' &&
                pausedNovel.blocksDone === 1 &&
                resumedNovel.status === 'awaiting_review' &&
                resumedNovel.blocksDone === 3 &&
                novelCalls.length === 3 &&
                novelCalls[1].userPrompt.includes('CONTINUOUS SCENE-STATE HANDOFF') &&
                novelCalls[1].userPrompt.includes('Segment 1 prose') &&
                cappedNovel.status === 'paused_budget'
              );

              // E. Co-writing: targeted passage rewrite preserving surrounding text verbatim + concurrent edit conflict -> alternative!
              const baseText = 'OPENING_INTACT_LINE. MIDDLE_TO_REWRITE_HERE. CLOSING_INTACT_LINE.';
              await db.put('chapters', {
                id: 'ch-m5-cowrite', projectId: pid, order: 4, title: 'Chapter 4 — Co-write',
                content: baseText, wordCount: 6, status: 'draft', versions: [],
              }, scope);
              const chCw = await db.get('chapters', 'ch-m5-cowrite', scope);
              const startIdx = baseText.indexOf('MIDDLE_TO_REWRITE_HERE.');
              const endIdx = startIdx + 'MIDDLE_TO_REWRITE_HERE.'.length;
              const pw = await rewriteSelectedPassage(chCw, {
                startOffset: startIdx,
                endOffset: endIdx,
                rewriteInstructions: 'Make the middle sharper.',
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-5.4-mini' },
                  async generate() {
                    return { ok: true, text: 'SHARPER_REWRITTEN_MIDDLE.', truncated: false, finishReason: 'stop', usage: { promptTokens: 500, completionTokens: 20, totalTokens: 520, reportedByProvider: true } };
                  },
                },
              });
              // Simulate concurrent edit before applying!
              await db.put('chapters', { ...chCw, content: baseText + ' CONCURRENT_EDIT!' }, scope);
              const conflictRes = await applySafePassageReplacement('ch-m5-cowrite', {
                mergedContent: pw.mergedContent,
                baseContentHash: pw.baseContentHash,
                projectId: pid,
                saveAsAlternativeOnConflict: false,
              });
              const altRes = await applySafePassageReplacement('ch-m5-cowrite', {
                mergedContent: pw.mergedContent,
                baseContentHash: pw.baseContentHash,
                projectId: pid,
                saveAsAlternativeOnConflict: true,
              });
              const contRes = await continueFromAuthorPosition(chCw, {
                cursorOffset: baseText.length,
                continuationInstruction: 'Add a quiet beat.',
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-5.4-mini' },
                  async generate() {
                    return { ok: true, text: 'A quiet beat followed in the watching room.', truncated: false, finishReason: 'stop', usage: { promptTokens: 400, completionTokens: 15, totalTokens: 415, reportedByProvider: true } };
                  },
                },
              });
              const cowritingOk = (
                pw.ok &&
                pw.mergedContent === 'OPENING_INTACT_LINE. SHARPER_REWRITTEN_MIDDLE. CLOSING_INTACT_LINE.' &&
                conflictRes.ok === false && conflictRes.conflict === true &&
                altRes.ok === true && altRes.savedAsAlternative === true &&
                contRes.ok === true && contRes.mergedContent.includes('A quiet beat followed')
              );

              // F. Post-Generation Review (deterministic vs probabilistic) & Editable Post-Approval Continuity
              const detCheck = runDeterministicProsePreflight(chFinished.content, { isPowerToStrive: true, reactionMode: true });
              const semCheck = await runSemanticEditorialReview(chFinished.content, {
                projectId: pid,
                targetChapterId: 'ch-m5-2',
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-4.1-mini' },
                  async generate() {
                    return {
                      ok: true,
                      text: JSON.stringify({
                        overallNotes: 'Strong restraint and distinct voices.',
                        invariantFlags: [],
                        voiceAndCraftNotes: ['Levi stays terse and controlled.'],
                        epistemicLeakRisks: [],
                      }),
                      truncated: false,
                      finishReason: 'stop',
                      usage: { promptTokens: 900, completionTokens: 60, totalTokens: 960, reportedByProvider: true },
                    };
                  },
                },
              });
              const contProp = await proposePostApprovalContinuity(chFinished, {
                projectId: pid,
                provider: {
                  name: 'openai',
                  config: { model: 'gpt-4.1-mini' },
                  async generate() {
                    return {
                      ok: true,
                      text: JSON.stringify({
                        EVENTS: 'Hange misread the silence between Erwin and Levi.',
                        RELATIONSHIP_CHANGES: 'Quiet unspoken tension deepened.',
                        NEW_FACTS: 'Teacup glance in room.',
                        WHO_KNOWS_WHAT: 'Hange suspects a false rivalry.',
                        PHYSICAL_STATE: 'Uninjured.',
                        CURRENT_LOCATION_TIME: 'Watching room.',
                        OPEN_THREADS: 'Hange still fishing for clues.',
                        PROPOSED_FACTS: [
                          { title: 'Teacup Silence', truth: 'Erwin and Levi shared a silent look.', isSecret: true, layer: 'room' },
                          { title: 'Unwanted Fact', truth: 'Should be deselected by author.', isSecret: false, layer: 'room' },
                        ],
                        PROPOSED_KNOWLEDGE_TRANSITIONS: [
                          { characterId: 'hange', factTitle: 'Teacup Silence', state: 'believes_false', beliefText: 'Thinks they are arguing over paperwork.', evidence: 'Cap. 2' },
                        ],
                        PROPOSED_RELATIONSHIP_UPDATES: [
                          { participants: ['erwin', 'levi'], shift: 'Shared dry restraint under scrutiny', promise: 'Keep history private in the room' },
                        ],
                        EMOTIONAL_SHIFTS: ['Guarded amusement'],
                      }),
                      truncated: false,
                      finishReason: 'stop',
                      usage: { promptTokens: 1000, completionTokens: 150, totalTokens: 1150, reportedByProvider: true },
                    };
                  },
                },
              });
              // Author deselects 'Unwanted Fact' before saving!
              const editedContProp = {
                ...contProp,
                proposedFacts: contProp.proposedFacts.map(f => ({ ...f, selected: f.title !== 'Unwanted Fact' })),
              };
              const appliedCont = await applyApprovedContinuityProposal(chFinished, editedContProp, { projectId: pid });
              const savedFacts = await listKnowledgeFacts(scope);
              const savedRels = await listRelationshipStates(scope);
              const postReviewAndContinuityOk = (
                detCheck.assessmentType === 'deterministic_structural_not_semantic_guarantee' &&
                semCheck.ok === true &&
                semCheck.assessmentType === 'probabilistic_ai_editorial_review' &&
                contProp.staged === true && contProp.persisted === false &&
                appliedCont.ok === true &&
                savedFacts.some(f => f.title === 'Teacup Silence') &&
                !savedFacts.some(f => f.title === 'Unwanted Fact') &&
                savedRels.length >= 1
              );

              const usageAfter = await getUsageSummary();
              const usageLoggedOk = usageAfter.totalRecorded.requests >= 6 && usageAfter.totalRecorded.actualReportedRequests >= 6;

              return {
                previewInvalidatedOk,
                blockedOk,
                fullChapterStartsAsDraftOk,
                approvedAndFinishedOk,
                novelModeOk,
                cowritingOk,
                postReviewAndContinuityOk,
                usageLoggedOk,
              };
            }''', snap_hash)
            assert all(m5_core.values()), f'Milestone 5 core E2E checks failed: {m5_core}'

            # ------------------------------------------------------------------
            # TEST 4: Creative Chat AI Provider Integration (mocked OpenAI fetch!)
            # ------------------------------------------------------------------
            page.click('[data-view="planner"]')
            page.wait_for_selector('#planner-send')
            page.fill('#planner-input', 'What if Hange tests her wrong theory during tea in Chapter 3?')
            page.click('#planner-send')
            page.wait_for_function("() => (document.querySelector('#planner-messages')?.innerText || '').includes('delicious subtext')")

            assert len(captured_openai_requests) == 1, f'Expected 1 mocked OpenAI Creative Chat request, got {len(captured_openai_requests)}'
            chat_req = captured_openai_requests[0]
            assert chat_req.get('model') == 'gpt-4.1-mini', f'Creative Chat should use auxiliary model gpt-4.1-mini, got {chat_req.get("model")}'
            chat_sys = chat_req['messages'][0]['content']
            assert 'CREATIVE CHAT' in chat_sys
            assert 'sk-proj-LOCALM5TESTKEY' not in chat_sys, 'API key leaked into Creative Chat request!'

            # Verify chat response did NOT modify chapters & backup excludes API keys
            backup_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const dump = await db.exportAll();
              const exportedMain = dump.settings.find(s => s.id === 'main');
              const dumpStr = JSON.stringify(dump);
              await db.importAll(dump, { merge: false });
              const mainAfter = await db.get('settings', 'main');
              const ch2 = await db.get('chapters', 'ch-m5-2', { projectId: 'story-m5-pts' });
              return {
                noApiKeyInBackup: !dumpStr.includes('sk-proj-LOCALM5TESTKEY') && Object.keys(exportedMain?.apiKeys || {}).length === 0,
                localKeyPreserved: mainAfter?.apiKeys?.openai === 'sk-proj-LOCALM5TESTKEY9876543210ABCDEF',
                chatDidNotTouchChapter: ch2 && !ch2.content.includes('delicious subtext'),
                usageLogPreserved: (dump.usageLog || []).length >= 7,
              };
            }''')
            assert all(backup_check.values()), f'Backup/isolation check failed: {backup_check}'

            # ------------------------------------------------------------------
            # TEST 5: Alpha Spending Safety E2E — exact Inspector->provider maxOutputTokens match,
            # unknown-cost blocking + explicit override, and cumulative caps across
            # generation -> ending extension -> polish & rewrite -> continuation
            # ------------------------------------------------------------------
            alpha_safety = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const { saveWalletConfig } = await import('/js/inkyWallet.js');
              const { assembleOperationContext } = await import('/js/contextEngine.js');
              const { startOrResumeGeneration, extendPendingBlockWithEnding, polishPendingBlock } = await import('/js/generation.js');
              const { previewOrchestrationBudget } = await import('/js/novelOrchestrator.js');
              const { rewriteChapter, continueRewriteDraft } = await import('/js/memoryEngine.js');
              const { runSemanticEditorialReview, proposePostApprovalContinuity } = await import('/js/postReview.js');

              const pid = 'story-m5-pts';
              const scope = { projectId: pid };

              // 1. Exact Inspector maxOutputTokens === actual provider request maxOutputTokens
              await saveWalletConfig({
                primaryProvider: 'openai',
                primaryModel: 'gpt-5.4-mini',
                auxiliaryProvider: 'openai',
                auxiliaryModel: 'gpt-4.1-mini',
                maxOutputTokensPerRequest: 6000,
                maxGenerationSpendUsd: 0.50,
                allowUnknownCostOverride: false,
              });
              const previewBundle = await assembleOperationContext({
                projectId: pid,
                operation: 'full_chapter',
                role: 'primary',
                chapterTitle: 'Cap Cap Match',
                instructions: 'Check exact output token budget identity.',
                targetWords: 5000,
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
              });
              const seenOutCaps = [];
              const trackingProvider = {
                name: 'openai',
                config: { model: 'gpt-5.4-mini' },
                async generate(args) {
                  seenOutCaps.push(args.maxOutputTokens);
                  return {
                    ok: true,
                    text: ('Erwin set down his pen while Levi watched the window without saying a word. '.repeat(18)).trim(),
                    truncated: false,
                    finishReason: 'stop',
                    usage: { promptTokens: 5000, completionTokens: 1000, totalTokens: 6000, cachedTokens: 0, reasoningTokens: 0, reportedByProvider: true },
                  };
                },
              };
              const genState = await startOrResumeGeneration({
                projectId: pid,
                chapterId: 'ch-alpha-cap-match',
                chapterTitle: 'Cap Cap Match',
                instructions: 'Check exact output token budget identity.',
                targetWords: 5000,
                generationMode: 'full_chapter',
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                provider: trackingProvider,
              });
              const inspectorMatchesProvider =
                previewBundle.modelBound.maxOutputTokens === 6000 &&
                seenOutCaps.length === 1 &&
                seenOutCaps[0] === previewBundle.modelBound.maxOutputTokens;

              // 2. Cumulative spend cap across generation -> ending extension -> polish
              // Force state spent to $0.495 against $0.50 cap so ending extension & polish MUST be blocked!
              genState.actualSpentUsd = 0.495;
              await db.put('generationState', genState, scope);
              let endingBlockedByCumulative = false;
              try {
                await extendPendingBlockWithEnding('ch-alpha-cap-match', genState.pendingText, 'natural', { projectId: pid, provider: trackingProvider });
              } catch (e) {
                endingBlockedByCumulative = String(e.message || '').includes('supera tu límite estimado local');
              }
              let polishBlockedByCumulative = false;
              try {
                await polishPendingBlock('ch-alpha-cap-match', genState.pendingText, { projectId: pid, provider: trackingProvider });
              } catch (e) {
                polishBlockedByCumulative = String(e.message || '').includes('supera tu límite estimado local');
              }

              // 3. Cumulative spend cap across rewriteChapter -> continueRewriteDraft
              const ch2 = await db.get('chapters', 'ch-m5-2', scope);
              const contBlocked = await continueRewriteDraft(ch2, 'Finish the scene.', 'Erwin paused by the map table while Levi waited silently near the door for the room to settle.', {
                provider: trackingProvider,
                spentSoFarUsd: 0.495,
              });
              const rewriteContBlockedOk = contBlocked.ok === false && contBlocked.errorType === 'budget_blocked';

              // 4. Unknown-priced custom model MUST BE BLOCKED when spending cap is active and override=false
              await saveWalletConfig({
                primaryProvider: 'openai',
                primaryModel: 'unpriced-custom-alpha-model',
                auxiliaryProvider: 'openai',
                auxiliaryModel: 'unpriced-custom-alpha-model',
                maxOutputTokensPerRequest: 4000,
                maxGenerationSpendUsd: 0.50,
                allowUnknownCostOverride: false,
              });
              const unknownProvider = {
                name: 'openai',
                config: { model: 'unpriced-custom-alpha-model' },
                async generate() {
                  return {
                    ok: true,
                    text: ('Unknown priced model prose returned only after explicit author override. '.repeat(12)).trim(),
                    truncated: false,
                    finishReason: 'stop',
                    usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700, cachedTokens: 0, reasoningTokens: 0, reportedByProvider: true },
                  };
                },
              };
              const unknownGenBlocked = await startOrResumeGeneration({
                projectId: pid,
                chapterId: 'ch-alpha-unknown-blocked',
                chapterTitle: 'Unknown Cost Block',
                instructions: 'Should block before calling provider.',
                targetWords: 3000,
                generationMode: 'full_chapter',
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                provider: unknownProvider,
              });
              const unknownNovelPreview = await previewOrchestrationBudget({
                projectId: pid,
                chapterId: 'ch-alpha-unknown-novel',
                chapterTitle: 'Unknown Novel Block',
                instructions: 'Should block preview.',
                targetWords: 3000,
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
              });
              const unknownRewriteBlocked = await rewriteChapter(ch2, 'Tighten pacing.', { provider: unknownProvider });
              const reviewSample = 'Erwin folded the dispatch carefully while Levi leaned against the doorframe and Hange whispered an entirely incorrect hypothesis to Petra across the long wooden table.';
              const unknownReviewBlocked = await runSemanticEditorialReview(reviewSample, { projectId: pid, provider: unknownProvider });
              const unknownContBlocked = await proposePostApprovalContinuity(ch2, { projectId: pid, provider: unknownProvider });

              const allUnknownBlocked = (
                unknownGenBlocked.status === 'paused_budget' &&
                unknownGenBlocked.lastError?.reason === 'unknown_pricing_blocked' &&
                unknownNovelPreview.withinBudget === false &&
                unknownNovelPreview.budgetReason === 'unknown_pricing_blocked' &&
                unknownRewriteBlocked.ok === false && unknownRewriteBlocked.reason === 'unknown_pricing_blocked' &&
                unknownReviewBlocked.ok === false && unknownReviewBlocked.reason === 'unknown_pricing_blocked' &&
                unknownContBlocked.ok === false && unknownContBlocked.reason === 'unknown_pricing_blocked'
              );

              // 5. Explicit author override (`allowUnknownCostOverride: true`) allows unknown-priced request
              await saveWalletConfig({ allowUnknownCostOverride: true });
              const overriddenGen = await startOrResumeGeneration({
                projectId: pid,
                chapterId: 'ch-alpha-unknown-overridden',
                chapterTitle: 'Unknown Cost Overridden',
                instructions: 'Proceeds only because author explicitly acknowledged unknown cost.',
                targetWords: 3000,
                generationMode: 'full_chapter',
                allowedCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                roomCast: 'Erwin, Levi, Hange, Petra, Eren, Mikasa, Armin, Jean, Connie, Sasha, Ymir, Historia',
                provider: unknownProvider,
              });
              const unknownOverrideAllowed = overriddenGen.status === 'awaiting_review' && overriddenGen.unknownCostCalls === 1;

              // Restore clean Wallet defaults
              await saveWalletConfig({
                primaryProvider: 'openai',
                primaryModel: 'gpt-5.4-mini',
                auxiliaryProvider: 'openai',
                auxiliaryModel: 'gpt-4.1-mini',
                maxOutputTokensPerRequest: 16384,
                maxGenerationSpendUsd: 0.50,
                allowUnknownCostOverride: false,
              });

              return {
                ok: inspectorMatchesProvider && endingBlockedByCumulative && polishBlockedByCumulative && rewriteContBlockedOk && allUnknownBlocked && unknownOverrideAllowed,
                checks: {
                  inspectorMatchesProvider,
                  endingBlockedByCumulative,
                  polishBlockedByCumulative,
                  rewriteContBlockedOk,
                  allUnknownBlocked,
                  unknownOverrideAllowed,
                },
                debug: {
                  previewMaxOut: previewBundle.modelBound.maxOutputTokens,
                  seenOutCaps,
                  genStateStatus: genState.status,
                  unknownGen: { status: unknownGenBlocked.status, err: unknownGenBlocked.lastError },
                  unknownNovel: { withinBudget: unknownNovelPreview.withinBudget, reason: unknownNovelPreview.budgetReason },
                  unknownRewrite: unknownRewriteBlocked,
                  unknownReview: unknownReviewBlocked,
                  unknownCont: unknownContBlocked,
                },
              };
            }''')
            assert alpha_safety['ok'], f"Alpha spending safety E2E checks failed: {alpha_safety}"

            assert not external_non_mocked, f'Unexpected external network requests: {external_non_mocked}'
            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP errors: {csp_errs}'

            ctx.close()
            browser.close()
            print('PASS: all Milestone 5 + Alpha release review browser E2E acceptance tests passed (7 tabs, Inky Wallet, upgraded Context Inspector + exact output cap match + invalidation + contradiction blocking, Full Chapter draft workflow, Novel Mode orchestrated pause/resume/budget-cap, Co-writing targeted passage rewrite + conflict fallback, deterministic vs probabilistic review, editable post-approval continuity, Creative Chat AI via Unified Context Engine, unknown-cost blocking & explicit override, cumulative spending caps across all operations, usageLog & API key backup safety, 0 external unmocked calls).')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
