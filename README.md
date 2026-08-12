Knowledge Hub:
An internal support tool that turns your published Intercom articles into a
searchable knowledge base and answers questions with the source article + URL.
What you need to set (in Vercel → Project → Settings → Environment Variables)
Name	What it is
`SUPABASE_URL`	Supabase → Project Settings → Data API → Project URL
`SUPABASE_SERVICE_ROLE_KEY`	Supabase → Project Settings → API Keys → `service_role` (secret)
`NEXT_PUBLIC_SUPABASE_URL`	The same Supabase Project URL, used by Google sign-in in the browser.
`NEXT_PUBLIC_SUPABASE_ANON_KEY`	Supabase → Project Settings → API Keys → `anon` / publishable key.
`APP_PASSWORD`	Any password you choose. Everyone using the app types this.
`ENCRYPTION_SECRET`	A long random string. Used to encrypt the vault. Never share it.
`CRON_SECRET`	A second long random string. Vercel uses it to authenticate automatic sync.
Your Intercom and OpenAI keys do NOT go here — you paste those into the
app's Admin page after it's live.
Order of setup
Run the Supabase SQL (creates the `articles`, `chunks`, `settings` tables + search function).
Push this folder to GitHub.
Import the repo into Vercel and add the 7 variables above. Deploy. Automatic schedules below 24 hours require a Vercel plan that supports hourly cron jobs.
Open the app → sign in with `APP_PASSWORD` → go to Admin → paste your Intercom + OpenAI keys → Save.
On the main page, press Check for updates to build the knowledge base.
Ask questions.
Notes
Answering model defaults to `gpt-5.6-luna`; change it any time in Admin.
Only changed/new articles are re-processed on each "Check for updates"..
