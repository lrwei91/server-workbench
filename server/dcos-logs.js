'use strict';

const fs = require('node:fs/promises');
const nodePath = require('node:path');

const ROOT = nodePath.join(__dirname, '..');
const LOG_DIR = nodePath.join(ROOT, 'logs', 'dcos');
const LOG_MAX_BYTES = 20 * 1024 * 1024; // 单个目标文件上限，超过后轮转一次为 .1.log
const LOG_SEED_BYTES = 64 * 1024; // 进程重启后回读文件尾部用于去重

class DcosError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message); this.status = status; this.code = code; this.retryable = retryable;
  }
}

function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80) || 'unknown';
}

// 自动刷新会重复拉取同一个“末尾 N 行”窗口：找上次尾部与本次头部的最大重合，只落盘新增部分
function newLinesAfter(previous, fetched) {
  if (!Array.isArray(previous) || !previous.length || !fetched.length) return fetched.slice();
  const max = Math.min(previous.length, fetched.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matched = true;
    for (let index = 0; index < overlap; index++) {
      if (previous[previous.length - overlap + index] !== fetched[index]) { matched = false; break; }
    }
    if (matched) return fetched.slice(overlap);
  }
  return fetched.slice();
}

async function readFileTail(file, maxLines) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const size = Math.min(stat.size, LOG_SEED_BYTES);
      if (!size) return [];
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, stat.size - size);
      return buffer.toString('utf8').split('\n').filter((line) => line.length > 0).slice(-maxLines);
    } finally { await handle.close(); }
  } catch (_) { return []; }
}

class DcosLogs {
  constructor(config, { fetchImpl = fetch, logDir = LOG_DIR } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.logDir = logDir;
    this.cookie = '';
    this.tails = new Map(); // 每个目标上一次落盘的尾部，用于跨轮询去重
    this.writes = new Map(); // 每个目标的写盘串行队列
  }

  status() {
    return {
      configured: Boolean(this.config.baseUrl && this.config.clusters?.length),
      connected: Boolean(this.cookie),
      baseUrl: this.config.baseUrl || '',
      clusters: this.config.clusters || [],
    };
  }

  cluster(clusterId) {
    const id = Number(clusterId);
    const cluster = this.config.clusters?.find((item) => item.id === id);
    if (!cluster) throw new DcosError(400, 'DCOS_INVALID_CLUSTER', '请选择已配置的集群');
    return cluster;
  }

