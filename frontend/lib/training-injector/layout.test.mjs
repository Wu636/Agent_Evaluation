import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStepLayout } from './layout.ts';

const boundaries = {
  startPosition: { x: 482, y: 0 },
  endPosition: { x: 482, y: 664 },
};

test('原始上下排列的 START/END 转为左右两端，单卡保留中点坐标', () => {
  const layout = planStepLayout({ stepCount: 1, ...boundaries });
  assert.deepEqual(layout.positions, [{ x: 482, y: 332 }]);
  assert.ok(layout.startPosition.x < layout.positions[0].x);
  assert.ok(layout.endPosition.x > layout.positions[0].x + 500);
  assert.deepEqual(planStepLayout({ stepCount: 1 }).positions, [{ x: 482, y: 332 }]);
});

test('分支同列并行，汇合节点在右侧居中', () => {
  const { positions, startPosition, endPosition } = planStepLayout({
    stepCount: 4,
    ...boundaries,
    edges: [
      { from: 'START', to: 0 },
      { from: 0, to: 1 }, { from: 0, to: 2 },
      { from: 1, to: 3 }, { from: 2, to: 3 },
      { from: 3, to: 'END' },
    ],
  });
  assert.equal(positions[1].x, positions[2].x);
  assert.ok(positions[1].y < positions[0].y && positions[2].y > positions[0].y);
  assert.ok(positions[0].x < positions[1].x && positions[1].x < positions[3].x);
  assert.equal(positions[0].y, positions[3].y);
  assert.ok(startPosition.x < positions[0].x && endPosition.x > positions[3].x);
});

test('后续卡片跟随各自上游的纵向分支，减少交叉连线', () => {
  const { positions } = planStepLayout({
    stepCount: 5,
    ...boundaries,
    edges: [
      { from: 'START', to: 0 },
      { from: 0, to: 1 }, { from: 0, to: 2 },
      { from: 1, to: 4 }, { from: 2, to: 3 },
      { from: 3, to: 'END' }, { from: 4, to: 'END' },
    ],
  });
  assert.ok(positions[1].y < positions[2].y);
  assert.ok(positions[4].y < positions[3].y);
  assert.equal(positions[3].x, positions[4].x);
});

test('截图所示四条并行分支：每条横向推进，结束卡片独立放在右侧', () => {
  const edges = [{ from: 'START', to: 0 }];
  for (const first of [1, 5, 9, 13]) {
    edges.push({ from: 0, to: first });
    for (let index = first; index < first + 3; index++) edges.push({ from: index, to: index + 1 });
    edges.push({ from: first + 3, to: 'END' });
  }
  const { positions, startPosition, endPosition } = planStepLayout({
    stepCount: 17, edges, ...boundaries,
  });
  for (const first of [1, 5, 9, 13]) {
    const lane = positions.slice(first, first + 4);
    assert.equal(new Set(lane.map(({ y }) => y)).size, 1);
    assert.ok(lane.every((item, index) => index === 0 || item.x > lane[index - 1].x));
  }
  assert.ok(positions[1].y < positions[5].y && positions[5].y < positions[9].y && positions[9].y < positions[13].y);
  assert.ok(startPosition.x < Math.min(...positions.map(({ x }) => x)));
  assert.ok(endPosition.x >= Math.max(...positions.map(({ x }) => x)) + 700);
  assert.ok(endPosition.y > positions[1].y && endPosition.y < positions[13].y + 300);
});

test('跨分支连线不改变四个角色的横向泳道，也不把结束卡片挤到下方', () => {
  const roles = ['主管接诊医师', '流行病学调查员', '临床药师', '检验医师'];
  const steps = [
    { stepName: '案情摘要与实训角色锁定' },
    ...roles.flatMap((role) => Array.from({ length: 4 }, (_, stage) => ({
      stepName: `${role} | 阶段 ${stage + 1}`,
    }))),
  ];
  const edges = [{ from: 'START', to: 0 }];
  for (const first of [1, 5, 9, 13]) {
    edges.push({ from: 0, to: first });
    for (let index = first; index < first + 3; index++) edges.push({ from: index, to: index + 1 });
    edges.push({ from: first + 3, to: 'END' });
  }
  // 实际剧本允许上一角色阶段触发下一角色阶段；这些边应保留，但不应重新分层。
  edges.push({ from: 4, to: 5 }, { from: 8, to: 9 }, { from: 12, to: 13 });
  const { positions, startPosition, endPosition } = planStepLayout({
    stepCount: steps.length, steps, edges, ...boundaries,
  });

  for (const first of [1, 5, 9, 13]) {
    const lane = positions.slice(first, first + 4);
    assert.equal(new Set(lane.map(({ y }) => y)).size, 1);
    assert.ok(lane.every((item, index) => index === 0 || item.x > lane[index - 1].x));
  }
  assert.deepEqual([1, 5, 9, 13].map((first) => positions[first].x), [
    positions[1].x, positions[1].x, positions[1].x, positions[1].x,
  ]);
  assert.ok(positions[1].y < positions[5].y && positions[5].y < positions[9].y && positions[9].y < positions[13].y);
  assert.ok(startPosition.x < positions[0].x && positions[0].x < positions[1].x);
  assert.ok(endPosition.x > Math.max(...positions.map(({ x }) => x)) + 500);
  assert.ok(endPosition.y > positions[1].y && endPosition.y < positions[13].y);
});

