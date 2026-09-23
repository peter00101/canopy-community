/**
 * 菜单基础样式的单一来源。
 *
 * DropdownMenu（「…」下拉）与 ContextMenu（右键）内容相同，视觉也必须相同，
 * 所以两边的容器 / 项 / 子菜单触发器 / 分隔线都从这里取类名，别再各写一份。
 */

// z 值决策（改动前先看 lib/overlay-layer.test.ts 的护栏）：
// 菜单 Portal 挂在 body 下，与 AppShell 的主区容器（relative z-[60]）同处根层叠上下文。
// 上游默认的 z-50 低于 60，菜单会被主内容区整块盖住：DOM 里已展开、屏幕上却什么都看不见，
// 同时 Radix 给 body 加了 pointer-events:none，整个界面像卡死（维护者报障「点了没用还会卡」）。
// 统一取 z-[9999]（globals.css 约定的 portal 弹窗层，低于 Tooltip 的 10050）。
export const menuSurfaceClassName =
  "z-[9999] min-w-[8rem] overflow-hidden rounded-lg border border-border/50 bg-popover p-1 text-popover-foreground shadow-lg"

export const menuAnimationClassName =
  "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2"

// 项内圆角与高亮态：rounded-md 跟容器更协调，focus 态用 accent/70 透明叠加更轻盈
export const menuItemClassName =
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors duration-100 focus:bg-accent/70 focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:pointer-events-none [&>svg]:size-4 [&>svg]:shrink-0"

export const menuSubTriggerClassName =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors duration-100 focus:bg-accent/70 focus:text-accent-foreground data-[state=open]:bg-accent/70 data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"

export const menuSeparatorClassName = "-mx-1 my-1 h-px bg-muted"
