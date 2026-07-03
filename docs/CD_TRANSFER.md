# Secure Radiology-CD Transfer

Move a patient's radiology CD from a remote branch to the main site — browser +
server only, **no software to install** on the receiving machine. A branch
employee uploads a full CD image (ISO or ZIP) through a private link; an
authorised user downloads it and imports it into PACS via **Import from CD**.

## What was built

| Piece | Where |
|---|---|
| Public upload page (token link) | `GET /cdupload?t=…` → `dashboard/cdupload-public.html` |
| Upload API (chunked, token-gated) | `POST /api/public/cdxfer/init` · `/chunk` · `/finish` |
| Admin tab (list / download / delete / link) | sidebar **CD Transfers** → `dashboard/js/cdxfer.js` |
| Admin API (login-protected) | `/api/cdxfer/list` · `/{ref}/download` · `DELETE /{ref}` · `/public-link[/regenerate]` |
| Storage + log | disk `CDXFER_DIR` + table `scheduling.cd_transfers` |
| Auto-delete | background sweep every 30 min, TTL `CDXFER_TTL_HOURS` |

## Security model

- **HTTPS** (the app is already TLS).
- Upload page is **not public** — gated by an unguessable rotatable token in the
  link; the token check is constant-time.
- **Only ISO/ZIP** accepted; executables (`.exe/.bat/.cmd/.msi/…`) rejected.
  Content is sniffed by magic bytes (`PK…` for ZIP, `CD001` for ISO9660).
- **Size cap** `CDXFER_MAX_BYTES` (default 4 GB), enforced on init and while
  appending chunks.
- **Download is login-only** — the public link can *upload* but never *list* or
  *download*. Only an authorised dashboard user (admin/manager/superadmin) can
  download.
- **No patient name in links or filenames** — the URL carries only a token; the
  stored file is a random UUID; the download name is `REF_<fileNo>.iso/zip`.
  Patient initials are optional.
- **Operations log**: the `cd_transfers` row records upload time, download time,
  uploader, size, status, and the upload/download IP; admin actions also go to
  the audit log.
- **Short retention**: files auto-delete after the TTL (48 h by default); the log
  row is kept, marked `expired`.
- DICOM is preserved as-is — nothing is transcoded to JPG/PDF and the CD image is
  never modified. For ZIPs a best-effort check reports whether a `DICOMDIR` or
  `.dcm` files are inside.

## 1) Server setup (one-time)

Set these environment variables on the server (Railway → Variables):

| Var | Default | Notes |
|---|---|---|
| `CDXFER_DIR` | system temp `/…/meena_cdxfer` | **Point this at a persistent volume** (see below) |
| `CDXFER_MAX_BYTES` | `4294967296` (4 GB) | raise/lower the per-file cap |
| `CDXFER_TTL_HOURS` | `48` | auto-delete window |
| `APP_URL` | (already set) | used to build the `/cdupload` link |

The `scheduling.cd_transfers` table is created automatically on startup — no
migration step.

> **Persistent storage (recommended).** On Railway the container filesystem is
> ephemeral: a redeploy wipes uploads. Mount a **Volume** and set `CDXFER_DIR`
> to its mount path (e.g. `/data/cdxfer`) so an in-flight transfer survives a
> deploy. Files are still auto-deleted after the TTL. Make sure the volume is at
> least a few × your max file size.

Then, in the app: open **CD Transfers** in the sidebar → copy the **Branch upload
link** and share it privately with the branch (the same link is reusable; rotate
it with **Regenerate** if it leaks).

## 2) Branch employee — how to send a CD

**Easiest way (no ISO/ZIP needed):**
1. Put the CD in the drive.
2. Open the **upload link** the radiology team shared.
3. Fill: **medical file number** (required), branch, exam type, exam date,
   **your name** (required), optional initials / note.
4. Press **Choose the CD (whole disc / folder)** → in the picker select the CD
   drive (e.g. **DVD RW Drive (D:)**) → **Select Folder** → allow "upload N
   files". Everything on the disc is sent, DICOM files unchanged; the server packs
   them into one ZIP for you.
5. **Upload securely** → watch the progress → keep the **reference number**.

**Alternative (if you already have an image file):** use *Upload a ready ISO or
ZIP file* instead — an ISO of the disc, or a ZIP of all its contents (right-click
the CD's files → **Send to → Compressed (zipped) folder**).

> The folder option needs Chrome or Edge (both are fine on the branch PC). Whether
> the branch sends a folder, a ZIP, or an ISO, you receive a downloadable file.

## 3) You (receiving user) — download & import into PACS

1. Open **CD Transfers** → find the row (by file number / branch / time) → it
   shows size, uploader, status and the DICOMDIR check → **Download**.
2. **If it's an ISO:**
   - In Windows Explorer, **right-click the .iso → Mount**. A new drive letter
     appears as if a CD is inserted.
   - Open **PACS → Import from CD** and point it at that drive.
   - When done, right-click the drive → **Eject**, and **Delete** the row here.
3. **If it's a ZIP:** extract it to a folder. Use **Import from Folder** if your
   PACS supports it (point at the folder containing `DICOMDIR`). If your PACS only
   does *Import from CD*, convert the folder to an ISO first (or ask the branch to
   send an ISO next time).

### If "Mount" is disabled on your machine

Windows' built-in ISO mount can be locked down by policy. Options, in order:
- Ask **IT** to enable "Mount" for ISO files (no third-party software needed).
- Ask the **PACS admin** to enable **Import from Folder** (then a ZIP is enough).
- As a fallback, have the **branch import the CD directly into PACS** on their
  side if they have PACS access.

## 4) Housekeeping

- Files auto-delete after `CDXFER_TTL_HOURS`. You can also **Delete** any row
  manually the moment you've imported it — do this; don't leave patient imaging
  sitting on the server.
- Every upload/download/delete is logged (time, IP, uploader, size, status).

## Future enhancements

1. **Resumable uploads** — remember the last received offset per `upload_id` so a
   dropped 4 GB upload resumes instead of restarting.
2. **Server-side ZIP→ISO** conversion so you always get a mountable ISO
   regardless of what the branch sent (needs `genisoimage`/`mkisofs` on the VPS).
3. **Deeper DICOM validation** — parse `DICOMDIR`, show patient/study summary and
   image count before download, and warn if the file number doesn't match.
4. **Per-branch links / accounts** instead of one shared token, with per-branch
   audit.
5. **Client-side checksum** (hash the file, verify after upload) to guarantee an
   intact copy.
6. **Antivirus scan** hook on `finish` before the file is downloadable.
7. **Encryption at rest** for the stored images.
