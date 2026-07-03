/**
 * 将生成阶段提示词中的可读角色名称转换为 Pro 平台角色标签。
 *
 * 大模型生成时只需稳定输出“用户”和成员名；真实 nid 在成员注入完成后
 * 由代码回填，避免让模型猜测或复制 nid。
 */

const ROLE_TAG_PATTERN = /<role>[^<]+<\/role>/g;
const USER_REFERENCE_ALIASES = ["用户", "学生", "学员"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function encodePromptRoleTags(
  prompt: string,
  memberNidMap: Record<string, string>,
): string {
  if (!prompt) return prompt;

  // 先保护已经存在的标签，保证重试注入时结果幂等。
  const protectedTags: string[] = [];
  let encoded = prompt.replace(ROLE_TAG_PATTERN, (tag) => {
    const placeholder = `__PRO_ROLE_TAG_${protectedTags.length}__`;
    protectedTags.push(tag);
    return placeholder;
  });

  const memberEntries = Object.entries(memberNidMap)
    .filter(([name, nid]) => Boolean(name.trim() && nid.trim()))
    .sort(([left], [right]) => right.length - left.length);

  // 先替换全局成员，兼容旧模板中的 @成员名 与纯成员名。
  for (const [memberName, nid] of memberEntries) {
    encoded = encoded.replace(
      new RegExp(`@?${escapeRegExp(memberName)}`, "g"),
      `<role>${nid}</role>`,
    );
  }

  const memberNames = new Set(memberEntries.map(([name]) => name));
  const userAliases = USER_REFERENCE_ALIASES.map((name) => name.trim())
    .filter(
      (name, index, aliases) =>
        Boolean(name) &&
        !memberNames.has(name) &&
        aliases.indexOf(name) === index,
    )
    .sort((left, right) => right.length - left.length);

  for (const alias of userAliases) {
    encoded = encoded.replace(
      new RegExp(`@?${escapeRegExp(alias)}`, "g"),
      "<role>user</role>",
    );
  }

  return protectedTags.reduce(
    (result, tag, index) => result.replace(`__PRO_ROLE_TAG_${index}__`, tag),
    encoded,
  );
}
