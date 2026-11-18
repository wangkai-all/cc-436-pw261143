import { api } from '../api.js';
import {
  el,
  esc,
  fmtDateTime,
  fmtJson,
  fmtPretty,
  fmtRelative,
  badge,
  actionBadge,
  severityBadge,
  compatBadge,
  statusBadge,
  decisionBadge,
  emptyState,
  openModal,
  segmentedBar,
  toast,
} from '../ui.js';

const TABS = [
  { key: 'contracts', label: '契约版本' },
  { key: 'batches', label: '采集批次' },
  { key: 'quarantine', label: '隔离与回放' },
  { key: 'policy', label: '策略配置' },
  { key: 'exceptions', label: '误报例外' },
  { key: 'verify', label: '自检' },
];

const CATEGORY_ORDER = [
  'new_field',
  'enum_extension',
  'missing_required',
  'type_change',
  'enum_violation',
  'format_violation',
  'constraint_violation',
  'null_violation',
  'semantic_conflict',
  'malformed_record',
];

export async function renderSource(state, source, ctx) {
  const { tab, navigate, meta } = ctx;
  const container = el('div');

  const header = el('div', { class: 'page-head' });
  header.innerHTML = `
    <div class="titles">
      <h2>${esc(source.name)}</h2>
      <p>${esc(source.description ?? '')}</p>
    </div>
    <div class="row tight">
      ${badge(source.domain, 'outline')}
      ${badge(source.versionPolicyLabel, 'neutral')}
      ${source.currentContract ? badge(`契约 ${source.currentContract.version}`, 'good') : badge('无生效契约', 'critical')}
      ${source.stats.pendingQuarantine ? badge(`待处理隔离 ${source.stats.pendingQuarantine}`, 'warning', { dot: true }) : badge('无待处理隔离', 'neutral')}
    </div>
  `;
  container.append(header);

  const subnav = el('div', { class: 'subnav' });
  for (const item of TABS) {
    const link = el(
      'a',
      { href: `#/source/${source.slug}/${item.key}`, class: item.key === tab ? 'active' : '' },
      [item.label + (item.key === 'quarantine' && source.stats.pendingQuarantine ? ` · ${source.stats.pendingQuarantine}` : '')],
    );
    subnav.append(link);
  }
  container.append(subnav);

  let body;
  try {
    if (tab === 'contracts') body = await renderContracts(state, source, ctx);
    else if (tab === 'batches') body = await renderBatches(state, source, ctx);
    else if (tab === 'quarantine') body = await renderQuarantine(state, source, ctx);
    else if (tab === 'policy') body = await renderPolicy(state, source, ctx);
    else if (tab === 'exceptions') body = await renderExceptions(state, source, ctx);
    else body = await renderVerify(state, source, ctx);
  } catch (error) {
    body = el('div', { class: 'notice critical' }, [el('span', { class: 'ico' }, ['⚠']), el('div', {}, [`加载失败：${error.message}`])]);
  }
  container.append(body);
  return container;
}

/* ============================================================
   契约版本
   ============================================================ */

async function renderContracts(state, source, { navigate, refresh, rerender, meta }) {
  const [proposals] = await Promise.all([api.proposals(source.slug)]);
  const wrap = el('div');
  const current = source.currentContract;
  const proposed = source.contracts.filter((c) => c.status === 'proposed');
  const archived = source.contracts.filter((c) => c.status !== 'proposed');

  wrap.append(
    sectionHead('当前生效契约', `${current ? current.version : '—'} · ${current ? current.fieldCount : 0} 个字段`, [
      { label: '提交新版本草案', primary: true, onClick: () => openVersionEditor(state, source, proposals, { refresh, rerender }) },
    ]),
  );

  if (!current) {
    wrap.append(el('div', { class: 'notice critical' }, ['该数据源没有生效契约，采集任务将无法运行。']));
  } else {
    wrap.append(contractCard(current, { source, onCompare: (from, to) => openCompare(source, from, to) }));
    wrap.append(fieldTable(current.fields, { meta }));
  }

  if (proposals.proposals.length) {
    wrap.append(sectionHead('观测到的新字段', '来自历史批次的未声明字段，按类型众数聚合'));
    wrap.append(proposalPanel(source, proposals.proposals, { refresh, rerender }));
  }

  wrap.append(sectionHead('待批准的版本', proposed.length ? `${proposed.length} 个草案` : '暂无', []));
  if (!proposed.length) {
    wrap.append(el('div', { class: 'empty' }, [el('strong', {}, ['没有待批准版本']), '当上游宣布新增枚举或字段时，提交草案后在此审阅并批准。']));
  } else {
    for (const contract of proposed) {
      wrap.append(proposedCard(source, contract, current, { refresh, rerender }));
    }
  }

  wrap.append(sectionHead('版本历史', '对比任意两个版本，并查看受影响批次'));
  wrap.append(historyPanel(source, archived, { navigate }));
  return wrap;
}

function sectionHead(title, hint, actions = []) {
  const head = el('div', { class: 'section-head' });
  head.innerHTML = `<h3>${esc(title)}</h3>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}<span class="spacer"></span>`;
  const row = el('div', { class: 'btn-row' });
  for (const action of actions) {
    row.append(el('button', { class: `btn sm ${action.primary ? 'primary' : ''}`, type: 'button', onclick: action.onClick }, [action.label]));
  }
  head.append(row);
  return head;
}

function contractCard(contract, { source, onCompare }) {
  const card = el('div', { class: 'card stack' });
  card.innerHTML = `
    <div class="row spread">
      <div class="row tight">
        <code style="font-size:14px;font-weight:650">${esc(contract.version)}</code>
        ${statusBadge(contract.status)}
        ${compatBadge(contract.compatibility)}
        <span class="muted small">${esc(contract.changelog ?? '无变更说明')}</span>
      </div>
      <div class="row tight small muted">
        <span>创建于 ${esc(fmtDateTime(contract.createdAt))}</span>
        ${contract.approvedAt ? `<span>· 批准于 ${esc(fmtDateTime(contract.approvedAt))}</span>` : ''}
      </div>
    </div>
    ${contract.approvedNote ? `<div class="notice good small">批准备注：${esc(contract.approvedNote)}</div>` : ''}
  `;
  return card;
}

