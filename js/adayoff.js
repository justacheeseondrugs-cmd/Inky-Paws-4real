// A Day Off — isolated AU workspace. Does not mutate Original, Violet or Kael.
import { chunkText } from './retrieval.js';

export const A_DAY_OFF_PROJECT = { id: 'a-day-off', name: 'A Day Off · Eruri & Frank' };

const frank = {
  name: 'Frank Gallagher',
  pronouns: 'he/him',
  personality: `Levi's father in this AOT AU, adapted from Shameless without importing the Chicago family or modern institutions. Clever, verbally nimble, satirical, alcoholic, unreliable, chaotic, often very funny, sometimes acutely observant, and capable of genuinely loving his son. Frank uses theories of freedom, class injustice, corrupt systems and anti-authoritarianism to rationalize irresponsibility. He can correctly identify hypocrisy and still be evading a much smaller concrete obligation. He lives on short-term schemes and is not a criminal mastermind. His pride and shame can be equally sincere; he often turns shame into outrage or self-pity instead of repair. He does not lack every form of empathy, nor is he constantly calculating. His addiction and history may help explain conduct but never excuse harm. He is capable of small generosity, attention and warmth even as he feels entitled to Levi's time, resources, salary, rank and connections. Do NOT diagnose him in narration or dialogue with personality disorders as an established medical fact.`,
  speechStyle: `Animated, teasing, articulate, vulgar when natural, capable of turning a practical complaint into a ridiculous class-theory lecture. Fast shifts between banter, affection, flamboyant defensiveness and unexpectedly sober lucidity. Give him plenty of mundane conversation and good jokes, not continuous monologues or therapist-speak. He may call Levi "Captain" with sincere pride one minute and as leverage the next. When cornered, he argues around the question; a plain apology is rare and may be followed by a relapse or rationalization.`,
  relationships: `Levi Ackerman: **his son, whom he truly loves and misses**. Frank remembers private details, enjoys his company, jokes with easy familiarity, sometimes wants to protect him, and is proud of his success. Also tends to use Levi's rank, pay and military contacts to escape money troubles, often without asking. When Levi refuses, Frank may plead, bargain, cast himself as the victim, sulk, or offer a peculiar but genuine small reconciliation. Erwin Smith: Levi's commander; Frank might size him up as both an authority to mock and a potential resource, but any history between them must be established on page. Nile Dok: an officer Frank may encounter due to the Voss paperwork; do not presume prior acquaintance. Voss Supply and Transport: his improvised arrangements collide with an independent military investigation, not a secret conspiracy he controls.`,
  chemistry: `With Levi: relaxed, familiar banter and old shared rhythms coexist with deception and resentment. Levi may actively enjoy a visit and laugh with him; Frank can then cross a boundary and change the atmosphere. Affection is never the same as permission. With strangers: charm, outrageous arguments and shameless invention are socially effective until somebody asks for actual receipts. With Erwin: possible verbal sparring, but not automatic villain-versus-savior staging.`,
  hardRules: `A DAY OFF AU ONLY. Frank is Levi's actual father here. **ONSCREEN ONLY — never physically present in the watching room, never counted as a viewer, even though he has an active character sheet.** Frank genuinely loves Levi; do not flatten him to a monster or clown. No Northwestern University, modern social-security fraud, Monica, Peggy, Fiona, Lip, Ian, Debbie, Carl, Liam, Frank's TV ending, or exact childhood trauma is AU canon merely because it occurred in Shameless. He is not responsible for the entire Voss affair. Kuchel's fate is UNRESOLVED.`,
  currentKnowledge: `OVA is months before Eren joins the military. Frank knows his own dealings, debts, promises and personal shared history with Levi as established in actual chapters. He does not know the later Titan revelations, hidden military truth, or facts from the watching room. He is not omniscient about Voss or Erwin and Nile's investigation. Do not fabricate definitive knowledge of Kuchel's fate.`,
  neverDoRules: `Never enter or comment FROM the reaction room. Never introduce Frank's other Shameless children or Monica as established AU cast. Never pretend Frank is always heartless, always innocent, a genius mastermind, or sincerely cured after one apology. Never make every funny moment malicious or every harm an accident. Never diagnose him or give him a long self-explanatory psychological speech.`,
  active:true
};