test('角色在剧本中的先后次序与依赖不同，按跨角色流向调整上下顺序', () => {
  const roles = ['主管接诊医师', '检验医师', '流行病学调查员', '临床药师'];
  const steps = [
    { stepName: '案情摘要' },
    ...roles.flatMap((role) => [1, 2].map((stage) => ({ stepName: `${role} | 阶段 ${stage}` }))),
  ];
  const edges = [
    { from: 'START', to: 0 },
    ...[1, 3, 5, 7].map((first) => ({ from: 0, to: first })),
    ...[1, 3, 5, 7].map((first) => ({ from: first, to: first + 1 })),
    { from: 2, to: 5 }, { from: 2, to: 7 },
    { from: 6, to: 3 }, { from: 8, to: 3 },
    ...[2, 4, 6, 8].map((last) => ({ from: last, to: 'END' })),
  ];
  const { positions } = planStepLayout({ stepCount: steps.length, steps, edges, ...boundaries });
  assert.ok(positions[1].y < positions[5].y);
  assert.ok(positions[1].y < positions[7].y);
  assert.ok(positions[5].y < positions[3].y);
  assert.ok(positions[7].y < positions[3].y);
  assert.equal(positions[3].x, positions[5].x);
});

test('再次替换注入时统一平移整张图，旧的远处坐标不会带偏新卡片', () => {
  const steps = [
    { stepName: '案情摘要' },
    { stepName: '医生 | 初诊' }, { stepName: '医生 | 复核' },
    { stepName: '药师 | 初审' }, { stepName: '药师 | 复核' },
  ];
  const edges = [
    { from: 'START', to: 0 },
    { from: 0, to: 1 }, { from: 0, to: 3 },
    { from: 1, to: 2 }, { from: 3, to: 4 },
    { from: 2, to: 'END' }, { from: 4, to: 'END' },
  ];
  const fresh = planStepLayout({ stepCount: steps.length, steps, edges, ...boundaries });
  const stale = planStepLayout({
    stepCount: steps.length, steps, edges,
    startPosition: { x: 846, y: 1420 },
    endPosition: { x: 4400, y: 2170 },
  });
  assert.deepEqual(fresh.positions[0], { x: 482, y: 332 });
  assert.deepEqual(stale.positions[0], { x: 482, y: 332 });
  assert.deepEqual(stale.positions[1], { x: 1042, y: 112 });
  assert.deepEqual(stale, fresh);
  assert.ok(stale.endPosition.x > Math.max(...stale.positions.map(({ x }) => x)));
});

test('普通流程也以首张卡片作为刷新后的可见锚点', () => {
  const layout = planStepLayout({
    stepCount: 3,
    startPosition: { x: 1756, y: 1575 },
    endPosition: { x: 3000, y: 2100 },
  });
  assert.deepEqual(layout.positions[0], { x: 482, y: 332 });
  assert.deepEqual(layout.positions.slice(1).map(({ x, y }, index) => ({
    x: x - layout.positions[index].x,
    y: y - layout.positions[index].y,
  })), [{ x: 560, y: 0 }, { x: 560, y: 0 }]);
});

test('长线性训练分段排布，结束卡片跟随最后一段', () => {
  const long = planStepLayout({ stepCount: 85, ...boundaries });
  assert.equal(long.positions.length, 85);
  assert.ok(Math.max(...long.positions.map(({ x }) => x)) < 5000);
  assert.ok(Math.max(...long.positions.map(({ y }) => y)) < 8000);
  assert.equal(new Set(long.positions.map(({ x, y }) => `${x},${y}`)).size, 85);
  assert.ok(long.endPosition.x > long.positions[84].x);

});

test('追加节点从现有末端向右展开，连线不跨回画布中心', () => {
  const append = planStepLayout({
    stepCount: 2, ...boundaries, appendAnchorPosition: { x: 1500, y: 600 },
  });
  assert.equal(append.positions[0].x, 2060);
  assert.ok(append.positions[1].x > append.positions[0].x);
  assert.ok(append.endPosition.x > append.positions[1].x);
});

test('回环按有限列布局', () => {
  const { positions } = planStepLayout({
    stepCount: 3,
    ...boundaries,
    edges: [{ from: 'START', to: 0 }, { from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 1 }],
  });
  assert.equal(positions.length, 3);
  assert.ok(positions.every(({ x, y }) => Math.abs(x) < 3000 && Math.abs(y) < 3000));
});
