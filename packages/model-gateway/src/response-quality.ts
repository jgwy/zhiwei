export type TextQualityOptions = {
  minMeaningfulCharacters?: number;
  minHanCharacters?: number;
  minHanRatio?: number;
  minParagraphs?: number;
  maxParagraphs?: number;
  maxQuestions?: number;
};

/** Only transport corruption blocks a live stream. Style metrics remain diagnostic. */
export function assertStreamTextIntegrity(text: string, final = false): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/u.test(text)) {
    throw new Error("invalid_generated_text:control-character");
  }
  if (/[\u00C0-\u024F]{6,}/u.test(text)) throw new Error("invalid_generated_text:mojibake-run");
  if ((final || [...text.replace(/\s/gu, "")].length >= 32) && !/[\p{L}\p{N}]/u.test(text)) {
    throw new Error("invalid_generated_text:too-little-language");
  }
}

/** Holds an initial 32-character prefix and an eight-code-point look-behind tail. */
export class StreamTextBuffer {
  private pending = "";
  private opened = false;
  private hadLanguage = false;

  push(delta: string): string {
    this.pending += delta;
    if (!this.opened && [...this.pending.replace(/\s/gu, "")].length < 32) return "";
    assertStreamTextIntegrity(this.pending);
    this.opened = true;
    this.hadLanguage ||= /[\p{L}\p{N}]/u.test(this.pending);
    const characters = [...this.pending];
    const output = characters.slice(0, -8).join("");
    this.pending = characters.slice(-8).join("");
    return output;
  }

  finish(): string {
    assertStreamTextIntegrity(this.pending, !this.hadLanguage);
    const output = this.pending;
    this.pending = "";
    return output;
  }
}

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
