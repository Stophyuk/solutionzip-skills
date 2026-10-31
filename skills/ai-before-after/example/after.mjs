// The same feature after a change: more question words, "부탁" read as a request, a refund label
// (outside the schema), a coupon offer in complaint replies (a number the input never mentions),
// and very short messages skipped (empty output).
// The change has good and bad parts on purpose — compare.mjs should show both.
const REPLY = {
  question: "문의 주셔서 감사합니다. 확인해서 답드리겠습니다.",
  request: "요청 잘 받았습니다. 처리되면 알려 드리겠습니다.",
  refund: "환불 요청 잘 받았습니다. 확인 후 알려 드리겠습니다.",
  complaint: "불편을 드려 죄송합니다. 10% 할인 쿠폰을 드릴게요.",
  other: "메시지 감사합니다.",
};

export async function predict(text) {
  const s = text.trim();
  if ([...s].length < 3) return null;
  const label = /\?$|어떻게|언제|되나요|인가요/.test(s) ? "question"
    : /환불/.test(s) ? "refund"
    : /주세요|싶어요|부탁/.test(s) ? "request"
    : /깨져|속상|없네요/.test(s) ? "complaint"
    : "other";
  return { label, reply: REPLY[label] };
}
