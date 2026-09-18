import { buildBaseline, compareWithBaseline, mergeRanges } from '../src/lib/baseline'
import {
  addHostAssignment,
  firstFreeAddress,
  hostIssueText,
  hostOwnersOfPlan,
  reconcileHosts,
} from '../src/lib/hosts'
import { ipToInt, prefixForHosts } from '../src/lib/ip'
import { plan } from '../src/lib/planner'
import { blocksToCidrList, summarizeSegments } from '../src/lib/summary'
import type { HostAssignment } from '../src/lib/hosts'
import type { PlannerInput, Segment } from '../src/lib/types'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

// 1) 容量换算
check('2 台主机 -> /30', prefixForHosts(2) === 30)
check('3 台主机 -> /29', prefixForHosts(3) === 29)
check('100 台主机 -> /25', prefixForHosts(100) === 25)
check('254 台主机 -> /24', prefixForHosts(254) === 24)
check('255 台主机 -> /23', prefixForHosts(255) === 23)

// 2) 示例场景：保留 0/28，固定 64/28；自动 100/40/25/2
const demo: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const r = plan(demo)
check('示例无输入错误', r.inputErrors.length === 0, JSON.stringify(r.inputErrors))
check('示例无失败需求', r.failures.length === 0, JSON.stringify(r.failures))
const auto = r.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)
check(
  '自动分配结果正确（按地址顺序）',
  JSON.stringify(auto) === JSON.stringify(['192.168.10.16/30', '192.168.10.64/26', '192.168.10.128/25']),
  JSON.stringify(auto),
)
check('总地址守恒 256', r.summary.reserved + r.summary.fixed + r.summary.auto + r.summary.free === 256)
check('示例浪费量=53', r.summary.waste === 53, String(r.summary.waste))
check('示例空闲=12（20–31 + 192–255）', r.summary.free === 12, String(r.summary.free))

// 2b) 回归：保留 0/28、固定 64/28，/26 需求必须推进到 128（不能压在固定段上）
const reg: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'f', name: '固定', hosts: 2, cidr: '192.168.10.64/28' },
    { id: 'a', name: '自动', hosts: 40, cidr: '' },
  ],
}
const rr = plan(reg)
check(
  '对齐推进不侵占固定段',
  rr.segments.find((s) => s.kind === 'auto')?.cidr === '192.168.10.128/26',
  JSON.stringify(rr.segments.map((s) => [s.kind, s.cidr])),
)
check(
  '占用段之间无重叠',
  (() => {
    const occ2 = rr.segments.filter((s) => s.kind !== 'free').sort((a, b) => a.start - b.start)
    for (let i = 1; i < occ2.length; i++) if (occ2[i].start <= occ2[i - 1].end) return false
    return true
  })(),
)

// 3) 同规模按录入顺序：/28 保留外，3 个 /30 需求依次落到 16、20、24
const tie: PlannerInput = {
  parentCidr: '10.0.0.0/27',
  reservations: [{ id: 'r1', name: 'res', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
  ],
}
const rt = plan(tie)
check(
  '同规模按录入顺序分配',
  JSON.stringify(rt.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.16/30', '10.0.0.20/30', '10.0.0.24/30']),
  JSON.stringify(rt.segments),
)

// 4) 放不下：父 /30，需求 100 台，应给出原因
const tooBig: PlannerInput = {
  parentCidr: '192.168.0.0/30',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
}
const rb = plan(tooBig)
check('超大需求失败且有原因', rb.failures.length === 1 && /最大连续空闲块/.test(rb.failures[0].reason), rb.failures[0]?.reason)

// 5) 碎片化：/30 块被保留区切碎，大网段找不到对齐空间
const frag: PlannerInput = {
  parentCidr: '10.1.0.0/26',
  reservations: [
    { id: 'r1', name: 'r1', cidr: '10.1.0.16/30' },
    { id: 'r2', name: 'r2', cidr: '10.1.0.32/30' },
    { id: 'r3', name: 'r3', cidr: '10.1.0.48/30' },
  ],
  requirements: [{ id: 'x', name: '大块', hosts: 20, cidr: '' }], // 需要 /27
}
const rf = plan(frag)
check('碎片场景 /27 无法分配', rf.failures.length === 1, JSON.stringify(rf.failures))
check('失败后其余段仍正常输出', rf.segments.filter((s) => s.kind === 'reserved').length === 3)

// 6) 固定网段超出父网段 -> 输入错误
const outside: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.2.0/30' }],
}
check('固定网段越界报错', plan(outside).inputErrors.some((e) => /不在父网段/.test(e)))

// 7) 保留区与固定网段重叠 -> 输入错误
const overlap: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [{ id: 'r', name: 'R', cidr: '192.168.1.0/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 2, cidr: '192.168.1.8/30' }],
}
check('保留与固定重叠报错', plan(overlap).inputErrors.some((e) => /重叠/.test(e)))

// 8) 固定网段容量不足 -> 报错并显示实际可用数
const small: PlannerInput = {
  parentCidr: '192.168.1.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 20, cidr: '192.168.1.0/28' }],
}
check('固定段容量不足报错', plan(small).inputErrors.some((e) => /仅提供 14/.test(e)))

// 9) 非规范网络地址（主机位非 0）报错
const nonCanonical: PlannerInput = {
  parentCidr: '192.168.1.10/24',
  reservations: [],
  requirements: [],
}
check('非规范父网段报错并提示正确写法', plan(nonCanonical).inputErrors.some((e) => /192\.168\.1\.0\/24/.test(e)))

// 10) 自动网段绕开保留区且边界对齐：保留区位于中间 16/28，/27 需求应落到 0/27 而非 32/27？
//  最低对齐：0/27 空闲可容纳 -> 0/27
const align: PlannerInput = {
  parentCidr: '10.2.0.0/26',
  reservations: [{ id: 'r', name: 'R', cidr: '10.2.0.16/28' }],
  requirements: [{ id: 'x', name: 'X', hosts: 25, cidr: '' }], // /27
}
const ra = plan(align)
check(
  '最低对齐原则（跳过保留区取 32/27）',
  ra.segments.find((s) => s.kind === 'auto')?.cidr === '10.2.0.32/27',
  JSON.stringify(ra.segments.map((s) => s.cidr)),
)

// 11) 浪费量统计：100 台在 /25 浪费 26；广播/网络/可用范围正确
const w = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [],
  requirements: [{ id: 'x', name: 'X', hosts: 100, cidr: '' }],
})
const seg0 = w.segments.find((s) => s.kind === 'auto')!
check('浪费量=26', seg0.waste === 26, String(seg0.waste))
check('网络地址', seg0.network === '192.168.10.0')
check('广播地址', seg0.broadcast === '192.168.10.127')
check('可用范围', seg0.firstUsable === '192.168.10.1' && seg0.lastUsable === '192.168.10.126')
check('容量 128 / 可用 126', seg0.capacity === 128 && seg0.usable === 126)

