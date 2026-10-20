// dsh-heartbeat client 入口
// 实现范围：docs/PLAN.md M3 —— HEARTBEAT tab（会话列表 + ON/OFF + 间隔输入 + 状态徽标）
// 注册方式参照 dsh-memory-evolve 的 client 注入（顶部栏 tab 与「Memory Evolve 设置」同级）

const styles = `
.hb-container {
  padding: 16px 20px;
  max-width: 1100px;
  margin: 0 auto;
  font-family: inherit;
  color: var(--dsh-text-primary, #e5e7eb);
  background: var(--dsh-bg-primary, transparent);
}
.hb-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--dsh-border, #374151);
  padding-bottom: 14px;
  margin-bottom: 18px;
}
.hb-title {
  font-size: 18px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.hb-subtitle {
  font-size: 13px;
  color: var(--dsh-text-muted, #9ca3af);
  margin-top: 4px;
}
.hb-refresh-btn {
  background: var(--dsh-bg-secondary, #1f2937);
  border: 1px solid var(--dsh-border, #4b5563);
  color: var(--dsh-text-primary, #e5e7eb);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}
.hb-refresh-btn:hover {
  background: var(--dsh-bg-hover, #374151);
}
.hb-info-banner {
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.2);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 18px;
  line-height: 1.5;
}
.hb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  border: 1px solid var(--dsh-border, #374151);
  border-radius: 8px;
  overflow: hidden;
}
.hb-table th {
  background: var(--dsh-bg-secondary, #1f2937);
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsh-border, #374151);
  color: var(--dsh-text-muted, #9ca3af);
  font-weight: 600;
}
.hb-table td {
  padding: 12px;
  border-bottom: 1px solid var(--dsh-border, #2d3748);
  vertical-align: middle;
}
.hb-table tr:hover {
  background: rgba(255, 255, 255, 0.02);
}
.hb-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.hb-badge-on {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.hb-badge-off {
  background: rgba(156, 163, 175, 0.15);
  color: #9ca3af;
  border: 1px solid rgba(156, 163, 175, 0.3);
}
.hb-badge-stale {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border: 1px solid rgba(245, 158, 11, 0.3);
}
.hb-badge-retrying {
  background: rgba(249, 115, 22, 0.15);
  color: #f97316;
  border: 1px solid rgba(249, 115, 22, 0.3);
}
.hb-badge-waiting {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.3);
}
.hb-interval-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hb-interval-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hb-input {
  width: 70px;
  background: var(--dsh-bg-input, #111827);
  border: 1px solid var(--dsh-border, #4b5563);
  color: inherit;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.hb-warning {
  color: #f59e0b;
  font-size: 11px;
  margin-top: 2px;
  line-height: 1.3;
}
.hb-btn-toggle {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.2s;
}
.hb-btn-turn-on {
  background: #059669;
  color: #fff;
}
.hb-btn-turn-on:hover {
  background: #047857;
}
.hb-btn-turn-off {
  background: #374151;
  color: #e5e7eb;
}
.hb-btn-turn-off:hover {
  background: #4b5563;
}
.hb-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.hb-empty {
  text-align: center;
  padding: 30px;
  color: var(--dsh-text-muted, #9ca3af);
}
`;
const stylesFix = `
.hb-container { color: #111827; }
.hb-container .hb-title { color: #111827; }
.hb-container .hb-subtitle { color: #6b7280; }
.hb-container td { color: #111827; border-color: #e5e7eb; }
.hb-container th { color: #f9fafb; }
.hb-container .hb-mono { color: #6b7280 !important; }
.hb-container .hb-warning { color: #b45309; }
.hb-container .hb-banner, .hb-container [class*="hb-note"] { color: #92400e; }
.hb-container .hb-btn-toggle[disabled] { opacity: 0.45; cursor: not-allowed; }
@media (prefers-color-scheme: dark) {
  .hb-container { color: #e5e7eb; }
  .hb-container .hb-title { color: #f3f4f6; }
  .hb-container .hb-subtitle { color: #9ca3af; }
  .hb-container td { color: #e5e7eb; border-color: #374151; }
  .hb-container .hb-mono { color: #9ca3af !important; }
  .hb-container .hb-warning { color: #fbbf24; }
  .hb-container .hb-banner, .hb-container [class*="hb-note"] { color: #fcd34d; }
}
`;


