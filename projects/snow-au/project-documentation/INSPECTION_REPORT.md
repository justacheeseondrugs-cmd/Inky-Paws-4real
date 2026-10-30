# Inspection report — 2026-10-30

## What was inspected

The accessible workspace, `/workspace/inky-paws`, empty shared download/library/scratch locations, accessible attachment locations, app import/export code, local Git status and the known Inky Paws repository's current `main` tree. No AGENTS.md was found in the workspace. No Git history-wide search or access to the author's browser IndexedDB was performed.

The initial workspace contained app code and reference material for Original/Kael, Violet, A Day Off and Your Name. Searches for Coriolanus, Panem and Hunger Games found no project material; “snow” matches in the reference fiction described ordinary snow. The current remote tree likewise contained no Snow AU project, compressed archives or Snow chapter files.

The author subsequently supplied three PDFs. Their master copies have been copied without modification into `archives/originals/`, with before/after SHA-256 verification and complete `pdftotext -layout` working extractions. No ZIP, TAR, RAR or 7z was supplied, so no compressed-container extraction was performed.

## Belongs to this project

- Snow AU PDF: authoritative project-specific dossier.
- FF Character Bible PDF: author-supplied general characterization reference, subject to Snow overrides.
- Power to Strive PDF: author-supplied third-party reference fiction by ii-Phoenix-ii, not this project's chapter canon.
- This preparation's documentation, source manifest, extracted working references and optional import pack.

App code is inspected as workflow configuration, not copied as Snow story canon. Existing unrelated AU packs and story bibles are excluded.

## Duplicates and version differences

No byte-identical duplicate group was found among the 56 existing local app files. See WORKSPACE_INVENTORY.json for file sizes and SHA-256 values. This does not assert that different files never share passages.

The newly extracted general character bible matches `inky-paws/data/violet/character-bible.txt` after removal of extraction whitespace and zero-width U+200B characters. The newly extracted Power to Strive matches `inky-paws/data/violet/power-to-strive-i.txt` after whitespace normalization. These are **reference-content matches**, not assertions that the original PDFs or extracted files are byte-identical. All supplied copies are retained.

No alternate Snow dossier, approved chapter, earlier Snow draft or author-labeled discarded file was found. Therefore none has been declared obsolete, superseded or discarded on the basis of filenames or modification times. This Snow dossier is the only supplied AU-specific version, not a verified latest chapter revision.

Conflicts: the generic bible's later room timeline is superseded by the Snow-specific pre-trial setting. Snow's own first-meeting date versus eight years apart needs clarification; see TIMELINE.md. Explicitly retain Erwin/Levi's non-couple status. Levi's own memories are an exception to the room's general ignorance of Snow.

## Git and publication findings

`git -C /workspace status` and `git -C /workspace/inky-paws status` report “not a git repository.” The visible `/workspace/.git` is an empty read-only directory, not usable repository configuration. Thus no local branch, remote URL, .gitignore, staged changes or commit history is configured for these files. No Git initialization, remote assignment, commit or push was performed.

The repository identified in the earlier conversation is `justacheeseondrugs-cmd/Inky-Paws-4real`, default branch `main`, visibility **public**, with the connected GitHub account reporting push permission. That is a known external app repository, **not evidence of a configured local Git remote or approval for publishing these sources**. Its `deploy-pages.yml` deploys pushes to `main`. No .gitignore appeared in the inspected local files or remote current tree.

No PDF archives, personal sources or generated preparation files have been uploaded. Destination/visibility approval is required by the current user instruction before public upload. Prefer a source-only private destination if these archives should remain private; the author must choose.

## Limits and safety checks

All three source PDFs are individually below 3 MiB, and none approaches GitHub's 100 MiB single-file limit. A future upload must still check the destination's rules, storage and permissions. This folder deliberately excludes .aws, .codex, .agents, API settings, browser backups and unrelated personal files. Its local .gitignore is precautionary; it does not make tracked files private or authorize publication.

The existing backup implementation excludes API credentials, but a browser backup can still contain every workspace's private stories. Review and scope any future backup locally before copying it into an upload set.

Chapter One is absent. No chapter has been touched; its exact preservation is not verifiable until supplied. The next approved chapter is likewise unknown. These missing sources block completion of the chapter-continuity and publication phases.

## Subsequent publication authorization

After reviewing the local package, the author asked to make it public. The publication copy is authorized for the existing public Inky Paws repository on main. The initial no-upload statements above describe the inspection phase, not the later publication decision. No chapter edits or browser installation are included.
