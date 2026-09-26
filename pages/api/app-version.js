import packageInfo from '../../package.json';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const version = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_RELEASE_VERSION || packageInfo.version;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  return res.status(200).json({ version: String(version), deployedAt: process.env.VERCEL_GIT_COMMIT_MESSAGE || null });
}
