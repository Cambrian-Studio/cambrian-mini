// Receipts: every finished run's receipt, with a Verify button that recomputes its hash in the browser.

import * as api from '../lib/api.js';
import { hashOfAsync } from '../lib/canonical.mjs';
import {
  h, put, plural, cap, card, dot, usd, count, when, short, seconds, between, ext, stateChip, originChip, isImported, IMPORTED,
} from '../lib/ui.js';

// Two different things can sign a call, and the receipt says which. They are not the same strength of claim.
const SIGNED_BY = {
  gateway: 'gateway-signed (NEAR AI\'s attested gateway relayed these bytes; not signed by the model)',
  provider_tee: 'model-signed (signed inside the model\'s TEE)',
};

const kvRows = (obj) => h('dl.kv', {}, Object.entries(obj || {}).flatMap(([k, v]) => [
  h('dt', {}, k), h('dd.hash', {}, v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))]));

function verifyBox(file) {
  const out = h('div.verify-out', { role: 'status' });
  const chain = api.mode().chain;
  const claimed = file.receipt_sha256;
  const btn = h('button.btn.ghost', { type: 'button', onclick: async () => {
    btn.disabled = true;
    out.replaceChildren(h('p.dim', {}, 'hashing…'));
    let hash;
    try {
      hash = await hashOfAsync(file.receipt);
    } catch (err) {
      out.replaceChildren(h('p', {}, `Could not hash the receipt: ${err.message}`));
      btn.disabled = false;
      return;
    }
    const match = Boolean(claimed) && hash === claimed;
    const stored = file.recorded_sha256
      ? (file.matches_record ? 'the run record stored the same hash when the run finished'
        : `the run record stored a different hash: ${file.recorded_sha256}`)
      : 'the run record stored no hash of its own (the receipt is rebuilt from the record each time it is asked for)';
    const chainLine = h('p.small');
    out.replaceChildren();
    put(out,
      h('p.verdict', {}, match ? dot() : null, match ? 'Hash matches.' : 'Hash does not match.'),
      h('dl.kv', {},
        h('dt', {}, 'computed here'), h('dd.hash', {}, hash),
        h('dt', {}, 'receipt_sha256'), h('dd.hash', {}, claimed || 'not given')),
      h('p.small.dim', {}, 'sha256 over the canonical JSON of this receipt, computed by your browser '
        + 'with the same serializer file the server uses.'),
      h('p', { class: 'small ' + (file.recorded_sha256 && !file.matches_record ? 'bad' : 'dim') }, stored),
      chainLine,
      file.on_chain ? h('details', {}, h('summary', {}, 'the on-chain record kept with this run'), kvRows(file.on_chain)) : null);

    chainLine.textContent = `on chain: ${file.on_chain_status || 'hash computed, not yet on chain'}`;
    // The contract keeps no state: a record is a log line in a transaction. What this page can say is which
    // transaction the run names and whether it names THIS hash; checking the transaction itself is one keyless command.
    const on = file.on_chain;
    if (on?.tx_hash && match) {
      const same = on.receipt_sha256 === hash;
      chainLine.className = same ? 'small ok' : 'small bad';
      chainLine.textContent = same
        ? `on chain: this hash is named in transaction ${on.tx_hash}, signed by ${on.signer} on NEAR ${on.network}`
          + ` (contract ${on.contract}). Check it yourself, no key needed: node scripts/verify-receipt.mjs`
          + ` --network ${on.network} --contract ${on.contract} --signer ${on.signer} --tx ${on.tx_hash} --hash ${hash}`
        : 'on chain: the transaction kept with this run names a different hash';
    } else if (chain?.contract && match) {
      chainLine.textContent = `on chain: not recorded yet (contract ${chain.contract} on NEAR ${chain.network})`;
    }
    btn.disabled = false;
  } }, 'Verify this receipt');
  return card('div.pad.verify', { tl: 'Verify' }, {}, btn, out);
}

