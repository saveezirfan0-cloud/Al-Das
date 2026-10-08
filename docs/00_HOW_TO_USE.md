# How to use this pack

## What each file is for

| File | Who reads it | Use it for |
|---|---|---|
| `AlDas_InHouse_Clinic_Platform_Proposal.pdf` | **Client** (Saeed / management) | The pitch: scope, delivery plan, running costs and savings. Send it, nothing else |
| `00_HOW_TO_USE.md` | You | This guide |
| `01_FEASIBILITY_AND_TEARDOWN.md` | You + Claude Code | **Functional spec**: every Sanoflow screen, field, flow node and integration, plus WhatsApp feasibility. Claude Code reads it to know *what* to build. (Its stack section is outdated; `02` wins) |
| `02_CLAUDE_CODE_BUILD_PLAN.md` | Claude Code (and you) | **How to build**: Supabase + Vercel stack, data model, jobs design, WhatsApp, back office, Unite, phases with **copy-paste prompts** |
| `03_CLAUDE.md` | Claude Code (auto-loaded) | **Rules Claude Code must always follow** (RLS, PHI, Unite read-only, Finance API guard, queues, clinical rules). Rename to `CLAUDE.md` at the repo root |
| `audit/airtable-schema.md` | Claude Code | What's in Al Das's 5 Airtable bases, the clinical rules hidden in field descriptions, and the mapping to new tables |
| `audit/make-scenarios.md` | Claude Code | All 49 Make scenarios: the 7 active ones explained step by step with native replacements, the rest triaged, and a parallel-run checklist |
| `audit/make-raw/` | Claude Code | Scenario list + redacted blueprints + per-scenario flow summaries |
| `scripts/export-airtable-schema.ts` | You run it | Re-pulls exact Airtable schema JSON (+ record counts) via the Airtable API |
| `scripts/export-make.ts` | You run it | Re-pulls every Make blueprint via the Make API, **auto-redacting secrets and sample patient data** |
| `scripts/import-airtable.README.md` | Claude Code | Spec for the Airtable → Supabase record importer (idempotent, dry-run, no PHI in reports) |
| `scripts/mcp.json.example` | You | Connect Claude Code directly to Make, Airtable and Supabase via MCP |

## Step by step

1. **Pitch first.** Send the PDF. Replace the savings estimates with real invoice numbers if you can get them.
2. **Create the repo.**
   ```
   mkdir pulse && cd pulse && git init
   cp 03_CLAUDE.md CLAUDE.md
   mkdir -p docs scripts && cp 01_*.md 02_*.md docs/ && cp -r audit docs/audit && cp scripts/* scripts/
   echo ".env.local\n.mcp.json\ndocs/audit/airtable-raw/*records*\n" >> .gitignore
   ```
3. **Set up data access** (02 → Phase 0b): create the Airtable PAT and Make API token and put them in `.env.local`. Optionally `cp scripts/mcp.json.example .mcp.json` so Claude Code can query Make/Airtable/Supabase itself.
4. **Refresh the audit** (the scripts run once the app is scaffolded and `tsx` is installed; or ask Claude Code to run them):
   ```
   pnpm tsx scripts/export-airtable-schema.ts --counts
   pnpm tsx scripts/export-make.ts --all
   ```
5. **Open Claude Code in the repo** and work phase by phase:
   - Press `shift+tab` for **Plan Mode**, paste the phase prompt from `docs/02`, review the plan, then let it build.
   - After each phase: `pnpm typecheck && pnpm lint && pnpm test`, click through the demo checklist, then commit.
   - Start a **fresh Claude Code session per phase** (`/clear`) so context stays focused. CLAUDE.md and the docs carry the memory.
6. **Migration and cut-over** (Phases 8–11): run Make and the native jobs in parallel in *Test* send mode, tick the checklist in `audit/make-scenarios.md`, import Airtable with `--dry-run` then for real, switch WhatsApp numbers one at a time, then retire Make → Airtable → Sanoflow.

## Things to clear up with the client early
- **Clinical sign-offs** already flagged in their Airtable: 85 vs 90-day recall target, the day-3 check offset, probiotic duration (10 days), the feedback red-flag threshold (5), the doctor → department routing lists, and the clinic working week and holidays.
- **Unite:** fresh API keys for the new platform, and confirmation of rate limits. The Finance API is sync-once, so agree a plan before touching it.
- **WhatsApp:** confirm Al Das owns the WABA (so it can be moved off Sanoflow).
- Which Google Sheet the reminder scenarios use, and what for.
- Whether the old/backup Airtable bases (Unite copies, "2025") can be ignored.

## Security note
The Make blueprints contain Unite and Sanoflow credentials in plain text. The exported copies here are **redacted**, but the originals in Make are not. Move the credentials into the new platform's encrypted settings, and **ask Unite to rotate the keys at cut-over**.
