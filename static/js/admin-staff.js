/* VENTEDA admin: Staff tools tab (search, account editing, activation, notes, risk, sessions, stories).
   Talks only to the /api/admin endpoints. Every write asks for a reason, as the server requires. */
import { api } from '/static/js/api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ACTIVE_CLASS = 'admin-nav-btn active w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-blue-50 dark:bg-sky-950/60 text-blue-700 dark:text-cyan-300 font-bold';
const INACTIVE_CLASS = 'admin-nav-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800';
let selected = null;

function reasonFor(action) {
  const reason = window.prompt(`Reason for ${action} (required, at least 5 characters):`, '');
  if (reason === null) return null;
  if (reason.trim().length < 5) { alert('A reason of at least 5 characters is required.'); return null; }
  return reason.trim();
}

function showStaff() {
  document.querySelectorAll('section[id^="tab"][id$="Section"]').forEach(s => s.classList.add('hidden'));
  $('tabStaffSection').classList.remove('hidden');
  const btn = $('navTabStaff');
  document.querySelectorAll('.admin-nav-btn').forEach(b => { b.className = INACTIVE_CLASS; });
  btn.className = ACTIVE_CLASS;
  search();
  loadStories();
}

function hideStaff() { $('tabStaffSection').classList.add('hidden'); }

async function search() {
  const params = new URLSearchParams();
  const q = $('staffQ').value.trim();
  if (q) params.set('q', q);
  if ($('staffRole').value) params.set('role', $('staffRole').value);
  if ($('staffStatus').value) params.set('status', $('staffStatus').value);
  if ($('staffRisk').value) params.set('min_risk', $('staffRisk').value);
  const list = $('staffResults');
  list.innerHTML = '<p class="p-4 text-xs text-slate-400">Searching...</p>';
  try {
    const rows = await api.request('/admin/users/search?' + params.toString());
    if (!rows.length) { list.innerHTML = '<p class="p-4 text-xs text-slate-400">No users match these filters.</p>'; return; }
    list.innerHTML = rows.map(u => {
      const risk = u.risk.level;
      const riskClass = risk === 'high' ? 'bg-rose-500/15 text-rose-400' : risk === 'medium' ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400';
      const state = u.is_banned ? 'banned' : (u.is_active ? 'active' : 'inactive');
      return `<button onclick="staffSelect('${esc(u.id)}')" class="w-full text-left p-3 rounded-xl hover:bg-white/5 border border-transparent hover:border-white/10 flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold truncate">${esc(u.display_name)} <span class="text-slate-400 font-mono text-xs">@${esc(u.username)}</span></p>
          <p class="text-[11px] text-slate-400">${esc(u.role)} · ${esc(state)} · ${u.is_online ? 'online' : 'offline'}</p>
        </div>
        <span class="text-[11px] font-bold px-2 py-1 rounded-lg ${riskClass}">risk ${u.risk.score}</span>
      </button>`;
    }).join('');
  } catch (e) { list.innerHTML = `<p class="p-4 text-xs text-rose-400">${esc(e.message)}</p>`; }
}

async function select(userId) {
  const panel = $('staffDetail');
  panel.innerHTML = '<p class="p-6 text-sm text-slate-400">Loading...</p>';
  try {
    const [rows, risk, sessions, violations, notes] = await Promise.all([
      api.request('/admin/users/search?limit=200'),
      api.request(`/admin/users/${userId}/risk`),
      api.request(`/admin/users/${userId}/sessions`),
      api.request(`/admin/users/${userId}/violations`),
      api.request(`/admin/users/${userId}/notes`),
    ]);
    selected = rows.find(r => r.id === userId) || { id: userId, username: '', display_name: '', role: '', is_active: true, is_banned: false };
    selected.risk = risk;
    render(sessions, violations, notes);
  } catch (e) { panel.innerHTML = `<p class="p-6 text-sm text-rose-400">${esc(e.message)}</p>`; }
}

