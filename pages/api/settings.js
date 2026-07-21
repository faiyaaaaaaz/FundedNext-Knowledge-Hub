import { checkPassword, getPassword, saveKeys, keysStatus } from '../../lib/server';

export default async function handler(req, res) {
  try {
    const password = getPassword(req);
    if (!checkPassword(password)) {
      return res.status(401).json({ error: 'Wrong password.' });
    }

    if (req.method === 'GET') {
      const status = await keysStatus();
      return res.status(200).json(status);
    }

    if (req.method === 'POST') {
      const { intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt } = req.body || {};
      await saveKeys({ intercomToken, openaiKey, groqKey, chatModel, chatProvider, chatPrompt });
      const status = await keysStatus();
      return res.status(200).json({ ok: true, ...status });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
