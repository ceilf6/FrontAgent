/**
 * 给「LLM 请求真的失败了」这件事打一个可机读的标记。
 *
 * 为什么标记在**消息文本**里，而不是用 Error 子类：错误在到达任何格式化器之前
 * 就已经被 `error instanceof Error ? error.message : String(error)` 拍平成字符串
 * （`agent.ts:572` 等四处），子类身份到不了下游。消息是唯一能穿过那道边界的通道。
 *
 * 这条标记存在的原因是 #408：`formatRunError` 曾用 `/not found|404/` 去猜错误来源，
 * 于是 `Cannot apply patch: file not found in context: src/hooks/useDebounce.ts`
 * 被改写成一次「404 Not Found」的 LLM 供应商配置错误，还附上从配置里取来的
 * provider / model / baseURL——一次没发生过的失败，被伪造成了证据充分的样子。
 * 判据必须是来源，不是子串。
 */
const LLM_REQUEST_FAILED_TAG = '[llm-request-failed]';

/** 给一次真实的 LLM 请求失败打标；已带标记的原样返回，避免重复包裹。 */
export function tagLLMRequestFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(LLM_REQUEST_FAILED_TAG)) return error;

  const tagged = new Error(`${LLM_REQUEST_FAILED_TAG} ${message}`);
  // 保留原始堆栈：包裹是为了标注来源，不是为了换一个新的失败点。
  if (error instanceof Error) {
    tagged.stack = error.stack;
    tagged.cause = error;
  }
  return tagged;
}

/** 这条错误是否来自一次真实的 LLM 请求。 */
export function isLLMRequestFailure(message: string): boolean {
  return message.startsWith(LLM_REQUEST_FAILED_TAG);
}

/** 去掉标记，还原给人看的原文。 */
export function stripLLMRequestTag(message: string): string {
  return isLLMRequestFailure(message)
    ? message.slice(LLM_REQUEST_FAILED_TAG.length).trimStart()
    : message;
}