// 12) 排序：录入小需求在前、大需求在后，大需求仍先分且不会被小需求挡住最低地址
const order: PlannerInput = {
  parentCidr: '172.16.0.0/24',
  reservations: [],
  requirements: [
    { id: 's', name: '小', hosts: 2, cidr: '' },
    { id: 'b', name: '大', hosts: 100, cidr: '' },
  ],
}
const ro = plan(order)
check(
  '大需求优先占最低对齐地址',
  JSON.stringify(ro.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['172.16.0.0/25', '172.16.0.128/30']),
  JSON.stringify(ro.segments.map((s) => s.cidr)),
)

// 13) 基线对比：按稳定 ID 识别新增/删除/未变/扩容/缩容/迁移/未分配/恢复分配
//  基线布局（10.0.0.0/24）：固定 q3 .32/28；q1(100台,/25) .128–.255；q2(40台,/26) .64–.127
const baseInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const basePlan = plan(baseInput)
check('基线场景无输入错误', basePlan.inputErrors.length === 0, JSON.stringify(basePlan.inputErrors))
check(
  '基线布局：q1=.128/25、q2=.64/26、q3=.32/28',
  JSON.stringify(basePlan.segments.filter((s) => s.kind !== 'free').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.32/28', '10.0.0.64/26', '10.0.0.128/25']),
  JSON.stringify(basePlan.segments.map((s) => s.cidr)),
)
const baseline = buildBaseline(basePlan)
check(
  '基线包含全部 3 个已分配需求',
  baseline.entries.length === 3 && baseline.entries.every((e) => e.state === 'allocated'),
)

// 13a) 相同输入 -> 全部未变、净变化 0
const same = compareWithBaseline(baseline, plan(baseInput))
check('相同规划全部未变', same.counts.unchanged === 3 && same.hasChanges === false)
check('相同规划净变化为 0', same.summary.net === 0)
check(
  '相同规划仍占用=基线占用，新占用/释放为 0',
  same.summary.occupiedCount === 0 &&
    same.summary.releasedCount === 0 &&
    same.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13b) 纯新增：简单基线 q1(100)=0/25、q2(40)=128/26，再加 q4(2 台)
//  q1/q2 位置不变，q4 落到最低空闲 .192/30 -> 新占用 4、释放 0、净 +4
const simpleBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    ],
  }),
)
const addPlan = plan({
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
  ],
})
const dAdd = compareWithBaseline(simpleBase, addPlan)
check('纯新增：added=1、unchanged=2', dAdd.counts.added === 1 && dAdd.counts.unchanged === 2)
check('新增段 q4 在 192/30', dAdd.rows.find((r) => r.id === 'q4')?.current?.cidr === '10.0.0.192/30')
check(
  '纯新增：新占用 4、释放 0、仍占用 192、净 +4，且无重复计数',
  dAdd.summary.occupiedCount === 4 &&
    dAdd.summary.releasedCount === 0 &&
    dAdd.summary.stillCount === 192 &&
    dAdd.summary.net === 4 &&
    dAdd.summary.occupiedCount + dAdd.summary.stillCount === addPlan.summary.usedCapacity,
  JSON.stringify({
    occ: dAdd.summary.occupiedCount,
    rel: dAdd.summary.releasedCount,
    still: dAdd.summary.stillCount,
  }),
)