function createHeartbeatClient(React) {
  const { createElement: h, useState, useEffect, useCallback } = React;

  function HeartbeatTabView(props) {
    const [stateData, setStateData] = useState({ sessions: [], pings: [] });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [inputValues, setInputValues] = useState({});
    const [warningMap, setWarningMap] = useState({});

    const fetchState = useCallback(async () => {
      try {
        const res = await fetch('/heartbeat/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setStateData(data);
        setError(null);
        // 初始化输入框状态
        setInputValues((prev) => {
          const next = { ...prev };
          for (const s of data.sessions || []) {
            if (next[s.sessionId] === undefined) {
              next[s.sessionId] = s.intervalMin || 45;
            }
          }
          return next;
        });
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      fetchState();
      const timer = setInterval(fetchState, 5000);
      return () => clearInterval(timer);
    }, [fetchState]);

    const handleToggle = async (sessionId, currentlyOn, currentInterval) => {
      const nextOn = !currentlyOn;
      try {
        await fetch('/heartbeat/api/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            on: nextOn,
            intervalMin: Number(inputValues[sessionId] || currentInterval || 45),
          }),
        });
        await fetchState();
      } catch (err) {
        alert('切换心跳状态失败: ' + String(err));
      }
    };

    const handleIntervalChange = (sessionId, val) => {
      setInputValues((prev) => ({ ...prev, [sessionId]: val }));
      const num = Number(val);
      if (num >= 60) {
        setWarningMap((prev) => ({
          ...prev,
          [sessionId]: '⚠️ 间隔≥60min，1h TTL 缓存会在 ping 间过期',
        }));
      } else {
        setWarningMap((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    };

    const handleIntervalSubmit = async (sessionId) => {
      const val = Number(inputValues[sessionId]);
      if (!Number.isInteger(val) || val < 1 || val > 720) {
        alert('请输入 1-720 之间的整数分钟数');
        return;
      }
      try {
        await fetch('/heartbeat/api/interval', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, intervalMin: val }),
        });
        await fetchState();
      } catch (err) {
        alert('更新心跳间隔失败: ' + String(err));
      }
    };

    const sessions = stateData.sessions || [];
    const pingsMap = new Map((stateData.pings || []).map((p) => [p.key, p]));

    return h('div', { className: 'hb-container' },
      h('div', { className: 'hb-header' },
        h('div', null,
          h('h2', { className: 'hb-title' }, '💓 LLM 前缀缓存保温 (HEARTBEAT)'),
          h('div', { className: 'hb-subtitle' }, '会话级 LLM 前缀缓存保温与状态管理，保持 Kimi 1h TTL 前缀活跃')
        ),
        h('button', {
          type: 'button',
          className: 'hb-refresh-btn',
          onClick: () => { setLoading(true); fetchState(); },
        }, loading ? '刷新中...' : '🔄 刷新状态')
      ),
      h('div', { className: 'hb-info-banner' },
        '💡 说明：心跳仅重放该会话最后一次真实请求（max_tokens=16，输出丢弃只取遥测），零会话污染。心跳间隔合法范围 1–720 分钟（默认 50min），开启后立即执行首次保温；临时错误（429/5xx/超时）自动 +2min/+4min 快速重试。'
      ),
      error ? h('div', { style: { color: '#ef4444', marginBottom: 12 } }, '状态加载异常：' + error) : null,
      sessions.length === 0
        ? h('div', { className: 'hb-empty' }, '暂无活跃会话。创建并与会话对话后将在此显示。')
        : h('table', { className: 'hb-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '会话 ID / 亲和键'),
                h('th', null, '保温状态'),
                h('th', null, '心跳间隔'),
                h('th', null, '开关操作'),
                h('th', null, '上次心跳 / 遥测')
              )
            ),
            h('tbody', null,
              sessions.map((s) => {
                const ping = pingsMap.get(s.key);
                const isStale = ping?.stale === true;
                const isOn = s.on === true;
                const health = ping?.health || null;
                const isWaiting = ping?.waitingForRequest === true || s.waiting === true;
                let badgeClass = 'hb-badge-off';
                let badgeText = '⚪ OFF';

                if (isOn || isWaiting) {
                  if (isStale || health === 'stale') {
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟡 STALE (已挂起)';
                  } else if (isWaiting || health === 'waiting') {
                    badgeClass = 'hb-badge-waiting';
                    badgeText = '🔵 WAITING FOR REAL REQUEST';
                  } else if (health === 'retrying') {
                    badgeClass = 'hb-badge-retrying';
                    badgeText = `🟠 RETRYING (#${ping?.retryCount || 1})`;
                  } else if (health === 'hit') {
                    badgeClass = 'hb-badge-on';
                    badgeText = '🟢 ACTIVE · HIT';
                  } else if (health === 'recreated') {
                    badgeClass = 'hb-badge-on';
                    badgeText = '🟢 ACTIVE · RECREATED';
                  } else if (health === 'no-cache') {
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟡 ON · NO-CACHE';
                  } else {
                    badgeClass = 'hb-badge-on';
                    badgeText = '🟢 ON (保温中)';
                  }
                }

                const currentVal = inputValues[s.sessionId] !== undefined ? inputValues[s.sessionId] : (s.intervalMin || 45);
                const warnText = warningMap[s.sessionId] || (Number(currentVal) >= 60 ? '⚠️ 间隔≥60min，1h TTL 缓存会在 ping 间过期' : null);

                return h('tr', { key: s.sessionId },
                  h('td', null,
                    h('div', { style: { fontWeight: 600 } }, s.title || `Session ${String(s.sessionId).replace(/^session-/, '').slice(0, 8)}…`),
                    h('div', { className: 'hb-mono', style: { color: 'var(--dsh-text-muted, #9ca3af)', marginTop: 2 } }, s.key)
                  ),
                  h('td', null,
                    h('span', { className: `hb-badge ${badgeClass}` }, badgeText)
                  ),
                  h('td', null,
                    h('div', { className: 'hb-interval-wrap' },
                      h('div', { className: 'hb-interval-row' },
                        h('input', {
                          type: 'number',
                          min: 1,
                          max: 720,
                          className: 'hb-input',
                          value: currentVal,
                          onChange: (e) => handleIntervalChange(s.sessionId, e.target.value),
                          onBlur: () => handleIntervalSubmit(s.sessionId),
                          onKeyDown: (e) => { if (e.key === 'Enter') handleIntervalSubmit(s.sessionId); },
                        }),
                        h('span', null, '分钟')
                      ),
                      warnText ? h('div', { className: 'hb-warning' }, warnText) : null
                    )
                  ),
                  h('td', null,
                    h('button', {
                      type: 'button',
                      className: `hb-btn-toggle ${isOn ? 'hb-btn-turn-off' : 'hb-btn-turn-on'}`,
                      disabled: !s.key,
                      title: !s.key ? '此会话暂无缓存活动：先对话一轮再开启' : '',
                      onClick: () => handleToggle(s.sessionId, isOn, s.intervalMin),
                    }, !s.key ? '未激活 (无缓存)' : (isOn ? '关闭心跳 (OFF)' : '开启心跳 (ON)'))
                  ),
                  h('td', null,
                    h('div', { className: 'hb-mono', style: { fontSize: 11 } },
                      'Last HB: ' + (ping?.lastPingAt ? new Date(ping.lastPingAt).toLocaleTimeString() : '无')
                    ),
                    h('div', { className: 'hb-mono', style: { fontSize: 11, color: 'var(--dsh-text-muted, #9ca3af)' } },
                      `次数: ${ping?.pingCount || 0} | Cache read: ${ping?.lastUsage?.cache_read_input_tokens || 0}`
                    ),
                    h('div', { className: 'hb-mono', style: { fontSize: 11, color: 'var(--dsh-text-muted, #9ca3af)' } },
                      `Cache creation: ${ping?.lastUsage?.cache_creation_input_tokens || 0}` +
                      (ping?.spentUsd > 0 ? ` | 花费≈$${ping.spentUsd}` : '') +
                      (ping?.lastError ? ` | 错误: ${ping.lastError}` : '')
                    )
                  )
                );
              })
            )
          )
    );
  }

  return { HeartbeatTabView };
}

