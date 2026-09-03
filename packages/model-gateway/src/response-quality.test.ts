import { describe, expect, it } from "vitest";
import { inspectGeneratedText } from "./response-quality";

describe("生成正文质量校验", () => {
  it("接受有具体内容的两段中文回应", () => {
    const content = "一上课就头晕，会直接打断你跟住推导的节奏，也难免让身体的不舒服和“是不是跟不上”缠在一起。那种害怕并不轻，因为你担心的不只是漏掉一节课，而是从这里逐渐落下。\n\n我先把身体不适和学业焦虑都认真放在这里，不急着把它们变成一份技巧清单。头晕本身值得被现实地留意，而大学物理暂时跟得吃力也不等于你的能力不够。我们可以先从此刻最压着你的那一边慢慢说起。";
    const result = inspectGeneratedText(content, { minMeaningfulCharacters: 90, minParagraphs: 2, maxParagraphs: 4 });

    expect(result.ok).toBe(true);
    expect(result.metrics.paragraphs).toBe(2);
  });

  it.each([
    ["{ ,,,,,,,,,,,,,,,,,,,,,,,,, }", "punctuation-run"],
    ["我听见了\u0000你的难受", "control-character"],
    ["我听见了，这件事很重。\n\n我听见了，这件事很重。", "too-little-language"],
  ])("拒绝异常正文：%s", (content, reason) => {
    expect(inspectGeneratedText(content, { minMeaningfulCharacters: 60, minParagraphs: 2 }).reason).toBe(reason);
  });

  it("rejects mojibake and text that does not contain enough expected Chinese", () => {
    const mojibake = `${"æåèäüöñçøéàôîëùœšžðþ".repeat(8)}\n\n${"æåèäüöñçøé".repeat(8)}`;
    expect(inspectGeneratedText(mojibake, {
      minMeaningfulCharacters: 90,
      minHanCharacters: 50,
      minHanRatio: 0.35,
      minParagraphs: 2,
    }).reason).toBe("mojibake-run");
  });

  it("rejects repeated long paragraphs and too many questions", () => {
    const paragraph = "你现在同时承受身体不适和学习焦虑，这两件事缠在一起时，很容易让注意力和安全感一起被拉走，这份难受值得被认真对待。";
    expect(inspectGeneratedText(`${paragraph}\n\n${paragraph}`, {
      minMeaningfulCharacters: 90,
      minParagraphs: 2,
    }).reason).toBe("repeated-paragraph");
    expect(inspectGeneratedText(`${paragraph}你更担心头晕吗？\n\n我会先陪你把最迫近的部分说清楚，不急着把你的感受塞进一份技巧清单。身体的不适和学习上的害怕都值得认真放在这里，你已经有哪一节开始听不懂了？`, {
      minMeaningfulCharacters: 90,
      minParagraphs: 2,
      maxQuestions: 1,
    }).reason).toBe("too-many-questions");
  });

  it("does not mistake a quoted inner thought for a second question", () => {
    const content = "那种‘我是不是哪里出了问题？’的念头一冒出来，很容易让羞耻和孤单一起加重，但它并不能替你定义这段感受。你愿意把它说出来，已经是在给这份长期憋着的难受找一个更安全的出口。\n\n我会先陪你把具体处境说清楚，不急着评价，也不会把它简化成一句想开一点。最近最让你觉得压抑的，是身体需求本身，还是身边没有适合谈这件事的人？";
    const result = inspectGeneratedText(content, {
      minMeaningfulCharacters: 90,
      minHanCharacters: 50,
      minHanRatio: 0.35,
      minParagraphs: 2,
      maxQuestions: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.metrics.questions).toBe(1);
  });

  it("reports style issues without mutating the inspected text", () => {
    const content = "你现在更害怕身体不适吗？还是担心课程跟不上？";
    expect(inspectGeneratedText(content, { maxQuestions: 1 }).reason).toBe("too-many-questions");
    expect(content).toBe("你现在更害怕身体不适吗？还是担心课程跟不上？");
  });
});
