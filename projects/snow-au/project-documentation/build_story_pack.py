"""Build an optional pack using the existing Inky Paws story-pack fields only.

No chapter text, document upload, automatic cast assignment or browser backup.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMON_RULES = ('Snow AU only. The watching-room opening is immediately before Eren’s trial. '
    'Snow-specific dossier overrides incompatible general-bible assumptions. Erwin and Levi '
    'are NOT a couple. Author references and profiles are not automatic character knowledge. '
    'A profile is not an assignment to the watching room; full room roster remains unresolved. '
    'Do not import other Inky Paws workspaces or write/reconstruct missing approved chapters.')
PROFILES = [
    ('Petra Ral','she/her','Practical experienced Scout and emotionally attentive observer. Warm without passivity; capable of tactical disagreement.','Calm, respectful, direct and sometimes playful; brief grounded observations.','Professional trust with Levi, mentorship toward Eren, practical judgment valued by Erwin.'),
    ('Erwin Smith','he/him','Controlled strategist who asks what events reveal, who benefits and what can change. Intelligent, fallible and emotionally affected without public display.','Precise, measured, formal without robotic speeches; quieter when angry.','Levi: considerable trust and growing emotional closeness, NOT an established romantic relationship. Snow: initially an unfamiliar political figure, potentially capable of pleasant intellectual conversation. Notice Levi’s reaction without inventing its cause.'),
    ('Hange Zoë','they/them','Curious scientist, veteran and officer. Playfulness, scientific interest, ethical concern and perceptiveness coexist.','Quick and excited during discovery, sharp when confronting cruelty, capable of gentleness; not always shouting.','Trusted long-standing colleagues in Erwin and Levi; can notice unusual recognition without knowing Levi’s past.'),
    ('Levi Ackerman','he/him','Practical, observant, blunt and emotionally guarded without being incapable of affection. Keeps agency, moral boundaries, competence and an independent life.','Economical, dry and sarcastic; vulgar when natural, not in every sentence; emotion often through action.','Snow: genuine former lover and cohabiting partner. Levi welcomed and reciprocated affection, but permanently ended the relationship over harmful moral choices. Recognizes him immediately at the trial, owes no renewal or forgiveness. Erwin: trust and growing closeness, NOT already his partner.'),
    ('Ymir','she/her','Perceptive about hypocrisy and hidden feelings; provocative, guarded and protective. Care and cynicism coexist.','Informal, sharp, sarcastic when natural, gentler with Christa.','Christa is her central emotional connection. Does not expose private identities merely to inform the audience.'),
    ('Historia Reiss / Christa Lenz','she/her','Initially performs agreeable, self-sacrificing Christa while an independent identity gradually emerges. Empathy does not make her passive or unintelligent.','Gentle and encouraging as Christa; increasing directness develops gradually.','Ymir is a central emotional anchor. Her author-facing identity does not authorize a public birth-name reveal.'),
    ('Sasha Blouse','she/her','Sincere, practical and attentive to ordinary people and emotional shifts; not limited to food jokes.','Natural, literal and emotionally sincere; can ask a socially awkward question without cruelty.','Friendship and humor with Connie coexist with care and seriousness about home and family.'),
    ('Connie Springer','he/him','Direct, funny and emotionally invested. Confusion or bluntness is not stupidity.','Simple, candid questions, spontaneous humor and genuine emotion; no permanent comic-relief role.','Sasha is a close friend; both can comfort each other as well as joke.'),
    ('Jean Kirstein','he/him','Skeptical and concerned with survival and consequences; capable of vulnerability and emerging leadership.','Blunt, argumentative and occasionally inadvertently revealing; can become sincere.','Eren: arguments about action, freedom and consequences can coexist with developing respect.'),
    ('Mikasa Ackerman','she/her','Reserved, observant and protective; notices physical danger and who protects whom, with independent judgment.','Restrained and direct, often economical; not only Eren’s name.','Eren and Armin are central bonds, but do not make her incapable of independent observation.'),
    ('Armin Arlert','he/him','Curious, analytical and emotionally vulnerable. Connects evidence without possessing omniscience.','Questions and compact reasoning; avoid turning every insight into a lecture.','Eren and Mikasa are a family-like unit with distinct responses. Insight into Snow must follow evidence.'),
    ('Eren Yeager','he/him','Driven by conviction and freedom, emotionally reactive but capable of thought.','Blunt and impassioned; can be confused or vulnerable without constant shouting.','Mikasa and Armin are central bonds. His upcoming military trial is a future screen event at the room opening.'),
    ('Coriolanus Snow / Edmund Voss','he/him','Young Tom Blyth Snow, not elderly President Snow. Charming, articulate, ambitious, socially perceptive, sincerely warm and affectionate, yet self-interested, possessive and capable of rationalizing harm. Voss is the same man adapted to the Walls. Power means security and agency to him; acquiring it is not evidence of moral repair.','Intelligent, measured and natural. Diplomatic with officials, capable of humor and pleasant engagement with Erwin, warmer and familiar with Levi. No nonstop philosophical speeches or generic dark-romance villain voice.','Levi: genuine former partner. Snow misreads the permanent breakup and believes he is coming home. Returns from love and self-justification rather than revenge. Erwin may gradually be perceived as a rival, but Snow can respect and enjoy him. Village friendships were real; specific people and job remain unresolved.'),
]

characters=[]
for name,pronouns,personality,speech,relationships in PROFILES:
    knowledge=('Only personal experience and information actually witnessed or disclosed at the pre-trial opening. '
        'Do not import post-trial events, later AOT secrets or another character’s private thoughts as shared knowledge. '
        'The exact opening scene and previously approved chapter revelations cannot be verified until Chapter One is supplied.')
    if name=='Levi Ackerman':
        knowledge+=' Privately knows his own past with Snow; do not erase that memory. Does not automatically know Snow’s eight-year biography. The surname on this author-facing profile is not a public reveal.'
    elif name=='Coriolanus Snow / Edmund Voss':
        knowledge+=' Knows his own life and former relationship; does not accept Levi intended permanent separation. No omniscient access to Levi’s present feelings, room events or unwitnessed military secrets.'
    elif name=='Ymir':
        knowledge+=' Privately retains her own past and Titan identity; others do not share those secrets. This is not comprehensive current intelligence.'
    elif name.startswith('Historia'):
        knowledge+=' Privately retains her birth name and childhood; uses Christa publicly. Do not infer knowledge of the complete royal truth.'
    characters.append(dict(name=name,pronouns=pronouns,personality=personality,speechStyle=speech,
        hardRules=COMMON_RULES,currentKnowledge=knowledge,relationships=relationships,chemistry='',
        neverDoRules='Do not invent finalized chapter events, silently approve suggestions, expose private knowledge or import unrelated AU relationships.',active=True))

facts=[
    'SNOW AU AUTHOR RULE: dossier is private author reference, not shared room knowledge. Start immediately before Eren’s trial, superseding the base bible’s later pre-expedition starting point.',
    'Erwin and Levi are NOT an established couple in Snow AU. Snow and Edmund Voss are one man, based on young Tom Blyth Snow. Full room roster and Snow’s room presence are not decided by the character-profile list.',
    'Preserve all approved chapters exactly. No approved Snow Chapter One has been supplied with this pack. Do not generate, reconstruct, summarize as established, or replace missing chapters from a reference story.',
    'Keep ESTABLISHED facts distinct from PROPOSED options, UNRESOLVED questions and explicitly DISCARDED ideas. Current author instructions and Snow-specific dossier override conflicting general reference or unrelated Inky Paws AU material.',
]
notes=[{'text':(ROOT/path).read_text(),'visibility':'private'} for path in ['MASTER_CONTEXT.md','STORY_BIBLE.md','TIMELINE.md','CONTINUITY_NOTES.md','characters/RELATIONSHIPS.md']]
pack={'__meta':{'app':'inky-paws-story-pack','title':'Snow AU — reference preparation'},'characters':characters,
      'lockedFacts':[{'text':text,'isCore':True} for text in facts],'canonNotes':notes}
target=ROOT/'inky-paws/snow-au-story-pack.json';target.parent.mkdir(exist_ok=True)
text=json.dumps(pack,ensure_ascii=False,indent=2)+'\n'
if target.exists() and target.read_text()!=text:raise RuntimeError('Refusing to replace differing pack')
if not target.exists():target.write_text(text)
print('Prepared existing-format pack: 13 profiles, 4 author rules, 5 private reference notes; no chapters or cast assignment.')
