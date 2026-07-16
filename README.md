Knowledge Hub
An internal support tool that turns your published Intercom articles into a
searchable knowledge base and answers questions with the source article + URL.
What you need to set (in Vercel → Project → Settings → Environment Variables)
Name	What it is
`SUPABASE_URL`	Supabase → Project Settings → Data API → Project URL
`SUPABASE_SERVICE_ROLE_KEY`	Supabase → Project Settings → API Keys → `service_role` (secret)
`APP_PASSWORD`	Any password you choose. Everyone using the app types this.
`ENCRYPTION_SECRET`	A long random string. Used to encrypt the vault. Never share it.
Your Intercom and OpenAI keys do NOT go here — you paste those into the
app's Admin page after it's live.
Order of setup
Run the Supabase SQL (creates the `articles`, `chunks`, `settings` tables + search function).
Push this folder to GitHub.
Import the repo into Vercel and add the 4 variables above. Deploy.
Open the app → sign in with `APP_PASSWORD` → go to Admin → paste your Intercom + OpenAI keys → Save.
On the main page, press Check for updates to build the knowledge base.
Ask questions.
Notes
Answering model defaults to `gpt-5.6-luna`; change it any time in Admin.
Only changed/new articles are re-processed on each "Check for updates".
