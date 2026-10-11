# Stagegate Project Tracker

A single-user project tracker built around **PRINCE2 7** governance, with **ITIL 4** Change Enablement and service transition for go-live and handover. It runs in any web browser.

## Two ways to use it

| | Hosted (claude.ai artifact) | Self-hosted |
| --- | --- | --- |
| Open it | Private claude.ai link, any browser or phone | `npm start`, then http://localhost:8080 |
| Data | Saved to your claude.ai account | SQLite file (`data/stagegate.db`) |
| Install | None | Node.js 22.5+ (no npm dependencies) |

Both run the same front end (`public/`). The app detects where it is running and picks storage to match. If neither backend is available it falls back to browser storage. Use **Settings → Export / Import JSON** to move data between the two.

### Self-hosting

```bash
npm start                                   # http://localhost:8080
PORT=3000 TRACKER_PASSWORD=change-me npm start   # password-protect (HTTP basic auth, user "admin")
DATA_FILE=/srv/stagegate.db npm start       # choose where the database lives
npm test                                    # unit tests for the core logic
```

Set `TRACKER_PASSWORD` before you expose the server beyond your machine, and put it behind HTTPS (for example a reverse proxy such as Caddy or nginx).

## What's in it

**PRINCE2 7**
- Project templates: *IT service change* (with ITIL transition gates), *Standard*, *Blank*. Each one creates the stages, gate checklists and standard risks for you.
- **Enforced stage gates.** You can't close a stage until its checklist is done. Closing a stage records the date, logs the board decision, creates a lessons-review action and drafts the End Stage Report.
- **Tolerances** for time, cost, risk, scope, quality, benefits and sustainability, checked at project and stage level. A forecast beyond tolerance raises an exception and offers a drafted Exception Report.
- Registers: **Risk** (5×5 P×I heat map, proximity, owner/actionee, PRINCE2 responses), **Issue** (request for change, off-specification, problem/concern), **Quality**, **Daily Log** and **Lessons Log**.
- **PID**: roles, controls and approaches in one form, compiled into a PID document.
- Reports drafted from your data: **Highlight**, **End Stage**, **Exception**, **End Project** (with Lessons Report) and **PID**. You can copy them as Markdown, download them, or save them to the report history.

**ITIL 4 transition**
- Change records (Standard / Normal / Emergency) with CAB status, implementation, test and backout plans, and a post-implementation review.
- **One-click "Raise RFC"** from a PRINCE2 request for change or off-specification, linked both ways.
- A change calendar with **freeze windows**. Any clash is flagged.
- Final-stage gates for go/no-go, service acceptance, SLAs/OLAs, support handover, knowledge articles, CMDB updates and early life support.

**Less admin**
- A **Today** list across all projects: overdue actions, risk reviews and proximity dates, high-priority issues with no decision, tolerance breaches, stage gates due, Highlight Reports due, freeze clashes, unauthorised changes, outstanding PIRs and stale items.
- **Quick capture** from anywhere (press `/`):
  - `r: vendor may slip p4 i3 @sam due:+3w` creates a risk.
  - `i: add SSO rfc !high` creates an issue.
  - `a: send PID @me due:fri` creates an action.
  - `d:` decision, `n:` note, `c:` change, `q:` quality, `l:` lesson.
- Auto-numbered references (R001, I001, CHG-001…), inline editing and autosave.

## Project layout

```
public/index.html   page markup (wrapped in a document skeleton by the host or server)
public/styles.css   design tokens and styles (light and dark)
public/core.js      pure logic: schemas, templates, tolerances, attention rules, quick capture, reports
public/app.js       UI and storage adapters (claude.ai db / server API / browser storage)
server.js           zero-dependency Node server with built-in SQLite
test/               node:test unit tests for core.js
```
