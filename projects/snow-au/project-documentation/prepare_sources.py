"""Non-destructive local preparation from the three author-supplied PDFs."""
from pathlib import Path
import hashlib,json,re,shutil,subprocess
ROOT=Path(__file__).resolve().parents[1]
SRC=Path('/tmp/codex-remote-attachments/01a18a31-27b1-753c-88ae-d8280c61b005/a3181684-a9e0-4c90-a405-7767b7a1633c')
INPUTS=[('1-Snow-AU-.pdf','Snow AU .pdf','snow-au.txt','AU-specific authoritative dossier'),('2-FF-CHARACTER-BIBLE.pdf','FF- CHARACTER BIBLE.pdf','base-character-bible.txt','General characterization; Snow-specific overrides apply'),('3-Power_to_Strive_by_ii-Phoenix-ii-PEtnW5Vg-1-.pdf','Power_to_Strive_by_ii-Phoenix-ii-PEtnW5Vg (1).pdf','power-to-strive.txt','Third-party reference fiction, not Snow AU chapter continuity')]
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(rel,text):
 p=ROOT/rel;p.parent.mkdir(parents=True,exist_ok=True)
 if p.exists() and p.read_text()!=text:raise RuntimeError('Refusing to overwrite differing file: '+str(p))
 if not p.exists():p.write_text(text)
manifest=[]
for filename,display,txt,role in INPUTS:
 original=SRC/filename;dest=ROOT/'archives/originals'/filename;dest.parent.mkdir(parents=True,exist_ok=True)
 if dest.exists() and digest(dest)!=digest(original):raise RuntimeError('Original collision')
 if not dest.exists():shutil.copy2(original,dest)
 assert digest(original)==digest(dest)
 extract=ROOT/'archives/extracted'/txt;extract.parent.mkdir(parents=True,exist_ok=True)
 if not extract.exists():subprocess.run(['pdftotext','-layout',str(dest),str(extract)],check=True)
 manifest.append({'received_filename':filename,'author_display_name':display,'original':str(dest.relative_to(ROOT)),'original_bytes':dest.stat().st_size,'sha256':digest(dest),'working_text':str(extract.relative_to(ROOT)),'text_sha256':digest(extract),'role':role})
write('archives/MANIFEST.json',json.dumps({'date':'2026-10-30','format':'Three PDFs; no ZIP, TAR, RAR or 7z supplied','sources':manifest},indent=2)+'\n')
snow=(ROOT/'archives/extracted/snow-au.txt').read_text();base=(ROOT/'archives/extracted/base-character-bible.txt').read_text()
# Preserve the dossier's exact words in standalone working references.
def section(start,end):return snow[snow.index(start):snow.index(end)].strip()
write('characters/SNOW_PROFILE.md','# Coriolanus Snow / Edmund Voss\n\nESTABLISHED: one person, not two personalities. Exact extracted dossier sections II and IX follow. Their example gestures remain examples, not mandatory chapter events. Source: Snow AU, pp. 2–4 and 20–22.\n\n'+section('II. CORIOLANUS SNOW:','III. THE UNDERGROUND:')+'\n\n'+section('IX. MANNERISMS AND DIALOGUE','X. THE MOST IMPORTANT')+'\n')
write('characters/BASE_CHARACTER_PROFILES.md','# General AOT profiles — source text\n\nESTABLISHED source scope: general characterization reference. Snow AU overrides its later room timeline and incompatible relationship assumptions. These profiles contain private character information, examples and discussion of other fiction; none is automatic shared room knowledge. Final Snow room roster is UNRESOLVED.\n\n'+base[base.index('1. Petra Ral'):base.index('The most useful relationship map')].strip()+'\n')
# Inventory app assets without copying unrelated stories or confidential configuration.
app=Path('/workspace/inky-paws');files=[];groups={}
for p in sorted(app.rglob('*')):
 if p.is_file():
  raw=p.read_bytes();h=hashlib.sha256(raw).hexdigest();files.append({'path':str(p.relative_to(app)),'bytes':len(raw),'sha256':h,'snow_project_source':False});groups.setdefault(h,[]).append(str(p.relative_to(app)))
write('project-documentation/WORKSPACE_INVENTORY.json',json.dumps({'root':str(app),'scope':'App code and unrelated existing AU data; no Snow project before supplied PDFs','files':files,'byte_identical_duplicate_groups':[g for g in groups.values() if len(g)>1]},indent=2)+'\n')
print('Preserved and verified',len(manifest),'original PDFs; extracted complete text. No source file modified.')
