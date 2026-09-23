/**
 * 新手引导自绘界面示意图
 *
 * 用纯 DOM/Tailwind 线框图代替真实截图：不依赖任何位图资产，
 * 讲解区域用品牌紫高亮环标出，随主题色演进只需改此文件。
 *
 * 原语：SketchWindow（窗口）、SketchSidebar（侧边栏）、Bar（文字占位条）、
 * Highlight(高亮环)；下方每个 Sketch* 组件对应引导的一个讲解场景。
 */

/** 品牌紫（与应用图标一致） */
const ACCENT = '#7C3AED'

function Bar({ w = 'w-24', tone = 'bg-neutral-200', h = 'h-2.5' }: { w?: string; tone?: string; h?: string }) {
  return <div className={`${h} ${w} rounded-full ${tone}`} />
}

/** 高亮环：包住被讲解的 UI 元素 */
function Highlight({ children, label, className = '' }: { children: React.ReactNode; label?: string; className?: string }) {
  return (
    <div className={`relative rounded-lg ring-2 ring-[#7C3AED] shadow-[0_0_0_5px_rgba(124,58,237,0.14)] ${className}`}>
      {children}
      {label && (
        <span className="absolute -top-2.5 left-2 rounded-full bg-[#7C3AED] px-2 py-0.5 text-[10px] font-medium leading-4 text-white">
          {label}
        </span>
      )}
    </div>
  )
}

/** 窗口外框：圆角 + 交通灯 + 阴影，内容区自适应 */
function SketchWindow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-xl border border-[#e4e0ef] bg-white shadow-[0_14px_30px_rgba(109,40,217,0.10)] ${className}`}>
      <div className="flex h-8 items-center gap-1.5 border-b border-neutral-100 bg-[#faf9fc] px-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#f2b8b5]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#f4d9a0]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#bfe3c0]" />
      </div>
      {children}
    </div>
  )
}

/** 模式分段控件（Agent / Chat） */
function ModeSegment({ active = 'agent' }: { active?: 'agent' | 'chat' }) {
  return (
    <div className="flex rounded-md bg-neutral-100 p-0.5 text-[11px] font-medium leading-5">
      <span className={`flex-1 rounded px-2 text-center ${active === 'agent' ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-neutral-400'}`}>Agent</span>
      <span className={`flex-1 rounded px-2 text-center ${active === 'chat' ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-neutral-400'}`}>Chat</span>
    </div>
  )
}

/** 侧边栏：模式切换 + 项目/会话列表 */
function SketchSidebar({ highlightMode = false, highlightProjects = false }: { highlightMode?: boolean; highlightProjects?: boolean }) {
  const projects = (
    <div className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">项目</div>
      <div className="flex items-center gap-1.5 rounded-md bg-[#F5F3FF] px-2 py-1.5 text-[11px] text-[#6D28D9]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#7C3AED]" />
        产品调研
      </div>
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-neutral-500">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" />
        代码仓库分析
      </div>
      <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-neutral-500">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" />
        周报写作
      </div>
    </div>
  )

  return (
    <div className="flex w-32 shrink-0 flex-col gap-3 border-r border-neutral-100 bg-[#faf9fc] p-2.5">
      {highlightMode ? <Highlight label="模式切换"><ModeSegment /></Highlight> : <ModeSegment />}
      {highlightProjects ? <Highlight label="项目" className="-mx-1 px-1 py-1">{projects}</Highlight> : projects}
      <div className="mt-auto space-y-1.5">
        <Bar w="w-16" tone="bg-neutral-200/80" h="h-2" />
        <Bar w="w-12" tone="bg-neutral-200/80" h="h-2" />
      </div>
    </div>
  )
}

/** 用户气泡（右对齐紫底）与助手内容（左对齐卡片）的消息流 */
function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm bg-[#7C3AED] px-2.5 py-1.5 text-[11px] leading-4 text-white">{children}</div>
    </div>
  )
}

function AssistantCard({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[92%] rounded-lg rounded-bl-sm border border-neutral-100 bg-white px-2.5 py-2 shadow-sm">{children}</div>
}

/** 工具调用行 */
function ToolRow({ name, done = true }: { name: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] leading-4 text-neutral-500">
      <span className={`flex h-3 w-3 items-center justify-center rounded-full text-[8px] text-white ${done ? 'bg-[#7C3AED]' : 'bg-neutral-300'}`}>✓</span>
      <span className="font-mono">{name}</span>
    </div>
  )
}

