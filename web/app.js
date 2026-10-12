import { connect } from './data.js';
import { formatCents } from './core/rules.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (c) => formatCents(c ?? 0);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const date = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const todayLocal = () => new Date().toLocaleDateString('en-CA');
const KIND = { permit: 'Permit only', paid: 'Paid', mixed: 'Permit or paid' };
const STATUS_LABEL = { open: 'Open', paid: 'Paid', appealed: 'Appealed', voided: 'Voided', active: 'Active', revoked: 'Revoked' };

let client;
let lots = [];
const OFFICER = 'Ofc. Tran #214';

// ---------- feedback ----------

let toastTimer;
function toast(message, tone = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message ?? 'Something went wrong', 'bad');
    return undefined;
  }
}

function ask({ title, text, ok, note = false, required = false }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  $('#dialog-ok').textContent = ok;
  $('#dialog-note-wrap').hidden = !note;
  const area = $('#dialog-note');
  area.value = '';
  area.required = note && required;
  dialog.showModal();
  if (note) area.focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? { note: area.value.trim() } : null);
    }, { once: true });
  });
}

// ---------- lots ----------

const STALLS = 48;

function stallStrip(lot) {
  const filled = Math.round((lot.occupancy / 100) * STALLS);
  const level = lot.occupancy >= 90 ? 'full' : lot.occupancy >= 75 ? 'busy' : 'open';
  let ticks = '';
  for (let i = 0; i < STALLS; i += 1) ticks += `<i${i < filled ? ' class="on"' : ''}></i>`;
  return `<div class="stalls" data-level="${level}" role="img" aria-label="${lot.occupied} of ${lot.capacity} spaces taken">${ticks}</div>`;
}

async function renderOverview() {
  const data = await attempt(() => client.overview());
  if (!data) return;
  lots = data.lots;
  const t = data.totals;
  $('#asof').textContent = `As of ${time(data.asOf)}. ${t.occupied} cars in ${t.capacity} spaces across ${lots.length} lots.`;
  $('#totals').innerHTML = `
    <div><dt>Occupancy</dt><dd>${t.occupancy}%</dd></div>
    <div><dt>Revenue today</dt><dd>${money(t.revenueTodayCents)}</dd></div>
    <div><dt>Open citations</dt><dd>${t.openCitations}<small>${money(t.outstandingCents)} owed</small></dd></div>
    <div><dt>Camera reads today</dt><dd>${t.readsToday}<small>${t.violationsToday} in violation</small></dd></div>`;
  $('#lots').innerHTML = lots
    .slice()
    .sort((a, b) => b.occupancy - a.occupancy)
    .map((l) => `
      <li class="lot">
        <div class="lot-sign" aria-hidden="true">${esc(l.zone)}</div>
        <div class="lot-body">
          <div class="lot-line">
            <h2>${esc(l.name)}</h2>
            <p class="lot-count"><strong>${l.capacity - l.occupied}</strong> open of ${l.capacity}</p>
          </div>
          ${stallStrip(l)}
          <p class="lot-meta">Zone ${esc(l.zone)}, ${KIND[l.kind]}${l.rate_cents_hour ? `, ${money(l.rate_cents_hour)} an hour` : ''}</p>
        </div>
        <p class="lot-pct">${l.occupancy}%</p>
      </li>`)
    .join('');
  fillLotSelects();
}

function fillLotSelects() {
  for (const select of document.querySelectorAll('.lot-select')) {
    const keep = select.value;
    select.innerHTML = lots
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => `<option value="${esc(l.id)}">${esc(l.name)} (zone ${esc(l.zone)})</option>`)
      .join('');
    if (keep) select.value = keep;
  }
  const zones = [...new Set(lots.map((l) => l.zone))].sort();
  const boxes = $('#zone-boxes');
  if (!boxes.children.length) {
    boxes.innerHTML = zones.map((z) => `<label class="chip"><input type="checkbox" name="zones" value="${z}"><span>${z}</span></label>`).join('');
  }
}

// ---------- enforcement ----------

function plateArt(plate, lotName) {
  return `<div class="plate" aria-label="Plate ${esc(plate)}"><span class="plate-top">${esc(lotName)}</span><span class="plate-num">${esc(plate)}</span></div>`;
}

const RESULT_TEXT = { valid: 'OK to park', grace: 'In grace period', violation: 'In violation' };

