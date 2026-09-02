import type { AtomicClaim } from "./types";

const solarEvidence = [
  {
    keywords: ["太阳耀斑", "电磁辐射"],
    title: "Solar Flares (Radio Blackouts) | NOAA Space Weather Prediction Center",
    url: "https://swpc-drupal.woc.noaa.gov/phenomena/solar-flares-radio-blackouts",
  },
  {
    keywords: ["太阳耀斑", "8分钟"],
    title: "Solar Storms and Flares | NASA Science",
    url: "https://science.nasa.gov/sun/solar-storms-and-flares/",
  },
  {
    keywords: ["高频无线电", "电离层"],
    title: "HF Radio Communications | NOAA Space Weather Prediction Center",
    url: "https://swpc-drupal.woc.noaa.gov/impacts/hf-radio-communications",
  },
];

export function checkAtomicClaims(text: string): AtomicClaim[] {
  const sentences = text
    .split(/(?<=[。！？!?])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 8)
    .slice(0, 12);
  return sentences.map((sentence) => {
    const evidence = solarEvidence.find((item) =>
      item.keywords.every((keyword) => sentence.includes(keyword)),
    );
    if (evidence) {
      return {
        text: sentence,
        status: "supported" as const,
        sourceTitle: evidence.title,
        sourceUrl: evidence.url,
      };
    }
    if (/可能|通常|有时|尚不确定|取决于/.test(sentence)) {
      return {
        text: sentence,
        status: "uncertain" as const,
        note: "表述包含不确定性，需要在真实 Qwen 联网检索接入后进一步核对。",
      };
    }
    return {
      text: sentence,
      status: "human_review" as const,
      note: "当前仿真适配器没有联网检索能力，不能把该主张标记为已查证。",
    };
  });
}
