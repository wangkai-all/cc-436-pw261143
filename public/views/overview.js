import { api } from '../api.js';
import { el, esc, fmtDateTime, fmtRelative, badge, actionBadge, barChart, emptyState, segmentedBar } from '../ui.js';

const CATEGORY_ORDER = ['new_field', 'enum_extension', 'missing_required', 'type_change', 'enum_violation', 'format_violation', 'constraint_violation', 'null_violation', 'semantic_conflict', 'malformed_record'];

function statTile({ label, value, note, tone }) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'stat-label' }, [label]),
    el('div', { class: 'stat-value' + (tone ? '' : '') }, [String(value)]),
    note ? el('div', { class: 'stat-note' }, [note]) : null,
  ]);
}

function categoryBars(categoryTotals, meta) {
  const rows = CATEGORY_ORDER.filter((key) => categoryTotals[key]).map((key) => ({
    label: meta?.categories?.[key]?.label ?? key,
    value: categoryTotals[key],
    tip: `${meta?.categories?.[key]?.label ?? key}：${categoryTotals[key]} 次观测`,
  }));
  return rows.length
    ? barChart(rows, { formatter: (v) => `${v} 次` })
    : emptyState('还没有任何漂移观测', '访问数据源并触发采集后，这里会显示漂移类别分布');
}

function sourceCards(sources, navigate) {
  return sources.map((source) => {
    const policyLabel = source.versionPolicyLabel;
    return el('div', { class: 'card stack' }, [
      el('div', { class: 'row spread' }, [
        el('div', { class: 'row tight' }, [
          el('a', { href: `#/source/${source.slug}`, style: 'font-weight:650;font-size:14px' }, [source.name]),
          el('span', { class: 'chip' }, [source.domain]),
        ]),
        el('span', { class: 'badge neutral' }, [policyLabel]),
      ]),
      el('div', { class: 'secondary small' }, [source.description ?? '']),
      el('div', { class: 'row tight small' }, [
        el('span', { class: 'muted' }, ['当前契约']),
        source.currentContract ? el('code', {}, [source.currentContract.version]) : el('span', { class: 'muted' }, ['—']),
        source.currentContract ? spanHtml(badge(`${source.currentContract.fieldCount} 字段`, 'outline')) : null,
      ]),
      el('div', { class: 'row tight' }, [
        el('span', { class: 'badge ' + (source.stats.pendingQuarantine ? 'warning' : 'neutral') }, [`待处理隔离 ${source.stats.pendingQuarantine}`]),
        el('span', { class: 'badge neutral' }, [`批次 ${source.stats.batches}`]),
        el('span', { class: 'badge neutral' }, [`例外 ${source.stats.activeExceptions}`]),
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn sm primary', type: 'button', onclick: () => navigate(`/source/${source.slug}/batches`) }, ['查看批次']),
        el('button', { class: 'btn sm', type: 'button', onclick: () => navigate(`/source/${source.slug}/contracts`) }, ['契约对比']),
        el('button', { class: 'btn sm', type: 'button', onclick: () => navigate(`/source/${source.slug}/verify`) }, ['自检']),
      ]),
    ]);
  });
}

function recentBatchesTable(batches, navigate) {
  if (!batches.length) return emptyState('还没有采集批次');
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'data' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['批次']),
          el('th', {}, ['数据源']),
          el('th', {}, ['场景']),
          el('th', {}, ['契约']),
          el('th', {}, ['判定']),
          el('th', { class: 'num' }, ['记录']),
          el('th', { class: 'num' }, ['差异']),
          el('th', {}, ['时间']),
        ]),
      ]),
      el(
        'tbody',
        {},
        batches.map((batch) =>
          el(
            'tr',
            {
              class: 'clickable',
              onclick: () => navigate(`/source/${batch.sourceSlug}/batches/${batch.id}`),
            },
            [
              el('td', { class: 'mono' }, [`#${batch.id}`]),
              el('td', {}, [batch.sourceName]),
              el('td', {}, [
                batch.variantLabel,
                batch.mode === 'shadow' ? el('span', { class: 'badge info', style: 'margin-left:6px' }, ['观察']) : null,
              ]),
              el('td', { class: 'mono' }, [batch.contractVersion]),
              el('td', {}, [spanHtml(actionBadge(batch.decision))]),
              el('td', { class: 'num' }, [String(batch.recordCount)]),
              el('td', { class: 'num' }, [String(batch.findingCount)]),
              el('td', { class: 'muted nowrap', title: fmtDateTime(batch.createdAt) }, [fmtRelative(batch.createdAt)]),
            ],
          ),
        ),
      ),
    ]),
  ]);
}

function spanHtml(markup) {
  const span = document.createElement('span');
  span.innerHTML = markup;
  return span;
}

