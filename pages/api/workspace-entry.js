import { authenticateRequest, logActivity, supabaseAdmin } from '../../lib/server';

// Updating this release object as part of a deployment automatically shows the
// real release notes once to every user, including Admins.
const CURRENT_RELEASE = {
  version: '2026.10.audit-permissions-disputes-v7',
  title: 'What’s new',
  changes: [
    'Agents with My Audits access can now review only results matched to their own Intercom email, while leads retain audit and testing controls.',
    'Agents and leads can dispute an audit; approved decisions become audit-only guidance and never affect customer chatbot answers.',
    'Audit history now shows color-coded category and final scores, and live transcript images can be opened from the result modal.',
    'Balanced workflow assignment is no longer mistaken for self-assignment, while confirmed self-assignment still sets Efficiency to 0/10.',
    'Investigation-status mistakes and review opportunities now follow the clarified Process & Judgment rules.',
    'Private answer transport fields are removed before an answer reaches the conversation.'
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
  res.setHeader('Cache-Control', 'no-store');
  try {
    const access = await authenticateRequest(req);
    if (!access) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

    const today = dhakaDay();
    const sb = supabaseAdmin();
    if (req.method === 'POST') {
      const releaseVersion = String(req.body?.releaseVersion || '');
      if (releaseVersion !== CURRENT_RELEASE.version) return res.status(400).json({ error: 'The acknowledgement is out of date. Please refresh.' });
      const recorded = await logActivity({
        actorRole: access.role, sessionId: access.sessionId, userName: access.name,
        userEmail: access.email, authProvider: access.authProvider,
        eventType: 'workspace_acknowledgement', success: true,
        metadata: { day: today, acknowledgementVersion: ACK_VERSION, releaseVersion: CURRENT_RELEASE.version, disclaimer: DISCLAIMER }
      }, { sb, returnId: false });
      if (!recorded) throw new Error('The acknowledgement could not be recorded. Please try again.');
      return res.status(200).json({ ok: true, recorded: true });
    }

    const { data, error } = await sb.from('activity_logs')
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
