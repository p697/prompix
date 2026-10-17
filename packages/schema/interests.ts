import definitions from "./interests.json" with { type: "json" };
export const interestDefinitions = definitions;
export const interestIDs = definitions.map(item => item.id);
/** Editorial tags are the input. Never infer user traits or visual sensitivity. */
export function contentTopics(item: { tags: string[]; kind: string; contentType?: string }): string[] {
  const tags = item.tags.map(tag => tag.normalize("NFKC").toLowerCase());
  return definitions.filter(topic => (topic.id === "skills" && item.contentType === "skill")
    || topic.kinds?.includes(item.kind)
    || topic.exactAliases?.some(alias => tags.includes(alias))
    || topic.aliases.some(alias => tags.some(tag => tag.includes(alias)))).map(topic => topic.id);
}