function callsTable(calls, totals) {
  const num = (v) => h('td.n', {}, v);
  const t = totals || {};
  return h('div.tablewrap.cb-card.cb-card2', { tabindex: '0', role: 'region', 'aria-label': 'Model calls' },
    h('table', {},
      h('thead', {}, h('tr', {},
        ['try', '#', 'model', 'in', 'cached', 'out', '$', 'ms'].map((x, i) => h(i === 2 ? 'th' : 'th.n', {}, x)))),
      h('tbody', {}, calls.map((c) => h('tr', { class: c.status && c.status !== 200 ? 'bad' : '' },
        num(c.attempt ?? ''), num(c.seq), h('td.model', { title: c.model }, c.model || '–'),
        num(count(c.prompt_tokens)), num(count(c.cached_tokens)), num(count(c.completion_tokens)),
        num(typeof c.usd === 'number' ? c.usd.toFixed(4) : 'unpriced'), num(count(c.ms))))),
      h('tfoot', {}, h('tr', {}, num(''), num(count(t.calls ?? calls.length)), h('td', {}, 'total'),
        num(count(t.prompt_tokens)), num(count(t.cached_tokens)), num(count(t.completion_tokens)),
        num(typeof t.usd === 'number' ? t.usd.toFixed(4) : '–'), num('')))));
}

// Attestation: which kind of signature a call carries and how its checks went, expandable.
function attestations(calls, runCalls, note) {
  const rows = calls.filter((c) => c.attestation);
  if (!rows.length) {
    return h('section', {}, h('h2', {}, 'Attestation'),
      h('p.plain', {}, note || 'No model call on this receipt carries an attestation.'));
  }
  return h('section', {}, h('h2', {}, `Attestation (${rows.length} of ${calls.length} calls)`),
    h('ul.rows', {}, rows.map((c) => {
      const a = c.attestation;
      const check = runCalls.get(`${c.attempt}:${c.seq}`)?.attestation_check || a.attestation_check || null;
      const list = check?.checks || [];
      const passed = list.filter((x) => x.ok === true).length;
      const skipped = list.filter((x) => x.skipped).length;
      const failed = list.length - passed - skipped;
      return h('li', {}, h('details', {},
        h('summary', {}, `call ${c.attempt}.${c.seq} · ${SIGNED_BY[a.kind || a.signature_kind] || 'signed'}`
          + (check ? ` · ${check.ok ? '✓' : '✗'} ${passed} ok, ${skipped} skipped${failed ? `, ${failed} failed` : ''}`
            : ' · not checked here')),
        list.length ? h('ul.checklist', {}, list.map((x) => h('li', { class: x.ok ? 'ok' : (x.skipped ? '' : 'bad') },
          h('b', {}, x.ok ? '✓' : (x.skipped ? '–' : '✗')),
          h('span', {}, x.name, x.detail ? h('em', {}, x.detail) : null)))) : null,
        kvRows(a)));
    })));
}

