# Micrologic Employee Portal (Google Sheet version)

Employees open the Netlify site, tap their role (**Field Technician** or **Project Manager**), and see buttons that open the pages they need.

Most buttons come from a **Google Sheet** through **Apps Script**. A few **built-in buttons** are written directly into `index.html` and always show, whatever is on the sheet.

```
Employee ──► Netlify site (netlify/index.html)
                 │  ├─ built-in buttons (in the file)
                 │  └─ fetch ?action=portal
                 ▼
           Apps Script web app (apps-script/Code.gs)
                 ▼
           Google Sheet: Settings · Roles · Links
```

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | Apps Script backend. It reads the sheet, handles the admin login, and adds a **Portal** menu to the sheet. |
| `netlify/index.html` | The portal page. It has your Apps Script URL and the built-in buttons. |
| `netlify/netlify.toml` | Netlify settings. |

---

## Built-in buttons (Project Management)

These three are written into `netlify/index.html` and always show on the **Project Manager** dashboard:

| Button | Opens |
|---|---|
| SOLA Portal | https://partner.cardknox.com/login |
| On Site Field Tech Orders | The On Site Field Tech Orders Google Sheet |
| Backorder Equipment Log | The Backorder Equipment Log Google Sheet |

They're listed with order numbers 11, 12 and 13, so they come after Product Request (order 10).

**To change them:** open `netlify/index.html`, find `const BUILT_IN_LINKS = [`, edit the list, and re-upload to Netlify.

- Built-in buttons don't appear on the admin screen, because the admin screen edits the sheet.
- If you later add a button with the same name and role to the sheet, the sheet's version is shown and the built-in copy is skipped, so you never get duplicates.
- The two Google Sheets links only open for people those sheets are shared with.

---

## Setup

### 1. Google Sheet + Apps Script
1. Create a blank Google Sheet. Any name works, e.g. **Micrologic Portal**.
2. Go to **Extensions → Apps Script**, paste in `apps-script/Code.gs`, and click **Save**.
3. Choose **setupSheets** in the function dropdown and click **Run**. Approve permissions when asked.
4. Three tabs appear in the sheet: **Settings**, **Roles** and **Links**. Don't rename them.

### 2. Deploy Apps Script as a web app
1. Click **Deploy → New deployment → Web app**.
2. Set **Execute as** to **Me**. Set **Who has access** to **Anyone**, or the widest option your Workspace allows.
3. Copy the URL ending in `/exec`.

After you change `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version → Deploy**. This keeps the same URL.

### 3. Netlify
1. In `netlify/index.html`, set `const APPS_SCRIPT_URL = "...";` to your `/exec` URL.
2. Drag the `netlify` folder onto **app.netlify.com → Add new site → Deploy manually**, or deploy from Git.

---

## Editing buttons

- **Admin screen:** click **Admin** at the bottom of the portal and log in (default `micrologic` / `mlaboss`). From there you can add, edit, hide or delete the sheet's buttons. To change the password, run `changeAdminLogin` in Apps Script, or edit `ADMIN_USER` and `ADMIN_PASS` in **Project Settings → Script Properties**.
- **Directly in the sheet:** use the **Links** tab, which has these columns:

| Column | What to enter |
|---|---|
| Roles | `technician`, `pm`, or both separated by a comma |
| Section | The heading the button appears under |
| Title / Description | The button's text |
| URL | Must start with `https://`. Leave it blank to show "Coming soon". |
| Icon | `clipboard` `search` `wrench` `box` `map` `grid` `truck` `users` `chart` `idcard` `gear` `file` `folder` `calendar` `camera` `phone` `link` `person` |
| Order | Lower numbers come first |
| Active | `TRUE` / `FALSE` |

The **Roles** tab sets the role buttons on the home screen: name, description, color and on/off. The **Settings** tab sets the header text and announcement banner.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Couldn't load the portal" | Open `YOUR_URL?action=portal` in a browser. If Google asks you to sign in, the deployment isn't public. |
| `Missing tab "Links"` | Run **Portal → Set up sheets**. |
| A sheet change doesn't show | Use **Portal → Refresh portal now**, then reload the site. |
| A button says "Coming soon" | Its URL is blank or doesn't start with `https://`. |