const nile = {
  name: 'Nile Dok',
  pronouns: 'he/him',
  personality: `A seasoned Military Police officer, family man, and old acquaintance/friend/rival of Erwin Smith. Competent, dry, skeptical, institutionally cautious and capable of moral courage. He values keeping people safe through stability and due process; that choice is partly principled and partly self-protective. Erwin represents the life of dangerous conviction he did not choose, a tension neither man must spell out in a speech. Nile's domestic commitments and love for Marie and his family are genuine, not merely a pretext. He can accept institutional compromise for too long without being secretly evil or intellectually inferior. His limits matter when ordinary lives are threatened. The author-facing later series arc and fate are NOT knowledge available to this earlier Nile.`,
  speechStyle: `Precise, economical, dryly sarcastic; speaks as an experienced military officer and investigator, not a comedic scold. Can trade old jabs with Erwin and show deliberate humor. He asks for dates, signatures, witnesses, receipts and what the records actually prove. Gives direct pushback if Erwin speculates past the evidence. Reveals his family concerns in ordinary, specific remarks, not confessions about his own psychology.`,
  relationships: `Erwin Smith: history, familiarity and competing philosophies. Each can argue and still value the other's judgment. Marie: a real person whom Nile loves and has built a life with; she is not a trophy won from Erwin. His children: central to how he defines legitimate protection. Levi Ackerman: a capable Scout officer whose name may arise in supply paperwork; professional interaction does not imply personal knowledge of Frank. Frank Gallagher: a potential witness or complicating party, not automatically an enemy. Brenner: clerk associated with a missing authorization; do not presume guilt. Voss Supply and Transport: intermediary implicated in anomalous payments, motive not yet proven.`,
  chemistry: `With Erwin: familiar enough to criticize him personally, disciplined enough to return to verifiable facts; occasional grudging amusement and genuine teamwork. With Frank: the contrast between Nile's documented evidence and Frank's flamboyant improvisation can be very funny without turning Nile into a buffoon. With Levi: respect autonomy and chain of command; do not treat Levi merely as Erwin's love interest.`,
  hardRules: `A DAY OFF AU ONLY. **ONSCREEN ONLY — never physically present in the watching room or counted among viewers.** Independent co-investigator with Erwin; he needs proof, not merely cynicism. The irregularity features Brenner, missing/irregular authorization and a payment preceding requisition through Voss Supply and Transport. Keep fraud, negligence and error as live hypotheses until earned evidence. His much later Titan fate, coup and future revelations are outside this earlier timeline.`,
  currentKnowledge: `OVA occurs months before Eren joins military. Nile knows his own career, family and experience with Erwin. He has access only to investigation evidence actually collected so far and knows nothing from the watching room, later Titan identity revelations or his own future.`,
  neverDoRules: `Never enter reaction room. Never reduce Nile to permanently exasperated comic relief, a foolish obstacle to Erwin, or a willing supporter of all corruption. Never assume Brenner or Voss guilty without evidence. Never refer to his later death/fate as current knowledge. Never explain his moral tensions in diagnostic monologues.`,
  active:true
};

function readAsset(path, asJson=false) {
  return fetch(new URL(path, import.meta.url)).then(async (res) => {
    if (!res.ok) throw new Error('Missing A Day Off reference: ' + path);
    return asJson ? res.json() : res.text();
  });
}

function projectCharacters(base) {
  if (!Array.isArray(base) || base.length !== 12) throw new Error('Invalid base character bible');
  return base.map((item) => {
    const copy = { ...item };
    for (const field of ['personality','speechStyle','relationships','hardRules','currentKnowledge','neverDoRules']) {
      copy[field] = String(copy[field] || '').replace(/\bViolet\b/g,'A Day Off');
    }
    copy.hardRules += ' In A Day Off only the twelve original AOT viewers are in the watching room. Frank Gallagher and Nile Dok exist only ONSCREEN; do not add them to the viewing audience.';
    if (copy.name === 'Levi Ackerman') {
      copy.relationships += '\nFrank Gallagher (father): a genuinely beloved but manipulative, unreliable parent. Levi willingly visits, enjoys his jokes and retains agency and boundaries. The precise past involving Kuchel remains unresolved.';
    }
    if (copy.name === 'Erwin Smith') {
      copy.relationships += '\nNile Dok: long-term acquaintance, old friend/rival and independent colleague in the supply investigation; genuine mutual respect under disagreement.';
    }
    return copy;
  });
}