/** 文件行（文件面板/记忆列表通用） */
function FileRow({ name, accent = false, badge }: { name: string; accent?: boolean; badge?: string }) {
  return (
    <div className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] ${accent ? 'bg-[#F5F3FF] text-[#6D28D9]' : 'text-neutral-600'}`}>
      <span className={`inline-block h-3 w-2.5 rounded-[2px] border ${accent ? 'border-[#7C3AED] bg-white' : 'border-neutral-300 bg-neutral-50'}`} />
      <span className="truncate">{name}</span>
      {badge && <span className="ml-auto rounded bg-[#7C3AED]/10 px-1 text-[9px] font-medium text-[#6D28D9]">{badge}</span>}
    </div>
  )
}

/** 右侧文件面板 */
function FilesPanel({ tab = 'session', highlightTabs = false, files }: { tab?: 'session' | 'project'; highlightTabs?: boolean; files: React.ReactNode }) {
  const tabs = (
    <div className="flex rounded-md bg-neutral-100 p-0.5 text-[10px] font-medium leading-5">
      <span className={`flex-1 rounded px-1.5 text-center ${tab === 'session' ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-neutral-400'}`}>会话文件</span>
      <span className={`flex-1 rounded px-1.5 text-center ${tab === 'project' ? 'bg-white text-[#6D28D9] shadow-sm' : 'text-neutral-400'}`}>项目文件</span>
    </div>
  )
  return (
    <div className="flex w-36 shrink-0 flex-col gap-2 border-l border-neutral-100 bg-[#faf9fc] p-2.5">
      {highlightTabs ? <Highlight label="文件页签">{tabs}</Highlight> : tabs}
      <div className="space-y-1">{files}</div>
    </div>
  )
}

// ===== 场景 1：模式切换（Agent vs Chat） =====

export function SketchModeSwitch() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-64">
        <SketchSidebar highlightMode />
        <div className="flex-1 space-y-2.5 p-3">
          <UserBubble>帮我研究一下什么是 RAG</UserBubble>
          <AssistantCard>
            <div className="space-y-1.5">
              <Bar w="w-40" tone="bg-neutral-200" />
              <Bar w="w-32" />
              <ToolRow name="WebSearch" />
              <ToolRow name="Write · RAG研究.md" />
            </div>
          </AssistantCard>
        </div>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 2：Chat 问答示例 =====

export function SketchChatQA() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-56">
        <SketchSidebar />
        <div className="flex-1 space-y-2.5 p-3">
          <UserBubble>用通俗的话解释一下 RAG 的搜索原理</UserBubble>
          <AssistantCard>
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium leading-4 text-[#6D28D9]">RAG = 检索 + 生成</div>
              <Bar w="w-44" />
              <Bar w="w-40" />
              <Bar w="w-28" />
            </div>
          </AssistantCard>
        </div>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 3：Agent 执行示例 =====

export function SketchAgentRun() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-64">
        <div className="flex-1 space-y-2.5 p-3">
          <UserBubble>研究 RAG，把结果写成文档放到会话文件里</UserBubble>
          <AssistantCard>
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-[#7C3AED]">执行计划</div>
              <ToolRow name="WebSearch · RAG 检索增强" />
              <ToolRow name="WebSearch · 向量检索对比" />
              <ToolRow name="Write · RAG研究报告.md" />
              <Bar w="w-36" />
            </div>
          </AssistantCard>
        </div>
        <FilesPanel
          tab="session"
          files={
            <>
              <FileRow name="RAG研究报告.md" accent badge="新" />
              <FileRow name="参考资料.md" />
            </>
          }
        />
      </div>
    </SketchWindow>
  )
}

// ===== 场景 4：项目列表 =====

export function SketchProjects() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-64">
        <SketchSidebar highlightProjects />
        <div className="flex-1 space-y-2.5 p-3">
          <AssistantCard>
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium leading-4 text-[#6D28D9]">产品调研 · 会话</div>
              <Bar w="w-40" />
              <Bar w="w-32" />
            </div>
          </AssistantCard>
          <AssistantCard>
            <div className="space-y-1.5">
              <Bar w="w-36" />
              <Bar w="w-24" />
            </div>
          </AssistantCard>
        </div>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 5：文件页签 =====

export function SketchFilesTabs() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-64">
        <div className="flex-1 space-y-2.5 p-3">
          <UserBubble>把研究结论整理成文档</UserBubble>
          <AssistantCard>
            <div className="space-y-1.5">
              <Bar w="w-40" />
              <ToolRow name="Write · 研究结论.md" />
            </div>
          </AssistantCard>
        </div>
        <FilesPanel
          tab="session"
          highlightTabs
          files={
            <>
              <FileRow name="研究结论.md" accent />
              <FileRow name="访谈记录.txt" />
              <FileRow name="数据表.csv" />
            </>
          }
        />
      </div>
    </SketchWindow>
  )
}

// ===== 场景 6：文件写入（会话文件 / 项目文件） =====