  async connect(cookie, { signal } = {}) {
    if (!this.status().configured) throw new DcosError(503, 'DCOS_NOT_CONFIGURED', '请在本机配置云翼平台地址和集群');
    if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 8192 || /[\r\n]/.test(cookie)) throw new DcosError(400, 'DCOS_INVALID_COOKIE', '请粘贴有效的 Cookie 请求头内容');
    const nextCookie = cookie.trim().replace(/^Cookie:\s*/i, '');
    this.cookie = '';
    await this.request('/dcos/cluster/namespace/list', { query: { clusterId: this.config.clusters[0].id }, cookie: nextCookie, signal });
    this.cookie = nextCookie;
    return this.status();
  }

  disconnect() { this.cookie = ''; return this.status(); }

  async request(path, { query, method = 'GET', body, cookie = this.cookie, signal } = {}) {
    if (!this.config.baseUrl) throw new DcosError(503, 'DCOS_NOT_CONFIGURED', '请在本机配置云翼平台地址');
    if (!cookie) throw new DcosError(409, 'DCOS_NOT_CONNECTED', '请先在进程日志页面输入云翼平台 Cookie');
    const url = new URL(path, `${this.config.baseUrl}/`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs || 15000);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: { Accept: 'application/json', Cookie: cookie, ...(body ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        if (cookie === this.cookie) this.cookie = '';
        throw new DcosError(401, 'DCOS_SESSION_EXPIRED', '云翼平台会话已失效，请重新粘贴 Cookie');
      }
      if (!response.ok) throw new DcosError(502, 'DCOS_UPSTREAM_HTTP', `云翼平台请求失败（HTTP ${response.status}）`, true);
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new DcosError(502, 'DCOS_RESPONSE_TOO_LARGE', '云翼平台返回内容超过 2 MiB，请减少日志行数');
      let result;
      try { result = JSON.parse(raw); } catch (_) { throw new DcosError(502, 'DCOS_INVALID_RESPONSE', '云翼平台返回的内容不是 JSON', true); }
      if (!result || result.code !== 0) throw new DcosError(502, 'DCOS_UPSTREAM_ERROR', '云翼平台返回业务错误，请检查所选目标或会话', true);
      return result.data;
    } catch (error) {
      if (error instanceof DcosError) throw error;
      if (timedOut) throw new DcosError(504, 'DCOS_TIMEOUT', '云翼平台请求超时', true);
      if (signal?.aborted) throw new DcosError(499, 'DCOS_CANCELLED', '请求已取消');
      throw new DcosError(502, 'DCOS_NETWORK_ERROR', '云翼平台连接失败，请检查地址和网络', true);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }

  async namespaces(clusterId, { signal } = {}) {
    const cluster = this.cluster(clusterId);
    const data = await this.request('/dcos/cluster/namespace/list', { query: { clusterId: cluster.id }, signal });
    // 平台不同版本可能直接返回数组，也可能把列表包在分页/列表对象中。
    const items = Array.isArray(data) ? data : [data?.records, data?.list, data?.namespaces, data?.namespaceList, data?.items, data?.content].find(Array.isArray);
    if (!items && data != null) throw new DcosError(502, 'DCOS_INVALID_RESPONSE', `命名空间响应格式错误（字段：${Object.keys(data).slice(0, 8).join('、') || '无'}）`);
    return (items || []).map((item) => ({ name: item?.namespaceName || item?.name, clusterId: item?.clusterId ?? cluster.id }))
      .filter((item) => item.name === 'bill-cnos-jf');
  }

  async workloads(clusterId, namespaceName, { pageNow = 1, pageSize = 50, search = '', signal } = {}) {
    const cluster = this.cluster(clusterId);
    const records = [];
    let remotePages = 1;
    for (let remotePage = 1; remotePage <= remotePages; remotePage++) {
      const data = await this.request(`/dcos/workload/page/cluster/${cluster.id}/namespace/${encodeURIComponent(namespaceName)}`, {
        method: 'POST', query: { pageNow: remotePage, pageSize: 100 },
        body: { workloadKind: 'StatefulSet', appName: '', workloadNames: ['test'] }, signal,
      });
      if (!data || !Array.isArray(data.records) || !Number.isFinite(Number(data.total))) throw new DcosError(502, 'DCOS_INVALID_RESPONSE', '工作负载响应格式错误');
      remotePages = Math.max(1, Math.ceil(Number(data.total) / 100));
      records.push(...data.records);
    }
    const term = search.trim().toLowerCase();
    const filtered = records.map((item) => ({ name: item.workloadName, kind: item.workloadKind, runningPodNum: item.runningPodNum }))
      .filter((item) => item.kind === 'StatefulSet' && typeof item.name === 'string' && item.name.split('-').includes('test') && item.name.toLowerCase().includes(term));
    return { records: filtered.slice((pageNow - 1) * pageSize, pageNow * pageSize), total: filtered.length, pageNow, pageSize };
  }

  async pods(clusterId, namespaceName, workloadName, { signal } = {}) {
    const cluster = this.cluster(clusterId);
    const data = await this.request('/dcos/workload/pods/', { query: { clusterId: cluster.id, namespaceName, workloadName, workloadKind: 'StatefulSet' }, signal });
    if (!Array.isArray(data)) throw new DcosError(502, 'DCOS_INVALID_RESPONSE', 'Pod 响应格式错误');
    return data.map((item) => ({ name: item.podName, status: item.podStatus, containers: (Array.isArray(item.containers) ? item.containers : []).map((container) => container.name).filter((name) => typeof name === 'string') })).filter((item) => typeof item.name === 'string');
  }

  async logs(clusterId, namespaceName, podName, containerName, tailingLines, { signal } = {}) {
    const cluster = this.cluster(clusterId);
    if (![100, 500, 1000].includes(tailingLines)) throw new DcosError(400, 'DCOS_INVALID_LINES', '日志行数只支持 100、500、1000');
    const data = await this.request('/dcos/workload/containerLogs', { query: { clusterId: cluster.id, namespaceName, podName, tailingLines, containerName }, signal });
    if (!Array.isArray(data) || !data.every((line) => typeof line === 'string')) throw new DcosError(502, 'DCOS_INVALID_RESPONSE', '日志响应格式错误');
    const saved = await this.persistLogs(cluster.id, namespaceName, podName, containerName, data);
    return { lines: data, readAt: new Date().toISOString(), saved };
  }

  // 容器日志按目标落盘到 logs/dcos/（已被 .gitignore 覆盖），写盘失败不影响页面读取
  // 自动刷新与手动刷新可能同时命中同一目标：按目标串行，避免重复追加和 Windows 并发写 EBUSY
  async persistLogs(clusterId, namespaceName, podName, containerName, lines) {
    const key = [clusterId, namespaceName, podName, containerName].join('|');
    const pending = this.writes.get(key) || Promise.resolve();
    const next = pending.catch(() => {}).then(() => this.writeLogFile(clusterId, namespaceName, podName, containerName, lines));
    this.writes.set(key, next.catch(() => {}));
    return next;
  }

  async writeLogFile(clusterId, namespaceName, podName, containerName, lines) {
    const key = [clusterId, namespaceName, podName, containerName].join('|');
    const file = nodePath.join(this.logDir, `${safeSegment(clusterId)}__${safeSegment(namespaceName)}__${safeSegment(podName)}__${safeSegment(containerName)}.log`);
    const display = nodePath.relative(ROOT, file).replace(/\\/g, '/');
    try {
      // 进程重启后内存没有上次尾部，用文件尾部兜底，避免重启后整段重复追加
      const previous = this.tails.get(key) || await readFileTail(file, lines.length);
      const fresh = newLinesAfter(previous, lines);
      let rotated = false;
      if (fresh.length) {
        await fs.mkdir(this.logDir, { recursive: true });
        const stat = await fs.stat(file).catch(() => null);
        if (stat && stat.size > LOG_MAX_BYTES) {
          const backup = file.replace(/\.log$/, '.1.log');
          await fs.rm(backup, { force: true });
          await fs.rename(file, backup);
          rotated = true;
        }
        await fs.appendFile(file, fresh.map((line) => `${line}\n`).join(''), 'utf8');
      }
      this.tails.set(key, lines);
      const stat = await fs.stat(file).catch(() => null);
      return { path: display, appended: fresh.length, bytes: stat ? stat.size : 0, rotated };
    } catch (error) {
      return { path: display, appended: 0, error: error.message };
    }
  }

  // 云翼平台启停接口是 StatefulSet（工作负载）级别：/dcos/workload/{start|stop}/{clusterId}/namespace/{ns}/workloadKind/StatefulSet/workloadName/{name}
  async workloadAction(action, clusterId, namespaceName, workloadName, { signal } = {}) {
    const cluster = this.cluster(clusterId);
    if (!['start', 'stop'].includes(action)) throw new DcosError(400, 'DCOS_INVALID_ACTION', '工作负载操作只支持 start 和 stop');
    const data = await this.request(`/dcos/workload/${action}/${cluster.id}/namespace/${encodeURIComponent(namespaceName)}/workloadKind/StatefulSet/workloadName/${encodeURIComponent(workloadName)}`, { method: 'POST', signal });
    return { action, clusterId: cluster.id, namespaceName, workloadName, respondedAt: new Date().toISOString(), detail: data ?? null };
  }
}

module.exports = { DcosLogs, DcosError };
