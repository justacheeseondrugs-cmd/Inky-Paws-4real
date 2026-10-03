// characterMatch.js — matching tolerante entre el reparto escrito por la autora
// y los nombres completos guardados en las fichas de personaje.
// Ej.: "Erwin" coincide con "Erwin Smith"; "Hange" con "Hange Zoë".

export function normalizeCharacterName(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim()
    .replace(/\s+/g,' ');
}

export function splitAllowedCast(value){
  return String(value || '')
    .split(/[,;\n]/)
    .map((name)=>name.trim())
    .filter(Boolean);
}

export function characterNameMatches(characterName, requestedName){
  const full=normalizeCharacterName(characterName);
  const requested=normalizeCharacterName(requestedName);
  if(!full || !requested) return false;
  if(full===requested) return true;

  const fullParts=full.split(' ');
  const requestedParts=requested.split(' ');

  // The common writing-screen case: the author types just first name (or surname)
  // while the saved sheet uses the full canonical name.
  if(requestedParts.length===1 && fullParts.includes(requested)) return true;
  if(fullParts.length===1 && requestedParts.includes(full)) return true;

  return false;
}

export function characterMatchesAllowedCast(characterName, allowedCast){
  const requested=Array.isArray(allowedCast) ? allowedCast : splitAllowedCast(allowedCast);
  return requested.some((name)=>characterNameMatches(characterName,name));
}

export function filterCharactersByAllowedCast(characters, allowedCast){
  return (characters || []).filter((character)=>
    character?.active !== false && characterMatchesAllowedCast(character?.name,allowedCast)
  );
}

export function hasMatchingCharacterSheet(characters, requestedName){
  return (characters || []).some((character)=>
    character?.active !== false && characterNameMatches(character?.name,requestedName)
  );
}