// 13b2) 纯删除：去掉 q2 -> q1 未变，q2 删除，释放 .128–.191 共 64
const dRm = compareWithBaseline(
  simpleBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '办公', hosts: 100, cidr: '' }],
  }),
)
check(
  '纯删除：removed=1、unchanged=1，释放 64、新占用 0、净 −64',
  dRm.counts.removed === 1 &&
    dRm.rows.find((r) => r.id === 'q2')?.type === 'removed' &&
    dRm.rows.find((r) => r.id === 'q1')?.type === 'unchanged' &&
    dRm.summary.releasedCount === 64 &&
    dRm.summary.occupiedCount === 0 &&
    dRm.summary.net === -64,
  JSON.stringify({
    rel: dRm.summary.releasedCount,
    occ: dRm.summary.occupiedCount,
  }),
)

// 13b3) 删除固定段 q3 并新增 q4：固定段在 32/28，删除后空闲地址上移，q1/q2 重排（迁移）
const reshuffle = compareWithBaseline(
  baseline,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q2', name: '机房', hosts: 40, cidr: '' },
      { id: 'q4', name: '新增段', hosts: 2, cidr: '' },
    ],
  }),
)
check(
  '删固定段引发重排：q3 删除、q4 新增、q1/q2 迁移',
  reshuffle.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    reshuffle.rows.find((r) => r.id === 'q4')?.type === 'added' &&
    reshuffle.rows.find((r) => r.id === 'q1')?.type === 'migrated' &&
    reshuffle.rows.find((r) => r.id === 'q2')?.type === 'migrated',
  JSON.stringify(reshuffle.rows.map((r) => [r.id, r.type])),
)

// 13c) q1 缩容（100→60 台，/25→/26）后与 q2 互换位置：CIDR 改变=迁移，且标记缩容
const shrunk: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [],
  requirements: [
    { id: 'q1', name: '办公', hosts: 60, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '固定段', hosts: 10, cidr: '10.0.0.32/28' },
  ],
}
const ds = compareWithBaseline(baseline, plan(shrunk))
const q1s = ds.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 缩容（128/25 -> 64/26）',
  q1s?.type === 'migrated' &&
    q1s.resize === 'shrink' &&
    q1s.baseline?.cidr === '10.0.0.128/25' &&
    q1s.current?.cidr === '10.0.0.64/26',
  JSON.stringify(q1s),
)
const q2s = ds.rows.find((r) => r.id === 'q2')
check('q2 也迁移（64/26 -> 128/26，容量不变不标扩缩容）', q2s?.type === 'migrated' && q2s.resize === undefined)
check('q3 固定段未变', ds.rows.find((r) => r.id === 'q3')?.type === 'unchanged')

// 13d) q1 扩容（100→200 台，/25→/24）：CIDR 改变=迁移且标记扩容
const growBase = buildBaseline(
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
const dg = compareWithBaseline(
  growBase,
  plan({
    parentCidr: '10.0.0.0/24',
    reservations: [],
    requirements: [{ id: 'q1', name: '大需求', hosts: 200, cidr: '' }],
  }),
)
const q1g = dg.rows.find((r) => r.id === 'q1')
check(
  'q1 迁移 + 扩容（0/25 -> 0/24，128->256）',
  q1g?.type === 'migrated' &&
    q1g.resize === 'grow' &&
    q1g.baseline?.cidr === '10.0.0.0/25' &&
    q1g.current?.cidr === '10.0.0.0/24',
  JSON.stringify(q1g),
)
check('扩容净变化 +128（新占用 .128–.255，无释放）', dg.summary.net === 128 && dg.summary.releasedCount === 0)

// 13e) 碎片化保留区：q1(/25) 无处可放，q2(/26) 迁到 .128，q3 被删除
//  保留 .0/26 + .64/27 堵死低端对齐点，保留 .192/26 切碎原 q1 空间（三段互不重叠）
const squeezed: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [
    { id: 'r1', name: '保留A', cidr: '10.0.0.0/26' },
    { id: 'r2', name: '保留B', cidr: '10.0.0.64/27' },
    { id: 'r3', name: '保留C', cidr: '10.0.0.192/26' },
  ],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
  ],
}
check('挤压场景无输入错误（q1 预期失败）', plan(squeezed).inputErrors.length === 0)
const dq = compareWithBaseline(baseline, plan(squeezed))
check(
  '碎片化：q1 未分配、q2 迁移到 .128/26、q3 删除，且释放地址非 0',
  dq.rows.find((r) => r.id === 'q2')?.type === 'migrated' &&
    dq.rows.find((r) => r.id === 'q2')?.current?.cidr === '10.0.0.128/26' &&
    dq.rows.find((r) => r.id === 'q1')?.type === 'unallocated' &&
    dq.rows.find((r) => r.id === 'q3')?.type === 'removed' &&
    dq.summary.releasedCount > 0,
  JSON.stringify(dq.rows.map((r) => [r.id, r.type, r.current?.cidr])),
)
// 地址守恒（同父网段）：净变化 = 当前占用 - 基线占用（含保留区变化）
check(
  '挤压场景地址守恒',
  dq.summary.occupiedCount + dq.summary.stillCount === plan(squeezed).summary.usedCapacity &&
    dq.summary.releasedCount + dq.summary.stillCount === basePlan.summary.usedCapacity,
)

