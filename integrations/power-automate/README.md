# Send Meena Health emails from your Microsoft 365 work mailbox (Power Automate)

This lets the platform send its emails **from your work email** (e.g.
`you@yourclinic.com`) via a Power Automate flow, instead of SMTP/Resend.

**How it works:** the platform POSTs `{to, subject, body, text}` to a flow's
HTTP trigger → the flow's *Office 365 Outlook → Send an email (V2)* action sends
the mail from your mailbox.

---

## Option A — Import the ready-made flow (`MeenaEmailSender.zip`)

1. Go to **make.powerautomate.com** → sign in with the **work account** that
   should send the emails.
2. Left menu → **My flows** → **Import** → **Import Package (Legacy)**.
3. Upload **`MeenaEmailSender.zip`**.
4. Under **Review Package Content**:
   - *Meena Email Sender* (flow) → action **Create as new**.
   - *Office 365 Outlook* (connection) → **Select during import** → pick or
     create the connection signed in as your work account.
5. Click **Import**.
6. Open the imported flow → open the first step **When an HTTP request is
   received** → copy the **HTTP POST URL** (it appears after you Save once).

> If the legacy import errors out (Microsoft changes this format occasionally),
> use **Option B** — it takes ~2 minutes and always works.

---

## Option B — Build it by hand (most reliable)

1. **make.powerautomate.com** → **Create** → **Instant cloud flow** → name it
   `Meena Email Sender` → trigger **When an HTTP request is received** → Create.
2. On that trigger, paste this into **Request Body JSON Schema**:
   ```json
   {
     "type": "object",
     "properties": {
       "to":      { "type": "string" },
       "subject": { "type": "string" },
       "body":    { "type": "string" },
       "text":    { "type": "string" }
     }
   }
   ```
3. **+ New step** → search **Office 365 Outlook** → **Send an email (V2)**.
   Sign in with your work account when prompted.
   - **To** → dynamic content `to`
   - **Subject** → dynamic content `subject`
   - **Body** → click the `</>` (code view) on the Body box, then dynamic
     content `body` (this keeps the HTML formatting).
4. **Save.** Reopen the HTTP trigger and **copy the HTTP POST URL**.

---

## Connect it to Meena Health

### Easiest — paste it in the app (no redeploy)

Sign in as a **superadmin** → open **Leaves → ⚙️ Settings** → under **Send email
from your work mailbox (Power Automate)** paste the **full** HTTP POST URL (it
must include `&sig=`) → **Save**. You should see 🟢 **Active**, then use **Send
test email** to verify it arrives from your work address.

> In the flow, set the trigger's **"Who can trigger the flow?"** to **Anyone**,
> otherwise the platform gets a `DirectApiAuthorizationRequired` error.

### Alternative — environment variable

Instead of the in-app field you can set this on the platform (the same place
other secrets live) and redeploy:

```
EMAIL_WEBHOOK_URL = <the HTTP POST URL you copied>
```

The env var **takes precedence** over the value saved in Settings (the UI shows
"set by environment variable" when it's in effect).

Optional shared-secret check (if you add an `Authorization` condition in the
flow): `EMAIL_WEBHOOK_TOKEN = <your secret>` → the platform sends it as
`Authorization: Bearer <secret>`. This token is env-only; there is no in-app
field for it.

When a webhook URL is set (in-app or env) it takes priority over Resend/SMTP, so
every Meena email (schedule approvals, leave decisions, custom messages,
reminders…) goes out from your work mailbox.

### Payload the flow receives
```json
{ "to": "person@example.com", "subject": "…", "body": "<html>…</html>", "text": "plain text" }
```

### Test it
Use **Send test email** in Settings, or trigger any email (e.g. send a custom
message with the **Email** channel to yourself) and confirm it arrives **from
your work address**.