function renderCheck(c) {
  const canCite = c.result === 'violation' && !c.citedToday;
  const paidLot = c.lot.kind !== 'permit';
  $('#check-result').innerHTML = `
    <article class="verdict" data-result="${c.result}">
      ${plateArt(c.plate, c.lot.name)}
      <div class="verdict-body">
        <p class="verdict-head">${RESULT_TEXT[c.result]}</p>
        <p>${esc(c.reason)}</p>
        ${c.scofflaw ? `<p class="flag">Repeat offender: ${c.unpaidCitations} unpaid citations on file. Follow your boot or tow policy.</p>` : c.unpaidCitations ? `<p class="muted">${c.unpaidCitations} unpaid citation${c.unpaidCitations > 1 ? 's' : ''} on file.</p>` : ''}
        ${c.citedToday ? `<p class="muted">Already cited here today: ${esc(c.citedToday.number)}.</p>` : ''}
        ${canCite ? `
          <form class="cite" id="cite-form">
            <label class="field compact"><span>Officer</span><input name="officer" value="${esc(OFFICER)}" required></label>
            <button class="btn stop" type="submit">Issue ${money(c.fineCents)} citation</button>
          </form>` : ''}
        ${paidLot && c.result !== 'valid' ? `
          <form class="pay" id="pay-form">
            <label class="field compact"><span>Driver pays for</span>
              <select name="minutes"><option value="30">30 min</option><option value="60" selected>1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option></select>
            </label>
            <button class="btn" type="submit">Record mobile payment</button>
          </form>` : ''}
      </div>
    </article>`;

  $('#cite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const officer = new FormData(e.currentTarget).get('officer');
    const cit = await attempt(() => client.issueCitation({ plate: c.plate, lotId: c.lot.id, officer }));
    if (cit) {
      toast(`Issued ${cit.number} to ${cit.plate}`);
      renderCheck(await client.checkPlate(c.plate, c.lot.id));
    }
  });
  $('#pay-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const minutes = Number(new FormData(e.currentTarget).get('minutes'));
    const s = await attempt(() => client.startSession({ plate: c.plate, lotId: c.lot.id, minutes, channel: 'mobile' }));
    if (s) {
      toast(`Recorded ${money(s.paid_cents)} payment for ${s.plate}`);
      renderCheck(await client.checkPlate(c.plate, c.lot.id));
    }
  });
}

async function renderReads() {
  const reads = await attempt(() => client.recentReads());
  if (!reads) return;
  $('#reads').innerHTML = reads.length
    ? reads.map((r) => `
        <li data-result="${r.result}">
          <button type="button" class="read" data-plate="${esc(r.plate)}" data-lot="${esc(r.lot_id)}">
            <span class="read-plate">${esc(r.plate)}</span>
            <span class="read-where">${esc(r.lot_name)}, ${time(r.read_at)}</span>
            <span class="read-result">${RESULT_TEXT[r.result]}</span>
          </button>
        </li>`).join('')
    : '<li class="empty">No reads yet. Run a camera pass on a lot to see plates come in.</li>';
}

function wireEnforcement() {
  $('#check-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = await attempt(() => client.checkPlate($('#check-plate').value, $('#check-lot').value));
    if (c) {
      $('#check-plate').value = c.plate;
      renderCheck(c);
    }
  });
  $('#sweep').addEventListener('click', async () => {
    const read = await attempt(() => client.sweep($('#check-lot').value));
    if (!read) return;
    $('#check-plate').value = read.plate;
    renderCheck(read);
    renderReads();
  });
  $('#reads').addEventListener('click', async (e) => {
    const btn = e.target.closest('.read');
    if (!btn) return;
    $('#check-lot').value = btn.dataset.lot;
    $('#check-plate').value = btn.dataset.plate;
    const c = await attempt(() => client.checkPlate(btn.dataset.plate, btn.dataset.lot));
    if (c) renderCheck(c);
  });
}

// ---------- citations ----------

function citationActions(c) {
  if (c.status === 'open') {
    return `<button class="btn small" data-act="pay" data-id="${c.id}" data-due="${c.amount_due_cents}">Take payment</button>
            <button class="btn small ghost" data-act="appeal" data-id="${c.id}">Appeal</button>`;
  }
  if (c.status === 'appealed') {
    return `<button class="btn small" data-act="uphold" data-id="${c.id}">Uphold</button>
            <button class="btn small ghost" data-act="void" data-id="${c.id}">Void</button>`;
  }
  return '';
}

