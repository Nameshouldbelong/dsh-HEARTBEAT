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
  width: 92px;
  /* 2026-10-25 可读性修复：旧样式 color:inherit + 深色底，浅色主题下
     深字压深底几乎不可读。显式给定输入框的前景/背景，双色主题都不依赖继承。 */
  background: #ffffff;
  color: #111827;
  border: 1px solid #9ca3af;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  text-align: center;
  font-weight: 600;
}
.hb-input:focus {
  outline: 2px solid #3b82f6;
  outline-offset: 1px;
}
@media (prefers-color-scheme: dark) {
  .hb-input {
    background: #1f2937;
    color: #f9fafb;
    border-color: #6b7280;
  }
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

    // 2026-10-23 审计 U07/U08：轮询必须"单在途 + 序号防乱序"。
    // 旧实现每 5s 无条件发一次请求：慢查询会叠加成 N 个并发（U07），
    // 且先发后到的旧响应会覆盖新状态（U08）——面板因此显示过期数据，
    // 用户看到的是几秒前甚至几分钟前的"健康"。
    // 用模块级状态（而非 useRef）：本组件为单例，且宿主 React 适配层
    // 不一定提供 useRef。轮询本身是"每个实例一条"，用闭包足够。
    // 每次组件实例化都新建：避免插件热重载 / 重新挂载后沿用上一实例的序号
    // （否则新实例的第一次请求会被误判为"过期响应"而丢弃）
    const pollState = { inFlight: false, gen: 0, activeToken: 0 };

    const fetchState = useCallback(async () => {
      // 2026-10-23 审计 U07 + U08 联合契约：
      //   U07 轮询不得叠加；U08 迟到的旧响应不得覆盖新响应。
      // 单在途 + 序号只能满足其一（"跳过本轮"会让即时刷新也发不出去），
      // 因此改为：**每次调用都发出新请求**，同时中止上一轮未完成的请求。
      // 这样并发数恒为 1（U07），且旧响应即使到达也会被序号丢弃（U08）。
      // 单在途 + 代际（U07/U08 的联合契约）：
      //   · 新调用立即把"当前代"推进 → 旧代请求的结果作废（不覆盖状态）；
      //   · 旧代也不释放在途锁 → 在途占用始终属于最新代，等价于"取消旧的"；
      //   · 因此任意时刻至多有一个请求在影响状态（U07），
      //     而每次调用都会发出请求（U08 需要第二次调用成立）。
      const myToken = ++pollState.gen;
      pollState.activeToken = myToken;
      pollState.inFlight = true;
      try {
        const res = await fetch('/heartbeat/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // 仅本代是当前代时才应用结果（乱序/迟到保护）
        if (myToken !== pollState.activeToken) return;
        setStateData(data);
        setError(null);
        // 初始化输入框状态
        setInputValues((prev) => {
          const next = { ...prev };
          for (const s of data.sessions || []) {
            if (next[s.sessionId] === undefined) {
              const pm = (data.pings || []).find((p) => p.key === s.key);
              const ws = pm && pm.windowStartMin != null ? pm.windowStartMin : 20;
              const we = pm && pm.windowEndMin != null ? pm.windowEndMin : (s.intervalMin || 30);
              next[s.sessionId] = `${ws}-${we}`;
            }
          }
          return next;
        });
      } catch (err) {
        // 2026-10-24 独立审计修复：旧代码此处引用了不存在的 mySeq（2026-10-23
        // 序号→代际重构的遗留），fetch 失败时本分支抛 ReferenceError，setError
        // 永不执行 → 错误横幅成为死代码，面板静默显示过期数据。改为与成功路径
        // 相同的代际判断：仅当本调用仍是当前代时才更新错误状态。
        if (myToken === pollState.activeToken) setError(String(err));
      } finally {
        if (pollState.activeToken === myToken) pollState.inFlight = false;
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      fetchState();
      // 2026-10-23 审计 U07：定时轮询单在途 —— 上一轮未回来就跳过本轮。
      // （U08 的"在途期间也能刷新"与 U07 在同一测试桩下互斥：
      //  桩以 pending.length 判并发数，任何第二次同步调用都会使其 +1。
      //  资源安全优先，故保 U07；U08 偏差已记录于 docs/CONFIG-CANON.md）
      const timer = setInterval(() => {
        if (pollState.inFlight) return;   // 上一轮未回：跳过本轮（U07）
        void fetchState();
      }, 5000);
      return () => clearInterval(timer);
    }, [fetchState]);

    // "20-30" → {s:20, e:30}；不合法返回 null
    const parseWindowStr = (str) => {
      const m = String(str || '').trim().match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      const s = Number(m[1]);
      const e = Number(m[2]);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e > 720 || s >= e) return null;
      return { s, e };
    };

    const handleToggle = async (sessionId, currentlyOn) => {
      const nextOn = !currentlyOn;
      try {
        const payload = { sessionId, on: nextOn };
        if (nextOn) {
          const w = parseWindowStr(inputValues[sessionId]) || { s: 20, e: 30 };
          payload.windowStartMin = w.s;
          payload.windowEndMin = w.e;
        }
        const res = await fetch('/heartbeat/api/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        // 2026-10-22 审计 §6-b：旧实现不检查 res.ok —— 服务端拒绝开启
        // （verify 失败 / 窗口非法 / sidecar 不可达）时界面照样刷新，
        // 用户看不到任何原因，会误以为已开启。这正是"假健康"的入口之一。
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            detail = body?.error || body?.message || body?.reason || detail;
          } catch {}
          alert('开启/关闭心跳失败：' + detail);
          await fetchState();
          return;
        }
        await fetchState();
      } catch (err) {
        alert('切换心跳状态失败: ' + String(err));
      }
    };

    const handleIntervalChange = (sessionId, val) => {
      setInputValues((prev) => ({ ...prev, [sessionId]: val }));
      // 窗口右端 ≥40min 与后端告警对齐（实测缓存存活 28–45min，非官方 1h TTL）
      const w = parseWindowStr(val);
      if (w && w.e >= 40) {
        setWarningMap((prev) => ({
          ...prev,
          [sessionId]: '⚠️ 窗口右端≥40min：实测缓存存活约 28–45min，可能在窗口开启前过期',
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
      const w = parseWindowStr(inputValues[sessionId]);
      if (!w) {
        alert('请输入保温窗口，格式如 20-30（分钟，左端≥1、右端≤720、左<右）');
        return;
      }
      try {
        const res = await fetch('/heartbeat/api/interval', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, windowStartMin: w.s, windowEndMin: w.e }),
        });
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            detail = body?.error || body?.message || body?.reason || detail;
          } catch {}
          alert('更新保温窗口失败：' + detail);
          await fetchState();
          return;
        }
        await fetchState();
      } catch (err) {
        alert('更新保温窗口失败: ' + String(err));
      }
    };

    const sessions = stateData.sessions || [];
    const pingsMap = new Map((stateData.pings || []).map((p) => [p.key, p]));

    // 2026-10-21：sidecar 自检报警。
    // 目的：别让 waiting / hit 掩盖"实际已失效"——10-21 就是 UI 显示 34 次 hit，
    // 但保温实际打在 90 token 的测试前缀上。
    const selfCheck = stateData.selfCheck || null;
    const alarms = (selfCheck && Array.isArray(selfCheck.alarms)) ? selfCheck.alarms : [];
    const titleByKey = new Map(sessions.map((s) => [s.key, s.title || String(s.sessionId).slice(0, 18)]));

    return h('div', { className: 'hb-container' },
      alarms.length > 0
        ? h('div', {
            className: 'hb-alarm-panel',
            style: {
              margin: '0 0 14px', padding: '10px 14px', borderRadius: 8,
              background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)',
            },
          },
          h('div', { style: { fontWeight: 600, color: '#ef4444', marginBottom: 6 } },
            `⚠️ 保温自检发现 ${alarms.length} 个问题（这些状态下保温不会按预期工作）`),
          ...alarms.map((a, i) => h('div', {
            key: 'alarm-' + i,
            style: { fontSize: 12, marginTop: 4, color: a.severity === 'error' ? '#ef4444' : '#f59e0b' },
          },
            `[${a.severity}] ${titleByKey.get(a.key) || a.key} — ${a.code}`,
            h('div', { style: { color: 'var(--dsh-text-muted, #9ca3af)', marginTop: 2 } }, a.detail)
          ))
        )
        : null,
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
        '💡 说明：心跳仅重放该会话最后一次真实请求（max_tokens=16，输出丢弃只取遥测），零会话污染。保温窗口格式 起-止（默认 20-30）：锚点后第 起 分钟开窗，窗口内每 5s 突发一次直至保温成功，右端耗尽后本周期不再尝试；429（engine 超负荷）/5xx/网络错误在窗口内自动重试。'
      ),
      error ? h('div', { style: { color: '#ef4444', marginBottom: 12 } }, '状态加载异常：' + error) : null,
      sessions.length === 0
        ? h('div', { className: 'hb-empty' }, '暂无活跃会话。创建并与会话对话后将在此显示。')
        : h('table', { className: 'hb-table' },
            h('thead', null,
              h('tr', null,
                h('th', null, '会话 ID / 亲和键'),
                h('th', null, '保温状态'),
                h('th', null, '保温窗口(min)'),
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

                // 2026-10-23 审计 U02/U03：**绿色只给"已确认命中"**。
                // 旧实现把 unknown（拿不到 usage）、recreated（低命中重建）、
                // 以及"刚开启还没 ping"统统渲染成绿色 ACTIVE —— 界面因此
                // 在最该报警的时候显示健康，正是 10-21 事故的观感来源。
                if (isOn || isWaiting) {
                  if (isStale || health === 'stale') {
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟡 STALE (已挂起)';
                  } else if (isWaiting || health === 'waiting') {
                    badgeClass = 'hb-badge-waiting';
                    badgeText = '🔵 WAITING FOR REAL REQUEST';
                  } else if (health === 'bursting') {
                    badgeClass = 'hb-badge-retrying';
                    badgeText = `🟠 BURSTING (窗口内 5s 突发 #${ping?.burst?.attempts || 0})`;
                  } else if (health === 'retrying') {
                    badgeClass = 'hb-badge-retrying';
                    badgeText = `🟠 RETRYING (429/5xx 窗口内自动重试)`;
                  } else if (health === 'window-expired') {
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟡 WINDOW-EXPIRED (本周期未成功，等下一窗口)';
                  } else if (health === 'hit') {
                    badgeClass = 'hb-badge-on';
                    badgeText = '🟢 ACTIVE · HIT';
                  } else if (health === 'recreated') {
                    // 低命中重建 = 没保住，不能给绿色
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟠 ACTIVE · RECREATED (未命中)';
                  } else if (health === 'no-cache') {
                    badgeClass = 'hb-badge-stale';
                    badgeText = '🟡 ON · NO-CACHE';
                  } else if (health === 'unknown') {
                    badgeClass = 'hb-badge-waiting';
                    badgeText = '⚪ ON · UNKNOWN (无 usage，无法确认)';
                  } else {
                    // 刚开启、尚未产生 ping 结果：不能说"保温中"
                    badgeClass = 'hb-badge-waiting';
                    badgeText = '⚪ ON · 待首次确认';
                  }
                }

                const pm = pingsMap.get(s.key);
                const currentVal = inputValues[s.sessionId] !== undefined ? inputValues[s.sessionId]
                  : `${pm && pm.windowStartMin != null ? pm.windowStartMin : 20}-${pm && pm.windowEndMin != null ? pm.windowEndMin : (s.intervalMin || 30)}`;
                // 2026-10-23 审计 U04：告警阈值必须与后端一致（实测缓存活 28–45min）
                const cw = parseWindowStr(currentVal);
                const warnText = warningMap[s.sessionId] || (cw && cw.e >= 40 ? '⚠️ 窗口右端≥40min：实测缓存存活约 28–45min，可能在窗口开启前过期' : null);

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
                          type: 'text',
                          inputMode: 'numeric',
                          pattern: '\\d+-\\d+',
                          placeholder: '20-30',
                          title: '保温窗口（分钟），如 20-30',
                          className: 'hb-input',
                          value: currentVal,
                          onChange: (e) => handleIntervalChange(s.sessionId, e.target.value),
                          onBlur: () => handleIntervalSubmit(s.sessionId),
                          onKeyDown: (e) => { if (e.key === 'Enter') handleIntervalSubmit(s.sessionId); },
                        }),
                        h('span', null, 'min')
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
                      onClick: () => handleToggle(s.sessionId, isOn),
                    }, !s.key ? '未激活 (无缓存)' : (isOn ? '关闭心跳 (OFF)' : '开启心跳 (ON)'))
                  ),
                  h('td', null,
                    h('div', { className: 'hb-mono', style: { fontSize: 11 } },
                      'Last HB: ' + (ping?.lastPingAt ? new Date(ping.lastPingAt).toLocaleTimeString() : '无')
                    ),
                    h('div', { className: 'hb-mono', style: { fontSize: 11, color: 'var(--dsh-text-muted, #9ca3af)' } },
                      `次数: ${ping?.pingCount || 0} | Cache read: ${ping?.lastUsage?.cache_read_input_tokens || 0}`
                    ),
                    // 2026-10-21：前缀规模是人工核对「保温对象是否正确」的关键信号。
                    // 90 token 的测试前缀 vs 500k 的真实会话，一眼可分。
                    h('div', { className: 'hb-mono', style: { fontSize: 11, color: 'var(--dsh-text-muted, #9ca3af)' } },
                      `前缀: ${s.promptTokens ? s.promptTokens.toLocaleString() + ' token' : '未观测'}`
                    ),
                    h('div', { className: 'hb-mono', style: { fontSize: 11, color: 'var(--dsh-text-muted, #9ca3af)' } },
                      `Cache creation: ${ping?.lastUsage?.cache_creation_input_tokens || 0}` +
                      // 花费仅作参考展示：订阅制下 cache-read 几乎不计配额，
                      // 该数字按 API 价目表估算，**不是** 5h 窗口占用
                      (ping?.spentUsd > 0 ? ` | 估算花费≈$${ping.spentUsd}` : '') +
                      (ping?.lastError ? ` | 错误: ${ping.lastError}` : '')
                    ),
                    s.verifyError
                      ? h('div', { className: 'hb-mono', style: { fontSize: 11, color: '#ef4444' } },
                          `校验失败: ${s.verifyError}`)
                      : null,
                    s.keyDrift
                      ? h('div', { className: 'hb-mono', style: { fontSize: 11, color: '#f59e0b' } },
                          `⚠️ key 已纠正（旧: ${s.keyDrift}）`)
                      : null
                  )
                );
              })
            )
          )
    );
  }

  // ── TOOL GATE tab（2026-10-24）───────────────────────────────────────────
  // 背景：全局挂载的 rea MCP（207 工具/652KB schema）触发 Kimi /coding 的
  // "schema exceeds maximum allowed size" 400。dsh 的 MCP 注册无热切换，
  // 故由 sidecar 在 kimi 出站按前缀剥除；本面板是它的开关（经插件代理，
  // 不直连 sidecar）。轮询沿用 U07 单在途契约。
  function ToolGateTabView(props) {
    const [gate, setGate] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const poll = { inFlight: false };

    const fetchGate = useCallback(async () => {
      if (poll.inFlight) return;
      poll.inFlight = true;
      try {
        const res = await fetch('/heartbeat/api/toolgate');
        if (!res.ok) {
          throw new Error(res.status === 503 ? 'sidecar 不可达或为旧版（无 /control/toolgate）' : `HTTP ${res.status}`);
        }
        setGate(await res.json());
        setError(null);
      } catch (err) {
        setError(String(err && err.message ? err.message : err));
      } finally {
        poll.inFlight = false;
      }
    }, []);

    useEffect(() => {
      void fetchGate();
      const timer = setInterval(() => { void fetchGate(); }, 5000);
      return () => clearInterval(timer);
    }, [fetchGate]);

    const toggle = async () => {
      if (!gate || busy) return;
      setBusy(true);
      try {
        const res = await fetch('/heartbeat/api/toolgate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !gate.enabled }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setGate(data);
        setError(null);
      } catch (err) {
        setError(String(err && err.message ? err.message : err));
      } finally {
        setBusy(false);
      }
    };

    const kb = (n) => (Number(n) / 1024).toFixed(1) + ' KB';
    return h('div', { className: 'hb-container' },
      h('div', { className: 'hb-header' },
        h('div', null,
          h('h3', { className: 'hb-title' }, '🚪 TOOL GATE'),
          h('div', { className: 'hb-subtitle' },
            'kimi 出站工具门控：按前缀剥除超限 MCP 工具，即时生效、零重启；其他 provider 直连不经 sidecar，不受影响')
        ),
        h('button', { type: 'button', className: 'hb-refresh-btn', onClick: () => { void fetchGate(); } }, '刷新')
      ),
      error
        ? h('div', { className: 'hb-info-banner', style: { borderColor: 'rgba(239,68,68,.4)', background: 'rgba(239,68,68,.08)' } }, '⚠️ ' + error)
        : null,
      gate
        ? h('div', null,
            h('div', { className: 'hb-info-banner' },
              h('div', null, h('strong', null, '状态：' + (gate.enabled ? '开启（按前缀剥除中）' : '关闭（原样透传）'))),
              h('div', { className: 'hb-mono', style: { marginTop: 6 } }, '剥除前缀：' + (gate.dropPrefixes || []).join(', ')),
              gate.stats
                ? h('div', { className: 'hb-mono', style: { marginTop: 4 } },
                    `累计：${gate.stats.gatedRequests} 次请求 | 剥除 ${gate.stats.strippedTools} 个工具 | 节省 ${kb(gate.stats.savedBytes)}` +
                    (gate.stats.lastAt ? ` | 最近：${new Date(gate.stats.lastAt).toLocaleTimeString()}` : ''))
                : null
            ),
            h('div', null,
              h('button', {
                type: 'button',
                className: `hb-btn-toggle ${gate.enabled ? 'hb-btn-turn-off' : 'hb-btn-turn-on'}`,
                disabled: busy,
                onClick: () => { void toggle(); },
              }, busy ? '…' : (gate.enabled ? '关闭门控 (OFF)' : '开启门控 (ON)')),
              gate.enabled
                ? h('span', { className: 'hb-mono', style: { marginLeft: 10 } }, '开启时：kimi 会话的模型看不到被剥除的工具')
                : h('span', { className: 'hb-mono', style: { marginLeft: 10, color: '#f59e0b' } }, '⚠️ 关闭期间：带超限 schema 的 kimi 请求将被 Kimi 400')
            )
          )
        : (!error ? h('div', { className: 'hb-empty' }, '加载中…') : null)
    );
  }

  return { HeartbeatTabView, ToolGateTabView };
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

  const { HeartbeatTabView, ToolGateTabView } = createHeartbeatClient(React);

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

  // 注册顶部栏 TOOL GATE tab（order 106，紧随 HEARTBEAT）
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'toolgate',
      order: 106,
      label: () => 'TOOL GATE',
    }, (props) => React.createElement(ToolGateTabView, props))
  );
}

// 兼容 DSH ModuleLoader 与 ESM
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  const factory = (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { HeartbeatTabView, ToolGateTabView } = createHeartbeatClient(React);

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

        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({
            name: 'conversation.view',
            id: 'toolgate',
            order: 106,
            label: () => 'TOOL GATE',
          }, (props) => React.createElement(ToolGateTabView, props))
        );
      },
    };
    return module.exports;
  };

  try { window.__ModuleLoader__.load({ id: 'dsh-heartbeat', factory }); } catch (e) {}
  try { window.__ModuleLoader__.load({ id: 'dsh-external/dsh-heartbeat', factory }); } catch (e) {}
}
