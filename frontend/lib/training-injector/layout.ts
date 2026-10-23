type Endpoint = number | "START" | "END";

export interface StepLayoutEdge {
    from: Endpoint;
    to: Endpoint;
}

export interface StepPosition {
    x: number;
    y: number;
}

export interface StepLayout {
    positions: StepPosition[];
    startPosition: StepPosition;
    endPosition: StepPosition;
}

export interface StepLayoutItem {
    stepName?: string;
    trainerName?: string;
}

const COLUMN_GAP = 560;
const ROW_GAP = 440;
const START_GAP = 350;
const END_GAP = 720;
const BOUNDARY_Y_OFFSET = 130;
const MAX_COLUMNS_PER_BAND = 8;
const FALLBACK_MIDDLE: StepPosition = { x: 482, y: 332 };

function validPosition(position?: { x?: number; y?: number } | null): StepPosition | null {
    const x = Number(position?.x);
    const y = Number(position?.y);
    return position && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function anchorFirstStep(layout: StepLayout, appendAnchor: StepPosition | null): StepLayout {
    if (appendAnchor || layout.positions.length === 0) return layout;
    // 刷新后视口仍停在初始画布附近；替换注入统一平移，避免沿用上次保存的边界坐标累积漂移。
    const offsetX = FALLBACK_MIDDLE.x - layout.positions[0].x;
    const offsetY = FALLBACK_MIDDLE.y - layout.positions[0].y;
    const move = ({ x, y }: StepPosition): StepPosition => ({ x: x + offsetX, y: y + offsetY });
    return {
        positions: layout.positions.map(move),
        startPosition: move(layout.startPosition),
        endPosition: move(layout.endPosition),
    };
}

function graphLayers(stepCount: number, edges: StepLayoutEdge[]): number[] {
    if (edges.length === 0) return Array.from({ length: stepCount }, (_, index) => index);

    const successors = Array.from({ length: stepCount }, () => new Set<number>());
    const indegrees = new Array<number>(stepCount).fill(0);
    for (const { from, to } of edges) {
        if (typeof from !== "number" || typeof to !== "number") continue;
        if (from < 0 || from >= stepCount || to < 0 || to >= stepCount || from === to) continue;
        if (!successors[from].has(to)) {
            successors[from].add(to);
            indegrees[to]++;
        }
    }

    const layers = new Array<number>(stepCount).fill(0);
    const queue = Array.from({ length: stepCount }, (_, index) => index)
        .filter((index) => indegrees[index] === 0);
    let processed = 0;
    while (queue.length > 0) {
        const current = queue.shift()!;
        processed++;
        for (const next of successors[current]) {
            layers[next] = Math.max(layers[next], layers[current] + 1);
            indegrees[next]--;
            if (indegrees[next] === 0) queue.push(next);
        }
    }

    // 回环无法完成拓扑排序，按原阶段顺序补到后续列，避免坐标无限增长。
    if (processed < stepCount) {
        let nextLayer = Math.max(-1, ...layers) + 1;
        for (let index = 0; index < stepCount; index++) {
            if (indegrees[index] > 0) layers[index] = nextLayer++;
        }
    }
    return layers;
}

function sortLaneNodes(indexes: number[], edges: StepLayoutEdge[]): number[] {
    const members = new Set(indexes);
    const successors = new Map(indexes.map((index) => [index, new Set<number>()]));
    const indegrees = new Map(indexes.map((index) => [index, 0]));
    for (const { from, to } of edges) {
        if (typeof from !== "number" || typeof to !== "number" ||
            !members.has(from) || !members.has(to) || successors.get(from)!.has(to)) continue;
        successors.get(from)!.add(to);
        indegrees.set(to, indegrees.get(to)! + 1);
    }
    const queue = indexes.filter((index) => indegrees.get(index) === 0);
    const sorted: number[] = [];
    while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);
        for (const next of successors.get(current)!) {
            indegrees.set(next, indegrees.get(next)! - 1);
            if (indegrees.get(next) === 0) queue.push(next);
        }
    }
    return sorted.length === indexes.length ? sorted : indexes;
}

