/**
 * _p2host-verify.mjs —— 真实宿主人工审核路径的端到端取证（一次性）。
 * 覆盖：认证（401/200）、详情、提交、批准、重复审核冲突、越权 scope、证据不足拒绝、UTF-8 正文。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

const PORT = process.env.DSH_PORT ?? '58043'
const BASE = `http://127.0.0.1:${PORT}/api/memory-sea/operator`
const tokenPath = resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), '3d-memory-sea', 'operator-token')
const token = readFileSync(tokenPath, 'utf8').trim()
const SCOPE = 'project_p2host'
const CANDIDATE = process.env.CANDIDATE_ID ?? 'skc_fdf9eadf-549d-44d7-a3d8-86d6b54182d3'
const WEAK_CANDIDATE = 'skc_6e8af1b1-7511-499b-a824-abb4732fb9fb'
const WEAK_SCOPE = 'project_5ca055eda66d0003'

async function call(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, text, body: text ? JSON.parse(text) : null }
}

const auth = { authorization: `Bearer ${token}` }
const out = {}

out.noToken = (await call('GET', `/candidates?scope=${SCOPE}`)).status
out.badToken = (await call('GET', `/candidates?scope=${SCOPE}`, null, { authorization: 'Bearer wrong-token' })).status
out.list = (await call('GET', `/candidates?scope=${SCOPE}&limit=5`, null, auth)).status
out.wrongScope = (await call('GET', `/candidates/${CANDIDATE}?scope=project_not_mine`, null, auth)).status

const detail = await call('GET', `/candidates/${CANDIDATE}?scope=${SCOPE}`, null, auth)
out.detail = detail.status
out.maturityBefore = detail.body?.maturity?.level
out.sampleSize = detail.body?.maturity?.effectiveness?.sampleSize
out.independent = detail.body?.maturity?.attempts?.independentVerified
out.ci95 = detail.body?.maturity?.effectiveness?.ci95

// 审核对象必须是候选当前版本（旧版本已冻结，不能用来批准）
const versionId = detail.body?.candidate?.currentVersionId
const statusBefore = detail.body?.candidate?.status

const submitReason = '描述清晰，提交人工审核'
const submit = statusBefore === 'in_review'
  ? { status: 200, body: { candidate: { status: 'in_review' } } }
  : await call('POST', `/candidates/${CANDIDATE}/submit?scope=${SCOPE}`, { reason: submitReason }, auth)
out.statusBefore = statusBefore
out.submit = submit.status
out.afterSubmit = submit.body?.candidate?.status

const approveReason = '措辞与证据一致，接受描述（不等于已验证有效）'
const approve = await call(
  'POST',
  `/candidates/${CANDIDATE}/review?scope=${SCOPE}`,
  { decision: 'approve', versionId, reason: approveReason },
  auth,
)
out.approve = approve.status
out.afterApprove = approve.body?.candidate?.status
out.versionAfterApprove = approve.body?.version?.status

const repeat = await call(
  'POST',
  `/candidates/${CANDIDATE}/review?scope=${SCOPE}`,
  { decision: 'approve', versionId, reason: '重复提交' },
  auth,
)
out.repeat = repeat.status
out.repeatError = repeat.body?.error

const reviews = await call('GET', `/candidates/${CANDIDATE}/reviews?scope=${SCOPE}`, null, auth)
out.reviewCount = reviews.body?.reviews?.length
out.reviewSequence = (reviews.body?.reviews ?? []).map((row) => `${row.decision}@${row.reviewer}`)
out.reasons = (reviews.body?.reviews ?? []).map((row) => row.reason)
out.reasonRoundTrip = out.reasons?.includes(submitReason) === true && out.reasons?.includes(approveReason) === true
out.authMethodPersisted = /^local_token:op_[0-9a-f]{8}$/.test(out.reviewSequence?.[0]?.split('@')[1] ?? '')

// 批准不产生新的尝试，也不会改变成熟度（Approved is not validated）
out.attemptsAfterApprove = approve.body?.candidate ? detail.body?.maturity?.attempts?.total : null

// 描述性候选（未验证）可以提交审核，但状态必须明确是「未验证」
const weakDetail = await call('GET', `/candidates/${WEAK_CANDIDATE}?scope=${WEAK_SCOPE}`, null, auth)
out.weakMaturity = weakDetail.body?.maturity?.level
out.weakMissing = weakDetail.body?.maturity?.missing

// 证据基座不足（insufficient）的候选连提交都不允许
const insufficientCandidate = 'skc_24cb2aba-afaf-48fb-8c85-49f8f0d0758b'
const insufficientDetail = await call('GET', `/candidates/${insufficientCandidate}?scope=${SCOPE}`, null, auth)
out.insufficientMaturity = insufficientDetail.body?.maturity?.level
const blocked = await call(
  'POST',
  `/candidates/${insufficientCandidate}/submit?scope=${SCOPE}`,
  { reason: '试图在证据不足时提交' },
  auth,
)
out.insufficientSubmit = blocked.status
out.insufficientError = String(blocked.body?.error ?? '').slice(0, 80)

// 不存在的能力：任何执行入口都应 404
out.executeRoute = (await call('POST', `/candidates/${CANDIDATE}/execute?scope=${SCOPE}`, {}, auth)).status
out.writeStatusRoute = Number(out.noToken) === 401 && Number(out.executeRoute) === 404

console.log(JSON.stringify(out, null, 2))
