"""Your Name: real IndexedDB, full references, UI cast, failure and reload safety."""
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
            self.wfile.write(b'<!doctype html><title>Your Name test</title>')
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
          const {ensureYourNameWorkspace,YOUR_NAME_ROOM_CAST} = await import('/js/yourName.js');
          const {getAutomaticReactionRoomCast} = await import('/js/storyCast.js');
          const assert = (v,m) => {if (!v) throw Error(m)};
          await db.openDb();
          await db.put('settings',{id:'workspaces',items:[{id:'violet',name:'Violet'},{id:'your-name',name:'My existing story'}]});
          await db.put('settings',{id:'main',apiKeys:{openai:'local-test-key'}});
          for (const id of ['original','violet','your-name']) {
            db.setActiveProjectId(id);
            await db.put('characters',{id:id+':existing',name:'Keep me',personality:'Existing edit'});
            await db.put('chapters',{id:id+':chapter',content:'Keep my text'});
          }
          const realFetch=window.fetch;
          window.fetch=(url,...args)=>String(url).endsWith('zeke-au.txt') ? Promise.resolve(new Response('',{status:503})) : realFetch(url,...args);
          let failed=false;
          try {await ensureYourNameWorkspace(db)} catch {failed=true}
          assert(failed,'failed reference should reject');
          assert((await db.get('settings','workspaces')).items.length===2,'failure registered workspace');
          assert(!(await db.get('settings','your-name-future-watch-seed:v1')),'failure wrote marker');
          assert((await db.getAll('characters')).length===1,'failure touched existing characters');
          window.fetch=realFetch;
          const project=await ensureYourNameWorkspace(db);
          assert(project.id!=='your-name','existing ID collision not protected');
          assert(db.getActiveProjectId()==='your-name','initializer unexpectedly changed active story');
          db.setActiveProjectId(project.id);
          const characters=await db.getAll('characters');
          const docs=await db.getAll('documents');
          const chunks=await db.getAll('docChunks');
          const facts=await db.getAll('lockedFacts');
          assert(characters.length===13,'expected thirteen profiles');
          assert(YOUR_NAME_ROOM_CAST.every(name=>characters.some(c=>c.name===name&&c.active)),'missing active profile');
          assert(docs.length===4&&docs.every(d=>d.active&&d.defaultSelected),'expected four selected references');
          for (const doc of docs) {
            const count=chunks.filter(c=>c.documentId===doc.id).reduce((sum,c)=>sum+c.wordCount,0);
            assert(count===doc.wordCount,'truncated reference: '+doc.filename);
          }
          assert(docs.find(d=>d.type==='STYLE_ONLY').wordCount>190000,'long fiction reference incomplete');
          assert(getAutomaticReactionRoomCast(project.id,true,facts).length===13,'automatic room cast incomplete');
          assert(getAutomaticReactionRoomCast(project.id,false,facts).length===0,'reaction off still has room');
          assert(getAutomaticReactionRoomCast('violet',true,[]).length===12,'Violet cast changed');
          assert(getAutomaticReactionRoomCast('a-day-off',true,[]).length===12,'A Day Off cast changed');
          assert(facts.some(f=>f.text.includes('OWN FUTURE')),'missing future premise');
          assert(characters.find(c=>c.name==='Levi Ackerman').pronouns==='he/him','Levi pronouns');
          assert(characters.find(c=>c.name==='Hange Zoë').pronouns==='they/them','Hange pronouns');
          assert((await db.getAll('canonNotes')).every(n=>n.visibility==='private'),'future plan revealed prematurely');
          assert((await db.getAll('chapters')).length===0,'imported another story’s chapters');
          const zeke=characters.find(c=>c.name==='Zeke Yeager');
          await db.put('characters',{...zeke,personality:'My later Zeke edit'});
          assert(await ensureYourNameWorkspace(db)===null,'initializer ran twice');
          assert((await db.get('characters',zeke.id)).personality==='My later Zeke edit','reload overwrote edit');
          for (const id of ['original','violet','your-name']) {
            db.setActiveProjectId(id);
            assert((await db.get('chapters',id+':chapter')).content==='Keep my text','existing chapter changed');
            assert((await db.getAll('characters')).length===1,'existing roster changed');
            assert((await db.getAll('documents')).length===0,'references leaked');
          }
          assert((await db.get('settings','main')).apiKeys.openai==='local-test-key','local settings changed');
          db.setActiveProjectId(project.id);
          return {project:project.id,characters:characters.length,documents:docs.length,chunks:chunks.length};
        }''')
        # Boot the real app against the same browser data and inspect actual tabs.
        page.goto(f'http://127.0.0.1:{server.server_port}/index.html')
        page.wait_for_function("document.querySelector('#workspace-select')?.options.length >= 4")
        page.select_option('#workspace-select',result['project'])
        page.click('[data-view="characters"]')
        page.wait_for_selector('#char-list .list-item')
        assert page.locator('#char-list .list-item').count()==13
        assert 'Zeke Yeager' in page.locator('#char-list').inner_text()
        page.click('[data-view="documents"]')
        page.wait_for_selector('#doc-list .card')
        assert page.locator('#doc-list .card').count()==4
        page.click('[data-view="write"]')
        page.wait_for_selector('.auto-cast-pills .pill')
        assert page.locator('.auto-cast-pills .pill').count()==13
        assert 'Zeke Yeager' in page.locator('#w-auto-room-cast').input_value()
        print('PASS:',result,'— atomic retry, collision safety, isolation, reload, real UI profiles/documents/room')
        browser.close()
finally:
    server.shutdown()
