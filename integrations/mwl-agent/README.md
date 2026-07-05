# Meena MWL agent — the on-site worklist watcher

A small watcher that runs on a hospital-LAN PC and closes the accession gap:
Siratech generates an accession per radiology order and publishes it ONLY on the
DICOM Modality Worklist (the feed the machines read) — its REST API returns
`accessionNumber: null`. This agent reads that worklist (C-FIND, read-only) and
pushes the entries to Meena's `/api/radiology/mwl/push`; Meena then files each
verified report to the exact order by accession instead of fuzzy matching.

```
Siratech ──MWL──▶ broker (DMWL_AE @ 10.0.73.56:104) ◀──C-FIND── this agent ──HTTPS──▶ Meena
                        ▲                                             (accession store →
                   CT / XR / US                                        deterministic filing)
```

## Broker facts (probed live 2026-07-05)
- Reachable from the hospital LAN; **not** from the VPS/cloud (private 10.x address).
- Allow-lists callers: rejects unknown AE titles; accepts **CTN3** (the CT's AE).
- Accepts **single-day** date queries only — a date range or empty date resets the
  connection. The agent therefore queries today + yesterday as two calls per cycle.

## Run (hospital PC, no installs)
1. Build the bundle anywhere with npm:
   `npx esbuild agent.js --bundle --platform=node --outfile=mwl-agent-win.js`
2. Put on the PC (e.g. `C:\mwltest`): `mwl-agent-win.js`, `RUN-MWL-AGENT.bat`, and the
   portable Node folder (`node\node.exe` — the ZIP from nodejs.org, no installer).
3. Create a dedicated Meena account for the agent (team-lead role is enough for the
   push endpoint) — do not reuse a person's login.
4. Edit the three lines at the top of `RUN-MWL-AGENT.bat` (Meena URL + credentials),
   then double-click it and leave the window open. Every cycle it logs what it pushed.

To survive reboots, add the .bat to Task Scheduler (run at logon).

## Behavior
- Read-only toward the broker; pushes only entries that carry an accession.
- Re-logs into Meena automatically when the token expires (verified in test).
- Never crashes the loop on an error — logs and retries next cycle (default 60s).
- Meena side: `scheduling.radiology_mwl` (upsert by accession, `last_seen` refreshed);
  `GET /api/radiology/mwl/recent` shows what the broker actually sends. Filing injects
  the accession only when exactly ONE entry matches that patient that day (conservative
  until real feed data teaches us the multi-order field semantics).
