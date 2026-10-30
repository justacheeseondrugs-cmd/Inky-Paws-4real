# Inky Paws workflow — inspected existing formats

This documents existing app behavior. No new import schema or app feature is invented, and no import has been performed.

## Reference source locations

Inspected: `/workspace/inky-paws/js/app.js`, especially `cleanStoryPackCharacter` and `importStoryPackFile`; `/workspace/inky-paws/js/db.js`, especially `exportAll` and `importAll`; and `/workspace/inky-paws/js/ui/settings.js` for backup controls. Existing app-specific workspace seeders provide another format, but adding a new seeder would require an app change and publication; none was added for Snow.

## Established story-pack format

The existing “Importar pack” handler accepts a JSON object with `__meta` (or `meta`) whose `app` may be `inky-paws-story-pack` or `pts-story-pack`. It imports these existing fields:

- `characters`: recognized fields are `name`, `pronouns`, `personality`, `speechStyle`, `hardRules`, `currentKnowledge`, `relationships`, `chemistry`, `neverDoRules`, `active`.
- `lockedFacts`: strings, or objects containing `text` and optional `isCore`.
- `canonNotes`: strings, or objects containing `text` and `visibility`; default is private, and only explicit `revealed` becomes revealed.
- `authorBrain`: optional existing settings, not needed for this preparation.

The UI imports into the active non-original workspace and merges profiles by lowercase name. **It can overwrite matching profile fields in that workspace.** It does not create a workspace or import chapter text, documents or document chunks. Do not claim a pack import preserves or restores chapters. It does not assign an automatic Snow watching-room roster.

`inky-paws/snow-au-story-pack.json` in this preparation uses this inspected format. It contains profiles and author-level rules/private dossier notes; it contains no chapter text. Its list of profile subjects is not a room roster. Uploading it to GitHub does not by itself import it into browser storage.

## Local-only preparation workflow — PROPOSED

1. In the author's existing Inky Paws browser, use **Ajustes → Exportar copia completa** to preserve current local data first. Keep that export private; it may include unrelated workspaces even though the app strips API keys.
2. Identify the existing Snow workspace and approved chapters from that export before changing anything. Do not create an accidental replacement for an existing story or overwrite its profiles blindly.
3. For a fresh workspace, create an independently named Snow workspace, then use **Importar pack** with this preparation's JSON. For an existing Snow workspace, compare profile changes and confirm them before importing because matching names are updated.
4. Upload the chosen reference PDFs or Markdown files through the app's Documents workflow. Suggested scopes below are **PROPOSED**, not unreviewed app configuration.
5. Keep dossier knowledge private in author references. Only actual screen/room revelations should become revealed continuity. Consult MASTER_CONTEXT, RELATIONSHIPS, TIMELINE and CHAPTER_CONTINUITY separately.
6. Supply and verify exact Chapter One before continuing. A story pack will not restore it. Do not write any chapter during this preparation task.

## Suggested document scope — PROPOSED

| Reference | Suggested existing app type | Use |
| --- | --- | --- |
| MASTER_CONTEXT / STORY_BIBLE / CONTINUITY_NOTES | CONTINUITY | Author-level rules; never automatic shared knowledge |
| Snow AU original, SNOW_PROFILE, BASE_CHARACTER_PROFILES | CHARACTER | Profiles, source-specific overrides, voice |
| RELATIONSHIPS | CHARACTER | Pairwise states and boundaries |
| TIMELINE | CONTINUITY | Historic sequence and dating ambiguities |
| CHAPTER_CONTINUITY | CONTINUITY | Approved events only, once actual chapters are supplied |
| Power to Strive | STYLE_ONLY | Ensemble/reference technique; not Snow canon or replacement prose |

Documents are not established chapter drafts. Prompts and brainstorms, if later supplied, should be labeled separately from approval-backed chapters. Source sketches in the dossier remain proposals or examples unless explicitly established.

## Complete browser backup format

`db.exportAll()` creates the existing `pts-studio` JSON backup with arrays of stores such as `chapters`, `characters`, `documents`, `docChunks`, `lockedFacts`, `canonNotes`, `settings` and memory data. This is different from a story pack. The full import can clear stores when not merging and can affect other workspaces. Do not use a synthetic all-workspace backup to install Snow or upload a whole personal backup to the public app repository.

## Publication gate

No local remote is configured. The previously used app repository is public and auto-deploys `main`. Obtain the author's destination and visibility approval before copying originals or preparation data there. A .gitignore is not a privacy boundary for tracked files.

## Later public publication

The author subsequently approved public publication of this package in the existing Inky Paws repository. Public files do not automatically install the optional pack or PDFs into browser storage. The workflow and chapter-preservation safeguards above still apply.
