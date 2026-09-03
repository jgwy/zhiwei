export type TextQualityOptions = {
  minMeaningfulCharacters?: number;
  minHanCharacters?: number;
  minHanRatio?: number;
  minParagraphs?: number;
  maxParagraphs?: number;
  maxQuestions?: number;
};

export type TextQualityResult = {
  ok: boolean;
  reason: string | null;
  metrics: {
    characters: number;
    meaningfulCharacters: number;
    meaningfulRatio: number;
    hanCharacters: number;
    hanRatio: number;
    punctuationRatio: number;
    paragraphs: number;
    questions: number;
    lexicalDiversity: number;
  };
};

export function inspectGeneratedText(
  content: string,
  options: TextQualityOptions = {},
): TextQualityResult {
  const normalized = content.normalize("NFC").trim();
  const characters = [...normalized.replace(/\s/gu, "")];
  const meaningfulCharacters = characters.filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  const hanCharacters = characters.filter((char) => /\p{Script=Han}/u.test(char)).length;
  const punctuationCharacters = characters.filter((char) => /[\p{P}\p{S}]/u.test(char)).length;
  const paragraphs = normalized.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
  const comparableParagraphs = paragraphs.map((paragraph) => paragraph.replace(/[\s\p{P}\p{S}]/gu, "").toLocaleLowerCase("zh-CN"));
  const tokens = lexicalTokens(normalized);
  const lexicalDiversity = tokens.length ? new Set(tokens).size / tokens.length : 0;
  const metrics = {
    characters: characters.length,
    meaningfulCharacters,
    meaningfulRatio: characters.length ? meaningfulCharacters / characters.length : 0,
    hanCharacters,
    hanRatio: meaningfulCharacters ? hanCharacters / meaningfulCharacters : 0,
    punctuationRatio: characters.length ? punctuationCharacters / characters.length : 0,
    paragraphs: paragraphs.length,
    questions: countUnquotedQuestions(normalized),
    lexicalDiversity,
  };
  const fail = (reason: string): TextQualityResult => ({ ok: false, reason, metrics });

  if (!normalized) return fail("empty");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u.test(normalized)) return fail("control-character");
  if (/[\u00C0-\u024F]{6,}/u.test(normalized)) return fail("mojibake-run");
  if (/[\p{P}\p{S}]{7,}/u.test(normalized)) return fail("punctuation-run");
  if (metrics.meaningfulCharacters < (options.minMeaningfulCharacters ?? 1)) return fail("too-little-language");
  if (options.minHanCharacters !== undefined && metrics.hanCharacters < options.minHanCharacters) return fail("too-little-han");
  if (options.minHanRatio !== undefined && metrics.hanRatio < options.minHanRatio) return fail("low-han-ratio");
  if (metrics.meaningfulRatio < 0.48) return fail("low-language-ratio");
  if (metrics.punctuationRatio > 0.38) return fail("high-punctuation-ratio");
  if (options.minParagraphs !== undefined && paragraphs.length < options.minParagraphs) return fail("too-few-paragraphs");
  if (options.maxParagraphs !== undefined && paragraphs.length > options.maxParagraphs) return fail("too-many-paragraphs");
  if (options.maxQuestions !== undefined && metrics.questions > options.maxQuestions) return fail("too-many-questions");
  if (comparableParagraphs.some((paragraph, index) => paragraph.length >= 16 && comparableParagraphs.indexOf(paragraph) !== index)) {
    return fail("repeated-paragraph");
  }
  if (tokens.length >= 24 && lexicalDiversity < 0.16) return fail("low-lexical-diversity");
  return { ok: true, reason: null, metrics };
}

export function assertGeneratedTextQuality(content: string, options: TextQualityOptions = {}): void {
  const result = inspectGeneratedText(content, options);
  if (!result.ok) throw new Error(`invalid_generated_text:${result.reason}`);
}

export function limitUnquotedQuestions(content: string, maximum = 1): string {
  const characters = [...content];
  const questionIndices: number[] = [];
  const closingForOpening = new Map([["“", "”"], ["‘", "’"], ["\"", "\""], ["'", "'"], ["`", "`"]]);
  let closingQuote: string | null = null;

  for (const [index, character] of characters.entries()) {
    if (closingQuote) {
      if (character === closingQuote) closingQuote = null;
      continue;
    }
    const closing = closingForOpening.get(character);
    if (closing) {
      closingQuote = closing;
      continue;
    }
    if (character === "？" || character === "?") questionIndices.push(index);
  }

  if (questionIndices.length <= maximum) return content;
  const keep = new Set(maximum > 0 ? questionIndices.slice(-maximum) : []);
  for (const index of questionIndices) {
    if (!keep.has(index)) characters[index] = "，";
  }
  return characters.join("");
}

export function ensureEmotionalParagraphs(content: string, minimum = 2): string {
  const trimmed = content.trim();
  const paragraphs = trimmed.split(/\n\s*\n/u).filter(Boolean);
  if (paragraphs.length >= minimum || minimum !== 2) return trimmed;

  const sentences = trimmed.match(/[^。！？!?]+[。！？!?]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  if (sentences.length < 2) return trimmed;
  const totalLength = sentences.reduce((sum, sentence) => sum + [...sentence].length, 0);
  let accumulated = 0;
  let splitIndex = -1;
  for (let index = 0; index < sentences.length - 1; index += 1) {
    accumulated += [...sentences[index]!].length;
    if (accumulated >= totalLength * 0.42) {
      splitIndex = index + 1;
      break;
    }
  }
  if (splitIndex <= 0 || splitIndex >= sentences.length) return trimmed;
  return `${sentences.slice(0, splitIndex).join("")}\n\n${sentences.slice(splitIndex).join("")}`;
}

function lexicalTokens(content: string): string[] {
  const tokens: string[] = [];
  const lettersAndNumbers = content.toLocaleLowerCase("zh-CN").match(/[a-z\p{N}]+/gu) ?? [];
  tokens.push(...lettersAndNumbers);
  const han = [...content.matchAll(/[\p{Script=Han}]+/gu)].map((match) => match[0]);
  for (const sequence of han) {
    if (sequence.length === 1) tokens.push(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) tokens.push(sequence.slice(index, index + 2));
  }
  return tokens;
}

function countUnquotedQuestions(content: string): number {
  const withoutQuotedThoughts = content
    .replace(/“[^”]*”/gu, "")
    .replace(/‘[^’]*’/gu, "")
    .replace(/"[^"]*"/gu, "")
    .replace(/'[^']*'/gu, "")
    .replace(/`[^`]*`/gu, "");
  return (withoutQuotedThoughts.match(/[？?]/gu) ?? []).length;
}