export function SketchFileSaved({ variant }: { variant: 'session' | 'project' }) {
  const isSession = variant === 'session'
  return (
    <SketchWindow className="w-full">
      <div className="flex h-56">
        <div className="flex-1 space-y-2.5 p-3">
          <UserBubble>
            {isSession ? '把这份 RAG 研究写入会话文件' : '把这套研究方法整理到项目文件'}
          </UserBubble>
          <AssistantCard>
            <div className="space-y-1.5">
              <ToolRow name={isSession ? 'Write · RAG研究.md' : 'Write · 研究方法.md'} />
              <Bar w="w-32" />
            </div>
          </AssistantCard>
        </div>
        <FilesPanel
          tab={variant}
          files={
            isSession ? (
              <>
                <FileRow name="RAG研究.md" accent badge="新" />
                <FileRow name="临时笔记.md" />
              </>
            ) : (
              <>
                <FileRow name="研究方法.md" accent badge="新" />
                <FileRow name="项目知识库.md" />
                <FileRow name="工作模板.md" />
              </>
            )
          }
        />
      </div>
    </SketchWindow>
  )
}

// ===== 场景 7-9：子会话 =====

function SubagentCard({ name, model, progress }: { name: string; model: string; progress: string }) {
  return (
    <div className="rounded-lg border border-[#7C3AED]/25 bg-[#F5F3FF]/60 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium leading-4 text-[#6D28D9]">{name}</span>
        <span className="rounded bg-white px-1.5 text-[9px] leading-4 text-neutral-500">{model}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#7C3AED]/15">
          <div className="h-full rounded-full bg-[#7C3AED]" style={{ width: progress }} />
        </div>
        <span className="text-[9px] text-neutral-400">{progress}</span>
      </div>
    </div>
  )
}

export function SketchSubagentSpawn() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="space-y-2.5 p-3">
        <UserBubble>启动 3 个子会话研究大五人格，其中一个用 DeepSeek</UserBubble>
        <AssistantCard>
          <div className="space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[#7C3AED]">已启动 3 个子会话</div>
            <SubagentCard name="人格理论溯源" model="Claude" progress="72%" />
            <SubagentCard name="测量与信效度" model="DeepSeek" progress="45%" />
            <SubagentCard name="实际应用场景" model="Claude" progress="58%" />
          </div>
        </AssistantCard>
      </div>
    </SketchWindow>
  )
}

export function SketchSubagentDetail() {
  return (
    <SketchWindow className="w-full">
      <div className="space-y-2.5 p-3">
        <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
          <span>父会话</span>
          <span>›</span>
          <span className="font-medium text-[#6D28D9]">子会话 · 实际应用场景</span>
        </div>
        <AssistantCard>
          <div className="space-y-1.5">
            <Bar w="w-40" />
            <ToolRow name="WebSearch · 大五人格 招聘评估" />
            <Bar w="w-32" />
          </div>
        </AssistantCard>
        <UserBubble>补充在人际关系中的应用，用要点列出</UserBubble>
      </div>
    </SketchWindow>
  )
}

export function SketchSubagentMerge() {
  return (
    <SketchWindow className="w-full">
      <div className="space-y-2.5 p-3">
        <AssistantCard>
          <div className="space-y-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[#7C3AED]">3 个子会话已完成</div>
            <div className="flex gap-1.5">
              {['溯源', '测量', '应用'].map((t) => (
                <span key={t} className="rounded bg-[#F5F3FF] px-1.5 py-0.5 text-[9px] text-[#6D28D9]">✓ {t}</span>
              ))}
            </div>
          </div>
        </AssistantCard>
        <AssistantCard>
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium leading-4 text-[#6D28D9]">大五人格研究报告（整合）</div>
            <Bar w="w-44" />
            <Bar w="w-40" />
            <Bar w="w-28" />
          </div>
        </AssistantCard>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 10-12：自动任务 =====

function FormRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-neutral-100 px-2.5 py-1.5">
      <span className="text-[10px] text-neutral-400">{label}</span>
      <span className="text-[11px] font-medium text-neutral-700">{value}</span>
    </div>
  )
}

export function SketchAutomationForm() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="space-y-2 p-3">
        <div className="text-[11px] font-medium text-[#6D28D9]">新建自动任务</div>
        <div className="rounded-md border border-neutral-100 px-2.5 py-2 text-[11px] leading-4 text-neutral-600">
          每天扫描代码库，检查前一天新提交代码的质量
        </div>
        <FormRow label="执行时间" value={<span className="text-[#6D28D9]">每天 09:00</span>} />
        <FormRow label="模型" value="DeepSeek V4 Flash" />
        <FormRow label="飞书通知" value={<span className="inline-block h-3.5 w-6 rounded-full bg-[#7C3AED] p-0.5"><span className="ml-auto block h-2.5 w-2.5 rounded-full bg-white" /></span>} />
        <div className="flex justify-end">
          <span className="rounded-md bg-[#7C3AED] px-3 py-1 text-[11px] font-medium text-white">保存任务</span>
        </div>
      </div>
    </SketchWindow>
  )
}

