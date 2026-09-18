// 主机地址分配：为成功分配的固定 / 自动网段登记设备名称与具体主机 IPv4。
// 本模块只读取规划结果、维护独立的登记数据，不参与、不影响规划、基线、路由汇总与导出逻辑。
//
// 关键约束：
// - 主机地址只能是所属网段内、扣除网络地址与广播地址后的可用地址（最小网段 /30）；
// - 新增登记时拒绝非法 IPv4、越界地址（不在所属网段）、网络/广播地址与网段内重复地址；
// - 自动模式取该网段内第一个未占用可用地址；
// - 重新规划后按「需求稳定 ID + 登记时 CIDR」对账：仍合法的登记原样保留；
//   不合法的登记明确标记失效原因，绝不静默改址。

import { intToIp, ipToInt } from './ip'
import type { PlanResult, Segment } from './types'

/** 成功分配、带稳定 ownerId 的固定 / 自动网段（可登记主机的网段） */
export type HostOwnerSegment = Segment & { ownerId: string; kind: 'fixed' | 'auto' }

export type HostIssue =
  | 'owner-deleted' // 需求已从列表删除
  | 'owner-unallocated' // 需求仍在但当前规划分配失败
  | 'owner-moved' // 网段迁移/改前缀，登记地址已不在当前网段（含落在新网络/广播地址上）
  | 'duplicate' // 同网段内与其他登记地址重复（防御性标记，正常新增流程会拦截）

export interface HostAssignment {
  id: string
  /** 所属需求的稳定 ID（重规划后按此匹配） */
  ownerId: string
  /** 登记时所属网段的名称（需求删除后仍可展示） */
  ownerName: string
  /** 登记时所属网段 CIDR（如 192.168.10.16/30），用于判断迁移 */
  ownerCidr: string
  deviceName: string
  /** 登记地址（数值） */
  address: number
  /** 登记时使用的模式：自动取首个未占用，或手动输入 */
  mode: 'auto' | 'manual'
  createdAt: string
}

export interface HostOwner {
  ownerId: string
  name: string
  kind: 'fixed' | 'auto'
  cidr: string
  prefix: number
  network: number
  broadcast: number
  firstUsable: number
  lastUsable: number
  usable: number
}

/** 重新规划对账后的单条主机视图 */
export interface ReconciledHost extends HostAssignment {
  valid: boolean
  issues: HostIssue[]
  /** 当前所属网段（失效时可能为 undefined） */
  owner?: HostOwner
}

export interface HostOwnerView extends HostOwner {
  hosts: ReconciledHost[]
  /** 有效登记数 */
  used: number
  /** 剩余可用数 = 可用主机数 - 有效登记数 */
  remaining: number
}

export interface HostReconciliation {
  owners: HostOwnerView[]
  validHosts: ReconciledHost[]
  invalidHosts: ReconciledHost[]
  ownerById: Map<string, HostOwnerView>
}

export function isHostOwnerSegment(seg: Segment): seg is HostOwnerSegment {
  return (seg.kind === 'fixed' || seg.kind === 'auto') && !!seg.ownerId
}

/** 从规划结果提取可登记主机的网段（按地址升序，与网段明细一致） */
export function hostOwnersOfPlan(result: PlanResult): HostOwner[] {
  return result.segments.filter(isHostOwnerSegment).map((seg) => ({
    ownerId: seg.ownerId,
    name: seg.name,
    kind: seg.kind,
    cidr: seg.cidr,
    prefix: seg.prefix,
    network: seg.start,
    broadcast: seg.end,
    firstUsable: seg.start + 1,
    lastUsable: seg.end - 1,
    usable: seg.usable,
  }))
}

/** 当前网段内已登记地址（数值）集合 */
function usedAddressesOf(list: HostAssignment[], ownerId: string): Set<number> {
  const set = new Set<number>()
  for (const h of list) if (h.ownerId === ownerId) set.add(h.address)
  return set
}