// 13f) 未分配与恢复分配
const tight: PlannerInput = {
  parentCidr: '192.168.10.0/28',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
  requirements: [
    { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
    { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
  ],
}
const tightPlan = plan(tight)
check('拥挤场景 q1 失败、q9 成功', tightPlan.failures.some((f) => f.id === 'q1') && tightPlan.failures.length === 1)
const tightBaseline = buildBaseline(tightPlan)
check('基线可包含失败需求（未分配）', tightBaseline.entries.find((e) => e.id === 'q1')?.state === 'unallocated')
const dRec = compareWithBaseline(
  tightBaseline,
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [
      { id: 'q1', name: '大需求', hosts: 100, cidr: '' },
      { id: 'q9', name: '小需求', hosts: 2, cidr: '' },
    ],
  }),
)
check('未分配 -> 已分配 标记为恢复分配', dRec.rows.find((r) => r.id === 'q1')?.type === 'recovered')
const dFail = compareWithBaseline(
  buildBaseline(
    plan({
      parentCidr: '192.168.10.0/24',
      reservations: [],
      requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
    }),
  ),
  plan({
    parentCidr: '192.168.10.0/28',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/29' }],
    requirements: [{ id: 'q1', name: '大需求', hosts: 100, cidr: '' }],
  }),
)
check('已分配 -> 失败 标记为未分配', dFail.rows.find((r) => r.id === 'q1')?.type === 'unallocated')

// 13g) 区间工具：重叠/相邻合并，重叠部分不重复计数
const mr = mergeRanges([
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.0.0.9') },
  { start: ipToInt('10.0.0.5'), end: ipToInt('10.0.0.20') },
  { start: ipToInt('10.0.0.21'), end: ipToInt('10.0.0.30') },
])
check(
  '区间合并去重（相交+相邻）',
  mr.length === 1 && mr[0].start === ipToInt('10.0.0.0') && mr[0].end === ipToInt('10.0.0.30'),
  JSON.stringify(mr),
)

// 14) 路由汇总：空选择
check('空选择汇总为空', summarizeSegments([]).blocks.length === 0)

