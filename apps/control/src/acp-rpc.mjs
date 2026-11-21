import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class AcpRpcError extends Error {
  constructor(code, message) { super(message); this.name = 'AcpRpcError'; this.code = code; }
}
export class AcpRpc extends EventEmitter {
  constructor({ command, args, cwd, env, spawnImpl = spawn }) {
    super(); this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.closed = false; this.stderrBytes = 0;
    this.process = spawnImpl(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 12 * 1024 * 1024) return this.fail(new AcpRpcError('acp_frame_limit', 'DSH ACP frame exceeded its limit.'));
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { return this.fail(new AcpRpcError('acp_invalid_frame', 'DSH ACP returned an invalid protocol frame.')); }
        if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
          const item = this.pending.get(message.id); if (!item) continue;
          this.pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) {
            const detail = String(message.error.message || '');
            const code = detail.includes('client_not_allowed') ? 'client_not_allowed' : /401|INVALID_CREDENTIAL|MISSING_CREDENTIAL/.test(detail) ? 'provider_authentication_failed' : 'acp_request_failed';
            item.reject(new AcpRpcError(code, code === 'client_not_allowed' ? '真实 DSH 客户端仍被模型网关拒绝。' : code === 'provider_authentication_failed' ? 'DSH 模型路由凭据不可用，请检查控制环境的私密配置。' : 'DSH ACP 请求未成功完成；没有自动重试。'));
          } else item.resolve(message.result);
        } else if (message.method) this.emit('notification', message);
      }
    });
    // DSH may emit private reasoning or provider details on stderr. Do not retain or expose it.
    this.process.stderr.on('data', chunk => { this.stderrBytes += chunk.length; });
    this.process.stdin.on('error', () => this.fail(new AcpRpcError('acp_pipe_failed', 'DSH ACP 输入通道已关闭。')));
    this.process.on('error', () => this.fail(new AcpRpcError('acp_launch_failed', '无法启动本地 DSH ACP 运行时。')));
    this.exit = new Promise(resolve => this.process.once('close', (code, signal) => {
      this.closed = true; this.fail(new AcpRpcError('acp_process_exited', 'DSH ACP 进程已退出。')); resolve({ code, signal });
    }));
  }
  fail(error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  send(message) { if (this.closed || this.process.stdin.destroyed) throw new AcpRpcError('acp_closed', 'ACP connection is closed.'); this.process.stdin.write(JSON.stringify(message) + '\n'); }
  call(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AcpRpcError('acp_timeout', 'DSH ACP 请求超时。')); }, timeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  answer(id, result) { this.send({ jsonrpc: '2.0', id, result }); }
  async close() {
    if (this.closed) return this.exit;
    this.process.stdin.end();
    const timer = setTimeout(() => {
      try { if (process.platform !== 'win32') process.kill(-this.process.pid, 'SIGTERM'); else this.process.kill(); } catch {}
      const force = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-this.process.pid, 'SIGKILL'); else this.process.kill('SIGKILL'); } catch {} }, 1000); force.unref();
    }, 5000); timer.unref();
    try { return await this.exit; } finally { clearTimeout(timer); }
  }
}
