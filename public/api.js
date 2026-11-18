const jsonHeaders = { 'content-type': 'application/json' };

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body ? jsonHeaders : {}), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(data?.error ?? `请求失败 (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  meta: () => request('/meta'),
  overview: () => request('/overview'),
  source: (slug) => request(`/sources/${encodeURIComponent(slug)}`),
  updateSource: (slug, body) => request(`/sources/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  compare: (slug, from, to) =>
    request(`/sources/${encodeURIComponent(slug)}/contracts/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createContract: (slug, body) => request(`/sources/${encodeURIComponent(slug)}/contracts`, { method: 'POST', body: JSON.stringify(body) }),
  approveContract: (slug, version, body) =>
    request(`/sources/${encodeURIComponent(slug)}/contracts/${encodeURIComponent(version)}/approve`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  batches: (slug, limit = 40) => request(`/sources/${encodeURIComponent(slug)}/batches?limit=${limit}`),
  batch: (id) => request(`/batches/${id}`),
  ingest: (slug, body) => request(`/sources/${encodeURIComponent(slug)}/ingest`, { method: 'POST', body: JSON.stringify(body) }),
  mock: (slug, variant) => request(`/sources/${encodeURIComponent(slug)}/mock?variant=${encodeURIComponent(variant)}`),
  quarantine: (slug, status = 'all') => request(`/sources/${encodeURIComponent(slug)}/quarantine?status=${encodeURIComponent(status)}`),
  replay: (id, contractVersion) => request(`/quarantine/${id}/replay`, { method: 'POST', body: JSON.stringify({ contractVersion }) }),
  replayAll: (slug, body) => request(`/sources/${encodeURIComponent(slug)}/quarantine/replay-all`, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  exceptions: (slug) => request(`/sources/${encodeURIComponent(slug)}/exceptions`),
  createException: (slug, body) => request(`/sources/${encodeURIComponent(slug)}/exceptions`, { method: 'POST', body: JSON.stringify(body) }),
  previewException: (slug, body) =>
    request(`/sources/${encodeURIComponent(slug)}/exceptions/preview`, { method: 'POST', body: JSON.stringify(body) }),
  toggleException: (id, active) => request(`/exceptions/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  exceptionImpact: (id) => request(`/exceptions/${id}/impact`),
  proposals: (slug) => request(`/sources/${encodeURIComponent(slug)}/field-proposals`),
  verify: (slug) => request(`/sources/${encodeURIComponent(slug)}/verify`),
  verifyAll: () => request('/verify'),
};