// 14a) 单选即自身（固定段），地址数守恒
const sumInput: PlannerInput = {
  parentCidr: '10.0.0.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q2', name: '机房', hosts: 40, cidr: '' },
    { id: 'q3', name: '监控固定', hosts: 25, cidr: '10.0.0.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const sumPlan = plan(sumInput)
check('汇总场景无错误', sumPlan.inputErrors.length === 0, JSON.stringify(sumPlan.inputErrors))
const byId = new Map<string, Segment>()
for (const s of sumPlan.segments) if (s.ownerId) byId.set(s.ownerId, s)

const one = summarizeSegments([byId.get('q3')!])
check(
  '单选固定段返回自身',
  one.blocks.length === 1 && one.blocks[0].cidr === '10.0.0.32/27' && !one.blocks[0].aggregated,
  JSON.stringify(one.blocks),
)
check('单选地址数 32 且来源正确', one.blocks[0].capacity === 32 && one.blocks[0].sources[0].id === 'q3')

// 14b) 四个连续 /30（16/20/24/28）全选 -> 10.0.0.16/28（仅同上级网段才聚合）
const chainInput: PlannerInput = {
  parentCidr: '10.0.0.0/27',
  reservations: [{ id: 'r', name: '保留', cidr: '10.0.0.0/28' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
    { id: 'd', name: 'D', hosts: 2, cidr: '' },
  ],
}
const chainPlan = plan(chainInput)
check(
  '四个连续 /30 落在 16/20/24/28',
  JSON.stringify(chainPlan.segments.filter((s) => s.kind === 'auto').map((s) => s.cidr)) ===
    JSON.stringify(['10.0.0.16/30', '10.0.0.20/30', '10.0.0.24/30', '10.0.0.28/30']),
  JSON.stringify(chainPlan.segments.map((s) => s.cidr)),
)
const allChain = summarizeSegments(chainPlan.segments.filter((s) => s.kind === 'auto'))
check(
  '四个连续 /30 聚合为 16/28',
  allChain.blocks.length === 1 && allChain.blocks[0].cidr === '10.0.0.16/28' && allChain.blocks[0].aggregated,
  JSON.stringify(allChain.blocks),
)
check(
  '聚合块列出全部 4 个原需求且地址数守恒（16）',
  allChain.blocks[0].sources.map((x) => x.id).join(',') === 'a,b,c,d' &&
    allChain.totalAddresses === 16 &&
    allChain.blocks[0].sources.reduce((n, s) => n + s.capacity, 0) === 16,
)

// 14c) 跳过中间未选：选 16/30 + 24/30（中间 20 空闲于选择外），不得聚合
const gapped = summarizeSegments(
  chainPlan.segments.filter((s) => s.kind === 'auto' && (s.cidr === '10.0.0.16/30' || s.cidr === '10.0.0.24/30')),
)
check(
  '不相邻选择保持两个 /30（不吞入中间未选地址）',
  gapped.blocks.length === 2 && gapped.blocks.every((b) => b.prefix === 30) && gapped.totalAddresses === 8,
  JSON.stringify(gapped.blocks.map((b) => b.cidr)),
)

// 14d) 不相邻（/30 与 /26 间有空闲）保持两项，不吞入空闲地址
const mixed = summarizeSegments([byId.get('q4')!, byId.get('q2')!])
check(
  '中间隔着空闲的两段不聚合（/30 + /26 保持两项）',
  mixed.blocks.length === 2 &&
    JSON.stringify(mixed.blocks.map((b) => b.cidr)) === JSON.stringify(['10.0.0.16/30', '10.0.0.64/26']),
  JSON.stringify(mixed.blocks.map((b) => b.cidr)),
)

// 14e) 同前缀连续但分属不同上级：4/30 与 8/30 的上级 /29 分别是 0/29、8/29 -> 不聚合（固定段）
const sibInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [],
  requirements: [
    { id: 'x', name: 'X', hosts: 2, cidr: '10.0.0.4/30' },
    { id: 'y', name: 'Y', hosts: 2, cidr: '10.0.0.8/30' },
  ],
}
const sibPlan = plan(sibInput)
check('跨上级 /30 固定段无错误', sibPlan.inputErrors.length === 0, JSON.stringify(sibPlan.inputErrors))
const sib = summarizeSegments(sibPlan.segments.filter((s) => s.kind === 'fixed'))
check(
  '跨上级兄弟 /30 不聚合（4/30 + 8/30）',
  sib.blocks.length === 2 && sib.blocks.map((b) => b.cidr).join(',') === '10.0.0.4/30,10.0.0.8/30',
  JSON.stringify(sib.blocks.map((b) => b.cidr)),
)

// 14e2) 对照组：同一上级内的 0/30 + 4/30 必须聚合为 0/29
const sameParentInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [],
  requirements: [
    { id: 'x', name: 'X', hosts: 2, cidr: '10.0.0.0/30' },
    { id: 'y', name: 'Y', hosts: 2, cidr: '10.0.0.4/30' },
  ],
}
const sameParent = summarizeSegments(plan(sameParentInput).segments.filter((s) => s.kind === 'fixed'))
check(
  '同上级兄弟 /30 聚合为 0/29',
  sameParent.blocks.length === 1 && sameParent.blocks[0].cidr === '10.0.0.0/29' && sameParent.blocks[0].aggregated,
  JSON.stringify(sameParent.blocks.map((b) => b.cidr)),
)

// 14f) 三个连续 /30（0/4/8）-> 0/29 + 8/30：最小块数的对齐拆分
const threeInput: PlannerInput = {
  parentCidr: '10.0.0.0/28',
  reservations: [{ id: 'r', name: '保留', cidr: '10.0.0.12/30' }],
  requirements: [
    { id: 'a', name: 'A', hosts: 2, cidr: '' },
    { id: 'b', name: 'B', hosts: 2, cidr: '' },
    { id: 'c', name: 'C', hosts: 2, cidr: '' },
  ],
}
const threePlan = plan(threeInput)
const three = summarizeSegments(threePlan.segments.filter((s) => s.kind === 'auto'))
check(
  '三个连续 /30 拆为 0/29 + 8/30（地址对齐边界）',
  three.blocks.length === 2 &&
    three.blocks[0].cidr === '10.0.0.0/29' &&
    three.blocks[1].cidr === '10.0.0.8/30' &&
    three.totalAddresses === 12,
  JSON.stringify(three.blocks.map((b) => [b.cidr, b.capacity])),
)
check(
  '0/29 仅覆盖前两段，8/30 覆盖第三段（来源不串行）',
  three.blocks[0].sources.map((s) => s.id).join(',') === 'a,b' &&
    three.blocks[0].aggregated &&
    three.blocks[1].sources.map((s) => s.id).join(',') === 'c',
  JSON.stringify(three.blocks.map((b) => b.sources.map((s) => s.id))),
)
check('不得纳入保留区 12/30', !blocksToCidrList(three.blocks).includes('10.0.0.12/30'))

