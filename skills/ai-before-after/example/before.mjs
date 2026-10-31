// Stand-in for an LLM feature: sort a customer message and draft a first reply.
// Rules only — no API call. A real feature would call the model here, and only when ctx.real is true.
const REPLY = {
  question: "문의 주셔서 감사합니다. 확인해서 답드리겠습니다.",
  request: "요청 잘 받았습니다. 처리되면 알려 드리겠습니다.",
  complaint: "불편을 드려 죄송합니다. 바로 확인하겠습니다.",
  other: "메시지 감사합니다.",
};

export async function predict(text) {
  const s = text.trim();
  const label = /\?$/.test(s) ? "question"
    : /주세요|싶어요/.test(s) ? "request"
    : /깨져|속상|없네요/.test(s) ? "complaint"
    : "other";
  return { label, reply: REPLY[label] };
}