/** 网段内第一个未占用可用地址；没有空位时返回 null（网络/广播地址天然不在可用范围内） */
export function firstFreeAddress(owner: HostOwner, used: Set<number>): number | null {
  for (let ip = owner.firstUsable; ip <= owner.lastUsable; ip++) {
    if (!used.has(ip)) return ip >>> 0
  }
  return null
}

export type AddHostErrorCode =
  | 'no-owner' // 当前规划中找不到该网段（已失效）
  | 'empty-name' // 设备名称为空
  | 'invalid-ip' // 不是合法 IPv4
  | 'network-or-broadcast' // 地址是网络地址或广播地址
  | 'out-of-subnet' // 不在所属网段的可用范围内
  | 'duplicate' // 与网段内已有登记重复
  | 'full' // 网段已无剩余可用地址

export interface AddHostInput {
  owner: HostOwner
  deviceName: string
  mode: 'auto' | 'manual'
  manualIp?: string
  /** 注入时间戳，便于测试 */
  now?: () => string
}
export interface AddHostResult {
  ok: boolean
  assignment?: HostAssignment
  address?: number
  error?: { code: AddHostErrorCode; message: string }
}

/**
 * 校验并构造一条主机登记。纯函数：不修改入参数组。
 * 自动模式取首个未占用可用地址；手动模式严格校验 IPv4、网络/广播、所属网段与重复占用。
 */