// 14g) 复制文本：按网络地址升序、每行一个纯 CIDR
const partial = summarizeSegments([byId.get('q1')!, byId.get('q4')!, byId.get('q3')!])
check(
  'CIDR 列表按网络地址升序',
  blocksToCidrList(partial.blocks) === '10.0.0.16/30\n10.0.0.32/27\n10.0.0.128/25',
  blocksToCidrList(partial.blocks),
)

// 14h) 覆盖精确性：任意勾选并集大小 = 结果块容量之和（不重不漏，不含保留/空闲）
for (let mask = 1; mask < 16; mask++) {
  const ids = ['q1', 'q2', 'q3', 'q4']
  const picked = ids.filter((_, i) => mask & (1 << i)).map((id) => byId.get(id)!)
  const res = summarizeSegments(picked)
  const expect = picked.reduce((n, s) => n + s.capacity, 0)
  check(
    `覆盖守恒 mask=${mask}`,
    res.totalAddresses === expect &&
      res.blocks.reduce((n, b) => n + b.capacity, 0) === expect &&
      res.blocks.every((b) => b.sources.length >= 1),
    `mask=${mask} got ${res.totalAddresses} expect ${expect}`,
  )
  // 每个汇总块不得与保留区 0/28 或空闲地址相交：块内每个地址都必须属于某个被选段
  const occupied = picked
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start)
  for (const b of res.blocks) {
    // 用来源并集精确比对块边界
    const own = b.sources
      .map((s) => ({ start: s.start, end: s.end }))
      .sort((a, b2) => a.start - b2.start)
    let cur = own[0].start
    for (const o of own) {
      if (o.start > cur) break
      cur = Math.max(cur, o.end + 1)
    }
    check(
      `精确覆盖 mask=${mask} block=${b.cidr}`,
      own[0].start === b.network && cur - 1 === b.network + b.capacity - 1,
      `block ${b.cidr} 与来源不匹配`,
    )
  }
}

// 14i) 全选示例（固定+自动）不越界包含保留区 0/28，块数最少
const full = summarizeSegments(sumPlan.segments.filter((s) => s.kind === 'fixed' || s.kind === 'auto'))
check(
  '全选示例不包含保留区，且结果不含 0/28',
  !full.blocks.some((b) => b.network === ipToInt('10.0.0.0') && b.prefix === 28),
  JSON.stringify(full.blocks.map((b) => b.cidr)),
)
check(
  '全选示例覆盖 = 100/25+40/26+32/27+4/30 = 228',
  full.totalAddresses === 228,
  String(full.totalAddresses),
)

// 15) 主机地址分配
const hostInput: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q3', name: '监控固定', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '' },
  ],
}
const hp = plan(hostInput)
check('主机场景无错误', hp.inputErrors.length === 0, JSON.stringify(hp.inputErrors))
const owners = hostOwnersOfPlan(hp)
const ownerById = new Map(owners.map((o) => [o.ownerId, o]))
check('可登记网段仅含固定/自动（3 个，保留区不可登记）', owners.length === 3, String(owners.length))
const q4 = ownerById.get('q4')!
check('管理 /30 可用范围 .17~.18', q4.firstUsable === ipToInt('192.168.10.17') && q4.lastUsable === ipToInt('192.168.10.18'))
const q3o = ownerById.get('q3')!

// 15a) 自动取首个未占用
let hosts: HostAssignment[] = []
const a1 = addHostAssignment(hosts, { owner: q4, deviceName: '网关', mode: 'auto', now: () => 't1' })
check('自动添加成功并取首个可用 .17', a1.ok && a1.assignment?.address === ipToInt('192.168.10.17'), String(a1))
if (a1.assignment) hosts.push(a1.assignment)
const a2 = addHostAssignment(hosts, { owner: q4, deviceName: '备机', mode: 'auto', now: () => 't2' })
check('第二次自动取 .18', a2.ok && a2.assignment?.address === ipToInt('192.168.10.18'))
if (a2.assignment) hosts.push(a2.assignment)
const used4 = new Set(hosts.filter((h) => h.ownerId === 'q4').map((h) => h.address))
check('占满后无空闲地址', firstFreeAddress(q4, used4) === null)
const a3 = addHostAssignment(hosts, { owner: q4, deviceName: '第三台', mode: 'auto' })
check('占满后自动添加被拒（full）', !a3.ok && a3.error?.code === 'full', String(a3.error))

