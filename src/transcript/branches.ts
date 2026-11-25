import { isTurnRecord, type RawRecord } from './parse.ts'

export class Branches {
  private readonly parents = new Map<string, string | null>()
  private readonly answers = new Map<string, string[]>()
  private leaf: string | undefined

  add(record: RawRecord): void {
    if (!record.uuid || record.isSidechain) return
    const compacted = record.subtype === 'compact_boundary' ? this.leaf : undefined
    this.parents.set(record.uuid, record.parentUuid ?? compacted ?? record.logicalParentUuid ?? null)
    const content = record.message?.content
    const answered = Array.isArray(content) ? content.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id ?? ''] : [])) : []
    if (answered.length) this.answers.set(record.uuid, answered)
    if (isTurnRecord(record)) this.leaf = record.uuid
  }

  clear(): void {
    this.parents.clear()
    this.answers.clear()
    this.leaf = undefined
  }

  live(): (uuid: string) => boolean {
    const active = new Set<string>()
    for (let id = this.leaf; id && !active.has(id); id = this.parents.get(id) ?? undefined) active.add(id)
    const answeredOnActive = new Set<string>()
    for (const id of active) for (const toolUse of this.answers.get(id) ?? []) answeredOnActive.add(toolUse)
    const settled = new Map<string, boolean>()

    const parallelResult = (uuid: string) => {
      const answered = this.answers.get(uuid)
      return Boolean(answered?.some((toolUse) => !answeredOnActive.has(toolUse)))
    }

    const abandoned = (start: string): boolean => {
      const path = new Set<string>()
      let id: string | null | undefined = start
      let branchRoot = start
      let dead = false
      while (id && !path.has(id)) {
        if (active.has(id)) {
          dead = !parallelResult(branchRoot)
          break
        }
        const known = settled.get(id)
        if (known !== undefined) {
          dead = known
          break
        }
        path.add(id)
        branchRoot = id
        id = this.parents.get(id)
      }
      for (const node of path) settled.set(node, dead)
      return dead
    }

    return (uuid) => !uuid || active.has(uuid) || !this.parents.has(uuid) || !abandoned(uuid)
  }
}
