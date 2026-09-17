# Line Studio — Save to Google Drive setup

About five minutes in the Google Cloud console, once. You need **one value**:
an OAuth client ID. It is not a secret — a client ID identifies the app, not
you, and is meant to sit in public JavaScript.

When you are done, paste it into the `CONFIG` block at the top of
`line-studio/drive.js` and push.

> There is deliberately **no API key** here. An API key was only ever needed by
> the Drive file *Picker*, and this saves rather than browses. One less
> credential to create, restrict and rotate.

> Google renames these console sections periodically (the OAuth consent screen
> is now split across "Branding", "Audience" and "Clients" under **Google Auth
> Platform**). The steps below hold even when labels move — search the console
> for the bolded thing if a menu name has changed.

---

## 1. Project

<https://console.cloud.google.com> → project picker → **New project**.
Call it something like `line-studio`. Select it.

## 2. Enable the Drive API

**APIs & Services ▸ Library** → enable **Google Drive API**.

That is the only API needed. (If you previously enabled the Google Picker API
for the old import feature, you can disable it.)

## 3. Consent screen

**OAuth consent screen** (or **Google Auth Platform ▸ Branding**):

- User type **External** — "Internal" requires a Workspace org
- App name, and your email for both support and developer contact
- **Scopes**: add `.../auth/drive.file` — *"See, edit, create and delete only
  the specific Google Drive files you use with this app"*

  Do not add `drive` or `drive.readonly`. Those are *restricted* scopes and
  pull you into Google's verification review, possibly a paid annual security
  assessment. `drive.file` is non-sensitive and needs none of it — and it is
  all a writer requires.

- **Audience**: leave it in **Testing** and add your own Google account as a
  test user. Testing caps you at 100 users and expires refresh tokens weekly;
  neither matters when the user is you. You can publish later without review,
  since the scope is non-sensitive.

## 4. OAuth client ID

**Credentials ▸ Create credentials ▸ OAuth client ID**

- Type: **Web application**
- **Authorized JavaScript origins**:
  - `https://jackbron.github.io`
  - `http://localhost:4173` — optional, for local testing

  Origins only: scheme and host, no path, no trailing slash. `file://` cannot
  be authorized at all, which is why the button hides itself when the app is
  opened from disk.
- Leave **Authorized redirect URIs** empty — the token flow does not use one.

Copy the client ID → `CLIENT_ID` in `drive.js`. Done.

---

## Using it

Click **Save to Drive** in the rail. First time, you sign in and approve. It
writes `line_studio_cookbook.json` to your Drive — the same payload
**File ▸ Export cookbook** produces, every recipe plus the week plan.

Subsequent saves **update that same file in place** rather than piling up
copies. The file id is remembered locally, but Drive is asked to confirm it
still exists — so deleting the file in Drive just means the next save creates
a fresh one instead of failing.

## Getting it back

There is no import button, by design: on iOS the existing **Choose files**
button already opens the Files app with Drive in it, so importing was
redundant. Pick `line_studio_cookbook.json` there and it loads through the
normal path.

## Notes

- **The token lives in memory only**, never in storage. It lasts about an hour;
  clicking the button again refreshes it, usually with no second prompt.
- **Google's script loads on first click**, not page load, so an ordinary
  cooking session never contacts Google.
- **`drive.file` means this app can only ever see files it created itself.** It
  cannot read the rest of your Drive even if it wanted to.
- **Unconfigured is harmless**: with `CLIENT_ID` blank the button says so in the
  status bar and does nothing else.