function render(sessions, violations, notes) {
  const u = selected;
  const card = (title, body) => `<div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><p class="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-3">${title}</p>${body}</div>`;
  const breakdown = Object.entries(u.risk.breakdown).map(([k, v]) => `<div class="flex justify-between text-xs"><span class="text-slate-400">${esc(k.replace('_', ' '))}</span><span>+${v}</span></div>`).join('');
  const sessionRows = sessions.length ? sessions.map(s => `<div class="text-xs py-1.5 border-b border-white/5 last:border-0 flex justify-between gap-2">
      <span class="truncate">${esc(s.device_name)} · ${esc(s.browser)}</span>
      <span class="text-slate-400 shrink-0">${s.is_revoked ? 'revoked' : esc(s.ip_address)}</span></div>`).join('') : '<p class="text-xs text-slate-400">No sessions.</p>';
  const actionRows = violations.actions.length ? violations.actions.map(a => `<div class="text-xs py-1.5 border-b border-white/5 last:border-0">
      <span class="font-semibold">${esc(a.action)}</span> by ${esc(a.actor)} <span class="text-slate-400">${esc(a.reason || '')}</span></div>`).join('') : '<p class="text-xs text-slate-400">No recorded actions.</p>';
  const reportRows = violations.reports.length ? violations.reports.map(r => `<div class="text-xs py-1.5 border-b border-white/5 last:border-0">${esc(r.category)} · ${esc(r.status)}</div>`).join('') : '<p class="text-xs text-slate-400">No reports against this user.</p>';
  const noteRows = notes.length ? notes.map(n => `<div class="text-xs py-2 border-b border-white/5 last:border-0"><p>${esc(n.text)}</p><p class="text-[10px] text-slate-400 mt-1">${esc(n.author)} · ${esc(new Date(n.created_at).toLocaleString())}</p></div>`).join('') : '<p class="text-xs text-slate-400">No private notes.</p>';
  const btn = 'px-3 py-2 rounded-xl text-xs font-semibold border border-white/10 bg-white/5 hover:bg-white/10';
  $('staffDetail').innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div><p class="text-lg font-bold">${esc(u.display_name)}</p><p class="text-xs text-slate-400 font-mono">@${esc(u.username)} · ${esc(u.role)}</p></div>
      <span class="text-xs font-bold px-2.5 py-1 rounded-lg ${u.risk.level === 'high' ? 'bg-rose-500/15 text-rose-400' : u.risk.level === 'medium' ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'}">Risk ${u.risk.score}/100</span>
    </div>
    <div class="grid grid-cols-2 gap-2 mt-4">
      <button class="${btn}" onclick="staffEdit()">Edit account</button>
      <button class="${btn}" onclick="staffToggleActive()">${u.is_active ? 'Deactivate account' : 'Activate account'}</button>
      <button class="${btn}" onclick="staffRemoveAvatar()">Remove profile photo</button>
      <button class="${btn}" onclick="staffAddNote()">Add private note</button>
    </div>
    <div class="grid gap-3 mt-4">
      ${card('Risk breakdown', breakdown || '<p class="text-xs text-slate-400">No risk factors.</p>')}
      ${card('Active devices and sessions', sessionRows)}
      ${card('Violation history', actionRows + '<div class="mt-3"></div>' + reportRows)}
      ${card('Private staff notes (never shown to the user)', noteRows)}
    </div>`;
}

window.staffSelect = select;

window.staffEdit = async () => {
  const fields = {};
  const display = window.prompt('Display name (leave empty to keep)', selected.display_name);
  if (display && display.trim() !== selected.display_name) fields.display_name = display.trim();
  const username = window.prompt('Username (leave empty to keep)', selected.username);
  if (username && username.trim() !== selected.username) fields.username = username.trim();
  const bio = window.prompt('Bio (leave empty to keep)', '');
  if (bio) fields.bio = bio.trim();
  if (!Object.keys(fields).length) return;
  const reason = reasonFor('the account edit');
  if (!reason) return;
  try {
    await api.request(`/admin/users/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ ...fields, reason }) });
    await select(selected.id);
    search();
  } catch (e) { alert(e.message); }
};

window.staffToggleActive = async () => {
  const next = !selected.is_active;
  if (!window.confirm(`${next ? 'Activate' : 'Deactivate'} this account?`)) return;
  const reason = reasonFor(next ? 'activation' : 'deactivation');
  if (!reason) return;
  try {
    await api.request(`/admin/users/${selected.id}/activation`, { method: 'POST', body: JSON.stringify({ active: next, reason }) });
    await select(selected.id);
    search();
  } catch (e) { alert(e.message); }
};

window.staffRemoveAvatar = async () => {
  if (!window.confirm('Remove this user\'s profile photo?')) return;
  const reason = reasonFor('removing the profile photo');
  if (!reason) return;
  try {
    await api.request(`/admin/users/${selected.id}/avatar`, { method: 'DELETE', body: JSON.stringify({ reason }) });
    await select(selected.id);
  } catch (e) { alert(e.message); }
};

window.staffAddNote = async () => {
  const text = window.prompt('Private note (visible only to staff):', '');
  if (!text || !text.trim()) return;
  try {
    await api.request(`/admin/users/${selected.id}/notes`, { method: 'POST', body: JSON.stringify({ text: text.trim() }) });
    await select(selected.id);
  } catch (e) { alert(e.message); }
};

async function loadStories() {
  const list = $('staffStories');
  try {
    const rows = await api.request('/admin/stories?limit=100');
    if (!rows.length) { list.innerHTML = '<p class="p-4 text-xs text-slate-400">No active stories.</p>'; return; }
    list.innerHTML = rows.map(s => `<div class="flex items-center gap-3 p-2.5 rounded-xl border border-white/10 bg-white/[0.02]">
      ${s.media_type === 'video' ? '<div class="w-14 h-14 rounded-lg bg-black/40 flex items-center justify-center text-lg">▶</div>' : `<img src="${esc(s.media_url)}" alt="" class="w-14 h-14 rounded-lg object-cover" />`}
      <div class="min-w-0 flex-1"><p class="text-xs font-semibold">@${esc(s.author || 'unknown')}${s.is_platform ? ' · <span class="text-cyan-300">platform</span>' : ''}</p>
        <p class="text-[11px] text-slate-400 truncate">${esc(s.caption || 'No caption')}</p></div>
      <button onclick="staffDeleteStory('${esc(s.id)}')" class="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-400 border border-rose-400/30 hover:bg-rose-500/10">Delete</button>
    </div>`).join('');
  } catch (e) { list.innerHTML = `<p class="p-4 text-xs text-rose-400">${esc(e.message)}</p>`; }
}

window.staffDeleteStory = async (id) => {
  if (!window.confirm('Delete this story?')) return;
  const reason = reasonFor('deleting a story');
  if (!reason) return;
  try {
    await api.request(`/admin/stories/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
    loadStories();
  } catch (e) { alert(e.message); }
};

window.staffSearch = search;

document.addEventListener('DOMContentLoaded', () => {
  $('navTabStaff')?.addEventListener('click', showStaff);
  document.querySelectorAll('.admin-nav-btn').forEach(b => {
    if (b.id !== 'navTabStaff') b.addEventListener('click', hideStaff);
  });
  $('staffSearchBtn')?.addEventListener('click', search);
  $('staffQ')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
});
