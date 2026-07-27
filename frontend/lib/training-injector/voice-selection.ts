export interface VoiceCandidate {
    voiceNid: string;
    voiceName?: string;
    voiceType?: string;
    voiceParam?: string;
    description?: string;
    source?: string;
    raw?: unknown;
}

export type DigitalHumanGender = "male" | "female" | "unknown";
export type DigitalHumanAgeGroup = "child" | "adult" | "senior" | "unknown";

export interface VoiceSelectionInput {
    preferredName?: string;
    preferredVoiceNid?: string;
    preferredGender?: DigitalHumanGender | string;
    preferredAgeGroup?: DigitalHumanAgeGroup | string;
    roleName?: string;
    roleDescription?: string;
    avatarDescription?: string;
    fallbackToFirst?: boolean;
}

function readString(source: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
}

function normalize(value: unknown): string {
    return String(value || "")
        .trim()
        .replace(/\s+/g, "")
        .toLowerCase();
}

function includesAny(text: string, words: string[]): boolean {
    return words.some((word) => text.includes(word));
}

/** 只使用明确性别词，职业和声音气质不作为性别依据。 */
export function inferDigitalHumanGender(
    ...values: unknown[]
): DigitalHumanGender {
    const text = normalize(values.filter(Boolean).join(" "));
    if (!text) return "unknown";

    const femaleSignals = [
        "女性", "女声", "女老师", "女教师", "女导师", "女教授", "女士",
        "女人", "女孩", "女生", "妈妈", "母亲", "姐姐", "阿姨", "奶奶",
        "外婆", "female", "woman", "girl", "zh_female", "zh-female",
    ];
    const maleSignals = [
        "男性", "男声", "男老师", "男教师", "男导师", "男教授", "先生",
        "男人", "男孩", "男生", "爸爸", "父亲", "哥哥", "叔叔", "爷爷",
        "外公", "male", "man", "boy", "zh_male", "zh-male",
    ];
    const hasFemale = includesAny(text, femaleSignals);
    // female 内含 male，woman 内含 man，男性检测前先去掉这些女性英文词。
    const hasMale = includesAny(
        text.replace(/female|woman/g, ""),
        maleSignals,
    );
    if (hasFemale === hasMale) return "unknown";
    return hasFemale ? "female" : "male";
}

export function normalizeDigitalHumanGender(
    value: unknown,
): DigitalHumanGender {
    const normalized = normalize(value);
    if (!normalized) return "unknown";
    if (["女", "女性", "女声", "female", "woman", "girl"].includes(normalized)) {
        return "female";
    }
    if (["男", "男性", "男声", "male", "man", "boy"].includes(normalized)) {
        return "male";
    }
    return inferDigitalHumanGender(normalized);
}

export function inferVoiceCandidateGender(
    candidate?: VoiceCandidate | null,
): DigitalHumanGender {
    if (!candidate) return "unknown";
    return inferDigitalHumanGender(
        candidate.voiceName,
        candidate.voiceType,
        candidate.voiceParam,
        candidate.description,
    );
}

export function isDigitalHumanGenderCompatible(
    preferred: DigitalHumanGender | string | undefined,
    actual: DigitalHumanGender | string | undefined,
): boolean {
    const preferredGender = normalizeDigitalHumanGender(preferred);
    const actualGender = normalizeDigitalHumanGender(actual);
    return preferredGender === "unknown" ||
        actualGender === "unknown" ||
        preferredGender === actualGender;
}

export function getDigitalHumanGenderLabel(
    gender: DigitalHumanGender | string | undefined,
): string {
    const normalized = normalizeDigitalHumanGender(gender);
    if (normalized === "female") return "女性";
    if (normalized === "male") return "男性";
    return "未指定";
}

