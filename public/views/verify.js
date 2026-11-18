import { api } from '../api.js';
import { el, esc, badge } from '../ui.js';

export async function renderVerifyPage(state, { navigate }) {
  const data = await api.verifyAll();
  const total = data.results.reduce((sum, r) => sum + r.total, 0);
  const passed = data.results.reduce((sum, r) => sum + r.passed, 0);
  const failures = data.results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => ({ ...c, source: r.source })));

  const wrap = el('div');
  wrap.innerHTML = `
    <div class="page-head">
      <div class="titles">
        <h2>防漏检自检</h2>
        <p>用固定的场景矩阵验证：良性形似数据不会被误判（误报不会淹没真实信号），真实漂移不会被检测层漏掉、也不会被误报例外吞掉（漏报）。每次改契约、改策略或登记例外后都应重跑。</p>
      </div>
      <div class="btn-row">
        <button class="btn" type="button" id="vf-refresh">重新运行</button>
      </div>
    </div>
    <div class="card hero">
      <div class="stat">
        <div class="stat-label">场景通过</div>
        <div class="stat-value">${passed}<span class="muted" style="font-size:24px">/${total}</span></div>
        <div class="stat-note">${failures.length ? `${failures.length} 项需要人工核对` : '全部通过，误报与漏报矩阵均成立'}</div>
      </div>
      <div class="hero-meta">
        ${data.results
          .map(
            (result) => `<div class="stat">
              <div class="stat-label">${esc(result.source.name)}</div>
              <div class="row tight">${result.verdict === 'ok' ? badge('通过', 'good', { dot: true }) : badge('关注', 'critical', { dot: true })}<span class="tnum">${result.passed}/${result.total}</span></div>
              <div class="stat-note">契约 ${esc(result.contractVersion ?? '—')} · ${esc(result.versionPolicy)}</div>
            </div>`,
          )
          .join('')}
      </div>
    </div>
    ${failures.length ? `<div class="notice critical"><span class="ico">⚠</span><div>存在失败项。请先查看对应数据源的批次与例外，再调整契约或策略。</div></div>` : `<div class="notice good"><span class="ico">✓</span><div>所有场景符合预期：良性样本零误报，破坏性漂移全部被检测且未被豁免。</div></div>`}
    <div class="section-head"><h3>按数据源</h3><span class="spacer"></span><span class="hint">点击数据源进入详情与自检明细</span></div>
    <div class="stack" id="vf-list"></div>
  `;

  const list = wrap.querySelector('#vf-list');
  for (const result of data.results) {
    const card = el('div', { class: 'card stack' });
    card.innerHTML = `
      <div class="row spread">
        <div class="row tight">
          <a href="#/source/${result.source.slug}/verify" style="font-weight:650">${esc(result.source.name)}</a>
          ${result.verdict === 'ok' ? badge('全部通过', 'good') : badge(`${result.checks.filter((c) => !c.pass).length} 项失败`, 'critical')}
        </div>
        <span class="muted small">${result.passed}/${result.total}</span>
      </div>
      <div class="table-wrap"><table class="matrix">
        <thead><tr><th>场景</th><th>验证目标</th><th>期望</th><th>观测</th><th>结果</th></tr></thead>
        <tbody>${result.checks
          .map(
            (check) => `<tr>
          <td class="small"><strong>${esc(check.variantLabel)}</strong></td>
          <td class="small">${check.kind === 'no_false_positive' ? '不应误报' : '真实漂移应被捕获'}</td>
          <td class="small">${esc(check.expected)}</td>
          <td class="small">${esc(check.observed)}${
            check.missing?.length ? `<div class="fail tiny">漏检：${esc(check.missing.join('、'))}</div>` : ''
          }${check.swallowed?.length ? `<div class="fail tiny">被吞：${esc(check.swallowed.join('、'))}</div>` : ''}</td>
          <td class="${check.pass ? 'pass' : 'fail'}">${check.pass ? '通过' : '失败'}</td>
        </tr>`,
          )
          .join('')}</tbody></table></div>
    `;
    list.append(card);
  }

  wrap.querySelector('#vf-refresh').addEventListener('click', () => navigate('/verify'));
  return wrap;
}