function planParallelRoleLanes(params: {
    steps: StepLayoutItem[];
    edges: StepLayoutEdge[];
    firstColumnX: number;
    sourceX: number;
    centerY: number;
}): StepLayout | null {
    const { steps, edges, firstColumnX, sourceX, centerY } = params;
    const outgoingCounts = new Map<Endpoint, Set<Endpoint>>();
    for (const edge of edges) {
        outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) || new Set()).add(edge.to));
    }
    if (![...outgoingCounts.values()].some((targets) => targets.size > 1)) return null;

    const prefixes = steps.map((step) =>
        String(step.stepName || "").match(/^\s*([^|｜]{2,30})\s*[|｜]\s*\S/u)?.[1]?.trim() || "");
    const prefixCounts = new Map<string, number>();
    prefixes.forEach((prefix) => {
        if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    });
    const usePrefix = [...prefixCounts.values()].filter((count) => count >= 2).length >= 2;
    const keys = steps.map((step, index) =>
        usePrefix ? prefixes[index] : String(step.trainerName || "").trim());
    const counts = new Map<string, number>();
    keys.forEach((key) => {
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    const repeatedKeys = new Set([...counts.entries()]
        .filter(([, count]) => count >= 2).map(([key]) => key));
    if (repeatedKeys.size < 2) return null;

    const groupedIndexes = keys.flatMap((key, index) => repeatedKeys.has(key) ? [index] : []);
    const firstGrouped = Math.min(...groupedIndexes);
    const lastGrouped = Math.max(...groupedIndexes);
    const prelude: number[] = [];
    const postlude: number[] = [];
    const lanes = new Map<string, number[]>();
    steps.forEach((_, index) => {
        const key = keys[index];
        if (repeatedKeys.has(key)) {
            lanes.set(key, [...(lanes.get(key) || []), index]);
        } else if (index < firstGrouped) {
            prelude.push(index);
        } else if (index > lastGrouped) {
            postlude.push(index);
        } else {
            lanes.set(`__single_${index}`, [index]);
        }
    });

    // 跨角色跳转只决定泳道的上下顺序，不参与角色内部的横向阶段深度。
    const laneKeys = [...lanes.keys()];
    const laneByStep = new Map<number, string>();
    lanes.forEach((indexes, key) => indexes.forEach((index) => laneByStep.set(index, key)));
    const laneSuccessors = new Map(laneKeys.map((key) => [key, new Set<string>()]));
    const laneIndegrees = new Map(laneKeys.map((key) => [key, 0]));
    for (const { from, to } of edges) {
        if (typeof from !== "number" || typeof to !== "number") continue;
        const sourceLane = laneByStep.get(from);
        const targetLane = laneByStep.get(to);
        if (!sourceLane || !targetLane || sourceLane === targetLane ||
            laneSuccessors.get(sourceLane)!.has(targetLane)) continue;
        laneSuccessors.get(sourceLane)!.add(targetLane);
        laneIndegrees.set(targetLane, laneIndegrees.get(targetLane)! + 1);
    }
    const readyLanes = laneKeys.filter((key) => laneIndegrees.get(key) === 0);
    const orderedLaneKeys: string[] = [];
    while (readyLanes.length > 0) {
        const key = readyLanes.shift()!;
        orderedLaneKeys.push(key);
        for (const next of laneSuccessors.get(key)!) {
            laneIndegrees.set(next, laneIndegrees.get(next)! - 1);
            if (laneIndegrees.get(next) === 0) readyLanes.push(next);
        }
    }
    const laneGroups = (orderedLaneKeys.length === laneKeys.length ? orderedLaneKeys : laneKeys)
        .map((key) => sortLaneNodes(lanes.get(key)!, edges));
    const maxLaneLength = Math.max(...laneGroups.map((indexes) => indexes.length));
    const laneCenterY = Math.max(centerY, 100 + (laneGroups.length - 1) * ROW_GAP / 2);
    const positions = new Array<StepPosition>(steps.length);
    prelude.forEach((index, column) => {
        positions[index] = { x: Math.round(firstColumnX + column * COLUMN_GAP), y: Math.round(laneCenterY) };
    });
    const laneStartX = firstColumnX + prelude.length * COLUMN_GAP;
    laneGroups.forEach((indexes, row) => {
        const y = Math.round(laneCenterY + (row - (laneGroups.length - 1) / 2) * ROW_GAP);
        indexes.forEach((index, column) => {
            positions[index] = { x: Math.round(laneStartX + column * COLUMN_GAP), y };
        });
    });
    postlude.forEach((index, column) => {
        positions[index] = {
            x: Math.round(laneStartX + (maxLaneLength + column) * COLUMN_GAP),
            y: Math.round(laneCenterY),
        };
    });
    const endX = Math.max(...positions.map((position) => position.x)) + END_GAP;
    const boundaryY = Math.round(laneCenterY + BOUNDARY_Y_OFFSET);
    return {
        positions,
        startPosition: { x: Math.round(sourceX), y: boundaryY },
        endPosition: { x: Math.round(endX), y: boundaryY },
    };
}

/** 左到右表示流程推进；同一层的分支上下并排，START/END 位于图谱两侧。 */
export function planStepLayout(params: {
    stepCount: number;
    edges?: StepLayoutEdge[];
    steps?: StepLayoutItem[];
    startPosition?: { x?: number; y?: number } | null;
    endPosition?: { x?: number; y?: number } | null;
    appendAnchorPosition?: { x?: number; y?: number } | null;
}): StepLayout {
    const { stepCount } = params;
    const originalStart = validPosition(params.startPosition);
    const originalEnd = validPosition(params.endPosition);
    const anchorMidX = originalStart && originalEnd
        ? (originalStart.x + originalEnd.x) / 2 : FALLBACK_MIDDLE.x;
    const anchorMidY = originalStart && originalEnd
        ? (originalStart.y + originalEnd.y) / 2 : FALLBACK_MIDDLE.y;
    const verticalBoundaries = !originalStart || !originalEnd ||
        Math.abs(originalEnd.x - originalStart.x) < START_GAP;
    const appendAnchor = validPosition(params.appendAnchorPosition);
    const sourceX = appendAnchor?.x ?? (verticalBoundaries
        ? Math.max(0, anchorMidX - START_GAP) : originalStart!.x);
    const firstColumnX = appendAnchor
        ? sourceX + COLUMN_GAP
        : sourceX + START_GAP;
    const centerY = appendAnchor?.y ?? anchorMidY;

    if (stepCount <= 0) {
        return {
            positions: [],
            startPosition: originalStart || { x: Math.round(sourceX), y: Math.round(centerY) },
            endPosition: originalEnd || { x: Math.round(firstColumnX + END_GAP), y: Math.round(centerY) },
        };
    }

    const edges = params.edges || [];
    if (params.steps?.length === stepCount) {
        const parallelLayout = planParallelRoleLanes({
            steps: params.steps,
            edges,
            firstColumnX,
            sourceX,
            centerY,
        });
        if (parallelLayout) return anchorFirstStep(parallelLayout, appendAnchor);
    }
    const layers = graphLayers(stepCount, edges);
    const layerGroups = new Map<number, number[]>();
    layers.forEach((layer, index) => {
        layerGroups.set(layer, [...(layerGroups.get(layer) || []), index]);
    });
    const parents = Array.from({ length: stepCount }, () => new Set<number>());
    const outgoing = Array.from({ length: stepCount }, () => new Set<number>());
    for (const edge of edges) {
        if (typeof edge.from === "number" && typeof edge.to === "number" &&
            edge.from >= 0 && edge.from < stepCount && edge.to >= 0 && edge.to < stepCount) {
            parents[edge.to].add(edge.from);
            outgoing[edge.from].add(edge.to);
        }
    }

    const previousOrder = new Map<number, number>();
    const sortedLayers = [...layerGroups.entries()].sort(([left], [right]) => left - right);
    for (const [, indexes] of sortedLayers) {
        const parentCenter = (index: number): number => {
            const order = [...parents[index]].map((parent) => previousOrder.get(parent))
                .filter((value): value is number => value !== undefined);
            return order.length ? order.reduce((sum, value) => sum + value, 0) / order.length : index;
        };
        indexes.sort((left, right) => parentCenter(left) - parentCenter(right) || left - right);
        indexes.forEach((index, order) => previousOrder.set(index, order));
    }

    const maxParallel = Math.max(...sortedLayers.map(([, indexes]) => indexes.length));
    const laneCenterY = Math.max(centerY, 100 + (maxParallel - 1) * ROW_GAP / 2);
    const bandGap = Math.max(700, maxParallel * ROW_GAP + 260);
    const positions = new Array<StepPosition>(stepCount);
    for (const [layer, indexes] of sortedLayers) {
        const band = Math.floor(layer / MAX_COLUMNS_PER_BAND);
        const column = layer % MAX_COLUMNS_PER_BAND;
        indexes.forEach((index, row) => {
            positions[index] = {
                x: Math.round(firstColumnX + column * COLUMN_GAP),
                y: Math.round(laneCenterY + band * bandGap +
                    (row - (indexes.length - 1) / 2) * ROW_GAP),
            };
        });
    }

    const lastBand = Math.max(...layers.map((layer) => Math.floor(layer / MAX_COLUMNS_PER_BAND)));
    const explicitEndIndexes = edges.filter((edge) => edge.to === "END" && typeof edge.from === "number")
        .map((edge) => edge.from as number).filter((index) => index >= 0 && index < stepCount);
    const terminalIndexes = explicitEndIndexes.length > 0
        ? [...new Set(explicitEndIndexes)]
        : Array.from({ length: stepCount }, (_, index) => index)
            .filter((index) => outgoing[index].size === 0);
    const finalTerminals = terminalIndexes.filter((index) =>
        Math.floor(layers[index] / MAX_COLUMNS_PER_BAND) === lastBand);
    const endSources = finalTerminals.length > 0
        ? finalTerminals
        : Array.from({ length: stepCount }, (_, index) => index)
            .filter((index) => Math.floor(layers[index] / MAX_COLUMNS_PER_BAND) === lastBand);
    const finalBandPositions = positions.filter((_, index) =>
        Math.floor(layers[index] / MAX_COLUMNS_PER_BAND) === lastBand);
    const endX = Math.max(...finalBandPositions.map((position) => position.x)) + END_GAP;
    const endY = endSources.reduce((sum, index) => sum + positions[index].y, 0) /
        endSources.length + BOUNDARY_Y_OFFSET;
    const entryIndexes = edges.filter((edge) => edge.from === "START" && typeof edge.to === "number")
        .map((edge) => edge.to as number).filter((index) => index >= 0 && index < stepCount);
    const startSources = entryIndexes.length > 0
        ? entryIndexes
        : Array.from({ length: stepCount }, (_, index) => index).filter((index) => layers[index] === 0);
    const startY = startSources.reduce((sum, index) => sum + positions[index].y, 0) /
        startSources.length + BOUNDARY_Y_OFFSET;

    return anchorFirstStep({
        positions,
        startPosition: { x: Math.round(sourceX), y: Math.round(startY) },
        endPosition: { x: Math.round(endX), y: Math.round(endY) },
    }, appendAnchor);
}
