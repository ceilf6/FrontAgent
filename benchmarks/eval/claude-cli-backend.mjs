import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// 空目录作为 CLI 工作目录：阻断 Claude Code 对宿主仓库 CLAUDE.md/项目上下文的注入
const CLI_CWD = '/tmp/frontagent-eval/claude-cli-cwd';
mkdirSync(CLI_CWD, { recursive: true });

const MODEL = process.env.EVAL_MODEL ?? 'claude-haiku-4-5';
const CALL_TIMEOUT_MS = Number(process.env.EVAL_LLM_TIMEOUT_MS ?? 180000);

const tally = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
export function getUsageTally() {
  return { ...tally };
}

function recordFailure(error) {
  tally.failures += 1;
  console.error(`[claude-cli-backend] call failed (#${tally.failures}): ${String(error?.message ?? error).slice(0, 200)}`);
}

function renderPrompt(messages, system) {
  const parts = [];
  if (system) parts.push(`[System]\n${system}`);
  for (const m of messages ?? []) {
    parts.push(`[${m.role}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
  }
  return parts.join('\n\n');
}

function callClaude(prompt) {
  return new Promise((resolvePromise, reject) => {
    // 纯文本生成后端：禁用全部工具，否则「列目录」类 prompt 会诱发 tool_use
    // 并在 --max-turns 1 下报 error_max_turns
    const args = [
      '-p',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--max-turns',
      '1',
      '--disallowedTools',
      '*',
      '--system-prompt',
      '你是一次性文本生成后端：只依据提示词中给出的信息直接作答，没有任何工具可用，不要尝试读取文件或执行命令。',
    ];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: CLI_CWD });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const err = new Error('claude CLI timeout');
      recordFailure(err);
      reject(err);
    }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      recordFailure(e);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(
          `claude exit ${code}: stderr=${stderr.slice(0, 300)} stdoutHead=${stdout.slice(0, 200)} promptChars=${prompt.length}`,
        );
        recordFailure(err);
        return reject(err);
      }
      try {
        const parsed = JSON.parse(stdout);
        tally.calls += 1;
        tally.inputTokens += parsed.usage?.input_tokens ?? 0;
        tally.outputTokens += parsed.usage?.output_tokens ?? 0;
        if (parsed.is_error) {
          const err = new Error(`claude error result: ${String(parsed.result).slice(0, 300)}`);
          recordFailure(err);
          return reject(err);
        }
        resolvePromise(String(parsed.result ?? ''));
      } catch (e) {
        const err = new Error(`bad CLI JSON: ${String(e)}; head=${stdout.slice(0, 200)}`);
        recordFailure(err);
        reject(err);
      }
    });
    child.stdin.end(prompt);
  });
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in output');
  return body.slice(start, end + 1);
}

export function createClaudeCliBackend() {
  return {
    name: `claude-cli:${MODEL}`,
    async generateText({ messages, system }) {
      return callClaude(renderPrompt(messages, system));
    },
    async generateObject({ messages, system, schema, maxRetries = 2 }) {
      let lastError = '';
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const suffix = `\n\n只输出一个 JSON 对象：不要 markdown 代码围栏、不要解释文字。${lastError ? `上次输出未通过 schema 校验（${lastError}），请修正。` : ''}`;
        const text = await callClaude(renderPrompt(messages, system) + suffix);
        try {
          return schema.parse(JSON.parse(extractJson(text)));
        } catch (error) {
          lastError = String(error).slice(0, 400);
        }
      }
      throw new Error(`generateObject retries exhausted: ${lastError}`);
    },
  };
}