export function inferDigitalHumanAgeGroup(
    ...values: unknown[]
): DigitalHumanAgeGroup {
    const text = normalize(values.filter(Boolean).join(" "));
    if (!text) return "unknown";

    const seniorSignals = [
        "老年", "老人", "老爷爷", "老奶奶", "爷爷", "奶奶", "外公",
        "外婆", "爷爷音", "奶奶音", "高龄", "elderly", "seniorvoice",
        "agedvoice", "oldman", "oldwoman",
    ];
    const childSignals = [
        "儿童", "幼儿", "幼童", "男童", "女童", "童声", "少儿",
        "小童", "孩童", "少年", "少女", "男孩", "女孩", "小男孩",
        "小女孩", "萌娃", "奶气", "正太", "萝莉", "child", "kid",
        "boy", "girl", "boyvoice", "girlvoice", "xiaotong",
        "tongsheng", "mengwa", "zhengtai", "luoli",
    ];
    const adultSignals = [
        "成人", "成年", "青年", "中年", "成熟男声", "成熟女声",
        "adult", "youngadult", "middleaged",
    ];
    const hasSenior = includesAny(text, seniorSignals);
    const hasChild = includesAny(text, childSignals);
    const hasAdult = includesAny(text, adultSignals);
    const matchedCount = [hasSenior, hasChild, hasAdult].filter(Boolean).length;
    if (matchedCount !== 1) return "unknown";
    if (hasSenior) return "senior";
    if (hasChild) return "child";
    return "adult";
}

export function normalizeDigitalHumanAgeGroup(
    value: unknown,
): DigitalHumanAgeGroup {
    const normalized = normalize(value);
    if (!normalized) return "unknown";
    if (["儿童", "幼儿", "幼童", "少儿", "child", "kid"].includes(normalized)) {
        return "child";
    }
    if (["成人", "成年", "青年", "中年", "adult", "youngadult"].includes(normalized)) {
        return "adult";
    }
    if (["老年", "老人", "高龄", "senior", "elderly"].includes(normalized)) {
        return "senior";
    }
    return inferDigitalHumanAgeGroup(normalized);
}

/**
 * 角色年龄先看角色名称中的主体身份，避免“患儿父亲”因上下文出现患儿而被判成儿童。
 */
export function inferDigitalHumanRoleAgeGroup(
    roleName?: unknown,
    roleDescription?: unknown,
    avatarDescription?: unknown,
): DigitalHumanAgeGroup {
    const normalizedName = normalize(roleName);
    const seniorRoleSignals = [
        "爷爷", "奶奶", "外公", "外婆", "祖父", "祖母", "老年人", "老人",
    ];
    const adultRoleSignals = [
        "父亲", "母亲", "爸爸", "妈妈", "家长", "监护人", "叔叔", "阿姨",
        "医生", "护士", "教师", "老师", "教授", "导师", "律师", "法官",
        "经理", "主任", "工程师", "教练", "辅导员", "工作人员", "专家",
    ];
    const childRoleSignals = [
        "患儿", "儿童", "幼儿", "幼童", "男童", "女童", "小朋友",
        "小男孩", "小女孩", "萌娃",
    ];

    if (includesAny(normalizedName, seniorRoleSignals)) return "senior";
    if (includesAny(normalizedName, adultRoleSignals)) return "adult";
    if (includesAny(normalizedName, childRoleSignals)) return "child";

    const roleText = normalize(
        [roleName, roleDescription, avatarDescription].filter(Boolean).join(" "),
    );
    if (includesAny(roleText, seniorRoleSignals)) return "senior";
    if (includesAny(roleText, adultRoleSignals)) return "adult";
    if (includesAny(roleText, childRoleSignals)) return "child";
    return inferDigitalHumanAgeGroup(roleText);
}

export function inferVoiceCandidateAgeGroup(
    candidate?: VoiceCandidate | null,
): DigitalHumanAgeGroup {
    if (!candidate) return "unknown";
    const primaryAge = inferDigitalHumanAgeGroup(
        candidate.voiceName,
        candidate.voiceType,
        candidate.voiceParam,
    );
    return primaryAge !== "unknown"
        ? primaryAge
        : inferDigitalHumanAgeGroup(candidate.description);
}

export function isDigitalHumanAgeGroupCompatible(
    preferred: DigitalHumanAgeGroup | string | undefined,
    actual: DigitalHumanAgeGroup | string | undefined,
): boolean {
    const preferredAge = normalizeDigitalHumanAgeGroup(preferred);
    const actualAge = normalizeDigitalHumanAgeGroup(actual);
    return preferredAge === "unknown" ||
        actualAge === "unknown" ||
        preferredAge === actualAge;
}

