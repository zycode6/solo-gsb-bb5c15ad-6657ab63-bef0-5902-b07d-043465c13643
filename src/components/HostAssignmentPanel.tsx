import { useMemo, useState } from 'react'
import {
  addHostAssignment,
  firstFreeAddress,
  formatHostAddress,
  hostIssueText,
  reconcileHosts,
  type HostAssignment,
  type HostOwnerView,
  type HostReconciliation,
  type ReconciledHost,
} from '../lib/hosts'
import { intToIp } from '../lib/ip'
import type { PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  onAssignmentsChange: (next: HostAssignment[]) => void
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

interface Draft {
  name: string
  mode: 'auto' | 'manual'
  ip: string
  error: string
}

const EMPTY_DRAFT: Draft = { name: '', mode: 'auto', ip: '', error: '' }

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** 迁移失效的登记在当前网段可显式改址到的首个空闲地址；不可改址（无当前网段/无空位）时返回 null */
function relocateTarget(host: ReconciledHost, rec: HostReconciliation): number | null {
  if (!host.issues.includes('owner-moved') || !host.owner) return null
  const view = rec.ownerById.get(host.owner.ownerId)
  if (!view) return null
  const used = new Set(
    view.hosts.filter((h) => h.valid && h.id !== host.id).map((h) => h.address),
  )
  return firstFreeAddress(host.owner, used)
}

function OwnerCard({
  owner,
  draft,
  onDraft,
  onAdd,
  onDelete,
}: {
  owner: HostOwnerView
  draft: Draft
  onDraft: (patch: Partial<Draft>) => void
  onAdd: () => void
  onDelete: (id: string) => void
}) {
  const full = owner.remaining === 0
  const usedSet = useMemo(
    () => new Set(owner.hosts.filter((h) => h.valid).map((h) => h.address)),
    [owner],
  )
  const preview = firstFreeAddress(owner, usedSet)

  return (
    <div className="host-owner">
      <div className="host-owner-head">
        <span className={`badge ${owner.kind}`}>{KIND_LABEL[owner.kind]}</span>
        <span className="host-owner-name">{owner.name}</span>
        <span className="mono host-owner-cidr">{owner.cidr}</span>
        <span className="host-owner-range mono">
          可用 {intToIp(owner.firstUsable)} ~ {intToIp(owner.lastUsable)}
        </span>
        <span className={`host-remaining${full ? ' is-zero' : ''}`}>
          剩余可用 <strong>{fmt(owner.remaining)}</strong> / {fmt(owner.usable)}
        </span>
      </div>

      <div className="host-add-row">
        <input
          type="text"
          className="host-name-input"
          placeholder="设备名称，如 网关 / web-01"
          value={draft.name}
          onChange={(e) => onDraft({ name: e.target.value, error: '' })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onAdd()
          }}
        />
        <label className="host-mode">
          <input
            type="radio"
            name={`mode-${owner.ownerId}`}
            checked={draft.mode === 'auto'}
            onChange={() => onDraft({ mode: 'auto', error: '' })}
          />
          自动（首个空闲{preview !== null ? `：${intToIp(preview)}` : '：无'}）
        </label>
        <label className="host-mode">
          <input
            type="radio"
            name={`mode-${owner.ownerId}`}
            checked={draft.mode === 'manual'}
            onChange={() => onDraft({ mode: 'manual', error: '' })}
          />
          手动
        </label>
        {draft.mode === 'manual' && (
          <input
            type="text"
            className="host-ip-input mono"
            placeholder="如 192.168.10.17"
            value={draft.ip}
            onChange={(e) => onDraft({ ip: e.target.value, error: '' })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAdd()
            }}
          />
        )}
        <button className="primary host-add-btn" onClick={onAdd} disabled={full && draft.mode === 'auto'}>
          添加
        </button>
      </div>
      {draft.error && <div className="host-error">✕ {draft.error}</div>}

      {owner.hosts.length > 0 ? (
        <ul className="host-list">
          {owner.hosts.map((h) => (
            <li key={h.id} className={h.valid ? '' : 'is-invalid'}>
              <span className="host-device">{h.deviceName}</span>
              <span className="mono host-addr">{formatHostAddress(h.address)}</span>
              <span className={`host-mode-badge ${h.mode}`}>
                {h.mode === 'auto' ? '自动' : '手动'}
              </span>
              {!h.valid && <span className="host-invalid-tag">已失效：{hostIssueText(h)}</span>}
              <button
                className="icon host-del"
                title="删除该登记"
                onClick={() => onDelete(h.id)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="host-empty-line">该网段尚未登记主机。</p>
      )}
    </div>
  )
}

export default function HostAssignmentPanel({ result, assignments, onAssignmentsChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const invalidInput = result.inputErrors.length > 0

  // 输入非法时不对账（避免把全部登记误判为失效），只暂停操作
  const reconciliation = useMemo(
    () => (invalidInput ? null : reconcileHosts(assignments, result)),
    [invalidInput, assignments, result],
  )

  function patchDraft(ownerId: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({
      ...prev,
      [ownerId]: { ...(prev[ownerId] ?? EMPTY_DRAFT), ...patch },
    }))
  }

  function add(owner: HostOwnerView) {
    const draft = drafts[owner.ownerId] ?? EMPTY_DRAFT
    const res = addHostAssignment(assignments, {
      owner,
      deviceName: draft.name,
      mode: draft.mode,
      manualIp: draft.ip,
    })
    if (!res.ok || !res.assignment) {
      patchDraft(owner.ownerId, { error: res.error?.message ?? '添加失败' })
      return
    }
    onAssignmentsChange([...assignments, res.assignment])
    setDrafts((prev) => ({ ...prev, [owner.ownerId]: { ...EMPTY_DRAFT, mode: draft.mode } }))
  }

  function remove(id: string) {
    onAssignmentsChange(assignments.filter((h) => h.id !== id))
  }

  function autoRelocate(id: string) {
    const host = reconciliation?.invalidHosts.find((h) => h.id === id)
    if (!host || !host.owner) return
    const target = relocateTarget(host, reconciliation!)
    if (target === null) return
    // 保留原登记 id 与时间，显式改址（仅用户点击触发，系统不自动静默改址）
    const { valid: _v, issues: _i, owner: _o, ...base } = host
    onAssignmentsChange([
      ...assignments.filter((h) => h.id !== id),
      {
        ...base,
        address: target,
        ownerName: host.owner.name,
        ownerCidr: host.owner.cidr,
        mode: 'auto',
      },
    ])
  }

  const totalRemaining = reconciliation
    ? reconciliation.owners.reduce((acc, o) => acc + o.remaining, 0)
    : 0
  const totalUsable = reconciliation ? reconciliation.owners.reduce((acc, o) => acc + o.usable, 0) : 0

  return (
    <div className={`panel host-panel${invalidInput ? ' is-disabled' : ''}`}>
      <h2>⑥ 主机地址分配</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        为<strong>成功分配</strong>的固定 / 自动网段登记设备名称与主机 IPv4：可
        <strong> 自动取该网段首个未占用可用地址</strong>，或手动输入。系统自动跳过网络地址与广播地址，
        拒绝不在所属网段、与已有登记重复或已被占用的地址。重新规划后，按需求稳定 ID 保留仍合法的登记；
        失效登记（网段迁移、需求删除或分配失败）会明确标记，<strong>绝不静默改址</strong>，需人工删除或显式改址。
      </p>

      {invalidInput && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），主机地址分配已暂停；现有 {assignments.length}
          条登记已保留，修正后自动重新校验。
        </div>
      )}

      {!invalidInput && reconciliation && (
        <>
          <div className="host-summary-line">
            共 <strong>{reconciliation.owners.length}</strong> 个可登记网段 · 已登记
            <strong> {reconciliation.validHosts.length}</strong> 台设备
            {reconciliation.invalidHosts.length > 0 && (
              <span className="host-invalid-count">
                · {reconciliation.invalidHosts.length} 条失效登记
              </span>
            )}
            · 全部网段剩余可用 <strong>{fmt(totalRemaining)}</strong> / {fmt(totalUsable)} 个主机位
          </div>

          {reconciliation.owners.length === 0 ? (
            <p className="summary-empty">当前没有成功分配的固定或自动网段，暂不可登记主机地址。</p>
          ) : (
            reconciliation.owners.map((owner) => (
              <OwnerCard
                key={owner.ownerId}
                owner={owner}
                draft={drafts[owner.ownerId] ?? EMPTY_DRAFT}
                onDraft={(patch) => patchDraft(owner.ownerId, patch)}
                onAdd={() => add(owner)}
                onDelete={remove}
              />
            ))
          )}

          {reconciliation.invalidHosts.length > 0 && (
            <div className="host-invalid-box">
              <h3 className="host-invalid-title">
                失效登记（{reconciliation.invalidHosts.length}）— 地址保持原样，等待人工处理
              </h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>设备名称</th>
                      <th>登记地址</th>
                      <th>登记时段网</th>
                      <th>失效原因</th>
                      <th style={{ textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.invalidHosts.map((h) => {
                      const target = relocateTarget(h, reconciliation)
                      return (
                        <tr key={h.id} className="host-invalid-row">
                          <td>{h.deviceName}</td>
                          <td className="mono">{formatHostAddress(h.address)}</td>
                          <td className="mono">
                            {h.ownerName}（{h.ownerCidr}）
                          </td>
                          <td className="host-invalid-reason">{hostIssueText(h)}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {target !== null && (
                              <button
                                className="host-relocate-btn"
                                title="改到当前网段的首个空闲地址（仅在你点击后执行）"
                                onClick={() => autoRelocate(h.id)}
                              >
                                显式改址到 {intToIp(target)}
                              </button>
                            )}
                            <button className="danger-btn host-remove-btn" onClick={() => remove(h.id)}>
                              删除登记
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {assignments.length === 0 && reconciliation.owners.length > 0 && (
            <p className="summary-empty">
              还没有主机登记。在上方任一网段填写设备名称，选择自动或手动地址后点击「添加」。
            </p>
          )}
        </>
      )}
    </div>
  )
}
