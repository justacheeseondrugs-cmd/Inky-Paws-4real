// storyCast.js — reparto estructural de la historia original Power to Strive.
// Evita que la autora tenga que volver a escribir los 13 espectadores en cada capítulo.

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

export function getAutomaticReactionRoomCast(projectId,reactionMode=true){
  return projectId === 'original' && reactionMode ? POWER_TO_STRIVE_ROOM_CAST.slice() : [];
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