export function addHostAssignment(list: HostAssignment[], input: AddHostInput): AddHostResult {
  const { owner } = input
  const deviceName = input.deviceName.trim()
  if (deviceName === '') {
    return { ok: false, error: { code: 'empty-name', message: '请填写设备名称' } }
  }

  const used = usedAddressesOf(list, owner.ownerId)
  let address: number
  if (input.mode === 'auto') {
    const free = firstFreeAddress(owner, used)
    if (free === null) {
      return {
        ok: false,
        error: {
          code: 'full',
          message: `网段 ${owner.cidr} 已无剩余可用地址（${owner.usable} 个可用主机位全部占用）`,
        },
      }
    }
    address = free
  } else {
    const raw = (input.manualIp ?? '').trim()
    const parsed = ipToInt(raw)
    if (Number.isNaN(parsed)) {
      return { ok: false, error: { code: 'invalid-ip', message: `“${raw}”不是合法的 IPv4 地址` } }
    }
    // 网络地址 / 广播地址必须跳过（/30 等小区段同样适用）
    if (parsed === owner.network || parsed === owner.broadcast) {
      return {
        ok: false,
        error: {
          code: 'network-or-broadcast',
          message: `${intToIp(parsed)} 是 ${owner.cidr} 的${
            parsed === owner.network ? '网络地址' : '广播地址'
          }，不可分配给主机`,
        },
      }
    }
    if (parsed < owner.firstUsable || parsed > owner.lastUsable) {
      return {
        ok: false,
        error: {
          code: 'out-of-subnet',
          message: `${intToIp(parsed)} 不在网段 ${owner.cidr} 的可用范围 ${intToIp(
            owner.firstUsable,
          )} ~ ${intToIp(owner.lastUsable)} 内`,
        },
      }
    }
    if (used.has(parsed)) {
      return {
        ok: false,
        error: {
          code: 'duplicate',
          message: `${intToIp(parsed)} 已在网段 ${owner.cidr} 中登记`,
        },
      }
    }
    address = parsed
  }

  const assignment: HostAssignment = {
    id: `host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: owner.ownerId,
    ownerName: owner.name,
    ownerCidr: owner.cidr,
    deviceName,
    address: address >>> 0,
    mode: input.mode,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  }
  return { ok: true, assignment, address }
}

/** 把一条已有登记显式重新分配到其当前网段的首个空闲地址（仅用户主动触发，绝不自动静默改址） */
export function reassignHost(
  list: HostAssignment[],
  hostId: string,
  owner: HostOwner,
): AddHostResult {
  const old = list.find((h) => h.id === hostId)
  if (!old) return { ok: false, error: { code: 'no-owner', message: '登记不存在' } }
  const others = list.filter((h) => h.id !== hostId)
  return addHostAssignment(others, {
    owner,
    deviceName: old.deviceName,
    mode: 'auto',
  })
}

/** 失效原因转中文说明 */
export function hostIssueText(host: ReconciledHost): string {
  if (!host.issues.length) return ''
  const parts: string[] = []
  if (host.issues.includes('owner-deleted')) {
    parts.push(`所属需求已删除（登记时网段 ${host.ownerCidr}）`)
  }
  if (host.issues.includes('owner-unallocated')) {
    parts.push(`所属需求当前分配失败（登记时网段 ${host.ownerCidr}）`)
  }
  if (host.issues.includes('owner-moved')) {
    parts.push(
      `网段已由 ${host.ownerCidr} 迁移为 ${host.owner?.cidr ?? '—'}，登记地址 ${intToIp(
        host.address,
      )} 不再合法（可能落在新网段之外或成为新网络/广播地址）`,
    )
  }
  if (host.issues.includes('duplicate')) {
    parts.push('与同网段其他登记地址重复')
  }
  return parts.join('；')
}

/**
 * 重新规划后对账：按需求稳定 ID 匹配当前成功分配的网段。
 * - 需求删除 / 分配失败 / 网段迁移导致地址失效：明确标记，不改动地址；
 * - 地址仍落在当前网段可用范围内：原样保留为有效；
 * - 剩余可用数只统计有效登记。
 */
export function reconcileHosts(
  list: HostAssignment[],
  result: PlanResult,
  failures: { id: string }[] = result.failures,
): HostReconciliation {
  const owners = hostOwnersOfPlan(result)
  const ownerMap = new Map(owners.map((o) => [o.ownerId, o]))
  const failedIds = new Set(failures.map((f) => f.id))

  // 网段内当前地址出现次数（正常新增流程已拦截重复，这里再做防御性校验）
  const countsByOwner = new Map<string, Map<number, number>>()
  for (const h of list) {
    if (!ownerMap.has(h.ownerId)) continue
    const m = countsByOwner.get(h.ownerId) ?? new Map<number, number>()
    m.set(h.address, (m.get(h.address) ?? 0) + 1)
    countsByOwner.set(h.ownerId, m)
  }

  const all: ReconciledHost[] = list.map((h) => {
    const owner = ownerMap.get(h.ownerId)
    const issues: HostIssue[] = []
    if (!owner) {
      issues.push(failedIds.has(h.ownerId) ? 'owner-unallocated' : 'owner-deleted')
    } else {
      const inRange = h.address >= owner.firstUsable && h.address <= owner.lastUsable
      if (owner.cidr !== h.ownerCidr || !inRange) {
        issues.push('owner-moved')
      }
      if ((countsByOwner.get(h.ownerId)?.get(h.address) ?? 0) > 1) {
        issues.push('duplicate')
      }
    }
    return { ...h, valid: issues.length === 0, issues, owner }
  })

  const validHosts = all.filter((h) => h.valid)
  const invalidHosts = all.filter((h) => !h.valid)

  const ownerById = new Map<string, HostOwnerView>()
  for (const o of owners) {
    const hosts = all
      .filter((h) => h.ownerId === o.ownerId)
      .sort((a, b) => a.address - b.address)
    const used = hosts.filter((h) => h.valid).length
    ownerById.set(o.ownerId, {
      ...o,
      hosts,
      used,
      remaining: Math.max(0, o.usable - used),
    })
  }

  return {
    owners: [...ownerById.values()].sort((a, b) => a.network - b.network),
    validHosts,
    invalidHosts,
    ownerById,
  }
}

/** 格式化主机地址 */
export function formatHostAddress(address: number): string {
  return intToIp(address)
}
