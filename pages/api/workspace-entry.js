import { authenticateRequest, logActivity, supabaseAdmin } from '../../lib/server';

// Updating this release object as part of a deployment automatically shows the
// real release notes once to every user, including Admins.
const CURRENT_RELEASE = {
  version: '2026.09.04-notices',
  title: 'What’s new',
  changes: [
    'CEx Notices are now included in the knowledgebase.',
    'Multi-question client messages are handled part by part.',
    'Account-model recognition and wrong-model source protection have been improved.',
    'Answer interpretation and evidence details are now recorded for Admin review.'
  ]
};

const ACK_VERSION = 'qc-review-v1';
const DISCLAIMER = 'This assistant is a support tool, not a replacement for agent review. Thoroughly review the answer, selected Account model, and cited sources before sending anything to a client. A QC audit failure caused by using this chatbot will not be accepted as a valid explanation.';

function dhakaDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

export default async function handler(req, res) {
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    const today = dhakaDay();
    if (req.method === 'POST') {
      const releaseVersion = String(req.body?.releaseVersion || '');
      if (releaseVersion !== CURRENT_RELEASE.version) return res.status(400).json({ error: 'The acknowledgement is out of date. Please refresh.' });
      const id = await logActivity({
        actorRole: access.role, sessionId: access.sessionId, userName: access.name,
        userEmail: access.email, authProvider: access.authProvider,
        eventType: 'workspace_acknowledgement', success: true,
        metadata: { day: today, acknowledgementVersion: ACK_VERSION, releaseVersion: CURRENT_RELEASE.version, disclaimer: DISCLAIMER }
      });
      if (!id) throw new Error('The acknowledgement could not be recorded. Please try again.');
      return res.status(200).json({ ok: true, recorded: true });
    }

    const { data, error } = await supabaseAdmin().from('activity_logs')
      .select('created_at,metadata').eq('event_type', 'workspace_acknowledgement')
      .eq('user_email', access.email).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    const acknowledgements = data || [];
    const acknowledgedToday = acknowledgements.some((item) => item.metadata?.day === today && item.metadata?.acknowledgementVersion === ACK_VERSION);
    const sawRelease = acknowledgements.some((item) => item.metadata?.releaseVersion === CURRENT_RELEASE.version);
    return res.status(200).json({
      required: !acknowledgedToday || !sawRelease,
      showRelease: !sawRelease,
      release: CURRENT_RELEASE,
      disclaimer: DISCLAIMER,
      acknowledgementVersion: ACK_VERSION
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
