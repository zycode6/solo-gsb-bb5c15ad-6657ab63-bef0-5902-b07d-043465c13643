import { useMemo, useState } from 'react'
import { intToIp, ipToInt } from '../lib/ip'
import {
  allocatableSegments,
  firstFreeAddress,
  reconcileHosts,
  validateManualAddress,
  type AllocSegment,
  type HostInvalidReason,
} from '../lib/hosts'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  onAssignmentsChange: (next: HostAssignment[]) => void
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

let hostCounter = 0
function hostUid(): string {
  hostCounter += 1
  return `host-${Date.now()}-${hostCounter}`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

const INVALID_BADGE: Partial<Record<HostInvalidReason, string>> = {
  'out-of-subnet': '不在网段',
  'network-address': '网络地址',
  'broadcast-address': '广播地址',
  duplicate: '重复',
}

/** 单个网段的登记块（设备表 + 添加表单） */
function SegmentBlock({
  seg,
  assignments,
  rows,
  used,
  remaining,
  onChange,
}: {
  seg: AllocSegment
  assignments: HostAssignment[]
  rows: ReturnType<typeof reconcileHosts>['rows']
  used: number
  remaining: number
  onChange: (next: HostAssignment[]) => void
}) {
  const [name, setName] = useState('')
  const [addrInput, setAddrInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string; error: string | null } | null>(
    null,
  )

  function commit(next: HostAssignment[]) {
    setFormError(null)
    onChange(next)
  }

  function addManual() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setFormError('请先填写设备名称')
      return
    }
    const err = validateManualAddress(addrInput, seg, assignments)
    if (err) {
      setFormError(err)
      return
    }
    commit([
      ...assignments,
      {
        id: hostUid(),
        ownerId: seg.ownerId,
        name: trimmedName,
        address: ipToInt(addrInput.trim()),
        mode: 'manual',
      },
    ])
    setName('')
    setAddrInput('')
  }

  function addAuto() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setFormError('请先填写设备名称')
      return
    }
    const addr = firstFreeAddress(seg, assignments)
    if (addr === null) {
      setFormError('该网段已无剩余可用地址（网络地址与广播地址不可分配）')
      return
    }
    commit([
      ...assignments,
      { id: hostUid(), ownerId: seg.ownerId, name: trimmedName, address: addr, mode: 'auto' },
    ])
    setName('')
    setAddrInput('')
  }

  function remove(id: string) {
    setEditing(null)
    commit(assignments.filter((a) => a.id !== id))
  }

  function startEdit(row: (typeof rows)[number]) {
    setEditing({ id: row.assignment.id, value: intToIp(row.assignment.address), error: null })
  }

  function saveEdit() {
    if (!editing) return
    if (!assignments.some((a) => a.id === editing.id)) {
      setEditing(null)
      return
    }
    const err = validateManualAddress(editing.value, seg, assignments, editing.id)
    if (err) {
      setEditing({ ...editing, error: err })
      return
    }
    const newAddr = ipToInt(editing.value.trim())
    onChange(
      assignments.map((a) =>
        a.id === editing.id
          ? { ...a, address: newAddr, mode: newAddr === a.address ? a.mode : 'manual' }
          : a,
      ),
    )
    setEditing(null)
  }

  const full = remaining === 0

  return (
    <div className="host-segment">
      <div className="host-seg-head">
        <span className={`badge ${seg.kind}`}>{KIND_LABEL[seg.kind]}</span>
        <span className="host-seg-name">{seg.name}</span>
        <span className="mono host-seg-cidr">{seg.cidr}</span>
        <span className="host-seg-range mono">
          可用 {seg.firstUsable} ~ {seg.lastUsable}
        </span>
        <span className={`host-seg-remain${full ? ' is-zero' : ''}`}>
          剩余可用 <strong>{fmt(remaining)}</strong> / {fmt(seg.usable)}
          （已登记 {fmt(used)}）
        </span>
      </div>

      {rows.length > 0 && (
        <table className="host-table">
          <tbody>
            {rows.map((row) => {
              const isEditing = editing?.id === row.assignment.id
              return (
                <tr key={row.assignment.id} className={row.valid ? '' : 'host-invalid-row'}>
                  <td className="host-device-name">{row.assignment.name || '未命名设备'}</td>
                  <td className="mono host-addr">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editing.value}
                        autoFocus
                        onChange={(e) =>
                          setEditing({ ...editing, value: e.target.value, error: null })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit()
                          if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    ) : (
                      <span className={row.valid ? '' : 'host-addr-bad'}>
                        {intToIp(row.assignment.address)}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`host-mode ${row.assignment.mode}`}>
                      {row.assignment.mode === 'auto' ? '自动' : '手动'}
                    </span>
                  </td>
                  <td className="host-reason">
                    {!row.valid && row.reason && (
                      <span className="host-invalid-tag" title={row.reasonText}>
                        {INVALID_BADGE[row.reason] ?? '失效'} · {row.reasonText}
                      </span>
                    )}
                  </td>
                  <td className="host-actions">
                    {isEditing ? (
                      <>
                        <button className="primary" onClick={saveEdit}>
                          保存
                        </button>
                        <button onClick={() => setEditing(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(row)} title="手动修改该登记的 IPv4 地址">
                          改址
                        </button>
                        <button className="danger-btn" onClick={() => remove(row.assignment.id)}>
                          删除
                        </button>
                      </>
                    )}
                    {isEditing && editing.error && (
                      <div className="host-form-error">{editing.error}</div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="host-add-row">
        <input
          type="text"
          placeholder="设备名称，如 网关 / 核心交换机"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setFormError(null)
          }}
        />
        <input
          type="text"
          placeholder="手动输入 IPv4（留空可点右侧自动取址）"
          value={addrInput}
          onChange={(e) => {
            setAddrInput(e.target.value)
            setFormError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addManual()
          }}
        />
        <button onClick={addAuto} disabled={full} title="取本网段第一个未占用的可用地址并登记">
          ⤓ 自动取址
        </button>
        <button className="primary" onClick={addManual} disabled={full}>
          ＋ 添加
        </button>
      </div>
      {formError && <div className="host-form-error">{formError}</div>}
    </div>
  )
}

/** 失效且不再属于任何现存网段的登记（需求删除 / 分配失败），只可删除，绝不静默改址 */
function OrphanList({
  rows,
  onRemove,
}: {
  rows: ReturnType<typeof reconcileHosts>['rows']
  onRemove: (id: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className="host-orphans">
      <h3>失效登记（{rows.length}）— 地址保持原样，需手动删除或调整规划</h3>
      <table className="host-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.assignment.id} className="host-invalid-row">
              <td className="host-device-name">{row.assignment.name || '未命名设备'}</td>
              <td className="mono host-addr">
                <span className="host-addr-bad">{intToIp(row.assignment.address)}</span>
              </td>
              <td>
                <span className={`host-mode ${row.assignment.mode}`}>
                  {row.assignment.mode === 'auto' ? '自动' : '手动'}
                </span>
              </td>
              <td className="host-reason">
                <span className="host-invalid-tag">{row.reasonText}</span>
              </td>
              <td className="host-actions">
                <button className="danger-btn" onClick={() => onRemove(row.assignment.id)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function HostAddressPanel({ result, assignments, onAssignmentsChange }: Props) {
  const segments = useMemo(() => allocatableSegments(result), [result])
  const { rows, statsByOwner } = useMemo(
    () => reconcileHosts(assignments, result),
    [assignments, result],
  )

  const invalid = result.inputErrors.length > 0
  const disabled = invalid || segments.length === 0
  const validCount = rows.filter((r) => r.valid).length
  const invalidRows = rows.filter((r) => !r.valid)
  const orphans = invalidRows.filter(
    (r) => r.reason === 'owner-gone' || r.reason === 'owner-unallocated',
  )

  function remove(id: string) {
    onAssignmentsChange(assignments.filter((a) => a.id !== id))
  }

  function clearInvalid() {
    const invalidIds = new Set(invalidRows.map((r) => r.assignment.id))
    onAssignmentsChange(assignments.filter((a) => !invalidIds.has(a.id)))
  }

  return (
    <div className={`panel host-panel${disabled ? ' is-disabled' : ''}`}>
      <div className="header-row">
        <h2 style={{ marginBottom: 0 }}>⑥ 主机地址分配</h2>
        {!disabled && (
          <div className="host-summary-meta">
            登记 <strong>{rows.length}</strong> 台 · 有效 {validCount} 台
            {invalidRows.length > 0 && <span className="host-invalid-count"> · 失效 {invalidRows.length}</span>}
            {invalidRows.length > 0 && (
              <button className="danger-btn host-clear-invalid" onClick={clearInvalid}>
                清除全部失效登记
              </button>
            )}
          </div>
        )}
      </div>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        为<strong>成功分配</strong>的固定 / 自动网段登记设备地址：可「自动取址」（本网段第一个未占用可用地址），
        也可手动输入 IPv4。系统自动跳过网络地址与广播地址，拒绝越界、重复或已占用的地址；
        每个网段实时显示剩余可用数。重新规划后仍合法的登记按需求稳定 ID 保留，
        失效登记明确标记且<strong>不会被静默改址</strong>。
      </p>

      {invalid && (
        <div className="summary-disabled-note">输入非法（请先修正左侧错误），主机地址分配已暂停，登记不会丢失。</div>
      )}
      {!invalid && segments.length === 0 && (
        <div className="summary-disabled-note">当前没有成功分配的固定或自动网段，暂无可登记的网段。</div>
      )}

      {!disabled && (
        <>
          <OrphanList rows={orphans} onRemove={remove} />
          {segments.map((seg) => {
            const stats = statsByOwner.get(seg.ownerId)
            if (!stats) return null
            return (
              <SegmentBlock
                key={seg.ownerId}
                seg={seg}
                assignments={assignments}
                rows={stats.rows}
                used={stats.used}
                remaining={stats.remaining}
                onChange={onAssignmentsChange}
              />
            )
          })}
        </>
      )}
    </div>
  )
}