export function getDigitalHumanAgeGroupLabel(
    ageGroup: DigitalHumanAgeGroup | string | undefined,
): string {
    const normalized = normalizeDigitalHumanAgeGroup(ageGroup);
    if (normalized === "child") return "儿童";
    if (normalized === "adult") return "成年";
    if (normalized === "senior") return "老年";
    return "年龄未指定";
}

function uniqueCandidates(candidates: VoiceCandidate[]): VoiceCandidate[] {
    const seen = new Set<string>();
    const result: VoiceCandidate[] = [];
    for (const candidate of candidates) {
        if (!candidate.voiceNid) continue;
        const key = `${candidate.voiceNid}::${candidate.voiceType || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

export function toVoiceCandidate(
    item: unknown,
    source = "voice-training",
): VoiceCandidate | null {
    if (!item || typeof item !== "object") return null;
    const object = item as Record<string, unknown>;
    const voiceNid = readString(object, [
        "voiceNid",
        "nid",
        "voiceTemplateNid",
        "templateNid",
        "voiceId",
        "id",
        "bizId",
    ]);
    if (!voiceNid) return null;

    const voiceName = readString(object, [
        "voiceName",
        "name",
        "voiceTone",
        "templateName",
        "voiceTemplateName",
        "displayName",
        "title",
    ]);
    const voiceType = readString(object, [
        "bigModelVoiceParam",
        "voiceType",
        "type",
        "modelVoiceParam",
        "ttsParam",
        "voiceCode",
    ]);
    const voiceParam = readString(object, [
        "voiceParam",
        "param",
        "streamingParam",
        "speaker",
    ]);
    const description = [
        readString(object, [
            "voiceIntroduce",
            "introduce",
            "description",
            "voiceDescription",
            "voiceDesc",
            "desc",
            "remark",
        ]),
        readString(object, ["language", "locale"]),
        readString(object, ["gender", "speakerGender", "sex"]),
        readString(object, ["ageGroup", "speakerAge", "age"]),
    ]
        .filter(Boolean)
        .join(" ");

    return {
        voiceNid,
        voiceName,
        voiceType,
        voiceParam,
        description,
        source,
        raw: item,
    };
}

export function toVoiceCandidates(
    items: unknown[],
    source = "voice-training",
): VoiceCandidate[] {
    return uniqueCandidates(
        items
            .map((item) => toVoiceCandidate(item, source))
            .filter(Boolean) as VoiceCandidate[],
    );
}

function scoreVoiceCandidate(
    candidate: VoiceCandidate,
    input: VoiceSelectionInput,
): number {
    const candidateText = normalize(
        [
            candidate.voiceName,
            candidate.voiceType,
            candidate.voiceParam,
            candidate.description,
        ]
            .filter(Boolean)
            .join(" "),
    );
    const preferredName = normalize(input.preferredName);
    const preferredVoiceNid = normalize(input.preferredVoiceNid);
    const roleText = normalize(
        [
            input.preferredName,
            input.roleName,
            input.roleDescription,
            input.avatarDescription,
        ]
            .filter(Boolean)
            .join(" "),
    );
    const explicitGender = normalizeDigitalHumanGender(input.preferredGender);
    const preferredGender = explicitGender !== "unknown"
        ? explicitGender
        : inferDigitalHumanGender(
            input.roleName,
            input.roleDescription,
            input.avatarDescription,
        );
    const candidateGender = inferVoiceCandidateGender(candidate);
    const explicitAgeGroup = normalizeDigitalHumanAgeGroup(
        input.preferredAgeGroup,
    );
    const preferredAgeGroup = explicitAgeGroup !== "unknown"
        ? explicitAgeGroup
        : inferDigitalHumanRoleAgeGroup(
            input.roleName,
            input.roleDescription,
            input.avatarDescription,
        );
    const candidateAgeGroup = inferVoiceCandidateAgeGroup(candidate);
    let score = 0;

    if (
        preferredGender !== "unknown" &&
        candidateGender !== "unknown" &&
        preferredGender !== candidateGender
    ) {
        return -10_000;
    }
    if (preferredGender !== "unknown" && preferredGender === candidateGender) {
        score += 180;
    }
    if (
        preferredAgeGroup !== "unknown" &&
        candidateAgeGroup !== "unknown" &&
        preferredAgeGroup !== candidateAgeGroup
    ) {
        return -20_000;
    }
    if (
        preferredAgeGroup !== "unknown" &&
        preferredAgeGroup === candidateAgeGroup
    ) {
        score += 220;
    }

    if (preferredVoiceNid && normalize(candidate.voiceNid) === preferredVoiceNid) {
        score += 160;
    }
    if (preferredName) {
        const candidateName = normalize(candidate.voiceName);
        if (candidateName === preferredName) score += 140;
        if (candidateText.includes(preferredName)) score += 100;
        if (preferredName.includes(candidateName) && candidateName.length >= 2) score += 80;

        const preferredTokens = preferredName
            .split(/[、，,;；/|()（）【】\s]+/)
            .map(normalize)
            .filter((token) => token.length >= 2);
        for (const token of preferredTokens) {
            if (candidateText.includes(token)) score += 20;
        }
    }

    if (!roleText) return score;

    const professionalSignals = [
        "专家",
        "教授",
        "导师",
        "法官",
        "检察",
        "律师",
        "书记",
        "主任",
        "领导",
        "评委",
        "考官",
        "专业",
        "严谨",
    ];
    const livelySignals = ["活泼", "灵动", "陪伴", "轻松", "年轻", "青年"];
    const englishSignals = ["英文", "英语", "美式", "英式", "english"];

    if (includesAny(roleText, professionalSignals) && includesAny(candidateText, ["专业", "沉稳", "成熟", "儒雅", "磁性", "擎苍", "霸气", "稳重"])) {
        score += 24;
    }
    if (includesAny(roleText, livelySignals) && includesAny(candidateText, ["灵动", "轻松", "活泼", "陪伴", "青年", "灿灿", "反卷"])) {
        score += 24;
    }
    if (includesAny(roleText, englishSignals) && includesAny(candidateText, ["英语", "英文", "美式", "英式", "english", "luna", "sophie"])) {
        score += 60;
    }

    return score;
}

export function selectBestVoiceCandidate(
    candidates: VoiceCandidate[],
    input: VoiceSelectionInput,
): VoiceCandidate | null {
    const unique = uniqueCandidates(candidates);
    if (unique.length === 0) return null;

    const explicitGender = normalizeDigitalHumanGender(input.preferredGender);
    const preferredGender = explicitGender !== "unknown"
        ? explicitGender
        : inferDigitalHumanGender(
            input.roleName,
            input.roleDescription,
            input.avatarDescription,
        );
    const explicitAgeGroup = normalizeDigitalHumanAgeGroup(
        input.preferredAgeGroup,
    );
    const preferredAgeGroup = explicitAgeGroup !== "unknown"
        ? explicitAgeGroup
        : inferDigitalHumanRoleAgeGroup(
            input.roleName,
            input.roleDescription,
            input.avatarDescription,
        );
    const genderCompatible = preferredGender === "unknown"
        ? unique
        : unique.filter((candidate) =>
            isDigitalHumanGenderCompatible(
                preferredGender,
                inferVoiceCandidateGender(candidate),
            )
        );
    const compatible = preferredAgeGroup === "unknown"
        ? genderCompatible
        : genderCompatible.filter((candidate) =>
            isDigitalHumanAgeGroupCompatible(
                preferredAgeGroup,
                inferVoiceCandidateAgeGroup(candidate),
            )
        );
    // 已明确角色性别或年龄层时，宁可不选，也不回退到已知不匹配的音色。
    if (compatible.length === 0) return null;

    let best: { candidate: VoiceCandidate; score: number } | null = null;
    for (const candidate of compatible) {
        const score = scoreVoiceCandidate(candidate, {
            ...input,
            preferredGender,
            preferredAgeGroup,
        });
        if (!best || score > best.score) {
            best = { candidate, score };
        }
    }

    if (best && best.score > 0) return best.candidate;
    return input.fallbackToFirst ? compatible[0] : null;
}
