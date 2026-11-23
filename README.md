# Finances: setup guide

A small app for your bank transactions: import UBS (or other) Excel/CSV exports, log expenses by hand, classify them, and see monthly summaries. Works on iPhone and computer, synced through **your own Dropbox**, optionally **encrypted with your password**.

## How your data is protected

- The app is only a web page (HTML + JavaScript). It contains **no data**.
- Your transactions are stored (1) on each device and (2) in one file: `Dropbox › Apps › <your app name> › finances.json`.
- The Dropbox connection can only access that one app folder, nothing else in your Dropbox.
- With an encryption password, the file is encrypted on your device (AES-256-GCM) before upload, so Dropbox can't read it. **If you forget the password, the Dropbox copy can't be recovered.** Write it down somewhere safe.
- Never put bank files (`.csv`, `.xlsx`) into the `app` folder you publish; `.gitignore` already blocks them.

---

## Step 1: Put the app online (GitHub Pages, free)

The phone needs an `https://` address. GitHub Pages hosts the page for free (the code is public, your data is not).

1. Go to https://github.com/new and create a **public** repository named `finances`.
2. Click **"uploading an existing file"** and drag in **everything inside this `app` folder**: `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, the three `.png` icons, and the `vendor` folder. **Do not upload any bank file.** Commit.
3. Open **Settings → Pages**. Under *Build and deployment*, set Source = **Deploy from a branch**, Branch = **main**, folder **/ (root)** → **Save**.
4. After about a minute your app is at **`https://<your-github-username>.github.io/finances/`**.

## Step 2: Create your private Dropbox "app" (about 3 minutes)

1. Go to https://www.dropbox.com/developers/apps and click **Create app**.
2. Choose **Scoped access** → **App folder** → name it something unique, e.g. `MyFinancesSync-2026` → **Create app**.
3. Open the **Permissions** tab, tick **files.content.write** and **files.content.read**, then click **Submit**.
4. Open the **Settings** tab:
   - Under **OAuth 2 → Redirect URIs**, add exactly your app address from step 1, including the final `/`, e.g. `https://<your-github-username>.github.io/finances/` → **Add**.
   - Copy the **App key**. It isn't secret (the app uses secure PKCE login, so no app secret is needed). **Never paste the App secret anywhere.**

## Step 3: Computer

1. Open your app address in Chrome or Safari.
2. **Settings** → paste the **App key** → **Connect Dropbox** → **Allow**. You come back to the app, connected.
3. **Settings → Encryption password**: choose a password → **Save password**.
4. **Import** → choose your UBS export. Check the numbers → **Import**.
5. **Transactions** → tap **⚠ uncategorised** to classify the rest. When you pick a category, leave *"Always classify transactions containing…"* ticked so similar ones (now and in future imports) are done automatically. Shorten the text to make the rule broader, e.g. `COOP-6116 GE CITY` → `COOP`.

## Step 4: iPhone

1. Open your app address in **Safari** → **Share** button → **Add to Home Screen**.
2. Open **Finances** from the home screen (not Safari: the home-screen app has its own storage).
3. **Settings** → paste the **App key** → **Connect Dropbox**. A Dropbox window opens → **Allow** → Dropbox shows a **code** → copy it → close that window → paste the code in the app → **Finish connecting**.
4. Enter the **same encryption password** → **Save password**. Your transactions appear.

From then on, anything you add or classify on one device appears on the other within seconds (or when you next open the app).

---

## Tips

- **UBS exports stop at 1,000 transactions.** For longer histories, export in smaller periods (e.g. 6 months at a time). Overlaps are fine: already-imported transactions are skipped.
- UBS rows without a date ("Sous-montant") are breakdowns of a grouped payment and are skipped on purpose, so they aren't counted twice.
- **Transfer** categories (e.g. moving money between your own accounts) are left out of income/expense totals.
- **Settings → Data → Export for Excel** gives you a `.csv` with all transactions and categories.
- To use another bank: import its file, and if the columns aren't recognised, pick them in the drop-downs. The app remembers the choice for that bank's format.

## Updating the app later

Upload the changed files to the same GitHub repository. The app picks up the new version the next time it's opened online. Your data is not affected.

## Testing locally

```bash
python3 -m http.server 8791 --bind 127.0.0.1 --directory app
```
Then open http://localhost:8791/. To use Dropbox locally, add `http://localhost:8791/` as an extra Redirect URI.
