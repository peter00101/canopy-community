import { SketchFileSaved } from './guide-sketches'

/** 会话文件与项目文件的真实工作流示例；由父页面负责放入章节容器和导航。 */
export function FileGuideExamples() {
  return (
    <>
      <div className="max-w-2xl">
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-[#6D28D9]">真实示例</div>
        <h2 className="mt-4 text-3xl font-light tracking-tight text-neutral-900 md:text-4xl">让文件跟着工作流留在正确的位置</h2>
      </div>

      <div className="mt-14 space-y-16 md:mt-16 md:space-y-20">
        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
          <SketchFileSaved variant="session" />
          <div>
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-[#6D28D9]">示例 01 · 会话文件</div>
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">把当前对话的产出留在会话里</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              当结果只服务于这一次讨论，例如一份 RAG 调研报告，就让 Agent 把它保存到会话文件。它会紧贴当前上下文，方便在这段对话中继续引用和修改。
            </p>
            <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
              <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
              <p className="mt-1 text-base leading-7 text-neutral-500">“把这份 RAG 研究结果写入会话文件，方便我在当前对话继续引用。”</p>
            </div>
          </div>
        </article>

        <article className="grid gap-10 border-t border-[#6D28D9]/15 pt-10 lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-center">
          <div className="lg:order-1">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-[#6D28D9]">示例 02 · 项目文件</div>
            <h3 className="mt-3 text-2xl font-medium text-neutral-900 md:text-3xl">把可复用的方法沉淀为项目资产</h3>
            <p className="mt-4 text-base leading-[1.7] text-neutral-600 md:text-lg">
              当内容可以跨会话复用，例如研究方法、工作模板或项目知识，把它保存到项目文件。同一项目中的其他对话都能找到并继续沿用这些成果。
            </p>
            <div className="mt-5 border-l-2 border-[#6D28D9]/35 pl-4">
              <div className="text-base font-medium leading-7 text-[#6D28D9]">这样告诉 Agent</div>
              <p className="mt-1 text-base leading-7 text-neutral-500">“把这套研究方法整理到项目文件，后面的会话都可以继续使用。”</p>
            </div>
          </div>
          <div className="lg:order-2">
            <SketchFileSaved variant="project" />
          </div>
        </article>
      </div>
    </>
  )
}
