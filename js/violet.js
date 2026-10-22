// One-time, atomic setup. Existing browser workspaces named Violet keep their ID.
import { chunkText } from './retrieval.js';

export const VIOLET_PROJECT = { id:'violet', name:'Violet' };
export const VIOLET_ROOM_CAST = [
  'Petra Ral', 'Erwin Smith', 'Hange Zoë', 'Levi Ackerman', 'Ymir',
  'Historia Reiss / Christa Lenz', 'Sasha Blouse', 'Connie Springer',
  'Jean Kirstein', 'Mikasa Ackerman', 'Armin Arlert', 'Eren Yeager',
];
export const VIOLET_CAST_RULE = 'Violet: exactly twelve original viewers physically present in the reaction room';
const normalize = (value) => String(value || '').trim().toLowerCase();
const key = (value) => normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
const aliases = new Map(VIOLET_ROOM_CAST.map((name, index) => [key(name), index]));
for (const [name,index] of [['Levi',3],['Hange',2],['Hanji Zoe',2],['Historia',5],['Christa',5],['Christa Lenz',5],['Historia Reiss',5],['Historia Reiss / Christa Lenzz',5],['Historia / Christa',5],['Sasha',6],['Sasha Braus',6],['Armin Arlet',10]]) aliases.set(key(name),index);

export function isVioletStory(projectId, facts = []) {
  return projectId === VIOLET_PROJECT.id || facts.some((fact) => String(fact.text || '').startsWith(VIOLET_CAST_RULE));
}

async function readAsset(path, json = false) {
  const response = await fetch(new URL('../data/violet/' + path, import.meta.url));
  if (!response.ok) throw new Error('No se pudo cargar Violet: ' + path);
  const value = await (json ? response.json() : response.text());
  if (!value || (!json && !value.trim())) throw new Error('Referencia de Violet vacía: ' + path);
  return value;
}

function records(database, store) {
  return new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function ensureVioletWorkspace(db) {
  const saved = await db.get('settings', 'workspaces') || {id:'workspaces',items:[]};
  // Prefer the currently selected Violet when there are duplicate display names.
  const matches = saved.items.filter((item) => item.id !== 'original' && normalize(item.name) === 'violet');
  const project = matches.find((item) => item.id === db.getActiveProjectId()) || matches[0] || {...VIOLET_PROJECT};
  const markerId = 'violet-original-twelve-seed:' + project.id + ':v1';
  if (await db.get('settings', markerId)) return null;

  // Finish every download and validation before touching the browser's data.
  const pack = await readAsset('pack.json', true);
  if (pack.characters?.length !== 12 || pack.documents?.length !== 2 || pack.characters.some((item,index) => item.name !== VIOLET_ROOM_CAST[index])) throw new Error('Pack de Violet inválido.');
  const texts = await Promise.all(pack.documents.map((document) => readAsset(document.path)));
  const database = await db.openDb();
  const existing = (await records(database, 'characters')).filter((item) => item.projectId === project.id);
  const now = new Date().toISOString();
  const facts = [
    VIOLET_CAST_RULE + ': ' + VIOLET_ROOM_CAST.join(', ') + '. No Joseph, Kael, Anya, Candy, narrator-avatar, new OC, or anyone else may join the room or the character roster. Reference mentions and onscreen people do not add viewers.',
    'Violet is an independent story. Never import relationships, memories, chapters, marriages, children, or other AU canon from Original or Kael AU. Levi is male (he/him); Hange uses they/them.',
    'Violet opens approximately two days before the 57th Expedition. Characters react from their own knowledge, priorities, emotional defenses and relationships. References are not shared knowledge: keep the Warrior identities, Ymir’s Titan identity, Christa’s identity, the Reiss royal truth, Marley, humanity outside the Walls, Levi’s Ackerman identity, the basement and Titan origins unrevealed until established on the screen. Respect each character’s private personal knowledge.',
    'Use Character Bible for individual characterization, and The Power to Strive I as reference, never as pre-existing Violet continuity. Use polished novel prose with distinct voices, restrained exposition and usually three or four active voices per beat. Never copy source passages or make all twelve comment in turn.',
  ];
  const stores = ['settings','characters','documents','docChunks','lockedFacts'];
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(stores, 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Violet setup aborted.'));
    const put = (store, record) => transaction.objectStore(store).put({...record, projectId:project.id});
    const used = new Set();
    for (const item of existing) {
      const index = aliases.get(key(item.name));
      // The user explicitly requested only these twelve in Violet.
      if (index === undefined || used.has(index)) transaction.objectStore('characters').delete(item.id);
      else {
        used.add(index);
        put('characters', {...pack.characters[index], id:item.id});
      }
    }
    pack.characters.forEach((character,index) => {
      if (!used.has(index)) put('characters', {...character,id:project.id + ':violet-character:' + index});
    });
    pack.documents.forEach((document,index) => {
      const id = project.id + ':violet-document:' + index;
      const text = texts[index];
      put('documents', {...document,id,active:true,defaultSelected:true,inclusion:'SMART',wordCount:text.split(/\s+/).filter(Boolean).length,createdAt:now});
      for (const chunk of chunkText(text,id)) put('docChunks',{...chunk,id:id + ':chunk:' + chunk.index});
    });
    facts.forEach((text,index) => put('lockedFacts',{id:project.id + ':violet-fact:' + index,text,isCore:true}));
    const items = saved.items.some((item) => item.id === project.id) ? saved.items : [...saved.items,project];
    transaction.objectStore('settings').put({...saved,items});
    transaction.objectStore('settings').put({id:markerId,done:true,projectId:project.id,createdAt:now});
  });
  return project;
}
