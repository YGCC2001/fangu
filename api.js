async function req(path, opts = {}) {
  const { method = 'GET', body } = opts;
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch (e) {
    const err = new Error('网络异常，请稍后重试');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || '请求失败（' + res.status + '）');
    err.status = res.status;
    err.code = data && data.code;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  entry: () => req('/entry'),
  me: () => req('/auth/me'),
  login: (nickname, password) => req('/auth/login', { method: 'POST', body: { nickname, password } }),
  register: (nickname, password) => req('/auth/register', { method: 'POST', body: { nickname, password } }),
  demoLogin: (as) => req('/auth/demo-login', { method: 'POST', body: { as } }),
  logout: () => req('/auth/logout', { method: 'POST', body: {} }),

  today: () => req('/today'),
  topic: (id) => req('/topics/' + id),
  history: () => req('/history'),
  conclusion: (id) => req('/topics/' + id + '/conclusion'),

  stance: (id, side) => req(`/topics/${id}/stance`, { method: 'POST', body: { side } }),
  stanceChange: (id, payload) => req(`/topics/${id}/stance-change`, { method: 'POST', body: payload }),
  statement: (id, content) => req(`/topics/${id}/statement`, { method: 'POST', body: { content } }),
  challenge: (id, messageId, content) =>
    req(`/topics/${id}/challenge`, { method: 'POST', body: { message_id: messageId, content } }),
  challengeAutoPass: (id) => req(`/topics/${id}/challenge/auto-pass`, { method: 'POST', body: {} }),

  postMessage: (id, content) => req(`/topics/${id}/messages`, { method: 'POST', body: { content } }),
  reply: (messageId, content) => req(`/messages/${messageId}/replies`, { method: 'POST', body: { content } }),
  up: (messageId) => req(`/messages/${messageId}/ups`, { method: 'POST', body: {} }),
  report: (messageId, reason) => req(`/messages/${messageId}/report`, { method: 'POST', body: { reason } }),
  markReads: (topicId, ids) => req(`/topics/${topicId}/reads`, { method: 'POST', body: { message_ids: ids } }),

  profile: () => req('/me'),

  publishInfo: () => req('/admin/publish'),
  createTopic: (payload) => req('/topics', { method: 'POST', body: payload }),
  writeConclusion: (id, conclusion) => req(`/topics/${id}/conclusion`, { method: 'POST', body: { conclusion } }),
  reports: () => req('/admin/reports'),
  resolveReport: (id, upheld) => req(`/admin/reports/${id}/resolve`, { method: 'POST', body: { upheld } }),

  adminTopics: () => req('/admin/topics'),
  adminMessages: (opts = {}) => {
    const qs = new URLSearchParams();
    if (opts.topic_id) qs.set('topic_id', opts.topic_id);
    if (opts.status) qs.set('status', opts.status);
    if (opts.q) qs.set('q', opts.q);
    const s = qs.toString();
    return req('/admin/messages' + (s ? '?' + s : ''));
  },
  setMessageVisibility: (id, hidden) =>
    req(`/admin/messages/${id}/visibility`, { method: 'POST', body: { hidden } })
};