export const inject = ['slots'];

export function apply(ctx) {
  let React;
  try {
    React = window.React || (typeof require === 'function' ? require('react') : null);
  } catch (e) {
    React = window.React;
  }

  if (!React) {
    return;
  }

  const { HeartbeatTabView } = createHeartbeatClient(React);

  // 注入样式
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const existing = document.querySelector('style[data-heartbeat-css]');
    if (existing) return () => {};
    const tag = document.createElement('style');
    tag.dataset.heartbeatCss = '1';
    tag.textContent = styles + stylesFix;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, 'dsh-heartbeat: stylesheet');

  // 注册顶部栏 HEARTBEAT tab（order 105，与「Memory Evolve 设置」同级）
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'heartbeat',
      order: 105,
      label: () => 'HEARTBEAT',
    }, (props) => React.createElement(HeartbeatTabView, props))
  );
}

// 兼容 DSH ModuleLoader 与 ESM
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  const factory = (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { HeartbeatTabView } = createHeartbeatClient(React);

    module.exports = {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const existing = document.querySelector('style[data-heartbeat-css]');
          if (existing) return () => {};
          const tag = document.createElement('style');
          tag.dataset.heartbeatCss = '1';
          tag.textContent = styles + stylesFix;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'dsh-heartbeat: stylesheet');

        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'heartbeat',
            order: 105,
            label: () => 'HEARTBEAT',
          }, (props) => React.createElement(HeartbeatTabView, props))
        );
      },
    };
    return module.exports;
  };

  try { window.__ModuleLoader__.load({ id: 'dsh-heartbeat', factory }); } catch (e) {}
  try { window.__ModuleLoader__.load({ id: 'dsh-external/dsh-heartbeat', factory }); } catch (e) {}
}