export async function renderOverview(state, { navigate, refresh }) {
  const data = await api.overview();
  state.overview = data;
  state.sources = data.sources;
  const { totals, categoryTotals, rowTotals } = data;

  const recorded = totals.recordedFindings;
  const suppressed = totals.suppressedFindings;

  const container = el('div');
  container.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <h2>契约哨站</h2>
        <p>为每个数据源登记字段类型、枚举、必填与版本兼容策略；采集任务按策略选择放行、隔离或阻断，同时保留具体差异样本。误报例外按精确签名生效，真实漂移仍然可选。</p>
      </div>
      <div class="btn-row">
        <button class="btn" id="ov-verify" type="button">运行全部自检</button>
      </div>
    </div>

    <div class="card hero">
      <div class="stat">
        <div class="stat-label">累计采集批次</div>
        <div class="stat-value">${totals.batches}</div>
        <div class="stat-note">覆盖 ${totals.sources} 个数据源</div>
      </div>
      <div class="hero-meta">
        <div class="stat">
          <div class="stat-label">记录的漂移观测</div>
          <div class="stat-value small">${recorded}</div>
          <div class="stat-note">其中 ${suppressed} 次被误报例外精确豁免</div>
        </div>
        <div class="stat">
          <div class="stat-label">待处理隔离记录</div>
          <div class="stat-value small">${totals.pendingQuarantine}</div>
          <div class="stat-note">共 ${totals.totalQuarantine} 行进入隔离区</div>
        </div>
        <div class="stat">
          <div class="stat-label">阻断行</div>
          <div class="stat-value small">${totals.blockedRows}</div>
          <div class="stat-note">保留证据但不进入下游</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>漂移类别分布</h3><span class="hint">按观测次数统计；检测层记录全部差异，处置层才决定放行/隔离/阻断</span></div>
      <div class="grid cols-2">
        <div class="card" id="ov-cat"></div>
        <div class="card" id="ov-policy"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>数据源</h3><span class="hint">每个来源独立维护契约版本、策略与例外</span></div>
      <div class="grid cols-3" id="ov-sources"></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>最近采集</h3><span class="hint">点击任意批次查看差异样本与处置理由</span></div>
      <div id="ov-batches"></div>
    </div>

    <div class="section">
      <div class="section-head"><h3>最近事件</h3><span class="hint">契约批准、例外登记与批次判定</span></div>
      <div class="card" id="ov-events"></div>
    </div>
  `;

  container.querySelector('#ov-cat').innerHTML = categoryBars(categoryTotals, state.meta);
  const policyCard = container.querySelector('#ov-policy');
  policyCard.innerHTML = `
    <div class="card-head"><h4>数据流去向</h4><span class="spacer"></span><span class="card-sub">当前累计</span></div>
    ${segmentedBar([
      { label: '放行', value: rowTotals.accepted, tone: 'good' },
      { label: '隔离待处理', value: rowTotals.pendingQuarantine, tone: 'warning' },
      { label: '隔离已回放', value: rowTotals.replayedOk + rowTotals.replayedFailed, tone: 'info' },
      { label: '阻断', value: rowTotals.blocked, tone: 'critical' },
    ])}
    <div class="notice info" style="margin-top:12px">
      <span class="ico">i</span>
      <div><strong>检测与处置分离。</strong>新增字段和枚举扩展即使被策略放行，仍会作为观测进入差异样本；破坏性变化不会被“自动兼容”静默丢弃。</div>
    </div>
  `;

  const sourceHost = container.querySelector('#ov-sources');
  for (const card of sourceCards(data.sources, navigate)) sourceHost.append(card);

  container.querySelector('#ov-batches').replaceChildren(recentBatchesTable(data.recentBatches, navigate));

  const eventsHost = container.querySelector('#ov-events');
  if (!data.events.length) {
    eventsHost.innerHTML = emptyState('暂无事件');
  } else {
    eventsHost.innerHTML = `<ul class="timeline">${data.events
      .map(
        (event) => `
      <li>
        <span class="marker ${eventTone(event.type)}"></span>
        <div class="t-body">
          <div class="t-title">${esc(event.message)}</div>
          <div class="t-meta">${esc(event.sourceName ?? '全局')} · ${esc(fmtDateTime(event.createdAt))}</div>
        </div>
      </li>`,
      )
      .join('')}</ul>`;
  }

  container.querySelector('#ov-verify').addEventListener('click', () => navigate('/verify'));
  return container;
}

function eventTone(type) {
  if (type === 'contract_approved') return 'good';
  if (type === 'exception_created') return 'info';
  if (type === 'quarantine_replayed') return 'info';
  if (type === 'batch_ingested') return 'warning';
  return 'info';
}