// 15b) 手动输入校验：非法 IPv4 / 网络地址 / 广播地址 / 越界 / 重复
const badIp = addHostAssignment(hosts, { owner: q3o, deviceName: 'd', mode: 'manual', manualIp: '999.1.1.1' })
check('非法 IPv4 被拒', !badIp.ok && badIp.error?.code === 'invalid-ip')
const net = addHostAssignment(hosts, { owner: q3o, deviceName: 'd', mode: 'manual', manualIp: '192.168.10.32' })
check('网络地址被拒', !net.ok && net.error?.code === 'network-or-broadcast', String(net.error))
const bcast = addHostAssignment(hosts, { owner: q3o, deviceName: 'd', mode: 'manual', manualIp: '192.168.10.63' })
check('广播地址被拒', !bcast.ok && bcast.error?.code === 'network-or-broadcast')
const outsideSeg = addHostAssignment(hosts, { owner: q3o, deviceName: 'd', mode: 'manual', manualIp: '192.168.10.17' })
check('不在所属网段被拒', !outsideSeg.ok && outsideSeg.error?.code === 'out-of-subnet', String(outsideSeg.error))
const dup = addHostAssignment(hosts, { owner: q4, deviceName: 'd', mode: 'manual', manualIp: '192.168.10.17' })
check('重复地址被拒', !dup.ok && dup.error?.code === 'duplicate')
const noName = addHostAssignment(hosts, { owner: q3o, deviceName: '  ', mode: 'auto' })
check('空设备名被拒', !noName.ok && noName.error?.code === 'empty-name')
const okManual = addHostAssignment(hosts, { owner: q3o, deviceName: '服务器', mode: 'manual', manualIp: '192.168.10.40' })
check('合法手动地址通过', okManual.ok && okManual.assignment?.address === ipToInt('192.168.10.40'))
if (okManual.assignment) hosts.push(okManual.assignment)
// 网络/广播地址绝不会被自动选中：在 /30 中只剩 0 个可用时直接 full，不会退回 .16/.19
check('自动模式绝不分配网络/广播地址', used4.has(ipToInt('192.168.10.16')) === false && used4.has(ipToInt('192.168.10.19')) === false)

// 15c) 剩余可用数
const rec1 = reconcileHosts(hosts, hp)
const q4view = rec1.ownerById.get('q4')!
check('/30 剩余 0、已用 2', q4view.remaining === 0 && q4view.used === 2, String([q4view.remaining, q4view.used]))
const q3view = rec1.ownerById.get('q3')!
check('/27 剩余 29（30 可用 - 1 登记）', q3view.remaining === 29 && q3view.used === 1, String(q3view.remaining))
check('全部登记当前有效', rec1.invalidHosts.length === 0 && rec1.validHosts.length === hosts.length)

// 15d) 重新规划：未变化 -> 全部稳定保留
const recSame = reconcileHosts(hosts, plan(hostInput))
check('规划未变：登记全部保留', recSame.invalidHosts.length === 0 && recSame.validHosts.length === hosts.length)

// 15e) 网段迁移导致地址失效：把 q4 改为固定网段 192.168.10.20/30（原自动段在 .16/30），
//  成功分配但 CIDR 改变 -> 原 .17/.18 越界失效；q1 自动 /25 落到 .128；q3 固定段不动 -> 其登记保留
const movedInput: PlannerInput = {
  parentCidr: '192.168.10.0/24',
  reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
  requirements: [
    { id: 'q1', name: '办公', hosts: 100, cidr: '' },
    { id: 'q3', name: '监控固定', hosts: 25, cidr: '192.168.10.32/27' },
    { id: 'q4', name: '管理', hosts: 2, cidr: '192.168.10.20/30' },
  ],
}
const movedPlan = plan(movedInput)
check('迁移场景无错误', movedPlan.inputErrors.length === 0, JSON.stringify(movedPlan.inputErrors))
check('q4 成功迁移到 192.168.10.20/30', movedPlan.segments.some((s) => s.ownerId === 'q4' && s.cidr === '192.168.10.20/30'))
const recMoved = reconcileHosts(hosts, movedPlan)
const movedQ4 = recMoved.invalidHosts.filter((h) => h.ownerId === 'q4')
check(
  '迁移后 q4 的 2 条登记标记 owner-moved 且地址原样保留',
  movedQ4.length === 2 &&
    movedQ4.every((h) => h.issues.includes('owner-moved')) &&
    movedQ4.some((h) => h.address === ipToInt('192.168.10.17')) &&
    movedQ4.some((h) => h.address === ipToInt('192.168.10.18')),
  JSON.stringify(movedQ4.map((h) => [h.address, h.issues])),
)
check('失效说明包含新旧网段且不静默改址', /192\.168\.10\.16\/30/.test(hostIssueText(movedQ4[0])) && /192\.168\.10\.20\/30/.test(hostIssueText(movedQ4[0])))
const keptQ3 = recMoved.validHosts.filter((h) => h.ownerId === 'q3')
check('固定段 q3 未动：其登记继续有效', keptQ3.length === 1 && keptQ3[0].address === ipToInt('192.168.10.40'))
check('剩余可用数只统计有效登记（失效不计占用，新 /30 剩余 2）', recMoved.ownerById.get('q4')!.remaining === 2)

