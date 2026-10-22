"""Browser integration check using real IndexedDB; no API key or model calls."""
import functools
import http.server
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/__test':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<!doctype html><title>Violet integration test</title>')
        else:
            super().do_GET()
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = browser.new_page()
        page.goto(f'http://127.0.0.1:{server.server_port}/__test')
        result = page.evaluate('''async () => {
          const {db} = await import('/js/db.js');
          const {ensureVioletWorkspace, VIOLET_ROOM_CAST} = await import('/js/violet.js');
          const {getAutomaticReactionRoomCast} = await import('/js/storyCast.js');
          const assert = (value,message) => {if (!value) throw new Error(message)};
          await db.openDb();
          await db.put('settings',{id:'workspaces',items:[{id:'existing-violet',name:' Violet '},{id:'kael-au',name:'Kael AU'}]});
          await db.put('settings',{id:'main',apiKeys:{openai:'local-test-key'},provider:'openai'});
          db.setActiveProjectId('original');
          await db.put('characters',{id:'original-joseph',name:'Joseph Alcott'});
          await db.put('chapters',{id:'original-chapter',content:'Original text'});
          db.setActiveProjectId('kael-au');
          await db.put('characters',{id:'kael-character',name:'Kael'});
          db.setActiveProjectId('existing-violet');
          await db.put('characters',{id:'violet-levi',name:'Levi',personality:'Old sheet'});
          await db.put('characters',{id:'violet-joseph',name:'Joseph Alcott'});
          await db.put('characters',{id:'violet-extra',name:'Extra'});
          await db.put('chapters',{id:'violet-chapter',content:'Keep my existing chapter'});

          // A failed reference download must leave the original data untouched.
          const realFetch = window.fetch;
          window.fetch = (url,...args) => String(url).endsWith('power-to-strive-i.txt') ? Promise.resolve(new Response('unavailable',{status:503})) : realFetch(url,...args);
          let failed = false;
          try {await ensureVioletWorkspace(db)} catch {failed = true}
          assert(failed,'missing source should fail');
          assert((await db.getAll('characters')).length === 3,'failure modified Violet');
          assert((await db.getAll('documents')).length === 0,'failure partially imported docs');
          assert(!(await db.get('settings','violet-original-twelve-seed:existing-violet:v1')),'failure wrote marker');
          window.fetch = realFetch;

          const project = await ensureVioletWorkspace(db);
          assert(project.id === 'existing-violet','existing Violet ID was not reused');
          assert(db.getActiveProjectId() === 'existing-violet','seed changed active project unexpectedly');
          const characters = await db.getAll('characters');
          assert(characters.length === 12,'expected exactly twelve sheets');
          assert(VIOLET_ROOM_CAST.every(name => characters.some(c => c.name === name)),'missing original');
          assert(!characters.some(c => /Joseph|Kael|Anya|Extra/.test(c.name)),'extra character leaked');
          assert((await db.get('characters','violet-levi')).name === 'Levi Ackerman','existing Levi ID was lost');
          assert((await db.get('chapters','violet-chapter')).content === 'Keep my existing chapter','Violet chapter changed');
          const documents = await db.getAll('documents');
          const chunks = await db.getAll('docChunks');
          assert(documents.length === 2,'expected both reference documents');
          assert(documents.every(d => d.active && d.defaultSelected),'references should be active and selected');
          for (const doc of documents) {
            const count = chunks.filter(c => c.documentId === doc.id).reduce((sum,c) => sum+c.wordCount,0);
            assert(count === doc.wordCount,'reference extraction truncated: '+doc.filename);
          }
          assert(documents.find(d => d.filename === 'The Power to Strive I').wordCount > 190000,'story reference incomplete');
          const facts = await db.getAll('lockedFacts');
          assert(getAutomaticReactionRoomCast(project.id,true,facts).length === 12,'automatic cast not recognized with existing ID');
          // Reload is a no-op and must preserve later edits or intentional deletion.
          const levi = await db.get('characters','violet-levi');
          await db.put('characters',{...levi,personality:'My later edit'});
          await db.del('documents',documents[0].id);
          assert(await ensureVioletWorkspace(db) === null,'seed repeated');
          assert((await db.get('characters','violet-levi')).personality === 'My later edit','later edit overwritten');
          assert((await db.getAll('documents')).length === 1,'deleted document resurrected');

          db.setActiveProjectId('original');
          assert((await db.getAll('characters')).length === 1,'Original cast changed');
          assert((await db.get('chapters','original-chapter')).content === 'Original text','Original chapter changed');
          assert((await db.getAll('documents')).length === 0,'Violet references leaked into Original');
          db.setActiveProjectId('kael-au');
          assert((await db.getAll('characters'))[0].name === 'Kael','Kael AU changed');
          assert((await db.get('settings','main')).apiKeys.openai === 'local-test-key','local settings changed');

          // A browser with no Violet gets a new, independent workspace.
          const settings = await db.get('settings','workspaces');
          await db.put('settings',{...settings,items:settings.items.filter(p => p.id !== 'existing-violet')});
          const fresh = await ensureVioletWorkspace(db);
          assert(fresh.id === 'violet','new Violet not created');
          db.setActiveProjectId(fresh.id);
          assert((await db.getAll('characters')).length === 12,'fresh Violet cast incomplete');
          assert((await db.getAll('documents')).length === 2,'fresh Violet references incomplete');
          return {characters:12,documents:2,chunks:chunks.length,checks:'existing and fresh workspaces, real IndexedDB, full reference text, failed-download retry, preserved chapters and settings, idempotency, cast isolation'};
        }''')
        print('PASS:', result)
        browser.close()
finally:
    server.shutdown()
