import { SketchSubagentDetail, SketchSubagentMerge, SketchSubagentSpawn } from './guide-sketches'

/** 子会话章节的真实工作流示例。 */
export function SubagentGuideExamples() {
  return (
    <section className="border-t border-[#6D28D9]/20 py-16 md:py-20">
      <div className="max-w-2xl">
        <div className="text-xs font-medium uppercase text-[#6D28D9]">真实示例</div>
        <h2 className="mt-4 text-3xl font-light text-neutral-900 md:text-4xl">从一个目标开始，由多个 Agent 一起推进</h2>
        <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
          子会话把复杂任务拆成独立方向：父会话负责组织，你仍然可以随时介入每一个研究过程。
        </p>
      </div>

      <div className="mt-14 space-y-16 md:mt-16 md:space-y-20">
        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <SketchSubagentSpawn />
          <div>
            <div className="text-xs font-medium uppercase text-[#6D28D9]">示例 01 · 启动</div>
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">一句话，就能启动多个研究方向</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              直接说出目标，Agent 可以创建多个子会话并行推进。复杂任务中，它也可能主动建议或自动唤起子会话；你还可以用自然语言指定每个子会话使用的模型。
            </p>
            <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
              <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
              <p className="mt-1 text-base leading-7 text-neutral-500">“启动 3 个子会话研究大五人格，并让其中一个使用 DeepSeek。”</p>
            </div>
          </div>
        </article>

        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-center">
          <div className="lg:order-1">
            <div className="text-xs font-medium uppercase text-[#6D28D9]">示例 02 · 深入</div>
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">进入子会话，继续完成自己的研究</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              每个子会话都是独立且完整的会话，拥有自己的上下文、任务边界和输出。打开后可像普通会话一样继续追问、补充方向，并检查它正在完成的工作。
            </p>
            <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
              <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
              <p className="mt-1 text-base leading-7 text-neutral-500">“补充大五人格在实际工作和人际关系中的应用，并用要点列出。”</p>
            </div>
          </div>
          <div className="lg:order-2">
            <SketchSubagentDetail />
          </div>
        </article>

        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <SketchSubagentMerge />
          <div>
            <div className="text-xs font-medium uppercase text-[#6D28D9]">示例 03 · 汇总</div>
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">研究完成后，父会话负责整合交付</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              各个子会话完成研究后，结果会自动汇回父会话。父会话会把不同方向的发现整合成最终答案、报告或其他可交付成果。
            </p>
            <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
              <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
              <p className="mt-1 text-base leading-7 text-neutral-500">“等所有子会话完成后，整合为一份面向新手的简明研究报告。”</p>
            </div>
          </div>
        </article>
      </div>
    </section>
  )
}
