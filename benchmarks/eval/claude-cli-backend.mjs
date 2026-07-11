import { spawn } from 'node:child_process';

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
    const args = ['-p', '--model', MODEL, '--output-format', 'json', '--max-turns', '1'];
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
        const err = new Error(`claude exit ${code}: ${stderr.slice(0, 300)}`);
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