export function SketchAutomationRun() {
  return (
    <SketchWindow className="w-full">
      <div className="space-y-2.5 p-3">
        <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
          <span className="rounded bg-[#F5F3FF] px-1.5 py-0.5 font-medium text-[#6D28D9]">自动任务</span>
          <span>今天 09:00 触发</span>
        </div>
        <AssistantCard>
          <div className="space-y-1.5">
            <ToolRow name="git log --since=yesterday" />
            <ToolRow name="Read · 2 个新提交" />
            <div className="text-[11px] font-medium leading-4 text-[#6D28D9]">质量审查结论</div>
            <Bar w="w-40" />
            <Bar w="w-32" />
          </div>
        </AssistantCard>
      </div>
    </SketchWindow>
  )
}

export function SketchAutomationCalendar() {
  const days = ['一', '二', '三', '四', '五']
  return (
    <SketchWindow className="w-full">
      <div className="p-3">
        <div className="mb-2 text-[11px] font-medium text-[#6D28D9]">日程表</div>
        <div className="grid grid-cols-5 gap-1.5">
          {days.map((d) => (
            <div key={d} className="space-y-1">
              <div className="text-center text-[9px] text-neutral-400">周{d}</div>
              <div className="h-24 rounded-md border border-neutral-100 bg-[#faf9fc] p-1">
                <div className="rounded bg-[#7C3AED]/12 px-1 py-0.5 text-[8px] leading-3 text-[#6D28D9]">
                  09:00 代码质量扫描
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 13-14：记忆 =====

export function SketchMemoryGenerate() {
  return (
    <SketchWindow className="w-full">
      <div className="space-y-2.5 p-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium text-[#6D28D9]">项目记忆 · 产品调研</div>
          <span className="rounded-md bg-[#7C3AED] px-2.5 py-1 text-[10px] font-medium text-white">生成项目记忆</span>
        </div>
        <div className="rounded-md border border-dashed border-[#7C3AED]/30 bg-[#F5F3FF]/50 px-2.5 py-2 text-[10px] leading-4 text-neutral-500">
          Agent 会整理近期有代表性的工作，提炼项目偏好、规则与已确认结论
        </div>
        <div className="space-y-1">
          <Bar w="w-40" tone="bg-neutral-200/70" h="h-2" />
          <Bar w="w-32" tone="bg-neutral-200/70" h="h-2" />
        </div>
      </div>
    </SketchWindow>
  )
}

export function SketchMemoryFiles() {
  return (
    <SketchWindow className="w-full">
      <div className="space-y-2 p-3">
        <div className="text-[11px] font-medium text-[#6D28D9]">记忆文件</div>
        <div className="space-y-1">
          <FileRow name="项目偏好.md" accent badge="自动" />
          <FileRow name="已确认结论.md" accent badge="自动" />
          <FileRow name="术语与规范.md" accent badge="自动" />
          <FileRow name="我的补充.md" />
        </div>
        <div className="text-[10px] leading-4 text-neutral-400">均为 Markdown 文件，可直接编辑</div>
      </div>
    </SketchWindow>
  )
}

// ===== 场景 15：侧边回答 =====

export function SketchSideAnswer() {
  return (
    <SketchWindow className="w-full max-w-xl">
      <div className="flex h-64">
        <div className="flex-1 space-y-2.5 p-3">
          <AssistantCard>
            <div className="space-y-1.5">
              <Bar w="w-40" />
              <div className="text-[11px] leading-4 text-neutral-600">
                <span className="rounded bg-[#7C3AED]/20 px-0.5 text-[#6D28D9]">向量检索通过语义相似度召回文档</span>
              </div>
              <Bar w="w-36" />
              <Bar w="w-24" />
            </div>
          </AssistantCard>
        </div>
        <div className="w-40 shrink-0 border-l border-neutral-100 bg-[#faf9fc] p-2.5">
          <Highlight label="侧边回答">
            <div className="space-y-1.5 rounded-lg bg-white p-2">
              <div className="text-[10px] font-medium text-[#6D28D9]">什么是向量检索？</div>
              <Bar w="w-24" tone="bg-neutral-200/80" h="h-2" />
              <Bar w="w-20" tone="bg-neutral-200/80" h="h-2" />
              <Bar w="w-16" tone="bg-neutral-200/80" h="h-2" />
            </div>
          </Highlight>
        </div>
      </div>
    </SketchWindow>
  )
}
