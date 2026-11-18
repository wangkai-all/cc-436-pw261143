import { api } from './api.js';
import { el, initTooltip, toast } from './ui.js';
import { renderOverview } from './views/overview.js';
import { renderSource } from './views/source.js';
import { renderVerifyPage } from './views/verify.js';

const state = {
  meta: null,
  sources: [],
  overview: null,
};

const content = document.querySelector('#content');
const nav = document.querySelector('#nav-sources');

const SOURCE_TABS = ['contracts', 'batches', 'quarantine', 'policy', 'exceptions', 'verify'];
const TAB_LABELS = {
  contracts: '契约版本',
  batches: '采集批次',
  quarantine: '隔离与回放',
  policy: '策略配置',
  exceptions: '误报例外',
  verify: '自检',
};

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const segments = hash.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'source' && segments[1]) {
    const tab = SOURCE_TABS.includes(segments[2]) ? segments[2] : 'contracts';
    return { name: 'source', slug: segments[1], tab, batchId: segments[3] ? Number(segments[3]) : null };
  }
  if (segments[0] === 'verify') return { name: 'verify' };
  return { name: 'overview' };
}

function navigate(path) {
  if (location.hash === `#${path}`) {
    render();
    return;
  }
  location.hash = path;
}

function setActiveNav(route) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const key = link.dataset.nav;
    const active =
      (key === 'overview' && route.name === 'overview') ||
      (key === 'verify' && route.name === 'verify') ||
      (key === 'source' && route.name === 'source' && link.dataset.slug === route.slug);
    link.classList.toggle('active', active);
  });
}

function renderNavSources() {
  nav.innerHTML = '';
  for (const source of state.sources) {
    const link = el('a', { class: 'nav-link', href: `#/source/${source.slug}`, dataset: { nav: 'source', slug: source.slug } }, [
      el('span', { class: 'ico' }, ['●']),
      el('span', { class: 'grow' }, [source.name]),
      source.stats.pendingQuarantine > 0 ? el('span', { class: 'nav-count', title: '待处理隔离记录' }, [String(source.stats.pendingQuarantine)]) : null,
    ]);
    nav.append(link);
  }
}

async function refreshSources() {
  const data = await api.overview();
  state.overview = data;
  state.sources = data.sources;
  renderNavSources();
  const pending = data.totals.pendingQuarantine;
  const badge = document.querySelector('#nav-pending');
  if (badge) {
    badge.textContent = pending > 0 ? String(pending) : '';
    badge.hidden = pending === 0;
  }
}

async function render() {
  const route = parseRoute();
  setActiveNav(route);
  try {
    if (route.name === 'overview') {
      content.replaceChildren(await renderOverview(state, { navigate, refresh: refreshSources, rerender: render }));
      document.querySelector('#page-title').textContent = '总览';
      document.querySelector('#page-crumb').textContent = '全部数据源';
      return;
    }
    if (route.name === 'verify') {
      content.replaceChildren(await renderVerifyPage(state, { navigate }));
      document.querySelector('#page-title').textContent = '防漏检自检';
      document.querySelector('#page-crumb').textContent = '全部数据源';
      return;
    }
    const source = await api.source(route.slug);
    const node = await renderSource(state, source, {
      tab: route.tab,
      batchId: route.batchId,
      navigate,
      refresh: refreshSources,
      rerender: render,
      meta: state.meta,
    });
    content.replaceChildren(node);
    document.querySelector('#page-title').textContent = source.name;
    document.querySelector('#page-crumb').textContent = `${source.domain} · ${TAB_LABELS[route.tab] ?? ''}`;
  } catch (error) {
    content.replaceChildren(
      el('div', { class: 'notice critical' }, [el('span', { class: 'ico' }, ['⚠']), el('div', { html: '' }, [])]),
    );
    content.firstChild.lastChild.textContent = `加载失败：${error.message}`;
  }
}

function initThemeToggle() {
  const root = document.documentElement;
  const stored = localStorage.getItem('cs-theme');
  if (stored) root.dataset.theme = stored;
  const button = document.querySelector('#theme-toggle');
  const sync = () => {
    button.textContent = root.dataset.theme === 'dark' ? '☀' : '☾';
    button.title = root.dataset.theme === 'dark' ? '切换到浅色' : '切换到深色';
  };
  sync();
  button.addEventListener('click', () => {
    const current = root.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('cs-theme', next);
    sync();
  });
}

async function boot() {
  initTooltip();
  initThemeToggle();
  try {
    state.meta = await api.meta();
  } catch (error) {
    toast(`无法读取元数据：${error.message}`, 'error');
  }
  await refreshSources();
  window.addEventListener('hashchange', () => {
    refreshSources().finally(render);
  });
  await render();
  // 数据变更后统一由视图调用 refresh + rerender
  window.__sentinel = { state, refresh: refreshSources, render, navigate, toast };
}

window.addEventListener('DOMContentLoaded', boot);
