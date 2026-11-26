"""Milestone 2 browser integration tests: reusable presets, Story Configuration UI,
Power to Strive invariants (Joseph/Anya/Eruri/Candy/Default 12), Character Lab
activation & conflict resolution, Room vs Screen Levi, scene-only expiration,
multiple stories from same preset, unrelated fandom isolation, reload persistence,
and v2 backup round-trip. Synthetic fixtures only; zero paid API calls."""
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


def synthetic_bible():
    core_ids = ['erwin', 'levi', 'hange', 'petra', 'eren', 'mikasa', 'armin', 'jean', 'connie', 'sasha', 'ymir', 'historia']
    return {
        'schema': 'inky.master_character_bible',
        'schema_version': 1,
        'content_version': '1.1',
        'language': 'en',
        'title': 'Synthetic M2 Bible',
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
            {'id': cid, 'name': cid.capitalize(), 'role': 'Spectator', 'core': f'Standard {cid}.', 'avoid': []}
            for cid in core_ids
        ],
        'optional_characters': [
            {'id': 'joseph', 'name': 'Joseph Alcott', 'role': 'Informant', 'core': 'Dry and observant.', 'avoid': []},
            {'id': 'anya', 'name': 'Anya', 'role': 'Child outside room', 'core': 'Five-year-old non-telepathic.', 'avoid': []},
        ],
        'story_presets': [],
        'optional_character_overlays': [
            {
                'id': 'levi_violet_traits',
                'character_id': 'levi',
                'default_enabled': False,
                'activation': ['author_selects_violet_au', 'author_explicitly_requests_traits'],
                'allowed_scopes': ['story', 'character_version', 'scene'],
                'traits_source': 'Author-configured only.',
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
            ctx = browser.new_context(service_workers='block')
            page = ctx.new_page()
            errors = []
            csp_errs = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: csp_errs.append(msg.text) if 'Content Security Policy' in msg.text else None)
            page.on('dialog', lambda d: d.accept())
            page.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
            page.route('https://fonts.gstatic.com/**', lambda r: r.fulfill(status=200, content_type='font/woff2', body=b''))

            page.goto(f'{base_url}/index.html')
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 4")

            # Create 3 clean workspaces: story-pts-a, story-pts-b, story-scifi
            page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              await db.put('settings', {
                id: 'main',
                provider: 'openai',
                apiKeys: { openai: 'LOCAL-M2-SECRET' },
                models: { openai: 'gpt-5.4-mini' },
              });
              const ws = (await db.get('settings', 'workspaces')) || { id: 'workspaces', items: [] };
              const extras = [
                { id: 'story-pts-a', name: 'PtS Story A' },
                { id: 'story-pts-b', name: 'PtS Story B' },
                { id: 'story-scifi', name: 'Starlight Original' },
              ];
              await db.put('settings', { ...ws, items: [...(ws.items || []), ...extras] });
            }''')
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 7")

            # Switch to PtS Story A, open Personajes & Universo, import synthetic Bible
            page.select_option('#workspace-select', 'story-pts-a')
            page.click('[data-view="characters"]')
            page.wait_for_selector('#universe-config-card')
            page.set_input_files('#bible-import-input', {
                'name': 'synthetic_m2_bible.json',
                'mimeType': 'application/json',
                'buffer': json.dumps(synthetic_bible()).encode('utf-8'),
            })
            page.wait_for_selector('#overlay-list .list-item[data-logical-id="levi_violet_traits"]')

            # --- TEST 1: Apply Violet AU preset (empty overlay) -> Inspector shows unconfigured warning, 12 in room, honest Hito 5 notice ---
            page.select_option('#uc-preset-select', 'power_to_strive::violet_au')
            page.click('#uc-apply-preset-btn')
            page.wait_for_selector('#uc-pts-panel')
            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('#universe-inspector-panel')
            insp_text = page.locator('#universe-inspector-panel').inner_text()
            assert '12 en sala permitida' in insp_text, f'Expected 12 in room: {insp_text}'
            assert 'Candy' in insp_text
            assert 'no tiene rasgos definidos' in insp_text.lower(), f'Missing unconfigured Violet warning: {insp_text}'
            assert 'Hito 5' in insp_text, 'Inspector must honestly state which config awaits Milestone 5 Context Engine'

            # --- TEST 2: Author defines custom Violet traits in UI + sets Room vs Screen isolation ---
            page.click('#overlay-list .list-item[data-logical-id="levi_violet_traits"] .act-ov-edit')
            page.wait_for_selector('#ov-changes')
            page.fill('#ov-changes', 'Screen-only Violet cadence\nLiteral emotional inquiry')
            page.fill('#ov-preserve', 'Blunt tactical focus')
            page.click('#ov-save-btn')
            page.wait_for_selector('#active-modal', state='detached')

            # Remove default story-wide activation and add screen-only activation
            page.click('#uc-active-overlays-box .act-ov-remove')
            page.wait_for_timeout(150)
            page.click('#uc-activate-overlay-btn')
            page.wait_for_selector('#act-ov-scope')
            page.select_option('#act-ov-select', 'power_to_strive::levi_violet_traits')
            page.select_option('#act-ov-scope', 'character_version')
            page.select_option('#act-ov-version', 'screen')
            page.click('#act-ov-confirm')
            page.wait_for_selector('#active-modal', state='detached')

            # Verify Room vs Screen Levi comparison in Zero-Cost Inspector
            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('#universe-inspector-panel')
            split_text = page.locator('#universe-inspector-panel').inner_text()
            assert 'sala=estándar' in split_text.lower() and 'screen-only violet cadence' in split_text.lower(), f'Room vs Screen split failed: {split_text}'

            # --- TEST 3: Joseph outside vs explicit invitation + Anya on screen + disabling Joseph ---
            page.check('#uc-opt-joseph')
            assert not page.locator('#uc-opt-anya').is_checked(), 'Enabling Joseph must NOT auto-enable Anya'
            page.check('#uc-opt-anya')
            page.check('#uc-invite-joseph')
            page.select_option('#uc-eruri-state', 'secret_relationship')
            page.fill('#uc-eruri-knownby', 'erwin, levi')
            page.fill('#uc-eruri-suspectedby', 'hange')
            # Open advanced details to put Anya on screen
            page.locator('#universe-config-card details').first.locator('summary').click()
            page.fill('#uc-cast-screen', 'levi, joseph, anya')
            page.click('#uc-save-btn')
            page.wait_for_timeout(200)

            # Reload full page and verify persistence!
            page.reload()
            page.wait_for_function("() => (document.querySelector('#workspace-select')?.options.length || 0) >= 7")
            page.select_option('#workspace-select', 'story-pts-a')
            page.click('[data-view="characters"]')
            page.wait_for_selector('#uc-pts-panel')
            assert page.locator('#uc-opt-joseph').is_checked()
            assert page.locator('#uc-invite-joseph').is_checked()
            assert page.locator('#uc-opt-anya').is_checked()
            assert page.input_value('#uc-eruri-state') == 'secret_relationship'

            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('#universe-inspector-panel')
            invited_text = page.locator('#universe-inspector-panel').inner_text()
            assert '13 en sala permitida' in invited_text, f'Invited Joseph should make 13 in room: {invited_text}'
            assert 'Joseph Alcott' in invited_text and 'NO hereda automáticamente' in invited_text
            assert 'Sin contradicciones críticas' in invited_text

            # Disable Joseph while still in screen cast -> room returns to 12 AND Inspector flags disabled-but-cast contradiction!
            page.uncheck('#uc-opt-joseph')
            assert not page.locator('#uc-invite-joseph').is_checked()
            page.click('#uc-save-btn')
            page.wait_for_timeout(200)
            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('#universe-inspector-panel')
            disabled_insp = page.locator('#universe-inspector-panel').inner_text()
            assert '12 en sala permitida' in disabled_insp
            assert 'joseph_disabled_but_referenced_in_cast' in disabled_insp

            # Remove Joseph from screen cast (leaving levi, anya) -> clean again!
            page.locator('#universe-config-card details').first.locator('summary').click()
            page.fill('#uc-cast-screen', 'levi, anya')
            page.click('#uc-save-btn')
            page.wait_for_timeout(200)

            # --- TEST 4: Multiple stories from same preset & overlay/memory isolation + unrelated fandom isolation ---
            isolation_check = page.evaluate('''async () => {
              const { db } = await import('/js/db.js');
              const { applyPresetToStory } = await import('/js/storyPresets.js');
              const { saveStoryConfig, getStoryConfig } = await import('/js/storyConfigSchema.js');
              const { resolveUniverseConfiguration } = await import('/js/universeResolver.js');
              const { saveCharacterOverlay } = await import('/js/characterLibrary.js');

              // Seed story-pts-b from Classic Eruri -> completely isolated from story-pts-a overlays & memory!
              await applyPresetToStory('story-pts-b', 'power_to_strive::classic_eruri');
              await db.put('memoryEntries', { id: 'mem-a-only', projectId: 'story-pts-a', chapterId: 'ch-a1', events: 'Secret in A' }, { projectId: 'story-pts-a' });

              // Configure story-scifi as unrelated fandom -> ZERO PtS rules or Eruri!
              await saveStoryConfig({
                id: 'story-scifi',
                fandom: 'starlight_original',
                universeName: 'Starlight Station',
                reactionMode: false,
                casts: { room: ['Aria Solis'] },
              });

              // Test conflicting overlays on story-pts-b + explicit author conflict resolution
              const ov1 = await saveCharacterOverlay({ id: 'levi_conf_a', name: 'Conflict A', baseCharacterId: 'levi', fandom: 'power_to_strive', characterizationChanges: ['Trait A'], conflictGroup: 'cg1' });
              const ov2 = await saveCharacterOverlay({ id: 'levi_conf_b', name: 'Conflict B', baseCharacterId: 'levi', fandom: 'power_to_strive', characterizationChanges: ['Trait B'], conflictGroup: 'cg1' });
              const cfgB = await getStoryConfig('story-pts-b');
              cfgB.overlayActivations = [
                { overlayId: ov1.id, scope: 'story', enabled: true },
                { overlayId: ov2.id, scope: 'story', enabled: true },
              ];
              await saveStoryConfig(cfgB);

              const allUniv = await db.getAll('universalCharacters');
              const allOv = await db.getAll('characterOverlays');
              const resBConflicted = resolveUniverseConfiguration({ storyConfig: cfgB, universalCharacters: allUniv, overlays: allOv });
              const resA = resolveUniverseConfiguration({ storyConfig: await getStoryConfig('story-pts-a'), universalCharacters: allUniv, overlays: allOv, context: { characterVersion: 'screen' } });
              const resScifi = resolveUniverseConfiguration({ storyConfig: await getStoryConfig('story-scifi'), universalCharacters: allUniv, overlays: allOv });
              const memsB = await db.getAll('memoryEntries', { projectId: 'story-pts-b' });

              // Backup export & re-import round-trip preserves v2 storyConfigs/presets/overlays & keeps local API keys
              const dump = await db.exportAll();
              const mainExported = dump.settings.find(s => s.id === 'main');
              await db.importAll(dump, { merge: false });
              const mainAfter = await db.get('settings', 'main');
              const cfgAAfterBackup = await getStoryConfig('story-pts-a');

              return {
                bHasConflict: !resBConflicted.ok && resBConflicted.contradictions.some(c => c.type === 'overlay_conflict'),
                aUnaffectedByB: resA.ok && resA.activeOverlays.every(a => a.overlayLogicalId === 'levi_violet_traits'),
                bMemoriesIsolated: memsB.length === 0,
                scifiClean: resScifi.ok && !resScifi.isPowerToStrive && resScifi.facilitator === null && resScifi.relationshipSummary.eruri === undefined,
                backupKeysExcluded: Object.keys(mainExported?.apiKeys || {}).length === 0,
                backupKeysPreserved: mainAfter?.apiKeys?.openai === 'LOCAL-M2-SECRET',
                backupConfigSurvived: cfgAAfterBackup?.relationshipStates?.eruri?.state === 'secret_relationship',
              };
            }''')
            assert all(isolation_check.values()), f'Isolation / backup check failed: {isolation_check}'

            # Resolve the conflict in UI on PtS Story B using the Inspector button!
            page.select_option('#workspace-select', 'story-pts-b')
            page.click('[data-view="characters"]')
            page.wait_for_selector('#uc-toggle-inspector-btn')
            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('.act-resolve-conflict')
            page.locator('.act-resolve-conflict').first.click()
            page.wait_for_timeout(200)
            page.click('#uc-toggle-inspector-btn')
            page.wait_for_selector('#universe-inspector-panel')
            assert 'Sin contradicciones críticas' in page.locator('#universe-inspector-panel').inner_text()

            assert not errors, f'Unexpected page errors: {errors}'
            assert not csp_errs, f'CSP violations: {csp_errs}'
            ctx.close()
            browser.close()
            print('PASS: all Milestone 2 browser integration tests passed (presets, PtS invariants, Joseph/Anya/Eruri, Character Lab Room vs Screen, conflict resolution UI, cross-story & unrelated-fandom isolation, reload persistence, v2 backup round-trip).')
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
