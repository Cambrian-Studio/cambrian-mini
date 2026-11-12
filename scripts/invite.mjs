// invite.mjs — `npm run invite -- <member>`: print a one-time enrolment link for a council member.
// The link is shown once. Only its hash is stored (outside the repository), it expires in 24 hours,
// and it enrols exactly one passkey for exactly that member.
import { appConfig } from '../app/config.mjs';
import { council } from '../app/store.mjs';
import { createInvite } from '../approvals/council.mjs';

const member = process.argv[2];
const cfg = appConfig();
const c = council(cfg);
if (!member) { console.error(`usage: npm run invite -- <${c.members.map((m) => m.id).join('|')}>`); process.exit(2); }
try {
  const inv = createInvite({ invitesFile: cfg.files.invites, council: c, memberId: member });
  const origin = cfg.rp.origin ?? c.rp.origins[0];
  console.log(`One-time enrolment link for ${member} (expires ${inv.expires_at}):`);
  console.log(`${origin}/#/enrol/${inv.token}`);
  console.log('Open it on the device whose passkey should approve. It works once.');
} catch (e) { console.error(String(e.message)); process.exit(1); }
