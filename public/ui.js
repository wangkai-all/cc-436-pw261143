/* 共享 UI 工具：DOM 构造、格式化、提示与弹层。 */

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function html(strings, ...values) {
  return strings.reduce((out, str, i) => out + str + (values[i] === undefined || values[i] === null ? '' : values[i]), '');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

export function fmtJson(value, max = 240) {
  if (value === undefined) return '—';
  let text;
  try {
    text = JSON.stringify(value, null, 0);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '—';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function fmtPretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ACTION_TONE = { accept: 'good', quarantine: 'warning', block: 'critical' };
export const ACTION_LABEL = { accept: '放行', quarantine: '隔离', block: '阻断' };
export const SEVERITY_TONE = { info: 'info', warning: 'warning', serious: 'serious', breaking: 'critical' };
export const SEVERITY_LABEL = { info: '提示', warning: '警告', serious: '严重', breaking: '破坏性' };
export const COMPAT_TONE = { identical: 'neutral', forward_compatible: 'good', breaking: 'critical', baseline: 'info' };
export const COMPAT_LABEL = { identical: '无变化', forward_compatible: '前向兼容', breaking: '破坏性', baseline: '基线' };
export const STATUS_LABEL = { active: '生效中', proposed: '待批准', superseded: '已归档' };

export function badge(label, tone = 'neutral', { dot = false } = {}) {
  return `<span class="badge ${tone}">${dot ? '<span class="dot"></span>' : ''}${esc(label)}</span>`;
}

export function actionBadge(action) {
  return badge(ACTION_LABEL[action] ?? action, ACTION_TONE[action] ?? 'neutral', { dot: true });
}

export function severityBadge(severity) {
  return badge(SEVERITY_LABEL[severity] ?? severity, SEVERITY_TONE[severity] ?? 'neutral');
}

export function compatBadge(compat) {
  return badge(COMPAT_LABEL[compat] ?? compat, COMPAT_TONE[compat] ?? 'neutral');
}

export function statusBadge(status) {
  const tone = status === 'active' ? 'good' : status === 'proposed' ? 'warning' : 'neutral';
  return badge(STATUS_LABEL[status] ?? status, tone);
}

export function decisionBadge(decision) {
  return actionBadge(decision);
}

export function emptyState(title, hint) {
  return `<div class="empty"><strong>${esc(title)}</strong>${hint ? esc(hint) : ''}</div>`;
}

export function toast(message, kind = 'ok') {
  const host = document.querySelector('#toasts');
  const node = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, [message]);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 5200 : 3200);
}

export function openModal({ title, body, footer, wide = false }) {
  const dialog = el('dialog', { class: 'modal' });
  if (wide) dialog.style.width = 'min(920px, calc(100vw - 32px))';
  dialog.innerHTML = `
    <div class="modal-head">
      <h3>${esc(title)}</h3>
      <span class="spacer"></span>
      <button class="btn ghost sm" data-close type="button">关闭</button>
    </div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>
  `;
  dialog.querySelector('.modal-body').append(body);
  if (footer) dialog.querySelector('.modal-foot').append(footer);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  return dialog;
}

/** 单系列横向条形图：一个量纲、一种颜色，数值用文字直接标注。 */
export function barChart(rows, { max, formatter = (v) => v } = {}) {
  if (!rows.length) return emptyState('暂无数据');
  const peak = max ?? Math.max(...rows.map((r) => r.value), 1);
  return `<div class="bars">${rows
    .map(
      (row) => `
      <div class="bar-row" data-tip="${esc(row.tip ?? `${row.label}：${formatter(row.value)}`)}">
        <div class="bar-label" title="${esc(row.label)}">${esc(row.label)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(2, (row.value / peak) * 100)}%;${row.tone ? `background:var(--${row.tone})` : ''}"></div>
          <span class="bar-value">${esc(formatter(row.value))}</span>
        </div>
      </div>`,
    )
    .join('')}</div>
  <div class="bar-axis"></div>`;
}

export function segmentedBar(parts, { showLabels = true } = {}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (!total) return emptyState('本批全部放行', '没有需要处置的记录');
  return `
    <div class="segbar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.value}`).join('，'))}">
      ${parts
        .filter((p) => p.value > 0)
        .map((p) => {
          const share = (p.value / total) * 100;
          return `<div class="part ${p.tone}" style="width:${share}%" title="${esc(`${p.label}：${p.value} 行（${share.toFixed(0)}%）`)}">${showLabels && share >= 12 ? esc(p.label) : ''}</div>`;
        })
        .join('')}
    </div>
    <div class="legend">
      ${parts
        .map(
          (p) => `<span class="key"><span class="swatch" style="background:var(--${p.tone})"></span>${esc(p.label)} <span class="tnum">${p.value}</span></span>`,
        )
        .join('')}
    </div>`;
}

export function initTooltip() {
  const tip = document.querySelector('#tooltip');
  document.addEventListener('pointerover', (event) => {
    const target = event.target.closest('[data-tip]');
    if (!target) return;
    tip.textContent = target.dataset.tip;
    tip.classList.add('visible');
  });
  document.addEventListener('pointerout', (event) => {
    const target = event.target.closest('[data-tip]');
    if (!target) return;
    tip.classList.remove('visible');
  });
  document.addEventListener('pointermove', (event) => {
    if (!tip.classList.contains('visible')) return;
    const pad = 14;
    const x = Math.min(event.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.max(8, event.clientY - tip.offsetHeight - 10);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
}

export function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function debounce(fn, ms = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
