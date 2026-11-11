// Agent boundaries flatten errors to messages, so provenance must survive string transport.
const LLM_REQUEST_FAILED_TAG = '[llm-request-failed]';
const LLM_REQUEST_FAILED_END = '[/llm-request-failed]';

export function tagLLMRequestFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (isLLMRequestFailure(message)) return error;

  const taggedMessage = `${LLM_REQUEST_FAILED_TAG} ${message}${LLM_REQUEST_FAILED_END}`;
  if (error instanceof Error) {
    // Provider error identity and metadata are part of the public LLMService contract.
    error.message = taggedMessage;
    return error;
  }
  return new Error(taggedMessage);
}

export function isLLMRequestFailure(message: string): boolean {
  return message.includes(LLM_REQUEST_FAILED_TAG);
}

// Only bounded segments can distinguish provider text from adjacent tool failures.
export function getLLMRequestFailureText(message: string): string {
  return Array.from(
    message.matchAll(/\[llm-request-failed\] ([\s\S]*?)\[\/llm-request-failed\]/g),
    (match) => match[1],
  ).join('\n');
}

export function stripLLMRequestTag(message: string): string {
  return message
    .replaceAll(`${LLM_REQUEST_FAILED_TAG} `, '')
    .replaceAll(LLM_REQUEST_FAILED_TAG, '')
    .replaceAll(LLM_REQUEST_FAILED_END, '');
}