async function renderCitations() {
  const f = new FormData($('#cit-filters'));
  const list = await attempt(() => client.listCitations({ status: f.get('status'), plate: f.get('plate') }));
  if (!list) return;
  const due = list.reduce((s, c) => s + c.amount_due_cents, 0);
  $('#cit-summary').textContent = `${list.length} shown${due ? `, ${money(due)} owed` : ''}.`;
  $('#cit-table tbody').innerHTML = list.length
    ? list.map((c) => `
      <tr>
        <td class="mono">${esc(c.number)}</td>
        <td><span class="mini-plate">${esc(c.plate)}</span></td>
        <td>${esc(c.lot_name)}</td>
        <td>${esc(c.violation_label)}${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</td>
        <td class="nowrap">${date(c.issued_at)}</td>
        <td class="num">${c.status === 'open' ? `${money(c.amount_due_cents)}${c.amount_due_cents > c.fine_cents ? '<div class="note">late fee added</div>' : ''}` : c.status === 'paid' ? `<span class="muted">${money(c.paid_cents)} paid</span>` : ''}</td>
        <td><span class="status" data-status="${c.status}">${STATUS_LABEL[c.status]}</span></td>
        <td class="actions">${citationActions(c)}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty">No citations match. Clear the search or pick another status.</td></tr>';
}

function wireCitations() {
  const form = $('#cit-filters');
  form.addEventListener('change', renderCitations);
  form.addEventListener('input', debounce(renderCitations, 200));
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#cit-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.act;
    let done;
    if (act === 'pay') {
      const due = Number(btn.dataset.due);
      const ok = await ask({ title: 'Take payment', text: `Record a payment of ${money(due)} for this citation?`, ok: `Take ${money(due)}` });
      if (ok) done = await attempt(() => client.payCitation(id, due));
      if (done) toast(`${done.number} paid`);
    } else if (act === 'appeal') {
      const ok = await ask({ title: 'Appeal citation', text: 'Why is the driver appealing?', ok: 'File appeal', note: true, required: true });
      if (ok) done = await attempt(() => client.appealCitation(id, ok.note));
      if (done) toast(`${done.number} is under appeal`);
    } else {
      const uphold = act === 'uphold';
      const ok = await ask({
        title: uphold ? 'Uphold citation' : 'Void citation',
        text: uphold ? 'The citation goes back to open and the driver owes the fine.' : 'The citation is cancelled and nothing is owed.',
        ok: uphold ? 'Uphold' : 'Void',
        note: true,
      });
      if (ok) done = await attempt(() => client.decideAppeal(id, uphold ? 'uphold' : 'void', ok.note || null));
      if (done) toast(`${done.number} ${uphold ? 'upheld' : 'voided'}`);
    }
    if (done) renderCitations();
  });
}

// ---------- permits ----------

async function renderPermits() {
  const f = new FormData($('#permit-filters'));
  const list = await attempt(() => client.listPermits({ status: f.get('status'), plate: f.get('plate') }));
  if (!list) return;
  const today = todayLocal();
  $('#permit-summary').textContent = `${list.length} shown.`;
  $('#permit-table tbody').innerHTML = list.length
    ? list.slice(0, 200).map((p) => {
      const expired = p.ends_on < today;
      return `
      <tr>
        <td class="mono">${p.id}</td>
        <td><span class="mini-plate">${esc(p.plate)}</span></td>
        <td>${esc(p.holder)}</td>
        <td>${esc(p.permit_type)}</td>
        <td>${esc(p.zones.replaceAll(',', ', '))}</td>
        <td>${dayLabel(p.starts_on)} to ${dayLabel(p.ends_on)}${expired ? '<div class="note">expired</div>' : ''}</td>
        <td><span class="status" data-status="${p.status}">${STATUS_LABEL[p.status]}</span></td>
        <td class="actions">${p.status === 'active' ? `<button class="btn small ghost" data-revoke="${p.id}">Revoke</button>` : ''}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8" class="empty">No permits match. Clear the search or pick another status.</td></tr>';
}

function wirePermits() {
  const form = $('#permit-form');
  const start = form.elements.startsOn;
  const end = form.elements.endsOn;
  start.value = todayLocal();
  const d = new Date();
  d.setMonth(d.getMonth() + 4);
  end.value = d.toLocaleDateString('en-CA');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p = await attempt(() => client.issuePermit({
      plate: fd.get('plate'),
      holder: fd.get('holder'),
      permitType: fd.get('permitType'),
      zones: fd.getAll('zones'),
      startsOn: fd.get('startsOn'),
      endsOn: fd.get('endsOn'),
    }));
    if (p) {
      toast(`Issued permit #${p.id} to ${p.plate}`);
      form.elements.plate.value = '';
      form.elements.holder.value = '';
      renderPermits();
    }
  });
  const filters = $('#permit-filters');
  filters.addEventListener('change', renderPermits);
  filters.addEventListener('input', debounce(renderPermits, 200));
  filters.addEventListener('submit', (e) => e.preventDefault());
  $('#permit-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-revoke]');
    if (!btn) return;
    const ok = await ask({ title: 'Revoke permit', text: 'The plate stops counting as permitted right away.', ok: 'Revoke permit' });
    if (!ok) return;
    const p = await attempt(() => client.revokePermit(Number(btn.dataset.revoke)));
    if (p) {
      toast(`Revoked permit #${p.id}`);
      renderPermits();
    }
  });
}

// ---------- routing ----------

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

const RENDER = { overview: renderOverview, enforcement: renderReads, citations: renderCitations, permits: renderPermits };

function route() {
  const tab = (location.hash || '#overview').slice(1);
  const name = RENDER[tab] ? tab : 'overview';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  RENDER[name]();
}

async function start() {
  client = await connect();
  $('#mode').textContent = client.mode === 'api' ? 'Connected to the API' : 'Demo data in your browser';
  $('#mode').dataset.mode = client.mode;
  await renderOverview();
  wireEnforcement();
  wireCitations();
  wirePermits();
  window.addEventListener('hashchange', route);
  route();
  document.body.dataset.ready = 'true';
}

start().catch((err) => {
  $('#mode').textContent = 'Could not load';
  $('#main').insertAdjacentHTML('afterbegin', `<p class="load-error">The data could not load: ${esc(err.message)}. Refresh to try again.</p>`);
});
