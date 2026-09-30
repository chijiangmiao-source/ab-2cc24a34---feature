'use strict';
/*
 * worker.js —— 在 Web Worker 中执行确定性 Schreier–Sims 审计
 *（普通可导出复核 / 执行奇偶复核：GF(2) 恒等关系空间求解与词回构）。
 * 每个请求带 requestId；主线程只按当前代次接收回包，旧回包一律丢弃。
 */
importScripts('core.js');

self.onmessage = function (ev) {
  const msg = ev.data || {};
  if (msg.type !== 'audit-request') return;
  const requestId = msg.requestId;
  try {
    const result = self.ApertureCore.audit(msg.input || {});
    self.postMessage({ type: 'audit-response', requestId, result });
  } catch (err) {
    self.postMessage({
      type: 'audit-response',
      requestId,
      result: {
        ok: false,
        errors: [{ scope: 'internal', message: '计算异常：' + (err && err.message ? err.message : String(err)) }],
      },
    });
  }
};