function records(database, store) {
  return new Promise((resolve,reject) => {
    const request = database.transaction(store).objectStore(store).getAll();
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

export async function ensureADayOffWorkspace(db) {
  const saved = await db.get('settings','workspaces') || { id:'workspaces',items:[] };
  const project = A_DAY_OFF_PROJECT;
  const markerId='a-day-off-seed:'+project.id+':v1';
  if (await db.get('settings',markerId)) return null;
  // Do not overwrite a manually created workspace with this ID.
  const database=await db.openDb();
  const existing=(await records(database,'characters')).filter((x)=>x.projectId===project.id);
  if (existing.length) return null;

  // Download and validate everything BEFORE the IndexedDB write transaction.
  const [pack,baseBible,auBible,plotBible] = await Promise.all([
    readAsset('../data/violet/pack.json',true),
    readAsset('../data/violet/character-bible.txt'),
    readAsset('../data/a-day-off/character-bible-supplement.md'),
    readAsset('../data/a-day-off/plot-and-watching-room.md')
  ]);
  const viewers=projectCharacters(pack.characters);
  const characters=[...viewers,frank,nile];
  if (new Set(characters.map((c)=>c.name.toLowerCase())).size!==14 || !baseBible || !auBible || !plotBible) throw new Error('Invalid A Day Off bible');
  const docs=[
    {filename:'A Day Off - Original AOT Character Bible',sourceFilename:'character-bible.txt',text:baseBible,type:'CHARACTER',priority:95},
    {filename:'A Day Off - AU Character Bible Supplement',sourceFilename:'character-bible-supplement.md',text:auBible,type:'CHARACTER',priority:110},
    {filename:'A Day Off - OVA and Watching Room',sourceFilename:'plot-and-watching-room.md',text:plotBible,type:'CANON',priority:105}
  ];
  const facts=[
    'A Day Off is an independent Attack on Titan watching-room AU. The reaction room contains exactly twelve original AOT viewers: Petra Ral, Erwin Smith, Hange Zoë, Levi Ackerman, Ymir, Historia Reiss / Christa Lenz, Sasha Blouse, Connie Springer, Jean Kirstein, Mikasa Ackerman, Armin Arlert, Eren Yeager. Never add Frank Gallagher, Nile Dok or characters from Original, Violet, Kael AU or other projects to the watching room.',
    'Frank Gallagher IS Levi Ackerman\'s father in A Day Off; he genuinely loves Levi, is clever and funny but is unreliable and can exploit Levi\'s rank and money. Frank is an ONSCREEN character only, never a watching-room viewer. Levi genuinely enjoys time with him and retains boundaries and agency.',
    'Nile Dok is an ONSCREEN character only, never a watching-room viewer. He investigates irregular supply and payment records with Erwin Smith as a competent, careful, independent colleague. Voss Supply and Transport and clerk Brenner are leads, not proven perpetrators.',
    'Erwin and Levi are in love in this AU, mostly unspoken and practical. Erwin arranged Levi\'s captain promotion and salary adjustment; bought Levi a black travel horse and expensive custom reinforced leather gloves; provided other needed equipment. These are thoughtful, practical gifts, not debts. Levi makes his own choices.',
    'Screen chronology: the OVA A Day Off begins months before Eren joins the military, prior to the major Titan revelations. Reaction-room chronology: approximately two days before the 57th Expedition. Do NOT merge the two timelines or give the audience future knowledge it has not acquired.',
    'Kuchel\'s fate, absence, relationship with Frank, and the exact childhood backstory are UNRESOLVED. Do not choose an explanation or reveal an answer in the first installment.',
    'The Erwin/Nile inquiry begins with an early military supply payment, irregular or missing authorization connected to clerk Brenner, and intermediary Voss Supply and Transport. Fraud, error and negligence are competing hypotheses, not established conclusions. Frank has not orchestrated the larger military affair.',
    'Use the original AOT character bible and supplementary A Day Off documents. Previous unrelated drafts and Power to Strive I are NOT canon for A Day Off. Onscreen actors are not automatically in the watching room. Reactions interleave with screen events, not a roll call.'
  ];
  const now=new Date().toISOString();
  const stores=['settings','characters','documents','docChunks','lockedFacts'];
  await new Promise((resolve,reject)=>{
    const tx=database.transaction(stores,'readwrite');
    tx.oncomplete=()=>resolve(true);
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('A Day Off setup aborted'));
    const put=(store,obj)=>tx.objectStore(store).put({...obj,projectId:project.id});
    characters.forEach((char,index)=>put('characters',{...char,id:project.id+':character:'+index}));
    docs.forEach((doc,index)=>{
      const id=project.id+':document:'+index;
      put('documents',{id,filename:doc.filename,sourceFilename:doc.sourceFilename,type:doc.type,priority:doc.priority,useOnlyFor:'',neverUseFor:'',active:true,defaultSelected:true,inclusion:'SMART',wordCount:doc.text.split(/\s+/).filter(Boolean).length,createdAt:now});
      chunkText(doc.text,id).forEach((chunk)=>put('docChunks',{...chunk,id:id+':chunk:'+chunk.index}));
    });
    facts.forEach((fact,index)=>put('lockedFacts',{id:project.id+':fact:'+index,text:fact,isCore:true}));
    const items=saved.items.some((p)=>p.id===project.id)?saved.items:[...saved.items,project];
    tx.objectStore('settings').put({...saved,items});
    tx.objectStore('settings').put({id:markerId,done:true,projectId:project.id,createdAt:now});
  });
  return project;
}
