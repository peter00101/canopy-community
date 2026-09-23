/**
 * 品牌配置真源
 *
 * 产品名、应用标识、本地目录命名、Git 归因等产品标识统一定义在这里。
 *
 * 此包不依赖任何其他 `@canopy/*` 包或 Electron，供 kernel / runtime 插件 /
 * 业务插件 / apps 任意一层单向消费。
 */
export interface BrandManifest {
  /** 产品展示名称 */
  productName: string
  /**
   * User-Agent 里的产品标识（`<token>/<version>`）。必须是不含空格的单个 token；
   * 部分渠道（如 Kimi Coding Plan）按 UA 校验，改值前需实测这些渠道。
   */
  userAgentProduct: string
  /** electron-builder 应用标识（appId），需与 electron-builder.yml 保持一致 */
  appId: string
  /** 正式版本地配置目录名（含前导点） */
  configDirName: string
  /** 开发模式本地配置目录名（含前导点） */
  configDirNameDev: string
  /**
   * Electron userData 目录名（位于系统 appData 下）。
   *
   * null = 沿用 Electron 默认（按 apps/electron/package.json 的 name）。
   * 显式给值可以与使用同一 package name 的其它发行版并存（独立的单实例锁与 safeStorage 密钥）；
   * 开发模式在其后追加 `-dev`。
   */
  userDataDirName: string | null
  /** Agent 代用户创建 commit / PR 时的归因标识 */
  gitAttribution: {
    /** commit trailer 的 key（标准 git trailer，不进入 GitHub co-author 列表） */
    trailerKey: string
    /** PR / MR 描述里产品名链接到的地址；null 则只写产品名不带链接 */
    linkUrl: string | null
  }
  /** 本地/云端 Vault 集成相关的展示文案 */
  vault: {
    /** 托管 Vault 的展示名称 */
    managedLabel: string
    /** 自建 Vault 的展示名称 */
    selfManagedLabel: string
    /** 托管 Vault 默认 Inbox 目录名 */
    inboxName: string
  }
}

export const CANOPY_BRAND: BrandManifest = {
  productName: 'Canopy Community',
  userAgentProduct: 'Canopy',
  appId: 'com.canopy.community',
  configDirName: '.canopy-community',
  configDirNameDev: '.canopy-community-dev',
  userDataDirName: '@canopy/electron-community',
  gitAttribution: {
    trailerKey: 'Made-with',
    linkUrl: 'https://github.com/peter00101/canopy-community',
  },
  vault: {
    managedLabel: 'Canopy Vault',
    selfManagedLabel: 'Canopy 自建 Vault',
    inboxName: 'Canopy Inbox',
  },
}
