import { SketchMemoryFiles, SketchMemoryGenerate } from './guide-sketches'

/** 项目记忆章节的真实工作流示例；由父页面负责放入章节容器和导航。 */
export function MemoryGuideExamples() {
  return (
    <>
      <div className="max-w-2xl">
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-[#6D28D9]">真实示例</div>
        <h2 className="mt-4 text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">复用已验证的经验</h2>
      </div>

      <div className="mt-14 space-y-16 md:mt-16 md:space-y-20">
        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <SketchMemoryGenerate />
          <div className="min-w-0">
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">一键生成项目记忆</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              项目使用一段时间后，在项目记忆处点击“生成项目记忆”。Agent 会开启一个会话整理选定范围内有代表性的工作，提炼项目偏好、规则与已确认结论。
            </p>
          </div>
        </article>

        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-center">
          <div className="min-w-0 lg:order-1">
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">
              Agent 整理好的<b className="font-medium text-neutral-900">偏好和记忆可以随时编辑</b>
            </h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              “记忆”下是 Agent 整理好的偏好和记忆。你可以手动编辑这些 md 文件；需要大规模重新梳理时，再一键生成或更新记忆即可。
            </p>
          </div>
          <div className="lg:order-2">
            <SketchMemoryFiles />
          </div>
        </article>
      </div>
    </>
  )
}