function fieldTable(fields, { meta }) {
  const table = el('div', { class: 'table-wrap' });
  table.innerHTML = `
    <table class="data">
      <thead><tr>
        <th>字段</th><th>类型</th><th>必填</th><th>可空</th><th>枚举 / 约束</th><th>格式</th><th>语义</th><th>策略覆盖</th>
      </tr></thead>
      <tbody>
        ${fields
          .map((f) => {
            const constraints = [];
            if (f.enum?.length) constraints.push(`枚举 ${f.enum.length} 项：${f.enum.map((v) => `"${v}"`).join('、')}`);
            if (f.min !== null && f.min !== undefined) constraints.push(`min ${f.min}`);
            if (f.max !== null && f.max !== undefined) constraints.push(`max ${f.max}`);
            if (f.minLength !== null && f.minLength !== undefined) constraints.push(`minLen ${f.minLength}`);
            if (f.maxLength !== null && f.maxLength !== undefined) constraints.push(`maxLen ${f.maxLength}`);
            if (f.pattern) constraints.push(`pattern /${f.pattern}/`);
            const semantics = [
              f.semantics?.unit ? `单位 ${f.semantics.unit}` : null,
              f.semantics?.scale !== undefined ? `scale ${f.semantics.scale}` : null,
              f.semantics?.dateFormat ? `日期格式 ${f.semantics.dateFormat}` : null,
              f.semantics?.namespace ? `命名空间 ${f.semantics.namespace}` : null,
            ].filter(Boolean);
            const overrides = Object.entries(f.policy ?? {});
            return `<tr>
              <td>
                <div style="font-weight:600">${esc(f.name)}</div>
                <div class="muted tiny">${esc(f.label ?? '')}</div>
              </td>
              <td><code>${esc(f.type)}</code></td>
              <td>${f.required ? badge('必填', 'warning') : '<span class="muted">可选</span>'}</td>
              <td>${f.nullable ? '<span class="muted">可空</span>' : '<span class="muted">非空</span>'}</td>
              <td class="small break">${constraints.map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
              <td class="small">${f.format ? `<code>${esc(f.format)}</code>` : '<span class="muted">—</span>'}</td>
              <td class="small">${semantics.map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
              <td class="small">${overrides.length ? overrides.map(([c, a]) => `${badge(meta?.categories?.[c]?.label ?? c, 'outline')} → ${actionBadge(a)}`).join('<br>') : '<span class="muted">跟随全局</span>'}</td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
  return table;
}

function proposalPanel(source, proposals, { refresh, rerender }) {
  const host = el('div', { class: 'grid cols-3' });
  for (const proposal of proposals) {
    const card = el('div', { class: 'card stack' });
    card.innerHTML = `
      <div class="row spread">
        <div class="row tight"><strong>${esc(proposal.name)}</strong>${badge(proposal.suggestedType, 'outline')}</div>
        <span class="muted small">${proposal.occurrences} 次观测</span>
      </div>
      ${proposal.hasTypeDisagreement ? `<div class="notice warning small">观测到多种类型：${esc(Object.entries(proposal.typeBreakdown).map(([t, n]) => `${t}×${n}`).join('，'))}，建议人工确认。</div>` : ''}
      <div class="small secondary">首次观测 ${esc(fmtDateTime(proposal.firstSeen))}</div>
      <div class="pill-row">${proposal.batches.map((b) => `<span class="chip">#${b.id} ${esc(b.variant)}</span>`).join('')}</div>
      <details class="expander"><summary>样本值</summary><pre class="sample">${esc(fmtPretty(proposal.samples.map((s) => ({ rowIndex: s.rowIndex, value: s.value }))))}</pre></details>
      <div class="btn-row"><button class="btn sm" type="button" data-add>加入新版本草案</button></div>
    `;
    card.querySelector('[data-add]').addEventListener('click', () =>
      openVersionEditor(source, null, { proposals: [proposal] }, { refresh, rerender }),
    );
    host.append(card);
  }
  return host;
}

function proposedCard(source, contract, current, { refresh, rerender }) {
  const proposal = contract.proposal ?? { changes: [] };
  const breaking = proposal.changes?.filter((c) => c.breaking) ?? [];
  const card = el('div', { class: 'card stack' });
  card.innerHTML = `
    <div class="row spread">
      <div class="row tight">
        <code style="font-size:14px;font-weight:650">${esc(contract.version)}</code>
        ${statusBadge(contract.status)}
        ${compatBadge(contract.compatibility)}
        <span class="muted small">${esc(contract.changelog ?? '未填写变更说明')}</span>
      </div>
      <span class="muted small">基于 ${esc(current?.version ?? '—')}</span>
    </div>
    <div class="diff-list">
      ${(proposal.changes ?? []).map(diffItem).join('') || '<div class="diff-item safe"><div class="diff-kind">无变化</div><div class="detail">字段定义与当前版本一致</div></div>'}
    </div>
    ${breaking.length ? `<div class="notice critical"><span class="ico">⚠</span><div><strong>包含 ${breaking.length} 项破坏性变化。</strong>批准后所有历史数据按新契约回放可能失败，必须先评估受影响批次。</div></div>` : `<div class="notice good"><span class="ico">✓</span><div>前向兼容版本：只放宽约束或增加枚举/可选字段，可直接批准。</div></div>`}
    <div class="btn-row">
      <button class="btn sm primary" type="button" data-approve>批准并生效</button>
      <button class="btn sm" type="button" data-compare>与当前版本对比</button>
    </div>
  `;
  card.querySelector('[data-approve]').addEventListener('click', () =>
    approveFlow(source, contract, { refresh, rerender }),
  );
  card.querySelector('[data-compare]').addEventListener('click', () => openCompare(source, current?.version, contract.version));
  return card;
}

function diffItem(change) {
  return `<div class="diff-item ${change.breaking ? 'breaking' : 'safe'}">
    <div class="diff-kind">${change.breaking ? '破坏性' : '兼容'}</div>
    <div>
      <div class="detail">${esc(change.detail)}</div>
      <div class="sub">${esc(change.fieldPath ?? '')} · ${esc(change.kind)}${change.aspect ? ` · ${esc(change.aspect)}` : ''}</div>
    </div>
  </div>`;
}

async function approveFlow(source, contract, { refresh, rerender }) {
  const body = el('div', { class: 'stack' });
  const breaking = (contract.proposal?.changes ?? []).filter((c) => c.breaking);
  body.innerHTML = `
    <div class="notice ${breaking.length ? 'warning' : 'good'}">
      <span class="ico">${breaking.length ? '⚠' : '✓'}</span>
      <div>即将批准契约 <strong>${esc(contract.version)}</strong>（${esc(contract.compatibility)}）。批准后新的采集批次将按该契约校验，历史批次保留原契约记录。</div>
    </div>
    ${breaking.length ? `<div class="notice critical"><span class="ico">⚠</span><div><strong>该版本含破坏性变化</strong>，不能按“兼容版本”直接批准；如确需推进，请勾选下方确认，并先查看受影响批次。</div></div>` : ''}
    <div class="field"><label for="approve-note">批准备注</label><input id="approve-note" type="text" placeholder="例如：源端已确认，灰度两天" /></div>
    ${breaking.length ? `<label class="check"><input type="checkbox" id="approve-breaking" /> 我已核对受影响批次，确认按破坏性版本推进</label>` : ''}
  `;
  const footer = el('div', { class: 'btn-row' });
  const approveBtn = el('button', { class: 'btn primary', type: 'button' }, ['确认批准']);
  const compareBtn = el('button', { class: 'btn', type: 'button' }, ['查看受影响批次']);
  footer.append(compareBtn, approveBtn);
  const dialog = openModal({ title: `批准契约 ${contract.version}`, body, footer });

  compareBtn.addEventListener('click', () => {
    dialog.close();
    openCompare(source, source.currentContract?.version, contract.version);
  });
  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    try {
      await api.approveContract(source.slug, contract.version, {
        note: body.querySelector('#approve-note').value,
        confirmBreaking: Boolean(body.querySelector('#approve-breaking')?.checked),
      });
      dialog.close();
      toast(`契约 ${contract.version} 已生效`);
      await refresh();
      rerender();
    } catch (error) {
      approveBtn.disabled = false;
      toast(error.message, 'error');
    }
  });
}

function historyPanel(source, archived, { navigate }) {
  const wrap = el('div', { class: 'card stack' });
  wrap.innerHTML = `
    <div class="row spread">
      <div class="row tight">
        <label class="small muted" for="cmp-from">从</label>
        <select id="cmp-from" style="width:auto">${archived.map((c) => `<option value="${esc(c.version)}">${esc(c.version)} · ${esc(c.status)}</option>`).join('')}</select>
        <label class="small muted" for="cmp-to">到</label>
        <select id="cmp-to" style="width:auto">${source.contracts.map((c) => `<option value="${esc(c.version)}">${esc(c.version)} · ${esc(c.status)}</option>`).join('')}</select>
        <button class="btn sm" type="button" id="cmp-run">对比</button>
      </div>
      <span class="muted small">共 ${source.contracts.length} 个版本</span>
    </div>
    <div id="cmp-result"></div>
  `;
  const fromSelect = wrap.querySelector('#cmp-from');
  const toSelect = wrap.querySelector('#cmp-to');
  const currentVersion = source.currentContract?.version;
  const proposedVersion = source.contracts.find((c) => c.status === 'proposed')?.version;
  // 默认对比“当前生效 → 待批准草案”，没有草案时退回上一个已归档版本。
  if (proposedVersion) toSelect.value = proposedVersion;
  else if (currentVersion) toSelect.value = currentVersion;
  if (archived.length) fromSelect.value = archived[0].version;
  else if (currentVersion) fromSelect.value = currentVersion;
  wrap.querySelector('#cmp-run').addEventListener('click', () =>
    openCompare(source, fromSelect.value, toSelect.value, { navigate }),
  );
  return wrap;
}

async function openCompare(source, from, to, { navigate } = {}) {
  if (!from || !to) {
    toast('请选择两个版本', 'error');
    return;
  }
  const body = el('div', { class: 'stack' });
  body.innerHTML = '<div class="loading">计算差异…</div>';
  const footer = el('div', { class: 'btn-row' });
  const dialog = openModal({ title: `契约对比 ${from} → ${to}`, body, footer, wide: true });
  try {
    const data = await api.compare(source.slug, from, to);
    const diff = data.diff;
    body.innerHTML = `
      <div class="row spread">
        <div class="row tight">${compatBadge(diff.compatibility)}<span class="secondary small">${esc(diff.summary)}</span></div>
        <div class="row tight small muted">
          <span>${diff.changes.length} 项变化</span><span>·</span><span>${diff.breakingCount} 项破坏性</span>
        </div>
      </div>
      <div class="diff-list">
        ${diff.changes.map(diffItem).join('') || '<div class="diff-item safe"><div class="diff-kind">一致</div><div class="detail">两个版本的字段定义没有差异</div></div>'}
      </div>
      <div class="section-head" style="margin:6px 0 0"><h3>受影响批次</h3><span class="hint">在旧契约下已采集、且命中这些字段的批次</span></div>
      ${renderImpacted(data.impactedBatches, navigate)}
    `;
    const exportBtn = el('button', { class: 'btn sm', type: 'button' }, ['导出对比 JSON']);
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `${source.slug}-${from}-to-${to}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
    footer.append(exportBtn);
  } catch (error) {
    body.innerHTML = `<div class="notice critical">对比失败：${esc(error.message)}</div>`;
  }
  return dialog;
}

function renderImpacted(impacted, navigate) {
  if (!impacted.length) return emptyState('没有命中这些字段的历史批次', '可能是新字段，或变化仅影响未来数据');
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>批次</th><th>场景</th><th>契约</th><th>判定</th><th>命中的差异</th><th></th></tr></thead>
    <tbody>
      ${impacted
        .map(
          (row) => `<tr>
        <td class="mono">#${row.batch.id}</td>
        <td>${esc(row.batch.variantLabel)}<div class="muted tiny">${esc(fmtDateTime(row.batch.createdAt))}</div></td>
        <td class="mono">${esc(row.batch.contractVersion)}</td>
        <td>${decisionBadge(row.batch.decision)}</td>
        <td class="small">${row.findings
          .map((f) => `${esc(f.message)} ${actionBadge(f.action)}`)
          .join('<br>')}</td>
        <td><button class="btn sm ghost" type="button" data-batch="${row.batch.id}">查看</button></td>
      </tr>`,
        )
        .join('')}
    </tbody></table></div>`;
}

function openVersionEditor(state, source, proposalsData, { refresh, rerender }) {
  const proposals = proposalsData?.proposals ?? [];
  const base = source.currentContract;
  if (!base) {
    toast('当前没有生效契约，无法基于其创建草案', 'error');
    return;
  }
  const fields = base.fields.map((f) => ({ ...f }));
  for (const proposal of proposals) {
    if (fields.some((f) => f.name === proposal.name)) continue;
    fields.push(proposal.suggestedField ?? { name: proposal.name, type: proposal.suggestedType, required: false, nullable: true });
  }

  const body = el('div', { class: 'stack' });
  body.innerHTML = `
    <div class="notice info"><span class="ico">i</span><div>提交后先成为<strong>待批准草案</strong>；系统会根据字段差异自动推导兼容性并给出建议版本号。批准前不会影响采集。</div></div>
    <div class="field">
      <label for="ver-changelog">变更说明</label>
      <input id="ver-changelog" type="text" placeholder="例如：采纳 loyalty_tier 字段，源端已声明" />
    </div>
    <div class="field">
      <label for="ver-fields">字段定义 JSON（可编辑；每项含 name/type/required/nullable/enum/min/max/format/semantics/policy）</label>
      <textarea id="ver-fields" style="min-height:320px" spellcheck="false">${esc(fmtPretty(fields))}</textarea>
      <span class="help">兼容性由字段差异自动推导，不采用提交者自报。语义变更（单位/量纲）一律视为破坏性。</span>
    </div>
    <div id="ver-error"></div>
  `;
  const footer = el('div', { class: 'btn-row' });
  const submit = el('button', { class: 'btn primary', type: 'button' }, ['提交草案']);
  footer.append(submit);
  const dialog = openModal({ title: `提交新版本草案 · 基于 ${base.version}`, body, footer, wide: true });

  submit.addEventListener('click', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body.querySelector('#ver-fields').value);
    } catch (error) {
      body.querySelector('#ver-error').innerHTML = `<div class="notice critical">JSON 解析失败：${esc(error.message)}</div>`;
      return;
    }
    submit.disabled = true;
    try {
      const contract = await api.createContract(source.slug, {
        fields: parsed,
        changelog: body.querySelector('#ver-changelog').value,
      });
      dialog.close();
      toast(`草案 ${contract.version} 已提交（${contract.compatibility === 'breaking' ? '含破坏性变化' : '前向兼容'}）`);
      await refresh();
      rerender();
    } catch (error) {
      submit.disabled = false;
      body.querySelector('#ver-error').innerHTML = `<div class="notice critical">${esc(error.message)}</div>`;
      if (error.data?.changes?.length) {
        body.querySelector('#ver-error').innerHTML += `<div class="diff-list" style="margin-top:8px">${error.data.changes.map(diffItem).join('')}</div>`;
      }
    }
  });
}

/* ============================================================
   采集批次
   ============================================================ */

async function renderBatches(state, source, { batchId, navigate, refresh, rerender, meta }) {
  const wrap = el('div');
  const variants = meta?.catalog?.find((c) => c.slug === source.slug)?.variants ?? [];
  const mockPanel = el('div', { class: 'card stack' });
  mockPanel.innerHTML = `
    <div class="card-head"><h4>本地模拟接口</h4><span class="spacer"></span><span class="card-sub">制造新增字段、类型变更、枚举扩展、字段缺失与语义冲突</span></div>
    <div class="form-row">
      <div class="field" style="flex:2">
        <label for="mock-variant">场景</label>
        <select id="mock-variant">${variants.map((v) => `<option value="${esc(v)}">${esc(meta?.variants?.[v]?.label ?? v)} — ${esc(meta?.variants?.[v]?.hint ?? '')}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label for="mock-mode">数据流模式</label>
        <select id="mock-mode">
          <option value="live">正式采集（按策略处置）</option>
          <option value="shadow">观察模式（只记录差异，不处置）</option>
        </select>
      </div>
      <div class="field" style="flex:1.4">
        <label for="mock-label">批次标签</label>
        <input id="mock-label" type="text" placeholder="可选，便于识别" />
      </div>
      <button class="btn primary" id="mock-run" type="button">调用模拟接口并采集</button>
      <button class="btn" id="mock-peek" type="button">查看载荷</button>
    </div>
  `;
  const runBtn = mockPanel.querySelector('#mock-run');
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    try {
      const variant = mockPanel.querySelector('#mock-variant').value;
      const result = await api.ingest(source.slug, {
        variant,
        mode: mockPanel.querySelector('#mock-mode').value,
        label: mockPanel.querySelector('#mock-label').value || undefined,
      });
      toast(`批次 #${result.batch.id} 判定：${result.batch.decisionLabel}（隔离 ${result.batch.counts.quarantined}，阻断 ${result.batch.counts.blocked}）`);
      await refresh();
      navigate(`/source/${source.slug}/batches/${result.batch.id}`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      runBtn.disabled = false;
    }
  });
  mockPanel.querySelector('#mock-peek').addEventListener('click', async () => {
    try {
      const variant = mockPanel.querySelector('#mock-variant').value;
      const data = await api.mock(source.slug, variant);
      const body = el('div');
      body.innerHTML = `<pre class="sample" style="max-height:52vh">${esc(fmtPretty(data.payload))}</pre>`;
      openModal({ title: `模拟载荷 · ${variant}`, body, wide: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.append(mockPanel);

  if (batchId) {
    wrap.append(await renderBatchDetail(source, batchId, { navigate, refresh, rerender }));
    return wrap;
  }

  const { batches } = await api.batches(source.slug, 60);
  wrap.append(sectionHead('采集批次', `${batches.length} 个批次`, []));
  if (!batches.length) {
    wrap.append(emptyState('还没有批次', '使用上方模拟接口生成一次采集'));
    return wrap;
  }
  const table = el('div', { class: 'table-wrap' });
  table.innerHTML = `<table class="data">
    <thead><tr><th>批次</th><th>场景 / 标签</th><th>契约</th><th>模式</th><th>判定</th><th class="num">放行</th><th class="num">隔离</th><th class="num">阻断</th><th class="num">差异</th><th>时间</th></tr></thead>
    <tbody>${batches
      .map(
        (b) => `<tr class="clickable" data-id="${b.id}">
      <td class="mono">#${b.id}</td>
      <td>${esc(b.variantLabel)}<div class="muted tiny">${esc(b.label ?? '')}</div></td>
      <td class="mono">${esc(b.contractVersion)}</td>
      <td>${b.mode === 'shadow' ? badge('观察', 'info') : badge('正式', 'neutral')}</td>
      <td>${decisionBadge(b.decision)}</td>
      <td class="num">${b.counts.accepted ?? 0}</td>
      <td class="num">${b.counts.quarantined ?? 0}</td>
      <td class="num">${b.counts.blocked ?? 0}</td>
      <td class="num">${b.findingCount}${b.suppressedCount ? `<span class="muted tiny">（豁免 ${b.suppressedCount}）</span>` : ''}</td>
      <td class="muted nowrap" title="${esc(fmtDateTime(b.createdAt))}">${esc(fmtRelative(b.createdAt))}</td>
    </tr>`,
      )
      .join('')}</tbody></table>`;
  table.querySelectorAll('tr[data-id]').forEach((row) => {
    row.addEventListener('click', () => navigate(`/source/${source.slug}/batches/${row.dataset.id}`));
  });
  wrap.append(table);
  return wrap;
}

async function renderBatchDetail(source, batchId, { navigate, refresh, rerender }) {
  const batch = await api.batch(batchId);
  const wrap = el('div', { class: 'stack' });
  const shadow = batch.mode === 'shadow';
  const counts = batch.counts ?? {};

  const head = el('div', { class: 'card stack' });
  head.innerHTML = `
    <div class="row spread">
      <div class="row tight">
        <button class="btn sm ghost" type="button" id="back-batches">← 批次列表</button>
        <strong style="font-size:15px">批次 #${batch.id}</strong>
        ${decisionBadge(batch.decision)}
        ${shadow ? badge('观察模式', 'info') : badge('正式模式', 'neutral')}
        ${batch.suppressedCount ? badge(`豁免 ${batch.suppressedCount} 类`, 'neutral') : ''}
      </div>
      <span class="muted small">${esc(fmtDateTime(batch.createdAt))} · 耗时 ${batch.durationMs ?? 0}ms</span>
    </div>
    <div class="dl">
      <dt>场景</dt><dd>${esc(batch.variantLabel)} · ${esc(batch.label ?? '—')}</dd>
      <dt>契约版本</dt><dd><code>${esc(batch.contractVersion)}</code></dd>
      <dt>记录数</dt><dd>${batch.recordCount} 行</dd>
      <dt>归一化</dt><dd>${batch.normalization?.coerced ? `数值字符串无损归一化 ${batch.normalization.coerced} 次（不记为漂移）` : '无'}</dd>
      <dt>源端声明</dt><dd class="small break">${esc(fmtJson(batch.meta ?? {}, 300))}</dd>
    </div>
    ${shadow ? `<div class="notice info"><span class="ico">i</span><div>观察模式只采集差异，不改变数据流；原始建议处置见下方。</div></div>` : ''}
    <div>${segmentedBar([
      { label: '放行', value: counts.accepted ?? 0, tone: 'good' },
      { label: '隔离', value: counts.quarantined ?? 0, tone: 'warning' },
      { label: '阻断', value: counts.blocked ?? 0, tone: 'critical' },
    ])}</div>
  `;
  head.querySelector('#back-batches').addEventListener('click', () => navigate(`/source/${source.slug}/batches`));
  wrap.append(head);

  if (!batch.findings.length) {
    wrap.append(el('div', { class: 'notice good' }, [el('span', { class: 'ico' }, ['✓']), el('div', {}, ['本批没有检测到任何差异。'])]));
  } else {
    wrap.append(sectionHead('差异明细', `${batch.findings.length} 类差异，含具体样本`));
    for (const finding of batch.findings) {
      wrap.append(findingCard(source, batch, finding, { refresh, rerender, navigate }));
    }
  }

  if (batch.quarantineRows?.length) {
    const pending = batch.quarantineRows.filter((r) => r.status === 'pending');
    const blocked = batch.quarantineRows.filter((r) => r.status === 'blocked');
    wrap.append(
      sectionHead(
        '隔离区记录',
        `${batch.quarantineRows.length} 行` +
          (pending.length ? ` · 待处理 ${pending.length}` : '') +
          (blocked.length ? ` · 已阻断 ${blocked.length}（保留证据，不能回放）` : ''),
      ),
    );
    wrap.append(quarantineTable(source, batch.quarantineRows, { refresh, rerender, navigate }));
  }
  return wrap;
}

function findingCard(source, batch, finding, { refresh, rerender, navigate }) {
  const card = el('div', { class: 'finding' });
  const observed = finding.observed ?? {};
  const expected = finding.expected ?? {};
  card.innerHTML = `
    <div class="finding-head">
      <div class="grow">
        <div class="finding-title">
          ${badge(finding.categoryLabel, categoryTone(finding.category))}
          ${severityBadge(finding.severity)}
          ${finding.suppressed ? badge('已豁免', 'neutral') : actionBadge(finding.action)}
          ${badge(`${finding.fieldPath}`, 'outline')}
          <span class="muted tiny">${finding.occurrences} 次</span>
        </div>
        <div class="finding-msg">${esc(finding.message)}</div>
        <div class="muted tiny" style="margin-top:4px">${esc(finding.actionReason ?? '')}${finding.recommendedAction ? ` · 建议处置 ${esc(finding.recommendedAction)}` : ''}</div>
      </div>
      <div class="finding-actions">
        ${finding.category === 'new_field' ? `<button class="btn sm" type="button" data-adopt>采纳字段</button>` : ''}
        <button class="btn sm" type="button" data-exception>登记为误报</button>
      </div>
    </div>
    <div class="finding-body">
      <div class="grid cols-2">
        <div><div class="tiny muted">契约期望</div><pre class="sample">${esc(fmtPretty(expected))}</pre></div>
        <div><div class="tiny muted">实际观测</div><pre class="sample">${esc(fmtPretty(observed))}</pre></div>
      </div>
      ${finding.samples?.length
        ? `<details class="expander" open><summary>差异样本（${finding.samples.length} 条，保留原始记录）</summary>
            <div class="stack">${finding.samples
              .map(
                (sample, i) => `<div>
                  <div class="tiny muted">第 ${sample.rowIndex === null || sample.rowIndex === undefined ? '—' : sample.rowIndex + 1} 行${sample.note ? ` · ${esc(sample.note)}` : ''}</div>
                  <pre class="sample">${esc(fmtPretty({ observed: sample.observed, record: sample.record }))}</pre>
                </div>`,
              )
              .join('')}</div>
          </details>`
        : '<div class="muted small">该差异没有可展示的记录级样本（载荷级问题）。</div>'}
    </div>
  `;
  const exceptionBtn = card.querySelector('[data-exception]');
  exceptionBtn?.addEventListener('click', () => openExceptionDialog(source, { batch, finding, refresh, rerender }));
  const adoptBtn = card.querySelector('[data-adopt]');
  adoptBtn?.addEventListener('click', async () => {
    try {
      const data = await api.proposals(source.slug);
      const proposal = data.proposals.find((p) => p.name === finding.fieldPath) ?? {
        name: finding.fieldPath,
        suggestedType: finding.observed?.type ?? 'string',
        suggestedField: { name: finding.fieldPath, type: finding.observed?.type ?? 'string', required: false, nullable: true },
        occurrences: finding.occurrences,
      };
      openVersionEditor(null, source, { proposals: [proposal] }, { refresh, rerender });
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  return card;
}

function openExceptionDialog(source, { batch, finding, refresh, rerender }) {
  const body = el('div', { class: 'stack' });
  body.innerHTML = `
    <div class="notice warning"><span class="ico">⚠</span><div>例外只豁免<strong>完全相同的签名</strong>（类别 + 字段 + 变形形状）。同一字段的其他变形仍会被检测并处置，避免误报把真实漂移一起吞掉。</div></div>
    <div class="dl">
      <dt>漂移类别</dt><dd>${esc(finding.categoryLabel)}</dd>
      <dt>字段</dt><dd><code>${esc(finding.fieldPath)}</code></dd>
      <dt>签名</dt><dd><code>${esc(finding.signature)}</code></dd>
      <dt>观测</dt><dd class="break"><code>${esc(fmtJson(finding.observed, 200))}</code></dd>
      <dt>来源批次</dt><dd>#${batch.id} · ${esc(batch.contractVersion)}</dd>
    </div>
    <div class="field"><label for="exc-note">登记理由</label><input id="exc-note" type="text" placeholder="例如：合作方文档 v5 已声明该字段" /></div>
    <div id="exc-preview"></div>
  `;
  const footer = el('div', { class: 'btn-row' });
  const previewBtn = el('button', { class: 'btn', type: 'button' }, ['预览影响']);
  const confirmBtn = el('button', { class: 'btn primary', type: 'button' }, ['登记例外']);
  footer.append(previewBtn, confirmBtn);
  const dialog = openModal({ title: '登记误报例外', body, footer });

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      const preview = await api.previewException(source.slug, {
        category: finding.category,
        fieldPath: finding.fieldPath,
        signature: finding.signature,
      });
      body.querySelector('#exc-preview').innerHTML = `
        <div class="notice ${preview.otherSignatureCount ? 'warning' : 'info'}">
          <span class="ico">${preview.otherSignatureCount ? '⚠' : 'i'}</span>
          <div>将豁免 <strong>${preview.matchCount}</strong> 处完全匹配的差异。${
            preview.otherSignatureCount
              ? `同字段另有 <strong>${preview.otherSignatureCount}</strong> 处不同签名的同类漂移不受影响。`
              : '当前没有其他签名的同字段漂移。'
          }</div>
        </div>
        ${preview.matches.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>批次</th><th>场景</th><th>判定</th><th>观测</th></tr></thead><tbody>${preview.matches
          .map((m) => `<tr><td class="mono">#${m.batchId}</td><td>${esc(m.variant)}</td><td>${decisionBadge(m.decision)}</td><td class="small break">${esc(fmtJson(m.observed, 120))}</td></tr>`)
          .join('')}</tbody></table></div>` : ''}
      `;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      previewBtn.disabled = false;
    }
  });
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await api.createException(source.slug, {
        batchId: batch.id,
        category: finding.category,
        fieldPath: finding.fieldPath,
        signature: finding.signature,
        note: body.querySelector('#exc-note').value,
      });
      dialog.close();
      toast('例外已登记；已发生批次的处置记录不会被追溯修改');
      await refresh();
      rerender();
    } catch (error) {
      confirmBtn.disabled = false;
      toast(error.message, 'error');
    }
  });
}

function categoryTone(category) {
  if (category === 'new_field' || category === 'enum_extension') return 'info';
  if (category === 'semantic_conflict' || category === 'missing_required') return 'critical';
  return 'warning';
}

/* ============================================================
   隔离与回放
   ============================================================ */

async function renderQuarantine(state, source, { refresh, rerender, navigate }) {
  const wrap = el('div', { class: 'stack' });
  const status = state._quarantineStatus ?? 'pending';
  const { rows } = await api.quarantine(source.slug, status);
  const counts = {
    pending: source.stats.pendingQuarantine,
  };
  const toolbar = el('div', { class: 'card row spread' });
  toolbar.innerHTML = `
    <div class="row tight">
      <div class="seg" id="q-filter">
        ${['pending', 'replayed_ok', 'replayed_failed', 'blocked', 'all'].map((key) => `<button type="button" data-key="${key}" class="${key === status ? 'active' : ''}">${statusLabel(key)}</button>`).join('')}
      </div>
      <span class="muted small">待处理 ${counts.pending} 行</span>
    </div>
    <div class="btn-row">
      <button class="btn sm" type="button" id="q-replay-all">用当前契约回放当前筛选</button>
    </div>
  `;
  toolbar.querySelectorAll('#q-filter button').forEach((button) => {
    button.addEventListener('click', () => {
      state._quarantineStatus = button.dataset.key;
      rerender();
    });
  });
  toolbar.querySelector('#q-replay-all').addEventListener('click', async () => {
    try {
      const result = await api.replayAll(source.slug, { status });
      toast(`回放 ${result.total} 行：放行 ${result.accepted}，仍隔离 ${result.quarantined}，阻断 ${result.blocked}`);
      await refresh();
      rerender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.append(toolbar);

  if (!rows.length) {
    wrap.append(emptyState('没有符合条件的隔离记录', status === 'pending' ? '当前没有待处理隔离，可切换到“全部”查看历史' : ''));
    return wrap;
  }
  wrap.append(quarantineTable(source, rows, { refresh, rerender, navigate }));
  return wrap;
}

function statusLabel(status) {
  return (
    {
      pending: '待处理',
      replayed_ok: '回放通过',
      replayed_failed: '回放仍失败',
      blocked: '阻断',
      all: '全部',
    }[status] ?? status
  );
}

function quarantineTable(source, rows, { refresh, rerender, navigate }) {
  const table = el('div', { class: 'table-wrap' });
  table.innerHTML = `<table class="data">
    <thead><tr><th>#</th><th>批次</th><th>行号</th><th>状态</th><th>原因</th><th>回放结果</th><th></th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
      <td class="mono">${row.id}</td>
      <td class="mono">#${row.batchId}</td>
      <td class="num">${row.rowIndex + 1}</td>
      <td>${badge(statusLabel(row.status), row.status === 'pending' ? 'warning' : row.status === 'replayed_ok' ? 'good' : row.status === 'blocked' ? 'critical' : 'serious')}</td>
      <td class="small">${row.reasons
        .map((r) => `${esc(r.message)} ${findingActionChip(r.action)}`)
        .join('<br>')}</td>
      <td class="small">${row.replayResult ? `${decisionBadge(row.replayResult.decision === 'accepted' ? 'accept' : row.replayResult.decision === 'quarantined' ? 'quarantine' : 'block')} <span class="muted tiny">${esc(fmtDateTime(row.replayedAt))}</span>` : '<span class="muted">—</span>'}</td>
      <td><button class="btn sm ghost" type="button" data-q="${row.id}">查看 / 回放</button></td>
    </tr>`,
      )
      .join('')}</tbody></table>`;
  table.querySelectorAll('[data-q]').forEach((button) => {
    button.addEventListener('click', () => openQuarantineDetail(source, rows.find((r) => String(r.id) === button.dataset.q), { refresh, rerender }));
  });
  return table;
}

function findingActionChip(action) {
  const label = { accept: '放行', quarantine: '隔离', block: '阻断' }[action] ?? action;
  return `<span class="badge ${action === 'block' ? 'critical' : action === 'quarantine' ? 'warning' : 'good'}">${label}</span>`;
}

function openQuarantineDetail(source, row, { refresh, rerender }) {
  const body = el('div', { class: 'stack' });
  body.innerHTML = `
    <div class="dl">
      <dt>记录</dt><dd>批次 #${row.batchId} · 第 ${row.rowIndex + 1} 行</dd>
      <dt>状态</dt><dd>${badge(statusLabel(row.status), row.status === 'pending' ? 'warning' : 'neutral')}</dd>
      <dt>处置</dt><dd>${decisionBadge(row.decision === 'blocked' ? 'block' : 'quarantine')}</dd>
    </div>
    <div>
      <div class="tiny muted">处置原因</div>
      <div class="stack" style="margin-top:6px">${row.reasons
        .map(
          (r) => `<div class="notice ${r.action === 'block' ? 'critical' : 'warning'}">
          <span class="ico">${r.action === 'block' ? '⛔' : '⚠'}</span>
          <div><strong>${esc(r.message)}</strong><div class="tiny muted">${esc(r.category)} · ${esc(r.fieldPath)}${r.suppressed ? ' · 已豁免' : ''}</div></div>
        </div>`,
        )
        .join('')}</div>
    </div>
    <div>
      <div class="tiny muted">原始记录（完整保留）</div>
      <pre class="sample" style="max-height:240px">${esc(fmtPretty(row.record))}</pre>
    </div>
    ${row.replayResult ? `<div class="notice info"><span class="ico">i</span><div>上次回放（契约 ${esc(row.replayResult.contractVersion)}）：${decisionBadge(row.replayResult.decision === 'accepted' ? 'accept' : row.replayResult.decision === 'quarantined' ? 'quarantine' : 'block')}</div></div>` : ''}
    <div class="field">
      <label for="replay-version">使用契约版本回放</label>
      <select id="replay-version">${source.contracts.map((c) => `<option value="${esc(c.version)}" ${c.status === 'active' ? 'selected' : ''}>${esc(c.version)} · ${esc(c.status)}</option>`).join('')}</select>
      <span class="help">改用能解释该记录的新契约回放；回放结果会写回隔离记录，并保留每次回放历史。</span>
    </div>
  `;
  const footer = el('div', { class: 'btn-row' });
  const replayBtn = el('button', { class: 'btn primary', type: 'button' }, ['回放该行']);
  footer.append(replayBtn);
  const dialog = openModal({ title: `隔离记录 #${row.id}`, body, footer, wide: true });
  replayBtn.addEventListener('click', async () => {
    replayBtn.disabled = true;
    try {
      const version = body.querySelector('#replay-version').value;
      const result = await api.replay(row.id, version);
      dialog.close();
      toast(
        result.newDecision === 'accepted'
          ? `回放通过：契约 ${version} 可解释该记录`
          : `回放仍为${result.newDecision === 'blocked' ? '阻断' : '隔离'}：契约 ${version} 仍不接受该记录`,
        result.newDecision === 'accepted' ? 'ok' : 'error',
      );
      await refresh();
      rerender();
    } catch (error) {
      replayBtn.disabled = false;
      toast(error.message, 'error');
    }
  });
}

/* ============================================================
   策略配置
   ============================================================ */

async function renderPolicy(state, source, { refresh, rerender, meta }) {
  const policy = source.policy;
  const wrap = el('div', { class: 'stack' });
  const versionOptions = Object.entries(meta?.versionPolicies ?? {})
    .map(([key, value]) => `<option value="${esc(key)}" ${key === source.versionPolicy ? 'selected' : ''}>${esc(value.label)} — ${esc(value.description)}</option>`)
    .join('');

  const card = el('div', { class: 'card stack' });
  card.innerHTML = `
    <div class="card-head"><h4>版本兼容策略</h4><span class="spacer"></span><span class="card-sub">决定“增量变化”是否需要审批/阻断</span></div>
    <select id="pol-version">${versionOptions}</select>
    <div class="notice info"><span class="ico">i</span><div>字段级覆盖优先于全局：在契约字段上设置 policy 可对单个字段的某类漂移单独放行/隔离/阻断。</div></div>
    <hr class="hr" />
    <div class="card-head"><h4>漂移类别处置</h4><span class="spacer"></span>
      <div class="field" style="width:150px"><label for="pol-samples">每类保留样本数</label><input id="pol-samples" type="number" min="1" max="10" value="${policy.sample_limit}" /></div>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead><tr><th>类别</th><th>说明</th><th>性质</th><th>处置</th></tr></thead>
        <tbody>
          ${CATEGORY_ORDER.map((key) => {
            const cat = meta?.categories?.[key];
            const current = policy.categories[key]?.action ?? policy.default_action;
            return `<tr>
              <td><strong>${esc(cat?.label ?? key)}</strong><div class="muted tiny mono">${esc(key)}</div></td>
              <td class="small secondary">${esc(cat?.description ?? '')}</td>
              <td>${cat?.additive ? badge('增量', 'info') : badge('破坏性', 'critical')}</td>
              <td>
                <select data-cat="${esc(key)}" style="width:110px">
                  ${['accept', 'quarantine', 'block'].map((action) => `<option value="${action}" ${action === current ? 'selected' : ''}>${actionLabel(action)}</option>`).join('')}
                </select>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="notice warning"><span class="ico">⚠</span><div><strong>放行不等于不检测。</strong>被放行的类别仍会写入差异样本与受影响批次；策略只影响数据流是否继续，不影响观测记录。</div></div>
    <div class="btn-row"><button class="btn primary" type="button" id="pol-save">保存策略</button><button class="btn" type="button" id="pol-reset">恢复默认</button></div>
  `;
  card.querySelector('#pol-reset').addEventListener('click', () => {
    card.querySelectorAll('select[data-cat]').forEach((select) => {
      select.value = meta?.defaultPolicy?.categories?.[select.dataset.cat]?.action ?? 'quarantine';
    });
    card.querySelector('#pol-samples').value = meta?.defaultPolicy?.sample_limit ?? 4;
    toast('已填入默认值，保存后生效');
  });
  card.querySelector('#pol-save').addEventListener('click', async () => {
    const categories = {};
    card.querySelectorAll('select[data-cat]').forEach((select) => {
      categories[select.dataset.cat] = { action: select.value };
    });
    try {
      await api.updateSource(source.slug, {
        versionPolicy: card.querySelector('#pol-version').value,
        policy: {
          categories,
          sample_limit: Number(card.querySelector('#pol-samples').value) || 4,
        },
      });
      toast('策略已保存；后续批次立即生效，历史批次保留原判定');
      await refresh();
      rerender();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  wrap.append(card);
  return wrap;
}

function actionLabel(action) {
  return { accept: '放行', quarantine: '隔离', block: '阻断' }[action] ?? action;
}

/* ============================================================
   误报例外
   ============================================================ */

async function renderExceptions(state, source, { refresh, rerender }) {
  const { exceptions } = await api.exceptions(source.slug);
  const wrap = el('div', { class: 'stack' });
  wrap.innerHTML = `
    <div class="notice info"><span class="ico">i</span><div>例外按<strong>类别 + 字段 + 签名</strong>精确匹配。签名由观测形状生成（字符串只记类型、对象记键名、枚举记具体值），所以 <code>bank_trace_id: "TRC…"</code> 的例外不会顺带豁免 <code>bank_trace_id: {trace, bank}</code>。</div></div>
  `;
  if (!exceptions.length) {
    wrap.append(emptyState('还没有登记任何例外', '在批次详情里对良性误报登记例外后，这里可以查看影响面并随时停用'));
    return wrap;
  }
  const table = el('div', { class: 'table-wrap' });
  table.innerHTML = `<table class="data">
    <thead><tr><th>类别</th><th>字段</th><th>签名</th><th>理由</th><th class="num">豁免观测</th><th class="num">涉及批次</th><th>状态</th><th></th></tr></thead>
    <tbody>${exceptions
      .map(
        (exception) => `<tr>
      <td>${badge(exception.categoryLabel, 'warning')}</td>
      <td><code>${esc(exception.fieldPath)}</code></td>
      <td class="mono tiny">${esc(exception.signature)}<div class="muted tiny break">${esc(fmtJson(exception.observed, 80))}</div></td>
      <td class="small">${esc(exception.note ?? '—')}</td>
      <td class="num">${exception.suppressedOccurrences}</td>
      <td class="num">${exception.affectedBatchCount}</td>
      <td>${exception.active ? badge('生效中', 'good') : badge('已停用', 'neutral')}</td>
      <td class="nowrap">
        <button class="btn sm ghost" type="button" data-impact="${exception.id}">影响面</button>
        <button class="btn sm ghost" type="button" data-toggle="${exception.id}" data-active="${exception.active ? '0' : '1'}">${exception.active ? '停用' : '启用'}</button>
      </td>
    </tr>`,
      )
      .join('')}</tbody></table>`;
  table.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api.toggleException(button.dataset.toggle, button.dataset.active === '1');
        toast(button.dataset.active === '1' ? '例外已启用' : '例外已停用；后续同类漂移将恢复处置');
        await refresh();
        rerender();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  table.querySelectorAll('[data-impact]').forEach((button) => {
    button.addEventListener('click', () => openExceptionImpact(source, button.dataset.impact));
  });
  wrap.append(table);
  return wrap;
}

async function openExceptionImpact(source, id) {
  const body = el('div', { class: 'stack' });
  body.innerHTML = '<div class="loading">计算影响面…</div>';
  openModal({ title: '例外影响面', body, wide: true });
  try {
    const data = await api.exceptionImpact(id);
    body.innerHTML = `
      <div class="notice ${data.otherSignatureCount ? 'warning' : 'info'}">
        <span class="ico">${data.otherSignatureCount ? '⚠' : 'i'}</span>
        <div>精确匹配 <strong>${data.matchCount}</strong> 处；同字段其他签名 <strong>${data.otherSignatureCount}</strong> 处不受影响。</div>
      </div>
      ${data.matches.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>批次</th><th>场景</th><th>契约</th><th>判定</th><th>观测样本</th></tr></thead><tbody>${data.matches
        .map(
          (m) => `<tr><td class="mono">#${m.batchId}</td><td>${esc(m.variant)}<div class="muted tiny">${esc(fmtDateTime(m.createdAt))}</div></td><td class="mono">${esc(m.contractVersion)}</td><td>${decisionBadge(m.decision)}</td><td class="small break">${esc(fmtJson(m.observed, 120))}</td></tr>`,
        )
        .join('')}</tbody></table></div>` : emptyState('没有匹配的历史批次')}
    `;
  } catch (error) {
    body.innerHTML = `<div class="notice critical">${esc(error.message)}</div>`;
  }
}

/* ============================================================
   自检
   ============================================================ */

async function renderVerify(state, source) {
  const data = await api.verify(source.slug);
  const wrap = el('div', { class: 'stack' });
  const failed = data.checks.filter((c) => !c.pass);
  wrap.innerHTML = `
    <div class="card stack">
      <div class="row spread">
        <div class="row tight">
          ${data.verdict === 'ok' ? badge('全部通过', 'good', { dot: true }) : badge(`${failed.length} 项需关注`, 'critical', { dot: true })}
          <span class="secondary">对每个模拟场景跑当前契约、策略与例外</span>
        </div>
        <span class="muted small">契约 ${esc(data.contractVersion)} · ${data.passed}/${data.total} 通过</span>
      </div>
      <div class="notice info"><span class="ico">i</span><div>两项独立验证：<strong>良性形似样本不得产生漂移</strong>（误报），<strong>真实漂移必须被检测且不被例外吞掉</strong>（漏报）。</div></div>
    </div>
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th>场景</th><th>验证目标</th><th>期望</th><th>观测</th><th>结果</th></tr></thead>
      <tbody>${data.checks
        .map(
          (check) => `<tr>
        <td><strong>${esc(check.variantLabel)}</strong><div class="muted tiny mono">${esc(check.variant)}</div></td>
        <td class="small">${check.kind === 'no_false_positive' ? '不应误报' : '真实漂移应被捕获'}</td>
        <td class="small">${esc(check.expected)}</td>
        <td class="small">${esc(check.observed)}${
          check.missing?.length ? `<div class="fail tiny">漏检：${esc(check.missing.join('、'))}</div>` : ''
        }${check.swallowed?.length ? `<div class="fail tiny">被例外吞掉：${esc(check.swallowed.join('、'))}</div>` : ''}
        ${check.suppressed?.length ? `<div class="muted tiny">已豁免：${esc(check.suppressed.join('、'))}</div>` : ''}</td>
        <td class="${check.pass ? 'pass' : 'fail'}">${check.pass ? '通过' : '失败'}</td>
      </tr>`,
        )
        .join('')}</tbody></table></div>
    <div class="card">
      <div class="card-head"><h4>处置分布（当前策略）</h4></div>
      <div class="row tight">
        ${data.checks
          .map((check) => `<span class="chip">${esc(check.variantLabel)} → ${decisionBadge(check.decision)}</span>`)
          .join('')}
      </div>
      <div class="muted small" style="margin-top:8px">观察模式下判定恒为“放行”，但每条差异仍记录了建议处置（recommendedAction）。</div>
    </div>
  `;
  return wrap;
}
