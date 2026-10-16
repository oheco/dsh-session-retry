import Schema from '@deepseek-ai/schemastery';

const text = (zh, en) => ({ zh, en });
const duration = (fallback, zh, en, allowZero = false) => Schema.number().step(1)
  .min(allowZero ? 0 : 1).max(2_147_483_647).default(fallback).volatile()
  .extra('description', text(zh, en));

/** Live fields exposed through DSH's native plugin configuration form. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile().extra('description', text('启用自动重试', 'Enable automatic retry')),
  idleTimeoutMs: duration(300_000, '连续无响应超时（毫秒）', 'Stream idle timeout (milliseconds)'),
  requestTimeoutMs: duration(1_800_000, '单次请求最长时间（毫秒，0 表示不限）', 'Maximum attempt duration (milliseconds; 0 disables)', true),
  initialDelayMs: duration(1_000, '初始重试间隔（毫秒，不超过最大间隔）', 'Initial retry delay (milliseconds; capped at maximum)'),
  maxDelayMs: duration(30_000, '最大重试间隔（毫秒）', 'Maximum retry delay (milliseconds)'),
  jitterRatio: Schema.number().min(0).max(1).default(0.2).volatile().extra('description', text('重试间隔抖动比例', 'Retry delay jitter ratio')),
});

/** Read one validated configuration snapshot for a request or retry. */
export function snapshot(config) {
  const value = Object.fromEntries(Object.entries(config).map(([key, ref]) => [key, ref.get()]));
  value.initialDelayMs = Math.min(value.initialDelayMs, value.maxDelayMs);
  return value;
}
