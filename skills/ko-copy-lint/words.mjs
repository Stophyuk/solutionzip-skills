// Default word lists for lint.mjs. A project adds its own in copy-lint.json (see SKILL.md).
//
// Each entry is [label, RegExp]. Labels are what the report prints; keep them short.

// Claims a reader cannot check — superlatives, guarantees, rankings. Skipped when the same sentence says what is
// NOT done ("순위 보장은 하지 않습니다"), because that is a limit, not a claim.
export const HYPE = [
  ["최고", /최고(?!경영|기온|가|점|치|봉|위)/],
  ["최초", /최초/],
  ["유일", /유일/],
  ["완벽", /완벽/],
  ["100%", /[가-힣]\s?100\s?%|100\s?%\s?[가-힣]/],
  ["보장", /보장/],
  ["1위", /(?<![0-9])1\s?위/],
  ["압도적", /압도적/],
  ["무조건", /무조건/],
  ["업계 최대", /(업계|국내|세계)\s?(최대|최다|최저|유일)/],
  ["획기적", /획기적/],
  ["단 하나", /단 하나뿐|오직 하나/],
];

// Phrases that are not false, just empty — they make copy read like a template or a press release.
export const STOCK = [
  ["~을 통해", /[을를] 통해/],
  ["효율적", /효율적/],
  ["원활", /원활/],
  ["성공적으로", /성공적으로/],
  ["한눈에", /한눈에/],
  ["~할 수 있도록 설계", /수 있도록 설계/],
  ["다양한", /다양한/],
  ["진행하였습니다", /진행하였습니다|진행되었습니다/],
  ["구축하였습니다", /구축하였습니다/],
  ["극대화", /극대화/],
  ["최적화된", /최적화된/],
  ["차별화된", /차별화된/],
  ["혁신", /혁신/],
  ["시너지", /시너지/],
  ["패러다임", /패러다임/],
  ["니즈", /니즈/],
  ["원스톱", /원스톱/],
  ["스마트한", /스마트한/],
  ["새로운 경험", /새로운 경험/],
  ["~의 시작", /의 시작$|의 시작[.!]/],
];

// Marks that read as machine-written in Korean screen copy. Off with "allowDash": true in copy-lint.json.
export const DASH = /[—―]/;

// A sentence this long is hard to read on a phone. Warn only.
export const LONG_SENTENCE = 80;

// Same-sentence words that turn a claim into a limit ("보장하지 않습니다", "1위는 아닙니다").
export const NEGATION = /않|없|아닙|아니|안 [되돼됩됐될]|못 |금지|말고|빼고/;
