// Your Name — one-time, atomic setup in a new, isolated browser workspace.
import { chunkText } from './retrieval.js';

export const YOUR_NAME_PROJECT = { id:'your-name', name:'Your Name · Erwin & Zeke' };
export const YOUR_NAME_ROOM_CAST = [
  'Petra Ral', 'Erwin Smith', 'Hange Zoë', 'Levi Ackerman', 'Ymir',
  'Historia Reiss / Christa Lenz', 'Sasha Blouse', 'Connie Springer',
  'Jean Kirstein', 'Mikasa Ackerman', 'Armin Arlert', 'Eren Yeager', 'Zeke Yeager',
];
const MARKER = 'your-name-future-watch-seed:v1';

export function isYourNameStory(projectId, facts=[]) {
  return projectId === YOUR_NAME_PROJECT.id || facts.some((fact) =>
    String(fact.text || '').startsWith('AUTHOR-CONFIRMED YOUR NAME PREMISE'));
}

async function readAsset(path, json=false) {
  const response = await fetch(new URL('../data/your-name/' + path, import.meta.url));
  if (!response.ok) throw new Error('No se pudo cargar Your Name: ' + path);
  const result = await (json ? response.json() : response.text());
  if (!result || (!json && !result.trim())) throw new Error('Referencia vacía: ' + path);
  return result;
}

function allRecords(database, store) {
  return new Promise((resolve,reject) => {
    const request = database.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function ensureYourNameWorkspace(db) {
  if (await db.get('settings',MARKER)) return null;
  const saved = await db.get('settings','workspaces') || {id:'workspaces',items:[]};
  const database = await db.openDb();
  // Even orphaned records reserve their project ID. Never overwrite an existing story.
  const stores = ['characters','documents','docChunks','lockedFacts','canonNotes','chapters','memoryEntries','generationState'];
  const existing = (await Promise.all(stores.map((store) => allRecords(database,store)))).flat();
  const occupied = new Set([...saved.items.map((item) => item.id), ...existing.map((item) => item.projectId)]);
  const project = {...YOUR_NAME_PROJECT};
  if (occupied.has(project.id)) project.id = YOUR_NAME_PROJECT.id + ':' + db.uid();

  // No writes until every reference has downloaded and the full pack has validated.
  const pack = await readAsset('pack.json',true);
  if (pack.characters?.length !== 13 || pack.documents?.length !== 4 ||
      pack.characters.some((character,index) => character.name !== YOUR_NAME_ROOM_CAST[index]) ||
      !Array.isArray(pack.lockedFacts) || !pack.lockedFacts.length) {
    throw new Error('Pack de Your Name inválido.');
  }
  const texts = await Promise.all(pack.documents.map((document) => readAsset(document.path)));
  const now = new Date().toISOString();
  await new Promise((resolve,reject) => {
    const tx = database.transaction(['settings','characters','documents','docChunks','lockedFacts','canonNotes'],'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Your Name setup aborted.'));
    const put = (store,record) => tx.objectStore(store).put({...record,projectId:project.id});
    pack.characters.forEach((character,index) => put('characters',{...character,id:project.id+':character:'+index}));
    pack.documents.forEach((document,index) => {
      const id = project.id+':document:'+index;
      const text = texts[index];
      put('documents',{...document,id,active:true,defaultSelected:true,inclusion:'SMART',wordCount:text.split(/\s+/).filter(Boolean).length,createdAt:now});
      chunkText(text,id).forEach((chunk) => put('docChunks',{...chunk,id:id+':chunk:'+chunk.index}));
    });
    pack.lockedFacts.forEach((fact,index) => put('lockedFacts',{...fact,id:project.id+':fact:'+index}));
    (pack.canonNotes || []).forEach((note,index) => put('canonNotes',{...note,id:project.id+':canon:'+index,visibility:'private',createdAt:now}));
    tx.objectStore('settings').put({...saved,items:[...saved.items,project]});
    tx.objectStore('settings').put({id:MARKER,done:true,createdAt:now,projectId:project.id});
  });
  return project;
}
