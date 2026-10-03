// contextGuard.js — preflight local y explicable antes de gastar API.
// No intenta "entender" toda la historia: detecta conflictos estructurales
// que sí podemos verificar de forma determinista con los datos actuales.

function normalize(value){
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'');
}

function splitNames(value){
  return String(value || '').split(/[,;\n]/).map((x)=>x.trim()).filter(Boolean);
}

function extractReactionRoomExclusions(lockedFacts){
  const names=new Set();
  const patterns=[
    /\b([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'’-]{1,40})\s+is\s+NOT\s+in\s+the\s+reaction\s+room\b/gi,
    /\b([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñü'’-]{1,40})\s+no\s+esta\s+en\s+la\s+sala\s+de\s+reacciones\b/gi,
  ];
  for(const fact of lockedFacts || []){
    const text=String(fact?.text || '');
    for(const pattern of patterns){
      pattern.lastIndex=0;
      let match;
      while((match=pattern.exec(text))) names.add(match[1]);
    }
  }
  return [...names];
}

function locationConflictFor(name, instructions, scenePlan){
  const source=[instructions,...(Array.isArray(scenePlan)?scenePlan:[])].filter(Boolean).join('\n');
  const pieces=source.split(/[\n.!?]+/).map((s)=>s.trim()).filter(Boolean);
  const nameNorm=normalize(name);
  const roomTerms=['reaction room','sala de reacciones','viewing room','cuarto de reacciones'];
  const observerTerms=['observa','observar','mira','mirar','watch','watches','watching','ve','viendo','sits','sentad','reacciona','reacts'];
  for(const piece of pieces){
    const n=normalize(piece);
    if(!n.includes(nameNorm)) continue;
    const mentionsRoom=roomTerms.some((term)=>n.includes(normalize(term)));
    const impliesPresence=observerTerms.some((term)=>n.includes(normalize(term)));
    if(mentionsRoom && impliesPresence) return piece;
  }
  return '';
}

function likelyPrivateCanon(canonNotes){
  const markers=[
    'not all revealed','not revealed','unrevealed','secret relationship','secret romantic',
    'private canon','author only','not yet revealed','no revelado','aun no revelado',
    'todavia no revelado','secreto','secret bargain','what actually happened'
  ];
  return (canonNotes || []).filter((note)=>{
    const n=normalize(note?.text);
    return markers.some((marker)=>n.includes(normalize(marker)));
  });
}

export function analyzeContextGuard({
  lockedFacts=[],
  canonNotes=[],
  allCharacters=[],
  allowedCast='',
  instructions='',
  scenePlan=[],
  reactionMode=true,
  selectedDocuments=[],
}={}){
  const issues=[];
  const allowedNames=splitNames(allowedCast);
  const localNames=new Set((allCharacters || []).filter((c)=>c?.active !== false).map((c)=>normalize(c.name)));
  const missingSheets=allowedNames.filter((name)=>!localNames.has(normalize(name)));
  if(missingSheets.length){
    issues.push({
      id:'missing-character-sheets',
      level:'info',
      title:'Fichas locales faltantes',
      message:'Estos personajes están autorizados pero no tienen ficha local activa: '+missingSheets.join(', ')+'. Pueden seguir entrando por documentos, pero Inky tiene menos contexto estructurado sobre ellos.',
      evidence:missingSheets,
    });
  }

  if(reactionMode){
    const excluded=extractReactionRoomExclusions(lockedFacts);
    for(const name of excluded){
      const evidence=locationConflictFor(name,instructions,scenePlan);
      if(evidence){
        issues.push({
          id:'reaction-room-location-'+normalize(name),
          level:'critical',
          title:'Posible conflicto de ubicación',
          message:name+' está marcado como NO presente en la sala de reacciones, pero la instrucción parece colocarlo allí como observador/reactor.',
          evidence,
          suggestion:'Aclara que '+name+' está onscreen, o cambia el sujeto para que sean los espectadores de la sala quienes observen.',
        });
      }
    }
  }

  const privateLike=likelyPrivateCanon(canonNotes);
  if(privateLike.length){
    issues.push({
      id:'possible-private-canon',
      level:'warning',
      title:'Canon con información posiblemente aún no revelada',
      message:'Hay canon permanente que parece contener secretos o hechos futuros. El modelo recibe esa verdad de autor junto al conocimiento de los personajes, así que existe riesgo de filtración accidental.',
      evidence:privateLike.slice(0,3).map((n)=>String(n.text || '').slice(0,260)),
      suggestion:'La siguiente mejora recomendada es separar Canon revelado de Canon privado del autor.',
    });
  }

  if(!(selectedDocuments || []).length){
    issues.push({
      id:'no-documents',
      level:'info',
      title:'Sin documentos autorizados',
      message:'Este capítulo no tiene documentos de referencia seleccionados. No es un error si memoria, canon y fichas son suficientes.',
    });
  }

  return {
    issues,
    criticalCount:issues.filter((item)=>item.level==='critical').length,
    warningCount:issues.filter((item)=>item.level==='warning').length,
    infoCount:issues.filter((item)=>item.level==='info').length,
    ok:!issues.some((item)=>item.level==='critical'),
  };
}