async function detail(root, id) {
  const [file, runR] = await Promise.all([
    api.get(`receipts/${encodeURIComponent(id)}.json`),
    api.get(`runs/${encodeURIComponent(id)}.json`).catch(() => null),
  ]);
  const r = file.receipt || {};
  const run = runR || {};
  const calls = r.calls || [];
  const res = r.result || {};
  const totals = r.totals || {};
  const sigs = r.approvals?.signatures || [];
  const took = between(res.started, res.finished);
  const runCalls = new Map((run.attempts || []).flatMap((a) => (a.calls || []).map((c) => [`${a.n}:${c.seq}`, c])));
  const differs = typeof totals.usd_recorded === 'number' && Math.abs(totals.usd_recorded - totals.usd) >= 0.005;

  put(root,
    h('div.actions', {}, h('a.textbtn', { href: '#/receipts' }, 'All receipts')),
    h('header.head', {},
      h('div.row.start', {}, stateChip(res.state), originChip(r)),
      h('h1.statement', {}, r.ticket?.title || id),
      h('p.mono.dim.small', {}, `receipt ${r.run_id || id}`)),
    isImported(r) ? h('p.note', {}, run.imported?.note || `This is an ${IMPORTED}.`) : null,
    run.waiting_on ? h('p.note', {}, run.waiting_on) : null,
    verifyBox(file),
    h('dl.facts', {},
      h('div', {}, h('dt', {}, 'total, from the calls below'), h('dd', {}, usd(totals.usd))),
      h('div', {}, h('dt', {}, 'model calls'), h('dd', {}, count(totals.calls ?? calls.length))),
      h('div', {}, h('dt', {}, 'attempts'), h('dd', {}, count(res.attempts))),
      h('div', {}, h('dt', {}, 'took'), h('dd', {}, took === null ? '–' : seconds(took))),
      h('div', {}, h('dt', {}, 'started'), h('dd', {}, when(res.started))),
      h('div', {}, h('dt', {}, 'commit'), h('dd.mono', {}, short(r.build?.commit, 10))),
      h('div.wide', {}, h('dt', {}, 'branch'), h('dd', {},
        r.build?.pushed ? `pushed to ${r.build.ref}` : 'nothing was pushed',
        r.build?.main_untouched === true ? ' · main untouched' : '')),
      h('div.wide', {}, h('dt', {}, 'preview'), h('dd', {},
        r.preview?.url ? ext(r.preview.url) : (run.preview?.why || 'none'))),
      typeof totals.usd_recorded === 'number' ? h('div.wide', {}, h('dt', {}, 'cost in the run record'),
        h('dd', {}, usd(totals.usd_recorded),
          differs ? h('span.small.dim', {}, ` · differs from the sum of the calls listed here (${usd(totals.usd)})`) : null,
          differs && run.cost?.note ? h('p.small.dim', {}, run.cost.note) : null)) : null,
      totals.priced_from ? h('div.wide', {}, h('dt', {}, 'priced from'), h('dd', {}, totals.priced_from)) : null),

    h('section', {},
      h('h2', {}, `Checks, last attempt (${(r.checks || []).filter((c) => c.pass).length} of ${(r.checks || []).length} pass)`),
      (r.checks || []).length ? h('ul.checklist', {}, r.checks.map((c) => h('li', { class: c.pass ? 'ok' : 'bad' },
        h('b', {}, c.pass ? '✓' : '✗'), h('span', {}, c.name || c.id, c.kind ? h('i.tag', {}, c.kind) : null,
          c.detail ? h('em', {}, c.detail) : null, c.unverified ? h('em', {}, 'unverified') : null))))
        : h('p.plain', {}, 'No check is recorded.'),
      (r.build?.walls || []).map((w) => h('p.mono.dim.small', {},
        `attempt ${w.attempt} walls: ${w.probe || 'not probed'}${w.sandbox ? ` (${w.sandbox})` : ''}`))),

    h('section', {}, h('h2', {}, `Model calls (${calls.length})`),
      calls.length ? callsTable(calls, totals) : h('p.plain', {}, 'No model call is recorded.')),

    attestations(calls, runCalls, run.attestation_note),

    h('section', {}, h('h2', {}, 'Council signatures'),
      sigs.length ? h('ul.rows', {}, sigs.map((a) => h('li', {}, h('div.row', {},
        h('span', {}, h('b', {}, a.member), h('span.dim', {}, `  ${when(a.at)}`)),
        h('span.mono.small.dim', {}, `passkey ${short(a.credential_id, 8)}…`)))))
        : h('p', {}, r.approvals?.note || 'No council signature is recorded on this receipt.'),
      sigs.length ? h('p.small', {}, cap('valid'), ' ',
        `${(r.approvals.valid || []).join(', ') || 'none'} · ${r.approvals.threshold ?? '–'} needed`) : null,
      r.ticket?.sha256 ? h('p.small', {}, cap('ticket hash'), ' ', h('span.hash', {}, r.ticket.sha256)) : null),

    (r.lessons?.fired || []).length || r.lessons?.drafted ? h('section', {}, h('h2', {}, 'Lessons'),
      h('ul.rows', {},
        (r.lessons.fired || []).map((f) => h('li', {}, h('a', { href: '#/lessons' },
          h('span', {}, h('b', {}, 'applied: '), f.lesson), h('span.dim.small', {}, f.what || f.why || '')))),
        r.lessons.drafted ? h('li', {}, h('a', { href: '#/lessons' },
          h('span', {}, h('b', {}, 'drafted from this run: '), r.lessons.drafted.rule))) : null)) : null);
}

export async function render(root, arg) {
  if (arg) return detail(root, arg);
  const { receipts = [] } = await api.get('receipts.json');
  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Receipts'), h('h1.statement', {}, 'Every run leaves a receipt.'),
      h('p.lede', {}, 'Each model call with its tokens and price, the checks, the commit, the signatures. '
        + 'Open one and verify its hash yourself.')),
    receipts.length ? h('div.stack.receipts', {}, receipts.map((r) => h('a.cb-card.receipt-row', {
      href: '#/receipts/' + encodeURIComponent(r.id),
    },
    h('span', {},
      h('span.name', {}, r.title || r.id),
      h('span.cap', {}, stateChip(r.state), ` · ${plural(r.calls, 'call')} · ${plural(r.attempts, 'attempt')} · ${seconds(r.seconds)}`),
      originChip(r),
      h('span.cap.faint', {}, `${when(r.started)} · sha256 ${short(r.receipt_sha256)}…`)),
    h('span.cost', {}, usd(r.usd)))))
      : h('p.plain', {}, 'No run has finished yet.'));
  return undefined;
}