// 15f) 需求删除 -> owner-deleted；分配失败 -> owner-unallocated
const deletedRec = reconcileHosts(
  hosts,
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [{ id: 'r1', name: '保留', cidr: '192.168.10.0/28' }],
    requirements: [
      { id: 'q1', name: '办公', hosts: 100, cidr: '' },
      { id: 'q3', name: '监控固定', hosts: 25, cidr: '192.168.10.32/27' },
    ],
  }),
)
check(
  '删除 q4：其登记标 owner-deleted 且保留名称/地址',
  deletedRec.invalidHosts.some(
    (h) => h.ownerId === 'q4' && h.issues.includes('owner-deleted') && h.address === ipToInt('192.168.10.17'),
  ),
)
// 两个 /25 保留区堵死所有 /25 对齐点：q1(100 台) 分配失败，但无输入错误
const failPlan = plan({
  parentCidr: '192.168.10.0/24',
  reservations: [
    { id: 'r1', name: '保留A', cidr: '192.168.10.0/25' },
    { id: 'r2', name: '保留B', cidr: '192.168.10.128/25' },
  ],
  requirements: [{ id: 'q1', name: '办公', hosts: 100, cidr: '' }],
})
check('占满父网段场景仅有失败需求、无输入错误', failPlan.inputErrors.length === 0 && failPlan.failures.length === 1, JSON.stringify(failPlan.inputErrors))
// 取 q1 在先前成功规划中的登记（其 /25 位于 .128，登记 .200 为可用地址）
const q1owner = hostOwnersOfPlan(plan({ ...hostInput, requirements: [{ id: 'q1', name: '办公', hosts: 100, cidr: '' }] }))[0]
const hostOnFail: HostAssignment[] = [
  {
    id: 'h-fail',
    ownerId: 'q1',
    ownerName: '办公',
    ownerCidr: q1owner.cidr,
    deviceName: '旧主机',
    address: q1owner.firstUsable + 100,
    mode: 'manual',
    createdAt: 't0',
  },
]
const recFail = reconcileHosts(hostOnFail, failPlan, failPlan.failures)
check(
  '分配失败的需求登记标 owner-unallocated（不静默改址、不删除）',
  recFail.invalidHosts.length === 1 && recFail.invalidHosts[0].issues.includes('owner-unallocated') &&
    recFail.invalidHosts[0].address === hostOnFail[0].address,
  JSON.stringify(recFail.invalidHosts.map((h) => h.issues)),
)

// 15g) 主机分配完全不影响规划/汇总：同一输入两次规划结果一致，汇总忽略主机登记
const planAgain = plan(hostInput)
check(
  '主机登记不改变规划结果',
  JSON.stringify(planAgain.segments.map((s) => s.cidr)) === JSON.stringify(hp.segments.map((s) => s.cidr)),
)
check(
  '路由汇总不读取主机登记',
  summarizeSegments(planAgain.segments.filter((s) => s.kind === 'fixed' || s.kind === 'auto')).totalAddresses ===
    summarizeSegments(hp.segments.filter((s) => s.kind === 'fixed' || s.kind === 'auto')).totalAddresses,
)

// 15h) 原主机地址在新网段中恰好成为网络/广播地址也要判失效（不静默改址）
//  原固定段 0/30 主机 .1；改为固定段 0/31 不允许（最小 /30），故用 /24 内：原 .16/30 的主机 .17，
//  当需求改为保留该地址所在更大边界——直接构造对账数据：owner 为 16/29（.16–.23，可用 .17~.22）时 .17 合法；
//  以「新段网络地址 = 旧主机地址」校验：把 owner 伪造成 .17/32 不可行，改为验证可用范围排除规则已覆盖
//  firstUsable=network+1、lastUsable=broadcast-1，因此等于网络/广播的地址必然越界。
const edgeOwner = hostOwnersOfPlan(
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [{ id: 'q9', name: '段', hosts: 6, cidr: '192.168.10.16/29' }],
  }),
)[0]
const edgeRec = reconcileHosts(
  [
    {
      id: 'h-net',
      ownerId: 'q9',
      ownerName: '段',
      ownerCidr: '192.168.10.0/30', // 登记时在别的段（.16 是其广播地址）
      deviceName: '踩新网络地址',
      address: edgeOwner.network, // = .16，恰好是新段网络地址
      mode: 'manual',
      createdAt: 't',
    },
    {
      id: 'h-bcast',
      ownerId: 'q9',
      ownerName: '段',
      ownerCidr: '192.168.10.24/30',
      deviceName: '踩新广播地址',
      address: edgeOwner.broadcast, // = .23，恰好是新段广播地址
      mode: 'manual',
      createdAt: 't',
    },
  ],
  plan({
    parentCidr: '192.168.10.0/24',
    reservations: [],
    requirements: [{ id: 'q9', name: '段', hosts: 6, cidr: '192.168.10.16/29' }],
  }),
)
check(
  '原地址成为新网络/广播地址均判 owner-moved 失效',
  edgeRec.invalidHosts.length === 2 && edgeRec.invalidHosts.every((h) => h.issues.includes('owner-moved')),
  JSON.stringify(edgeRec.invalidHosts.map((h) => [h.address, h.issues])),
)

console.log(failures === 0 ? '\n全部测试通过 ✅' : `\n${failures} 个测试失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
