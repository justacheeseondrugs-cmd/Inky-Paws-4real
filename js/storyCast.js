// storyCast.js — reparto estructural de la historia original Power to Strive.
// Evita que la autora tenga que volver a escribir los 13 espectadores en cada capítulo.

export const KAEL_AU_ROOM_CAST = [
  'Petra Ral',
  'Erwin Smith',
  'Levi',
  'Hange Zoë',
  'Ymir',
  'Historia Reiss / Christa Lenzz',
  'Sasha Braus',
  'Connie Springer',
  'Jean Kirstein',
  'Mikasa Ackerman',
  'Armin Arlert',
  'Eren Yeager',
  'Kael',
];

export const POWER_TO_STRIVE_ROOM_CAST = [
  'Petra Ral',
  'Erwin Smith',
  'Joseph Alcott',
  'Levi',
  'Hange Zoë',
  'Ymir',
  'Historia Reiss / Christa Lenzz',
  'Sasha Braus',
  'Connie Springer',
  'Jean Kirstein',
  'Mikasa Ackerman',
  'Armin Arlert',
  'Eren Yeager',
];

function split(value){
  return String(value || '').split(/[,;\n]/).map((x)=>x.trim()).filter(Boolean);
}

function key(value){
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}

function normalize(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'');
}

export function isPowerToStriveStory(projectId,lockedFacts=[]){
  if(projectId === 'original') return true;
  const facts=(lockedFacts || []).map((fact)=>normalize(fact?.text)).join('\n');
  const hasRoomRule =
    facts.includes('exactly thirteen viewers physically present in the reaction room') ||
    (facts.includes('joseph joins as the thirteenth') && facts.includes('anya is not in the reaction room'));
  const hasCoreNames =
    facts.includes('petra ral') &&
    facts.includes('erwin smith') &&
    facts.includes('joseph alcott') &&
    facts.includes('hange zoe') &&
    facts.includes('eren yeager');
  return hasRoomRule && hasCoreNames;
}

export function getAutomaticReactionRoomCast(projectId,reactionMode=true,lockedFacts=[]){
  if(!reactionMode) return [];
  if(projectId === 'kael-au') return KAEL_AU_ROOM_CAST.slice();
  return isPowerToStriveStory(projectId,lockedFacts) ? POWER_TO_STRIVE_ROOM_CAST.slice() : [];
}

export function combineCast(...groups){
  const out=[];
  const seen=new Set();
  for(const group of groups){
    const names=Array.isArray(group) ? group : split(group);
    for(const name of names){
      const k=key(name);
      if(!k || seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
  }
  return out;
}

export function formatCast(names){
  return (names || []).join(', ');
}
