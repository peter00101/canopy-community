import * as React from 'react'

interface AgentMascotIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number
}

/**
 * 折叠侧栏 Agent 会话用的「机器人」：偏宽的圆角头 + 两个大圆点眼 + 顶着小球的短天线，无嘴无耳。
 * 与 lucide 同一套描边规范（24 视口、2px 圆头描边）。
 * 演进：lucide Bot（方脑袋，偏工业）→ 圆脸笑脸带天线（维护者嫌幼稚）→ 圆角框两竖线
 * （小尺寸像电源插座，否）→ 中性天线版 → 现在这版：头更圆更宽、眼睛放大、天线顶小球，
 * 在「可爱」与「不幼稚」之间取中——可爱靠比例而不是靠表情。
 */
export function AgentMascotIcon({ size = 16, ...props }: AgentMascotIconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="3.4" r="1.4" fill="currentColor" stroke="none" />
      <path d="M12 4.8v2.2" />
      <rect x="3.5" y="7" width="17" height="12.5" rx="5.5" />
      <circle cx="8.9" cy="13.25" r="1.85" fill="currentColor" stroke="none" />
      <circle cx="15.1" cy="13.25" r="1.85" fill="currentColor" stroke="none" />
    </svg>
  )
}
